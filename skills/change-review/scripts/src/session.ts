import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyFileDiffToContent, filePathOf, filterFiles, type ChunkRef } from "./chunks.ts";
import type {
  AnswerInput,
  ApplyOutcome,
  CommentReply,
  FileDiff,
  QuestionThread,
  ReviewResult,
  ServerInfo,
  SessionRequest,
} from "./types.ts";

// Where sessions live. The agent provides it per review session (--dir) so nothing
// is ever written to a fixed global path; the default serves humans running by hand.
let dataRoot = path.join(os.tmpdir(), "change-review");

export function setDataDir(dir: string): void {
  dataRoot = dir;
}

export function dataDir(): string {
  return dataRoot;
}

export function sessionDir(id: string): string {
  return path.join(dataRoot, id);
}

const reqPath = (id: string) => path.join(sessionDir(id), "request.json");
const patchPath = (id: string) => path.join(sessionDir(id), "patch.diff");
const resultPath = (id: string) => path.join(sessionDir(id), "result.json");
const serverPath = (id: string) => path.join(sessionDir(id), "server.json");
const threadsPath = (id: string) => path.join(sessionDir(id), "threads.json");
const historyDir = (id: string) => path.join(sessionDir(id), "history");
const stagedDir = (id: string) => path.join(sessionDir(id), "proposal");
const stagedBaseDir = (id: string) => path.join(sessionDir(id), "proposal-base");
const applyManifestPath = (id: string) => path.join(sessionDir(id), "apply.json");
export const appliedPatchPath = (id: string) => path.join(sessionDir(id), "applied.patch");
export const revertPatchPath = (id: string) => path.join(sessionDir(id), "revert.patch");

function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

export function newSessionId(): string {
  return `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString("hex")}`;
}

export function createSession(opts: {
  id?: string;
  title: string;
  patch: string;
  cwd: string;
  /** Agent replies to the previous round's comments; merged into the archived result. */
  replies?: CommentReply[];
}): SessionRequest {
  const id = opts.id ?? newSessionId();
  fs.mkdirSync(historyDir(id), { recursive: true });

  const existing = readJson<SessionRequest>(reqPath(id));
  let round = 1;
  if (existing) {
    round = existing.round + 1;
    const prevResult = readJson<ReviewResult>(resultPath(id));
    if (prevResult) {
      for (const r of opts.replies ?? []) {
        const c = prevResult.comments[r.comment];
        if (c) c.reply = r.reply;
      }
      fs.writeFileSync(
        path.join(historyDir(id), `round-${existing.round}.result.json`),
        JSON.stringify(prevResult, null, 2),
      );
      fs.rmSync(resultPath(id), { force: true });
    }
    if (fs.existsSync(patchPath(id))) {
      fs.renameSync(patchPath(id), path.join(historyDir(id), `round-${existing.round}.patch`));
    }
    // A server still running for the previous round would show a stale diff.
    stopServer(id);
  }

  const req: SessionRequest = {
    id,
    title: opts.title,
    cwd: opts.cwd,
    round,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(reqPath(id), JSON.stringify(req, null, 2));
  fs.writeFileSync(patchPath(id), opts.patch);
  fs.rmSync(resultPath(id), { force: true });
  // A new round must not inherit the previous round's staged proposal or chunk artifacts.
  fs.rmSync(stagedDir(id), { recursive: true, force: true });
  fs.rmSync(stagedBaseDir(id), { recursive: true, force: true });
  fs.rmSync(applyManifestPath(id), { force: true });
  fs.rmSync(appliedPatchPath(id), { force: true });
  fs.rmSync(revertPatchPath(id), { force: true });
  return req;
}

interface ApplyManifestEntry {
  rel: string;
  /** sha256 of the file in the working tree when the review was created; null = file didn't exist. */
  baseSha256: string | null;
  /** sha256 of the proposed (staged) contents. */
  sha256: string;
}

const sha256 = (data: Buffer) => crypto.createHash("sha256").update(data).digest("hex");

const stagedFilePath = (id: string, rel: string) => path.join(stagedDir(id), ...rel.split("/"));
const stagedBaseFilePath = (id: string, rel: string) => path.join(stagedBaseDir(id), ...rel.split("/"));

/**
 * Snapshot the proposed contents of the changed files into the session dir so an
 * approve verdict can be applied byte-for-byte even after the temp dir is gone.
 * The base contents are snapshotted too, so a partial approve ("Apply N of M chunks")
 * can rebuild base-plus-kept-chunks deterministically at verdict time.
 */
export function stageProposal(id: string, root: string, files: Array<{ rel: string; src: string }>): void {
  const entries: ApplyManifestEntry[] = [];
  for (const f of files) {
    const data = fs.readFileSync(f.src);
    let base: Buffer | null = null;
    try {
      base = fs.readFileSync(path.resolve(root, f.rel));
    } catch {
      // new file
    }
    const dest = stagedFilePath(id, f.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    if (base) {
      const baseDest = stagedBaseFilePath(id, f.rel);
      fs.mkdirSync(path.dirname(baseDest), { recursive: true });
      fs.writeFileSync(baseDest, base);
    }
    entries.push({ rel: f.rel, baseSha256: base ? sha256(base) : null, sha256: sha256(data) });
  }
  fs.writeFileSync(applyManifestPath(id), JSON.stringify({ files: entries }, null, 2));
}

function readStagedBase(id: string, f: ApplyManifestEntry): Buffer | null {
  if (f.baseSha256 === null) return null;
  let data: Buffer;
  try {
    data = fs.readFileSync(stagedBaseFilePath(id, f.rel));
  } catch {
    throw new Error(`no staged base for ${f.rel} — this session predates partial apply; open a new review`);
  }
  if (sha256(data) !== f.baseSha256) {
    throw new Error(`staged base of ${f.rel} no longer matches the reviewed base`);
  }
  return data;
}

/**
 * Write the staged proposal into the working tree, exactly as reviewed.
 * With `partial`, each file's target is computed deterministically from the selection:
 * the staged proposal when fully kept, the reviewed base when fully skipped, and
 * base-plus-kept-runs (exact line splice, no fuzzing) when partially kept.
 * All-or-nothing: if any file's current contents match neither the reviewed base
 * nor its target (it changed mid-review), nothing is written and the conflicts
 * are reported. Returns undefined when the session has no staged proposal.
 */
export function applyProposal(
  id: string,
  cwd: string,
  partial?: { files: FileDiff[]; skipped: ChunkRef[] },
): ApplyOutcome | undefined {
  const manifest = readJson<{ files: ApplyManifestEntry[] }>(applyManifestPath(id));
  if (!manifest) return undefined;
  const wrote: string[] = [];
  try {
    const skipped = partial?.skipped ?? [];
    const diffByPath = new Map((partial?.files ?? []).map((f) => [filePathOf(f), f]));
    const pending: Array<{ abs: string; data: Buffer; rel: string }> = [];
    const conflicts: string[] = [];
    for (const f of manifest.files) {
      const staged = fs.readFileSync(stagedFilePath(id, f.rel));
      if (sha256(staged) !== f.sha256) throw new Error(`staged copy of ${f.rel} no longer matches the reviewed contents`);
      const refs = skipped.filter((r) => r.file === f.rel);
      // Target contents under the selection; null = the file should not exist.
      let target: Buffer | null;
      if (refs.length === 0) {
        target = staged;
      } else {
        const base = readStagedBase(id, f);
        const fd = diffByPath.get(f.rel);
        if (!fd) throw new Error(`no parsed diff for ${f.rel} — cannot apply a partial selection`);
        const kept = filterFiles([fd], refs);
        if (kept.length === 0) {
          target = base; // every chunk skipped — the file stays at its base state
        } else {
          target = Buffer.from(applyFileDiffToContent(base === null ? "" : base.toString("utf8"), kept[0]), "utf8");
        }
      }
      const targetSha = target === null ? null : sha256(target);
      const abs = path.resolve(cwd, f.rel);
      let currentSha: string | null = null;
      try {
        currentSha = sha256(fs.readFileSync(abs));
      } catch {
        // file absent
      }
      if (currentSha === targetSha) continue; // already in the wanted state
      if (currentSha !== f.baseSha256) {
        conflicts.push(f.rel);
        continue;
      }
      if (target === null) continue; // wanted absent; disk == base == absent was handled above
      pending.push({ abs, data: target, rel: f.rel });
    }
    if (conflicts.length > 0) return { applied: false, wrote, conflicts };
    for (const p of pending) {
      fs.mkdirSync(path.dirname(p.abs), { recursive: true });
      fs.writeFileSync(p.abs, p.data);
      wrote.push(p.rel);
    }
    return { applied: true, wrote };
  } catch (err) {
    return { applied: false, wrote, error: err instanceof Error ? err.message : String(err) };
  }
}

export function readRequest(id: string): SessionRequest | null {
  return readJson<SessionRequest>(reqPath(id));
}

export function readPatch(id: string): string | null {
  try {
    return fs.readFileSync(patchPath(id), "utf8");
  } catch {
    return null;
  }
}

export function readResult(id: string): ReviewResult | null {
  return readJson<ReviewResult>(resultPath(id));
}

export function writeResult(id: string, result: ReviewResult): void {
  const tmp = resultPath(id) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2));
  fs.renameSync(tmp, resultPath(id));
}

export function readHistory(id: string): ReviewResult[] {
  try {
    return fs
      .readdirSync(historyDir(id))
      .filter((f) => f.endsWith(".result.json"))
      .map((f) => readJson<ReviewResult>(path.join(historyDir(id), f)))
      .filter((r): r is ReviewResult => r !== null)
      .sort((a, b) => a.round - b.round);
  } catch {
    return [];
  }
}

/** The archived patch for a completed round, or null if that round isn't in history. */
export function readHistoryPatch(id: string, round: number): string | null {
  try {
    return fs.readFileSync(path.join(historyDir(id), `round-${round}.patch`), "utf8");
  } catch {
    return null;
  }
}

/** The archived verdict for a completed round, or null if that round isn't in history. */
export function readHistoryResult(id: string, round: number): ReviewResult | null {
  return readJson<ReviewResult>(path.join(historyDir(id), `round-${round}.result.json`));
}

export function readThreads(id: string): QuestionThread[] {
  return readJson<QuestionThread[]>(threadsPath(id)) ?? [];
}

/** Only the server process may call this — the CLI posts answers over HTTP so all
 *  writes to threads.json are serialized through one event loop. */
export function writeThreads(id: string, threads: QuestionThread[]): void {
  const tmp = threadsPath(id) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(threads, null, 2));
  fs.renameSync(tmp, threadsPath(id));
}

/** Threads still waiting on the agent: not closed, and the user spoke last. */
export function openQuestions(threads: QuestionThread[]): QuestionThread[] {
  return threads.filter(
    (t) => !t.closed && t.messages.length > 0 && t.messages[t.messages.length - 1].from === "user",
  );
}

/** Validate agent replies against the round they answer. Returns an error message for the agent on bad input. */
export function validateReplies(prev: ReviewResult, raw: unknown): CommentReply[] | string {
  if (!Array.isArray(raw)) return 'replies must be a JSON array: [{ "comment": <index>, "reply": "..." }, ...]';
  const replies: CommentReply[] = [];
  const seen = new Set<number>();
  for (const r of raw as Array<Record<string, unknown>>) {
    if (!r || !Number.isInteger(r.comment) || typeof r.reply !== "string" || r.reply.trim() === "") {
      return "each reply needs: comment (0-based index into the verdict's comments array), reply (non-empty string)";
    }
    const idx = r.comment as number;
    if (idx < 0 || idx >= prev.comments.length) {
      return `reply index ${idx} is out of range — round ${prev.round} has ${prev.comments.length} comment(s)`;
    }
    if (seen.has(idx)) return `duplicate reply for comment ${idx}`;
    seen.add(idx);
    replies.push({ comment: idx, reply: r.reply.trim() });
  }
  const missing = prev.comments.flatMap((c, i) => (seen.has(i) ? [] : [`  ${i}: ${c.file}:${c.line} — ${c.body}`]));
  if (missing.length > 0) {
    return `every comment needs a reply — what you changed, or why you deliberately didn't:\n${missing.join("\n")}`;
  }
  return replies;
}

/** Validate agent answers against the open question threads. Returns an error message for the agent on bad input. */
export function validateAnswers(threads: QuestionThread[], raw: unknown): AnswerInput[] | string {
  if (!Array.isArray(raw)) return 'answers must be a JSON array: [{ "thread": <id>, "answer": "..." }, ...]';
  const byId = new Map(threads.map((t) => [t.id, t]));
  const answers: AnswerInput[] = [];
  const seen = new Set<number>();
  for (const a of raw as Array<Record<string, unknown>>) {
    if (!a || !Number.isInteger(a.thread) || typeof a.answer !== "string" || a.answer.trim() === "") {
      return "each answer needs: thread (integer id), answer (non-empty string)";
    }
    const id = a.thread as number;
    const t = byId.get(id);
    if (!t) return `unknown thread ${id}`;
    if (seen.has(id)) return `duplicate answer for thread ${id}`;
    const last = t.messages[t.messages.length - 1];
    if (!last || last.from !== "user") {
      return `thread ${id} is already answered — use the wait command if you only meant to keep waiting`;
    }
    seen.add(id);
    answers.push({ thread: id, answer: a.answer.trim() });
  }
  const missing = openQuestions(threads)
    .filter((t) => !seen.has(t.id))
    .map((t) => `  thread ${t.id}: ${t.file}:${t.line} — ${t.messages[t.messages.length - 1].body}`);
  if (missing.length > 0) return `every open question needs an answer:\n${missing.join("\n")}`;
  return answers;
}

export function writeServerInfo(id: string, info: ServerInfo): void {
  fs.writeFileSync(serverPath(id), JSON.stringify(info, null, 2));
}

export function readServerInfo(id: string): ServerInfo | null {
  return readJson<ServerInfo>(serverPath(id));
}

export function clearServerInfo(id: string): void {
  fs.rmSync(serverPath(id), { force: true });
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function liveServer(id: string): ServerInfo | null {
  const info = readServerInfo(id);
  return info && isPidAlive(info.pid) ? info : null;
}

export function stopServer(id: string): void {
  const info = readServerInfo(id);
  if (info && isPidAlive(info.pid)) {
    try {
      process.kill(info.pid);
    } catch {
      // already gone
    }
  }
  clearServerInfo(id);
}

export function listSessions(): SessionRequest[] {
  let ids: string[];
  try {
    ids = fs.readdirSync(dataRoot);
  } catch {
    return [];
  }
  const out: SessionRequest[] = [];
  for (const id of ids) {
    const r = readJson<SessionRequest>(reqPath(id));
    if (r) out.push(r);
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function waitForResult(id: string, timeoutMs: number): Promise<ReviewResult | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = readResult(id);
    if (r) return r;
    if (Date.now() >= deadline) return null;
    await new Promise((res) => setTimeout(res, 500));
  }
}

export type Outcome =
  | { kind: "verdict"; result: ReviewResult }
  | { kind: "discussion"; threads: QuestionThread[] };

/** Like waitForResult, but also returns early when the user hits "Discuss" — sending
 *  comments the agent must reply to. */
export async function waitForOutcome(id: string, timeoutMs: number): Promise<Outcome | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = readResult(id);
    if (r) return { kind: "verdict", result: r };
    const open = openQuestions(readThreads(id));
    if (open.length > 0) return { kind: "discussion", threads: open };
    if (Date.now() >= deadline) return null;
    await new Promise((res) => setTimeout(res, 500));
  }
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function isHealthy(port: number, id: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const body = (await res.json()) as { session?: string };
    return body.session === id;
  } catch {
    return false;
  }
}

/** Make sure a detached UI server is running for the session; returns its port. */
export async function ensureServer(id: string, port?: number): Promise<{ port: number; restarted: boolean }> {
  const live = liveServer(id);
  if (live && (await isHealthy(live.port, id))) return { port: live.port, restarted: false };
  // Don't kill the recorded pid here: if the health check failed, the pid may
  // belong to someone else by now. Just forget it and start fresh.
  clearServerInfo(id);

  const cliPath = fileURLToPath(new URL("../reviewer.ts", import.meta.url));
  const args = [cliPath, "serve", id, "--dir", dataRoot, ...(port ? ["--port", String(port)] : [])];
  const child = spawn(process.execPath, args, { detached: true, stdio: "ignore" });
  child.unref();

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const liveNow = liveServer(id);
    if (liveNow && (await isHealthy(liveNow.port, id))) return { port: liveNow.port, restarted: true };
    await sleep(150);
  }
  throw new Error(`the review server did not start — run \`node ${cliPath} serve ${id} --dir ${dataRoot}\` to see why`);
}
