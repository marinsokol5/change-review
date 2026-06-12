import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyPatchChanges } from "./applypatch.js";
import * as config from "./config.js";
import { openBrowser } from "./open.js";
import { relabel } from "./proposal.js";
import * as session from "./session.js";
import type { ReviewResult } from "./types.js";

export const ALWAYS_DIR = path.join(os.homedir(), ".reviewer", "always-allow");
const HOOK_COMMAND = "agent-change-reviewer hook-run";
/** The agent kills the hook after the configured timeout; decide a bit earlier so we can still answer. */
const INSTALL_TIMEOUT_SECS = 600;
const WAIT_MS = (INSTALL_TIMEOUT_SECS - 30) * 1000;
const ALWAYS_FLAG_TTL_MS = 7 * 24 * 3600 * 1000;

export type HookTarget = "claude" | "codex";

const TARGETS: Record<HookTarget, { file: string; matcher: string; label: string }> = {
  // Claude Code: Edit/Write tool calls, structured tool_input.
  claude: {
    file: path.join(os.homedir(), ".claude", "settings.json"),
    matcher: "Edit|Write",
    label: "Claude Code",
  },
  // Codex: file edits arrive as tool_name "apply_patch" with the raw V4A patch in tool_input.command.
  codex: {
    file: path.join(os.homedir(), ".codex", "hooks.json"),
    matcher: "^apply_patch$",
    label: "Codex",
  },
};

// --- PreToolUse stdin payload ----------------------------------------------

interface HookInput {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: {
    file_path?: string;
    content?: string;
    old_string?: string;
    new_string?: string;
    replace_all?: boolean;
    /** apply_patch (Codex): the raw "*** Begin Patch" envelope. */
    command?: string;
  };
}

type Decision =
  | { action: "allow"; reason: string }
  | { action: "deny"; reason: string }
  | { action: "ask"; reason: string }
  | { action: "pass" }; // no opinion — exit silently, normal permission flow applies

function emit(d: Decision): never {
  if (d.action !== "pass") {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: d.action,
          permissionDecisionReason: d.reason,
        },
      }),
    );
  }
  process.exit(0);
}

// --- "Allow all edits this session" flags ----------------------------------

function alwaysFlagPath(agentSession: string): string {
  return path.join(ALWAYS_DIR, agentSession.replace(/[^\w.-]/g, "_"));
}

export function writeAlwaysFlag(agentSession: string): void {
  fs.mkdirSync(ALWAYS_DIR, { recursive: true });
  fs.writeFileSync(alwaysFlagPath(agentSession), new Date().toISOString());
  pruneAlwaysFlags();
}

function hasAlwaysFlag(agentSession: string): boolean {
  try {
    return Date.now() - fs.statSync(alwaysFlagPath(agentSession)).mtimeMs < ALWAYS_FLAG_TTL_MS;
  } catch {
    return false;
  }
}

export function clearAlwaysFlags(): number {
  try {
    const files = fs.readdirSync(ALWAYS_DIR);
    for (const f of files) fs.rmSync(path.join(ALWAYS_DIR, f), { force: true });
    return files.length;
  } catch {
    return 0;
  }
}

function pruneAlwaysFlags(): void {
  try {
    for (const f of fs.readdirSync(ALWAYS_DIR)) {
      const p = path.join(ALWAYS_DIR, f);
      if (Date.now() - fs.statSync(p).mtimeMs > ALWAYS_FLAG_TTL_MS) fs.rmSync(p, { force: true });
    }
  } catch {
    // best-effort housekeeping
  }
}

// --- Building the patch from the intercepted tool call ----------------------

/** Mirrors the Edit tool's own rules; returns null when the tool call would fail anyway. */
function applyEdit(content: string, oldStr: string, newStr: string, replaceAll: boolean): string | null {
  if (oldStr === "" || oldStr === newStr) return null;
  const count = content.split(oldStr).length - 1;
  if (count === 0 || (count > 1 && !replaceAll)) return null;
  return replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, () => newStr);
}

function diffStrings(rel: string, oldText: string | null, newText: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-hook-"));
  try {
    let oldPath = "/dev/null";
    if (oldText != null) {
      oldPath = path.join(dir, "old");
      fs.writeFileSync(oldPath, oldText);
    }
    let newPath = "/dev/null";
    if (newText != null) {
      newPath = path.join(dir, "new");
      fs.writeFileSync(newPath, newText);
    }
    const r = spawnSync("git", ["diff", "--no-index", "--no-color", "--", oldPath, newPath], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    if (r.error) throw new Error(`git diff --no-index failed: ${r.error.message}`);
    if (r.status === 0) return ""; // identical
    if (r.status !== 1 || !r.stdout) throw new Error(`git diff --no-index failed: ${r.stderr}`);
    return relabel(r.stdout, rel);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** apply_patch (Codex): apply the V4A envelope in memory and diff every touched file. */
function buildApplyPatchDiff(input: HookInput): { patch: string; rel: string } | null {
  const envelope = input.tool_input?.command;
  if (typeof envelope !== "string") return null;
  const changes = applyPatchChanges(envelope, input.cwd ?? process.cwd());
  if (!changes) return null; // malformed or context mismatch — apply_patch itself will surface that
  const chunks = changes
    .map((c) => diffStrings(c.rel, c.oldText, c.newText))
    .filter((c) => c !== "");
  if (chunks.length === 0) return null;
  return { patch: chunks.join(""), rel: changes.length === 1 ? changes[0].rel : `${changes.length} files` };
}

/** Returns the unified diff for the proposed edit, or null when there is nothing to gate. */
function buildToolPatch(input: HookInput): { patch: string; rel: string } | null {
  const tool = input.tool_name;
  const t = input.tool_input;
  if (tool === "apply_patch") return buildApplyPatchDiff(input);
  if ((tool !== "Edit" && tool !== "Write") || !t?.file_path) return null;
  const abs = path.resolve(input.cwd ?? process.cwd(), t.file_path);
  const rel = (() => {
    const r = path.relative(input.cwd ?? process.cwd(), abs);
    return r.startsWith("..") ? abs.replace(/^[/\\]+/, "") : r.split(path.sep).join("/");
  })();

  let oldText: string | null = null;
  try {
    oldText = fs.readFileSync(abs, "utf8");
  } catch {
    oldText = null; // new file (or unreadable — the tool itself will surface that)
  }

  let newText: string;
  if (tool === "Write") {
    if (typeof t.content !== "string") return null;
    newText = t.content;
  } else {
    if (oldText == null || typeof t.old_string !== "string" || typeof t.new_string !== "string") return null;
    const applied = applyEdit(oldText, t.old_string, t.new_string, t.replace_all === true);
    if (applied == null) return null; // the Edit call will fail on its own; nothing to review
    newText = applied;
  }

  const patch = diffStrings(rel, oldText, newText);
  return patch ? { patch, rel } : null;
}

// --- Turning the verdict into a hook decision -------------------------------

function formatVerdict(r: ReviewResult): Decision {
  const lines: string[] = [];
  if (r.summary) lines.push(r.summary);
  for (const c of r.comments) lines.push(`- ${c.file}:${c.line} (${c.side} side): ${c.body}`);

  if (r.verdict === "approve") {
    return { action: "allow", reason: r.summary || "Approved by the human reviewer." };
  }
  if (r.verdict === "request_changes") {
    lines.unshift("The human reviewer requested changes to this edit:");
    lines.push("Apply the feedback, then retry the edit — the new version will be re-reviewed.");
    return { action: "deny", reason: lines.join("\n") };
  }
  lines.unshift("The human reviewer rejected this edit — do not re-apply it as written.");
  if (!r.summary && r.comments.length === 0) {
    lines.push("No reason was given; ask the user how to proceed.");
  }
  return { action: "deny", reason: lines.join("\n") };
}

// --- The hook entry point (agent-change-reviewer hook-run) -------------------------------

export async function runHook(): Promise<never> {
  let input: HookInput;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as HookInput;
  } catch {
    emit({ action: "pass" });
  }

  if (!config.readConfig().hookEnabled) emit({ action: "pass" });
  if (input.session_id && hasAlwaysFlag(input.session_id)) {
    emit({ action: "allow", reason: "agent-change-reviewer: all edits allowed for this session by the human reviewer" });
  }

  let built: { patch: string; rel: string } | null;
  try {
    built = buildToolPatch(input);
  } catch (err) {
    console.error(`agent-change-reviewer hook: could not diff the edit (${err instanceof Error ? err.message : err})`);
    emit({ action: "pass" });
  }
  if (!built) emit({ action: "pass" });

  const req = session.createSession({
    title: `${input.tool_name} ${built.rel}`,
    patch: built.patch,
    cwd: input.cwd ?? process.cwd(),
    kind: "hook",
    meta: { tool: input.tool_name!, file: built.rel },
  });

  let result: ReviewResult | null = null;
  try {
    const { port } = await session.ensureServer(req.id);
    console.error(`agent-change-reviewer hook: session ${req.id} — review at http://localhost:${port}/`);
    openBrowser(`http://localhost:${port}/`);
    result = await session.waitForResult(req.id, WAIT_MS);
  } catch (err) {
    console.error(`agent-change-reviewer hook: ${err instanceof Error ? err.message : err}`);
    emit({ action: "pass" });
  }

  if (!result) {
    session.stopServer(req.id); // a decision clicked after this point would go nowhere
    const mins = Math.round(WAIT_MS / 60000);
    // Claude Code can fall back to its native permission prompt; Codex has no "ask",
    // so the safe default in review mode is to keep the gate closed.
    if (input.tool_name === "apply_patch") {
      emit({
        action: "deny",
        reason:
          `The human review timed out after ${mins} minutes with no decision. ` +
          `Retry the edit to request a new review, or ask the user to disable review mode (agent-change-reviewer hook off).`,
      });
    }
    emit({
      action: "ask",
      reason: `agent-change-reviewer: no decision within ${mins} minutes (session ${req.id}) — falling back to the built-in prompt`,
    });
  }
  if (result.decision === "accept_session" && input.session_id) writeAlwaysFlag(input.session_id);
  emit(formatVerdict(result));
}

// --- Install / status (agent-change-reviewer hook ...) -----------------------------------

interface HookEntry {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
}

export function readJsonSettings(file: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`${file} exists but is not valid JSON — fix it first, nothing was changed`);
  }
}

function entryIsOurs(e: HookEntry): boolean {
  return (e.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes(HOOK_COMMAND));
}

export function isHookInstalled(target: HookTarget): boolean {
  try {
    const settings = readJsonSettings(TARGETS[target].file);
    const pre = (settings.hooks as Record<string, HookEntry[]> | undefined)?.PreToolUse ?? [];
    return pre.some(entryIsOurs);
  } catch {
    return false;
  }
}

export function installHook(target: HookTarget): string {
  const { file, matcher, label } = TARGETS[target];
  const settings = readJsonSettings(file);
  const hooks = (settings.hooks ?? {}) as Record<string, HookEntry[]>;
  settings.hooks = hooks;
  const pre = (hooks.PreToolUse ??= []);
  if (pre.some(entryIsOurs)) return `already installed in ${file}`;
  pre.push({
    matcher,
    hooks: [{ type: "command", command: HOOK_COMMAND, timeout: INSTALL_TIMEOUT_SECS }],
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  return `installed the ${label} PreToolUse hook (${matcher}) in ${file}`;
}

export function uninstallHook(target: HookTarget): string {
  const { file, label } = TARGETS[target];
  const settings = readJsonSettings(file);
  const hooks = settings.hooks as Record<string, HookEntry[]> | undefined;
  const pre = hooks?.PreToolUse;
  if (!pre?.some(entryIsOurs)) return `not installed in ${file}`;
  hooks!.PreToolUse = pre.filter((e) => !entryIsOurs(e));
  if (hooks!.PreToolUse.length === 0) delete hooks!.PreToolUse;
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
  return `removed the ${label} PreToolUse hook from ${file}`;
}
