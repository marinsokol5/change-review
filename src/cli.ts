#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import * as config from "./config.js";
import * as hook from "./hook.js";
import { openBrowser } from "./open.js";
import { buildProposalPatch } from "./proposal.js";
import { runServe } from "./server.js";
import * as session from "./session.js";
import type { CommentReply } from "./types.js";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));

const USAGE = `agent-change-reviewer — human review of agent-proposed changes

Usage:
  agent-change-reviewer review [patch-file]      review a unified diff (file, stdin, or "-")
    --worktree                      review uncommitted changes (git diff <base>)
    --base <ref>                    base for --worktree (default: HEAD)
    --proposal <dir>                review a proposal dir mirroring repo-relative paths;
                                    on approve the CLI writes the reviewed files into the repo
                                    itself (verdict JSON reports it under "apply")
    -t, --title <title>             review title shown in the UI
    -s, --session <id>              reuse a session id (next round of the same review)
    --replies <file>                with --session: JSON replies to the previous round's comments,
                                    [{ "comment": <0-based index>, "reply": "..." }] — one per comment
    --timeout <secs>                max seconds to wait for a verdict (default 480, 0 = forever)
    --port <port>                   fixed port for the review server
    --no-open                       don't open the browser
  agent-change-reviewer wait <session-id>        keep waiting for a pending review (restarts the UI server if needed)
    --timeout <secs> --open --no-open
  agent-change-reviewer answer <session-id> <answers-file>
                                    reply to the reviewer's Discuss comments, then keep waiting;
                                    answers-file: [{ "thread": <id>, "answer": "..." }]
  agent-change-reviewer result <session-id>      print the verdict or open questions if any (non-blocking)
  agent-change-reviewer list                     list sessions
  agent-change-reviewer serve <session-id>       run the UI server in the foreground (debugging)
  agent-change-reviewer install claude|codex     install the change-review skill to ~/.claude/skills or ~/.codex/skills
                                    (claude: also allowlists proposal staging under /tmp/change-review
                                    in ~/.claude/settings.json so review staging never prompts)
  agent-change-reviewer hook install claude|codex    register the PreToolUse hook (~/.claude/settings.json or ~/.codex/hooks.json)
  agent-change-reviewer hook uninstall claude|codex  remove it again
  agent-change-reviewer hook on|off|status       review mode: intercept the agent's file edits (Claude Code Edit/Write,
                                    Codex apply_patch) with an allow / allow-session / review / reject menu
  agent-change-reviewer hook-run                 (internal) the hook entry point agents invoke
  agent-change-reviewer config [key] [value]     get or set config; keys:
    wait-mode poll|stop             what agents do when a review outlives the CLI timeout (default
                                    stop: end the turn and let the user resume; poll: keep waiting)

Output: verdict JSON on stdout. Exit codes: 0 approve, 2 request_changes, 3 reject, 4 pending,
5 discussion — reply to each comment with \`agent-change-reviewer answer\`, 1 error.`;

function fail(msg: string): never {
  console.error(`agent-change-reviewer: ${msg}`);
  process.exit(1);
}

function info(msg: string): void {
  console.error(`agent-change-reviewer: ${msg}`);
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
        ? `No verdict yet. Run \`agent-change-reviewer wait ${id}\` (with a long timeout) to keep waiting.`
        : `No verdict yet — STOP, do not poll. End your turn and tell the user the review is open${url ? ` at ${url}` : ""}; ` +
          `when they say they have submitted a verdict (or asked questions), run \`agent-change-reviewer result ${id}\` to pick it up.`;
    console.log(
      JSON.stringify({ status: "pending", session: id, waitMode, ...(url && { url }), hint }, null, 2),
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
          comments,
          hint:
            `The reviewer opened a discussion instead of deciding. Reply to EVERY comment — what you changed, ` +
            `or a brief ACK if you agree: write answers.json as [{ "thread": <id>, "answer": "..." }, ...] and run ` +
            `\`agent-change-reviewer answer ${id} answers.json\` — it posts your replies and keeps waiting for the verdict.`,
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
      "no-open": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  let patch: string;
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
    if (!session.readRequest(values.session)) fail(`unknown session "${values.session}"`);
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
    title: values.title ?? `Changes in ${path.basename(process.cwd())}`,
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
  if (!id) fail("usage: agent-change-reviewer wait <session-id>");
  if (!session.readRequest(id)) fail(`unknown session "${id}"`);

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
  if (!id) fail("usage: agent-change-reviewer result <session-id>");
  if (!session.readRequest(id)) fail(`unknown session "${id}"`);
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
  if (!id || !file) fail("usage: agent-change-reviewer answer <session-id> <answers-file>");
  if (!session.readRequest(id)) fail(`unknown session "${id}"`);

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
  if (!id) fail("usage: agent-change-reviewer serve <session-id>");
  await runServe(id, values.port ? Number(values.port) : undefined);
}

function cmdList(): void {
  const sessions = session.listSessions();
  if (sessions.length === 0) {
    info("no sessions");
    return;
  }
  for (const s of sessions) {
    const res = session.readResult(s.id);
    const live = session.liveServer(s.id);
    const open = session.openQuestions(session.readThreads(s.id));
    const status = res
      ? `${res.verdict} (${res.comments.length} comments)`
      : open.length > 0
        ? `${open.length} comment${open.length === 1 ? "" : "s"} to discuss — \`agent-change-reviewer answer ${s.id} …\``
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
    console.log(JSON.stringify({ "wait-mode": cfg.waitMode, "review-prefix": cfg.reviewPrefix ?? null }, null, 2));
    return;
  }
  if (key === "wait-mode") {
    if (value === undefined) { console.log(cfg.waitMode); return; }
    if (value !== "poll" && value !== "stop") fail(`wait-mode must be "poll" or "stop", got "${value}"`);
    config.writeConfig({ ...cfg, waitMode: value });
    console.log(`wait-mode = ${value}`);
    return;
  }
  if (key === "review-prefix") {
    if (value === undefined) { console.log(cfg.reviewPrefix ?? "(not set)"); return; }
    const prefix = value === "" ? undefined : value;
    config.writeConfig({ ...cfg, reviewPrefix: prefix });
    console.log(prefix ? `review-prefix = ${prefix}` : "review-prefix cleared");
    return;
  }
  fail(`unknown config key "${key}" (known keys: wait-mode, review-prefix)`);
}

function hookTarget(raw: string | undefined): hook.HookTarget {
  if (raw !== "claude" && raw !== "codex") fail("usage: agent-change-reviewer hook install|uninstall <claude|codex>");
  return raw;
}

function cmdHook(args: string[]): void {
  const sub = args[0];
  const cfg = config.readConfig();
  switch (sub) {
    case "install": {
      const target = hookTarget(args[1]);
      console.log(hook.installHook(target));
      console.log(
        target === "claude"
          ? "Restart Claude Code (or run /hooks) so it picks the hook up, then arm it with `agent-change-reviewer hook on`."
          : "Restart Codex so it picks the hook up, then arm it with `agent-change-reviewer hook on`.",
      );
      return;
    }
    case "uninstall":
      console.log(hook.uninstallHook(hookTarget(args[1])));
      return;
    case "on":
      config.writeConfig({ ...cfg, hookEnabled: true });
      console.log("review mode ON — agent file edits now open the review menu in your browser");
      if (!hook.isHookInstalled("claude") && !hook.isHookInstalled("codex")) {
        console.log("note: no hook is registered yet — run `agent-change-reviewer hook install claude` (and/or codex) first.");
      }
      return;
    case "off": {
      config.writeConfig({ ...cfg, hookEnabled: false });
      const n = hook.clearAlwaysFlags();
      console.log(`review mode OFF${n ? ` (cleared ${n} session allow-flag${n === 1 ? "" : "s"})` : ""}`);
      return;
    }
    case "status":
      console.log(`claude hook installed: ${hook.isHookInstalled("claude") ? "yes" : "no (agent-change-reviewer hook install claude)"}`);
      console.log(`codex hook installed:  ${hook.isHookInstalled("codex") ? "yes" : "no (agent-change-reviewer hook install codex)"}`);
      console.log(`review mode: ${cfg.hookEnabled ? "on" : "off"}`);
      if (cfg.reviewPrefix) console.log(`review prefix: "${cfg.reviewPrefix}"`);
      return;
    default:
      fail("usage: agent-change-reviewer hook <install|uninstall|on|off|status>");
  }
}

/** Where SKILL.md tells agents to stage proposal-mode files — keep the two in sync. */
const PROPOSAL_STAGING_DIR = "/tmp/change-review";
// "//" is Claude Code's absolute-path permission syntax; the /private twin covers
// macOS canonicalizing the /tmp symlink before rules are matched.
const PROPOSAL_ALLOW_RULES = ["Read", "Edit", "Write"].flatMap((tool) => [
  `${tool}(/${PROPOSAL_STAGING_DIR}/**)`,
  `${tool}(//private${PROPOSAL_STAGING_DIR}/**)`,
]);

/** Pre-approve agent file writes under the proposal staging dir so review staging never prompts. */
function allowProposalDir(): void {
  const file = path.join(os.homedir(), ".claude", "settings.json");
  const settings = hook.readJsonSettings(file);
  const permissions = (settings.permissions ??= {}) as { allow?: string[] };
  const allow = (permissions.allow ??= []);
  const missing = PROPOSAL_ALLOW_RULES.filter((rule) => !allow.includes(rule));
  if (missing.length === 0) {
    console.log(`Proposal staging dir ${PROPOSAL_STAGING_DIR}/ is already allowlisted in ${file}`);
    return;
  }
  allow.push(...missing);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  console.log(`Allowlisted agent file writes under ${PROPOSAL_STAGING_DIR}/ in ${file}`);
}

function cmdInstall(args: string[]): void {
  const target = args[0];
  if (target !== "claude" && target !== "codex") fail("usage: agent-change-reviewer install <claude|codex>");
  const src = path.join(PKG_ROOT, "skill", "change-review");
  const dest = path.join(os.homedir(), target === "claude" ? ".claude" : ".codex", "skills", "change-review");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  console.log(`Installed skill to ${dest}`);
  if (target === "claude") allowProposalDir();
  else console.log(`(Codex's workspace-write sandbox already allows ${PROPOSAL_STAGING_DIR}/ — nothing to allowlist.)`);
  console.log(`Restart your ${target === "claude" ? "Claude Code" : "Codex"} session so it picks up the new skill.`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
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
    case "install":
      return cmdInstall(rest);
    case "hook":
      return cmdHook(rest);
    case "hook-run":
      return hook.runHook();
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
