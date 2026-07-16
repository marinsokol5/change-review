import http from "node:http";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  describeSkipped,
  filterFiles,
  revertFiles,
  serializePatch,
  totalChunks,
  validateChunkRefs,
} from "./chunks.ts";
import { contentForFile, newTotal, sliceNewRange } from "./expand.ts";
import { interdiffFiles } from "./interdiff.ts";
import { parseUnifiedDiff } from "./patch.ts";
import * as session from "./session.ts";
import type { ChunksOutcome, FileDiff, ReviewComment, ReviewResult, Verdict } from "./types.ts";

const UI_FILE = fileURLToPath(new URL("../ui/index.html", import.meta.url));

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

// Binding 127.0.0.1 alone doesn't keep malicious webpages out: DNS rebinding
// forges the Host, and POSTs without a preflight (text/plain) cross origins
// freely. So every request must carry a local Host, and a browser-sent Origin
// must be local too. The CLI's fetch and curl send no Origin and pass.
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLocalUrl(value: string): boolean {
  try {
    return LOCAL_HOSTNAMES.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

function rejectNonLocal(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const host = req.headers.host;
  if (!host || !isLocalUrl(`http://${host}`)) {
    json(res, 403, { error: "forbidden: non-local Host header" });
    return true;
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !isLocalUrl(origin)) {
    json(res, 403, { error: "forbidden: cross-origin request" });
    return true;
  }
  return false;
}

function readBody(req: http.IncomingMessage, limit = 10 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** A submitted comment may carry the id of the discussion thread it was sent to via "Discuss";
 *  the server attaches that thread's messages as the comment's `discussion` at verdict time. */
type SubmittedComment = ReviewComment & { thread?: number };

interface Submission {
  verdict: Verdict;
  summary: string;
  comments: SubmittedComment[];
  /** Chunk refs the reviewer deselected before hitting Apply; validated against the parsed patch. */
  skipped?: unknown[];
}

function validateSubmission(body: unknown): Submission | string {
  const verdicts: Verdict[] = ["approve", "request_changes", "reject"];
  if (!body || typeof body !== "object") return "body must be a JSON object";
  const b = body as Record<string, unknown>;
  if (!verdicts.includes(b.verdict as Verdict)) return `verdict must be one of: ${verdicts.join(", ")}`;
  const summary = typeof b.summary === "string" ? b.summary : "";
  if (b.skipped !== undefined && !Array.isArray(b.skipped)) return "skipped must be an array of chunk refs";
  if (Array.isArray(b.skipped) && b.verdict !== "approve") {
    return "a chunk selection only makes sense with an approve verdict";
  }
  if (!Array.isArray(b.comments)) return "comments must be an array";
  const comments: SubmittedComment[] = [];
  for (const c of b.comments as Array<Record<string, unknown>>) {
    if (
      !c ||
      typeof c.file !== "string" ||
      (c.side !== "old" && c.side !== "new") ||
      !Number.isInteger(c.line) ||
      typeof c.body !== "string" ||
      c.body.trim() === ""
    ) {
      return "each comment needs: file (string), side ('old'|'new'), line (integer), body (non-empty string)";
    }
    comments.push({
      file: c.file,
      side: c.side,
      line: c.line as number,
      body: c.body.trim(),
      ...(Number.isInteger(c.thread) && { thread: c.thread as number }),
    });
  }
  return {
    verdict: b.verdict as Verdict,
    summary,
    comments,
    ...(Array.isArray(b.skipped) && { skipped: b.skipped }),
  };
}

/** Per-file context-expansion availability for the current round: files whose real
 *  contents were found and verified against the patch, with the new-side line total
 *  (so the UI knows where EOF is). Files that don't resolve simply get no expanders. */
function expandInfo(id: string, cwd: string, files: FileDiff[]): Record<string, { total: number }> | undefined {
  const out: Record<string, { total: number }> = {};
  for (const f of files) {
    const c = contentForFile(id, cwd, f);
    if (!c) continue;
    out[f.newPath ?? f.oldPath ?? ""] = { total: newTotal(f, c) };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function listenWithFallback(server: http.Server, preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryListen = (p: number, fallback: boolean) => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (fallback && err.code === "EADDRINUSE") tryListen(0, false);
        else reject(err);
      });
      server.listen(p, "127.0.0.1", () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : p);
      });
    };
    tryListen(preferred, preferred !== 0);
  });
}

export async function runServe(id: string, portArg?: number): Promise<void> {
  const request = session.readRequest(id);
  if (!request) throw new Error(`unknown session "${id}" in ${session.dataDir()}`);
  if (session.readResult(id)) {
    console.error(`change-review: session ${id} already has a verdict for round ${request.round}`);
    return;
  }

  let shuttingDown = false;
  const finishAfterVerdict = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    setTimeout(() => {
      session.clearServerInfo(id);
      process.exit(0);
    }, 500);
  };
  const sendHtml = (res: http.ServerResponse, file: string) => {
    const html = fs.readFileSync(file);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (rejectNonLocal(req, res)) return;
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/") {
        sendHtml(res, UI_FILE);
      } else if (req.method === "GET" && (url.pathname === "/review" || url.pathname.startsWith("/round/"))) {
        // The diff UI is a single-page app; `/round/<n>` is handled client-side
        // off location.pathname, so every round URL serves the same file.
        sendHtml(res, UI_FILE);
      } else if (req.method === "GET" && url.pathname === "/api/health") {
        json(res, 200, { ok: true, session: id });
      } else if (req.method === "GET" && url.pathname === "/api/session") {
        const r = session.readRequest(id);
        if (!r) {
          json(res, 404, { error: "unknown session" });
          return;
        }
        const currentRound = r.round;
        const history = session.readHistory(id);
        const currentResult = session.readResult(id);
        // Every round, newest last, with its verdict (null = current, not yet decided) — the nav list.
        const rounds = [
          ...history.map((h) => ({ round: h.round, verdict: h.verdict, summary: h.summary })),
          { round: currentRound, verdict: currentResult?.verdict ?? null, summary: currentResult?.summary ?? "" },
        ];

        const roundParam = url.searchParams.get("round");
        const viewRound = roundParam == null ? currentRound : Number(roundParam);
        if (!Number.isInteger(viewRound) || viewRound < 1 || viewRound > currentRound) {
          json(res, 404, { error: `no such round ${roundParam}` });
          return;
        }

        // ?diffAgainst=A compares round A → the viewed round: a read-only interdiff
        // with nothing to comment on, approve or reject — purely how the change evolved.
        const againstParam = url.searchParams.get("diffAgainst");
        if (againstParam != null) {
          const against = Number(againstParam);
          if (!Number.isInteger(against) || against < 1 || against > currentRound || against === viewRound) {
            json(res, 404, { error: `cannot diff round ${viewRound} against "${againstParam}"` });
            return;
          }
          const patchFor = (n: number) =>
            n === currentRound ? session.readPatch(id) : session.readHistoryPatch(id, n);
          const pa = patchFor(against);
          const pb = patchFor(viewRound);
          if (pa == null || pb == null) {
            json(res, 404, { error: `round ${pa == null ? against : viewRound} is not available` });
            return;
          }
          json(res, 200, {
            request: r,
            round: viewRound,
            currentRound,
            diffAgainst: against,
            readOnly: true,
            rounds,
            verdict: null,
            summary: "",
            comments: [],
            files: interdiffFiles(parseUnifiedDiff(pa), parseUnifiedDiff(pb)),
            threads: [],
          });
          return;
        }

        // The current round is the live, editable one; earlier rounds are read-only
        // snapshots served from history/ (the diff, comments and replies as they were).
        let patch: string;
        let readOnly = false;
        let comments: ReviewComment[] = [];
        let verdict: Verdict | null = null;
        let summary = "";
        if (viewRound === currentRound) {
          patch = session.readPatch(id) ?? "";
        } else {
          const hp = session.readHistoryPatch(id, viewRound);
          const hr = session.readHistoryResult(id, viewRound);
          if (hp == null || !hr) {
            json(res, 404, { error: `round ${viewRound} is not available` });
            return;
          }
          patch = hp;
          readOnly = true;
          comments = hr.comments;
          verdict = hr.verdict;
          summary = hr.summary;
        }

        const files = parseUnifiedDiff(patch);
        // Only the live round offers context expansion — historical rounds may
        // predate the current file contents, so verification would mislead.
        const expand = readOnly ? undefined : expandInfo(id, r.cwd, files);
        json(res, 200, {
          request: r,
          round: viewRound,
          currentRound,
          readOnly,
          rounds,
          verdict,
          summary,
          comments,
          files,
          threads: session.readThreads(id),
          ...(expand && { expand }),
        });
      } else if (req.method === "GET" && url.pathname === "/api/expand") {
        // Context expansion: the texts of new-side lines [from, to] of one diffed
        // file, served only from contents that verify against the current round's
        // patch (see contentForFile) — wrong context would be worse than none.
        const fileParam = url.searchParams.get("file") ?? "";
        const from = Number(url.searchParams.get("from"));
        const to = Number(url.searchParams.get("to"));
        if (!fileParam || !Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to - from >= 10_000) {
          json(res, 400, { error: "expected file, from and to (1-based new-side line numbers, from <= to, at most 10000 lines)" });
          return;
        }
        const cur = session.readRequest(id) ?? request;
        const files = parseUnifiedDiff(session.readPatch(id) ?? "");
        const f = files.find((x) => (x.newPath ?? x.oldPath) === fileParam);
        if (!f) {
          json(res, 404, { error: `no such file in this round: ${fileParam}` });
          return;
        }
        const content = contentForFile(id, cur.cwd, f);
        if (!content) {
          json(res, 409, { error: "the file's contents are unavailable or no longer match the reviewed diff" });
          return;
        }
        const lines = sliceNewRange(f, content, from, to);
        if (typeof lines === "string") {
          json(res, 400, { error: lines });
          return;
        }
        json(res, 200, { lines, total: newTotal(f, content) });
      } else if (req.method === "GET" && url.pathname === "/api/threads") {
        json(res, 200, { threads: session.readThreads(id) });
      } else if (req.method === "POST" && url.pathname === "/api/questions") {
        if (session.readResult(id)) {
          json(res, 409, { error: "a verdict was already submitted for this round" });
          return;
        }
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        const items = body.items;
        if (!Array.isArray(items) || items.length === 0) {
          json(res, 400, { error: "items must be a non-empty array" });
          return;
        }
        const threads = session.readThreads(id);
        const current = session.readRequest(id) ?? request;
        const now = new Date().toISOString();
        let nextId = threads.reduce((m, t) => Math.max(m, t.id), 0) + 1;
        // Aligned to `items` order: the thread id each item created or followed up on,
        // so the UI can link a just-sent comment to its new discussion thread.
        const created: number[] = [];
        for (const it of items as Array<Record<string, unknown>>) {
          if (!it || typeof it.body !== "string" || it.body.trim() === "") {
            json(res, 400, { error: "each item needs a non-empty body" });
            return;
          }
          if (Number.isInteger(it.thread)) {
            const t = threads.find((x) => x.id === it.thread);
            if (!t) {
              json(res, 400, { error: `unknown thread ${it.thread}` });
              return;
            }
            t.messages.push({ from: "user", body: it.body.trim(), at: now });
            delete t.closed; // a follow-up reopens a closed thread
            created.push(t.id);
          } else if (typeof it.file === "string" && (it.side === "old" || it.side === "new") && Number.isInteger(it.line)) {
            const newId = nextId++;
            threads.push({
              id: newId,
              file: it.file,
              side: it.side,
              line: it.line as number,
              round: current.round,
              messages: [{ from: "user", body: it.body.trim(), at: now }],
            });
            created.push(newId);
          } else {
            json(res, 400, { error: "each item needs either thread (follow-up) or file/side/line (new comment)" });
            return;
          }
        }
        session.writeThreads(id, threads);
        json(res, 200, { ok: true, threads, created });
      } else if (req.method === "POST" && url.pathname === "/api/answer") {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        const threads = session.readThreads(id);
        const v = session.validateAnswers(threads, body.answers);
        if (typeof v === "string") {
          json(res, 400, { error: v });
          return;
        }
        const now = new Date().toISOString();
        for (const a of v) {
          const t = threads.find((x) => x.id === a.thread);
          if (t) t.messages.push({ from: "agent", body: a.answer, at: now });
        }
        session.writeThreads(id, threads);
        json(res, 200, { ok: true, threads });
      } else if (req.method === "POST" && url.pathname === "/api/close-thread") {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        const threads = session.readThreads(id);
        const t = threads.find((x) => x.id === body.thread);
        if (!t) {
          json(res, 400, { error: `unknown thread ${body.thread}` });
          return;
        }
        t.closed = true;
        session.writeThreads(id, threads);
        json(res, 200, { ok: true, threads });
      } else if (req.method === "POST" && url.pathname === "/api/submit") {
        if (session.readResult(id)) {
          json(res, 409, { error: "a verdict was already submitted for this round" });
          return;
        }
        // A discussion never blocks the verdict: the user can decide at any time,
        // whether or not an open discussion is still waiting on the agent.
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        const v = validateSubmission(body);
        if (typeof v === "string") {
          json(res, 400, { error: v });
          return;
        }
        const current = session.readRequest(id) ?? request;
        // A per-chunk selection ("Apply N of M") rides along with an approve verdict.
        // Chunk identity is (file, hunk, run) against this round's parsed patch.
        let chunks: ChunksOutcome | undefined;
        let partial: Parameters<typeof session.applyProposal>[2];
        if (v.skipped) {
          const files = parseUnifiedDiff(session.readPatch(id) ?? "");
          const validated = validateChunkRefs(files, v.skipped);
          if (typeof validated === "string") {
            json(res, 400, { error: validated });
            return;
          }
          const total = totalChunks(files);
          chunks = { total, applied: total - validated.length, skipped: describeSkipped(files, validated) };
          if (validated.length > 0) {
            partial = { files, skipped: validated };
            // The two deterministic artifacts a non-proposal agent needs to act on a
            // partial approve: the selected-only diff (base → approved subset) and the
            // diff that strips the skipped chunks out of an already-applied tree.
            fs.writeFileSync(session.appliedPatchPath(id), serializePatch(filterFiles(files, validated)));
            fs.writeFileSync(session.revertPatchPath(id), serializePatch(revertFiles(files, validated)));
            chunks.appliedPatch = session.appliedPatchPath(id);
            chunks.revertPatch = session.revertPatchPath(id);
          }
        }
        // Attach each discussed comment's thread (agent replies + follow-ups) so the
        // verdict is self-contained — the `thread` id is dropped from the output.
        const threads = session.readThreads(id);
        const comments: ReviewComment[] = v.comments.map(({ thread, ...c }) => {
          const t = thread != null ? threads.find((x) => x.id === thread) : undefined;
          return t ? { ...c, discussion: t.messages } : c;
        });
        // Approving a proposal-mode review applies the reviewed bytes to the repo
        // right here, so "approve" deterministically lands exactly what was shown —
        // filtered down to the kept chunks when the reviewer made a selection.
        const apply = v.verdict === "approve" ? session.applyProposal(id, current.cwd, partial) : undefined;
        const result: ReviewResult = {
          verdict: v.verdict,
          summary: v.summary,
          comments,
          session: id,
          round: current.round,
          submittedAt: new Date().toISOString(),
          ...(apply && { apply }),
          ...(chunks && { chunks }),
        };
        session.writeResult(id, result);
        json(res, 200, { ok: true, ...(apply && { apply }), ...(chunks && { chunks }) });
        finishAfterVerdict();
      } else if (url.pathname === "/favicon.ico") {
        res.writeHead(204);
        res.end();
      } else {
        json(res, 404, { error: "not found" });
      }
    } catch (err) {
      try {
        json(res, 500, { error: String(err) });
      } catch {
        // response already started
      }
    }
  });

  const preferred = portArg ?? session.readServerInfo(id)?.port ?? 0;
  const port = await listenWithFallback(server, preferred);
  session.writeServerInfo(id, { pid: process.pid, port, startedAt: new Date().toISOString() });
  console.error(`change-review: serving session ${id} at http://localhost:${port}/`);

  const cleanup = () => {
    session.clearServerInfo(id);
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}
