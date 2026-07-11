#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildAnnotationPatch } from "./src/annotate.ts";
import * as config from "./src/config.ts";
import { openBrowser } from "./src/open.ts";
import { buildProposalPatch } from "./src/proposal.ts";
import { runServe } from "./src/server.ts";
import * as session from "./src/session.ts";
import type { CommentReply } from "./src/types.ts";

const SELF = fileURLToPath(import.meta.url);

/** Quote a value for inclusion in a copy-pasteable shell command. */
const shq = (s: string) => (/[^\w@%+=:,./-]/.test(s) ? `'${s.replaceAll("'", `'\\''`)}'` : s);
/** The exact command an agent should run for `rest`, with the script path and data dir spelled out. */
const cli = (rest: string) => `node ${shq(SELF)} ${rest} --dir ${shq(session.dataDir())}`;

const USAGE = `change-review — human review of agent-proposed changes

Runs directly under Node >= 22.18 (native TypeScript type stripping) — no build, no install.

Every command accepts --dir <path>: the directory sessions live in (default:
<os-tmpdir>/change-review). Use the same --dir for every command of one review.

Usage:
  node reviewer.ts review [patch-file]           review a unified diff (file, stdin, or "-")
    --worktree                      review uncommitted changes (git diff <base>)
    --base <ref>                    base for --worktree (default: HEAD)
    --proposal <dir>                review a proposal dir mirroring repo-relative paths;
                                    on approve the CLI writes the reviewed files into the repo
                                    itself (verdict JSON reports it under "apply")
    --file <path>                   annotation mode (repeatable): open the file as-is — no diff —
                                    to collect line comments on existing code; the agent's changes
                                    then come back as round 2 of the same session
    -t, --title <title>             review title shown in the UI
    -s, --session <id>              reuse a session id (next round of the same review)
    --replies <file>                with --session: JSON replies to the previous round's comments,
                                    [{ "comment": <0-based index>, "reply": "..." }] — one per comment
    --timeout <secs>                max seconds to wait for a verdict (default 480, 0 = forever)
    --port <port>                   fixed port for the review server
    --no-open                       don't open the browser
  node reviewer.ts wait <session-id>             keep waiting for a pending review (restarts the UI server if needed)
    --timeout <secs> --open --no-open
  node reviewer.ts answer <session-id> <answers-file>
                                    reply to the reviewer's Discuss comments, then keep waiting;
                                    answers-file: [{ "thread": <id>, "answer": "..." }]
  node reviewer.ts result <session-id>           print the verdict or open questions if any (non-blocking)
  node reviewer.ts list                          list sessions
  node reviewer.ts serve <session-id>            run the UI server in the foreground (debugging)
  node reviewer.ts config [key] [value]          get or set config (~/.change-review/config.json); keys:
    wait-mode poll|stop             what agents do when a review outlives the CLI timeout (default
                                    stop: end the turn and let the user resume; poll: keep waiting)

Output: verdict JSON on stdout. Exit codes: 0 approve, 2 request_changes, 3 reject, 4 pending,
5 discussion — reply to each comment with the answer command, 1 error.`;

function fail(msg: string): never {
  console.error(`change-review: ${msg}`);
  process.exit(1);
}

function info(msg: string): void {
  console.error(`change-review: ${msg}`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function emitOutcome(id: string, outcome: session.Outcome | null): never {
  if (!outcome) {
    const live = session.liveServer(id);
    const url = live ? `http://localhost:${live.port}/` : undefined;
    const waitMode = config.readConfig().waitMode;
    const hint =
      waitMode === "poll"
        ? `No verdict yet. Run \`${cli(`wait ${id}`)}\` (with a long timeout) to keep waiting.`
        : `No verdict yet — STOP, do not poll. End your turn and tell the user the review is open${url ? ` at ${url}` : ""}; ` +
          `when they say they have submitted a verdict (or asked questions), run \`${cli(`result ${id}`)}\` to pick it up.`;
    console.log(
      JSON.stringify(
        { status: "pending", session: id, dir: session.dataDir(), waitMode, ...(url && { url }), hint },
        null,
        2,
      ),
    );
    process.exit(4);
  }
  if (outcome.kind === "discussion") {
    const comments = outcome.threads.map((t) => ({
      thread: t.id,
      file: t.file,
      side: t.side,
      line: t.line,
      comment: t.messages[t.messages.length - 1].body,
      ...(t.messages.length > 1 && { history: t.messages.slice(0, -1) }),
    }));
    console.log(
      JSON.stringify(
        {
          status: "discussion",
          session: id,
          dir: session.dataDir(),
          comments,
          hint:
            `The reviewer opened a discussion instead of deciding. Reply to EVERY comment — what you changed, ` +
            `or a brief ACK if you agree: write answers.json as [{ "thread": <id>, "answer": "..." }, ...] and run ` +
            `\`${cli(`answer ${id} answers.json`)}\` — it posts your replies and keeps waiting for the verdict.`,
        },
        null,
        2,
      ),
    );
    process.exit(5);
  }
  const result = outcome.result;
  console.log(JSON.stringify(result, null, 2));
  if (result.verdict === "approve") process.exit(0);
  if (result.verdict === "request_changes") process.exit(2);
  process.exit(3);
}

function parseTimeout(raw: string): number {
  const t = Number(raw);
  if (!Number.isFinite(t) || t < 0) fail(`invalid --timeout "${raw}"`);
  return t;
}

async function cmdReview(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      title: { type: "string", short: "t" },
      session: { type: "string", short: "s" },
      replies: { type: "string" },
      timeout: { type: "string", default: "480" },
      port: { type: "string" },
      worktree: { type: "boolean", default: false },
      base: { type: "string", default: "HEAD" },
      proposal: { type: "string" },
      file: { type: "string", multiple: true },
      "no-open": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (values.file?.length && (values.worktree || values.proposal || positionals[0])) {
    fail("--file (annotation mode) cannot be combined with --worktree, --proposal, or a patch file");
  }

  let patch: string;
  let defaultTitle = `Changes in ${path.basename(process.cwd())}`;
  let proposalFiles: Array<{ rel: string; src: string }> | undefined;
  if (values.worktree) {
    const r = spawnSync("git", ["diff", "--no-color", values.base], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    if (r.error || r.status !== 0) fail(`git diff failed: ${(r.error?.message ?? r.stderr ?? "").trim()}`);
    patch = r.stdout;
  } else if (values.proposal) {
    const built = buildProposalPatch(path.resolve(values.proposal), process.cwd());
    patch = built.patch;
    proposalFiles = built.files;
  } else if (values.file?.length) {
    const annot = buildAnnotationPatch(values.file, process.cwd());
    patch = annot.patch;
    defaultTitle = annot.files.length === 1 ? `Annotate ${annot.files[0]}` : `Annotate ${annot.files.length} files`;
  } else if (positionals[0] && positionals[0] !== "-") {
    try {
      patch = fs.readFileSync(positionals[0], "utf8");
    } catch {
      fail(`cannot read patch file: ${positionals[0]}`);
    }
  } else if (positionals[0] === "-" || !process.stdin.isTTY) {
    patch = await readStdin();
  } else {
    fail(`no diff given — pass a patch file, pipe a diff on stdin, or use --worktree / --proposal <dir>\n\n${USAGE}`);
  }
  if (!patch.trim()) {
    fail("the diff is empty — nothing to review (for --worktree, untracked files need `git add -N` first)");
  }

  let replies: CommentReply[] | undefined;
  if (values.replies) {
    if (!values.session) fail("--replies requires --session — replies answer the previous round's comments");
    if (!session.readRequest(values.session)) fail(`unknown session "${values.session}" in ${session.dataDir()}`);
    const prev = session.readResult(values.session);
    if (!prev) fail(`session ${values.session} has no submitted verdict to reply to`);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(values.replies, "utf8"));
    } catch {
      fail(`cannot read replies file as JSON: ${values.replies}`);
    }
    const v = session.validateReplies(prev, raw);
    if (typeof v === "string") fail(v);
    replies = v;
  }

  const req = session.createSession({
    id: values.session,
    title: values.title ?? defaultTitle,
    patch,
    cwd: process.cwd(),
    replies,
  });
  if (proposalFiles) session.stageProposal(req.id, process.cwd(), proposalFiles);

  const { port } = await session.ensureServer(req.id, values.port ? Number(values.port) : undefined);
  const url = `http://localhost:${port}/`;
  info(`session ${req.id} round ${req.round} — review at ${url}`);
  if (!values["no-open"]) openBrowser(url);

  const t = parseTimeout(values.timeout);
  emitOutcome(req.id, await session.waitForOutcome(req.id, t > 0 ? t * 1000 : Infinity));
}

async function cmdWait(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      timeout: { type: "string", default: "480" },
      port: { type: "string" },
      open: { type: "boolean", default: false },
      "no-open": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const id = positionals[0];
  if (!id) fail("usage: node reviewer.ts wait <session-id>");
  if (!session.readRequest(id)) fail(`unknown session "${id}" in ${session.dataDir()}`);

  const existing = session.readResult(id);
  if (existing) emitOutcome(id, { kind: "verdict", result: existing });

  const { port, restarted } = await session.ensureServer(id, values.port ? Number(values.port) : undefined);
  const url = `http://localhost:${port}/`;
  info(`waiting on session ${id} — review at ${url}`);
  if (!values["no-open"] && (values.open || restarted)) openBrowser(url);

  const t = parseTimeout(values.timeout);
  emitOutcome(id, await session.waitForOutcome(id, t > 0 ? t * 1000 : Infinity));
}

function cmdResult(args: string[]): void {
  const id = args[0];
  if (!id) fail("usage: node reviewer.ts result <session-id>");
  if (!session.readRequest(id)) fail(`unknown session "${id}" in ${session.dataDir()}`);
  const result = session.readResult(id);
  if (result) emitOutcome(id, { kind: "verdict", result });
  const open = session.openQuestions(session.readThreads(id));
  emitOutcome(id, open.length > 0 ? { kind: "discussion", threads: open } : null);
}

async function cmdAnswer(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      timeout: { type: "string", default: "480" },
      port: { type: "string" },
      open: { type: "boolean", default: false },
      "no-open": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const [id, file] = positionals;
  if (!id || !file) fail("usage: node reviewer.ts answer <session-id> <answers-file>");
  if (!session.readRequest(id)) fail(`unknown session "${id}" in ${session.dataDir()}`);

  const existing = session.readResult(id);
  if (existing) emitOutcome(id, { kind: "verdict", result: existing });

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail(`cannot read answers file as JSON: ${file}`);
  }
  // Pre-validate for a fast, local error; the server re-validates atomically on POST.
  const v = session.validateAnswers(session.readThreads(id), raw);
  if (typeof v === "string") fail(v);

  const { port, restarted } = await session.ensureServer(id, values.port ? Number(values.port) : undefined);
  const url = `http://localhost:${port}/`;
  const res = await fetch(`http://127.0.0.1:${port}/api/answer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers: raw }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    fail(body.error ?? `posting answers failed (HTTP ${res.status})`);
  }
  info(`answers posted — waiting on session ${id} at ${url}`);
  if (!values["no-open"] && (values.open || restarted)) openBrowser(url);

  const t = parseTimeout(values.timeout);
  emitOutcome(id, await session.waitForOutcome(id, t > 0 ? t * 1000 : Infinity));
}

async function cmdServe(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: { port: { type: "string" } },
    allowPositionals: true,
  });
  const id = positionals[0];
  if (!id) fail("usage: node reviewer.ts serve <session-id>");
  await runServe(id, values.port ? Number(values.port) : undefined);
}

function cmdList(): void {
  const sessions = session.listSessions();
  if (sessions.length === 0) {
    info(`no sessions in ${session.dataDir()}`);
    return;
  }
  for (const s of sessions) {
    const res = session.readResult(s.id);
    const live = session.liveServer(s.id);
    const open = session.openQuestions(session.readThreads(s.id));
    const status = res
      ? `${res.verdict} (${res.comments.length} comments)`
      : open.length > 0
        ? `${open.length} comment${open.length === 1 ? "" : "s"} to discuss — reply via \`answer ${s.id} …\``
        : live
          ? `pending — http://localhost:${live.port}/`
          : "pending — no server";
    console.log(`${s.id}  round ${s.round}  [${status}]  ${s.title}`);
  }
}

function cmdConfig(args: string[]): void {
  const [key, value] = args;
  const cfg = config.readConfig();
  if (!key) {
    console.log(JSON.stringify({ "wait-mode": cfg.waitMode }, null, 2));
    return;
  }
  if (key === "wait-mode") {
    if (value === undefined) { console.log(cfg.waitMode); return; }
    if (value !== "poll" && value !== "stop") fail(`wait-mode must be "poll" or "stop", got "${value}"`);
    config.writeConfig({ ...cfg, waitMode: value });
    console.log(`wait-mode = ${value}`);
    return;
  }
  fail(`unknown config key "${key}" (known keys: wait-mode)`);
}

/** Pull the global --dir option out of the argv so per-command parseArgs never sees it. */
function extractDir(argv: string[]): { args: string[]; dir?: string } {
  const args: string[] = [];
  let dir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") {
      dir = argv[++i];
      if (dir === undefined) fail("--dir needs a path");
    } else if (a.startsWith("--dir=")) {
      dir = a.slice("--dir=".length);
    } else {
      args.push(a);
    }
  }
  return { args, dir };
}

async function main(): Promise<void> {
  const { args, dir } = extractDir(process.argv.slice(2));
  if (dir) session.setDataDir(path.resolve(dir));
  const [cmd, ...rest] = args;
  switch (cmd) {
    case "review":
      return cmdReview(rest);
    case "wait":
      return cmdWait(rest);
    case "answer":
      return cmdAnswer(rest);
    case "result":
      return cmdResult(rest);
    case "serve":
      return cmdServe(rest);
    case "list":
      return cmdList();
    case "config":
      return cmdConfig(rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    default:
      fail(`unknown command "${cmd}"\n\n${USAGE}`);
  }
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
