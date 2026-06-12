# Developing agent-change-reviewer

Instructions for working **on this codebase** — written for coding agents, useful for humans too. (The instructions for *using* the tool live in `skill/change-review/SKILL.md`, which `agent-change-reviewer install` copies into the user's `~/.claude/skills/` or `~/.codex/skills/`.)

## What this is

A zero-runtime-dependency Node CLI that lets an AI agent request human review of a diff: the CLI serves a single-file diff UI on localhost, the human leaves line comments and a verdict in the browser, and the verdict comes back to the agent as JSON on stdout with a meaningful exit code. See [README.md](README.md) for the user-facing story.

## Setup

```bash
npm install     # installs dev deps and builds (the prepare script runs tsc)
npm link        # puts `agent-change-reviewer` on PATH, pointing at this checkout
npm run demo    # smoke test: opens examples/demo.patch in the browser
```

- Node >= 18, ESM throughout, TypeScript as the only (dev) dependency.
- `npm run build` = `tsc` (src/ → dist/), `npm run dev` = `tsc --watch`.
- Because of `npm link`, the global `agent-change-reviewer` command runs `bin/agent-change-reviewer.js → dist/cli.js` from this checkout. So: **TypeScript changes need `npm run build` to take effect**; `ui/index.html` is read from disk on every request, so UI changes just need a page reload (or a new session if the old server already exited).

## Repo layout

| path | role |
|---|---|
| `src/cli.ts` | arg parsing + all commands (`review`, `wait`, `result`, `list`, `serve`, `install`); spawns the detached server; turns the result into stdout JSON + exit code |
| `src/session.ts` | session store under `~/.reviewer/sessions/<id>/` — request.json, patch.diff, result.json, server.json, threads.json (question threads), history/ per round, proposal/ + apply.json (staged proposal bytes + sha256 manifest for deterministic apply); outcome polling (verdict or open questions); reply/answer validation |
| `src/config.ts` | user config at `~/.reviewer/config.json`; currently one key, `waitMode` (`"stop"` default \| `"poll"`), surfaced as `agent-change-reviewer config wait-mode` |
| `src/server.ts` | localhost HTTP server — serves the UI, `GET /api/session` (parsed diff + history + threads), `POST /api/submit` (validates, 409 while questions are open, applies a staged proposal on approve, writes result.json, exits ~500 ms later), `POST /api/questions`/`/api/answer`/`/api/close-thread` (question threads) |
| `src/patch.ts` | unified-diff parser (git and plain diffs, renames, binary, `\ No newline`, content lines that look like headers). Most edge-case-prone code in the repo; still untested |
| `src/proposal.ts` | builds a patch from a proposal dir via `git diff --no-index`, relabelling temp paths to repo-relative ones; also returns the list of changed files so `cmdReview` can stage them for apply |
| `src/open.ts` | best-effort cross-platform browser open |
| `ui/index.html` | the entire frontend in one self-contained file — no build step, no CDN, drafts persisted in localStorage |
| `bin/agent-change-reviewer.js` | two-line shim importing `dist/cli.js` |
| `skill/change-review/` | the skill `agent-change-reviewer install claude\|codex` copies to `~/.claude/skills/` or `~/.codex/skills/` — documents the user-facing contract |

## How a review flows internally

1. `cmdReview` obtains a patch (from `git diff`, a proposal dir, a file, or stdin) and calls `session.createSession`. Reusing an id (`--session`) bumps `round`, archives the previous round's patch/result into `history/`, clears any staged proposal, and kills any stale server. With `--replies`, each agent reply is validated against the previous round's comments (one per comment, enforced) and merged into the archived result as `comments[].reply` — that's what the UI threads in the history panel. In proposal mode, `session.stageProposal` then snapshots the changed files' proposed bytes into `proposal/` and writes `apply.json` (base + proposed sha256 per file), so the approve-time apply doesn't depend on the agent's temp dir still existing.
2. `ensureServer` health-checks `server.json`'s pid/port (`GET /api/health` must echo the session id); if dead, it spawns `agent-change-reviewer serve <id>` **detached** and waits for it to come up.
3. The CLI opens the browser, then polls `result.json` *and* `threads.json` every 500 ms via `session.waitForOutcome`.
4. Instead of a verdict, the user can send clarifying **question threads** (`POST /api/questions` → `threads.json`). The waiting CLI returns early with exit 5 and the open questions on stdout; the agent posts answers with `agent-change-reviewer answer <id> answers.json` (validated all-or-nothing, then `POST /api/answer`) and goes back to waiting. A user follow-up reopens its thread; open questions lock `/api/submit` with a 409 (the UI also disables the verdict buttons).
5. The UI submits to `/api/submit`; the server validates, and on an approve of a proposal session first runs `session.applyProposal` — writing the staged bytes into the session's `cwd`, all-or-nothing: if any file's current contents match neither the reviewed base hash nor the proposed hash (it drifted mid-review), nothing is written and the conflicts are reported. The outcome lands in the result as `apply` (`{ applied, wrote, conflicts?, error? }`). Then it writes `result.json` atomically (tmp + rename) and exits shortly after.
6. The CLI prints the result and exits 0/2/3 — or, if its `--timeout` fired first, prints a pending JSON and exits 4. The detached server keeps running, so the review can be picked up later. What the pending JSON's `hint` tells the agent depends on the configured `wait-mode`: `stop` (default) = end the turn and let the user resume (`agent-change-reviewer result <id>` picks up the verdict — or the open questions), `poll` = keep re-running `agent-change-reviewer wait <id>`.

## Invariants — don't break these

1. **stdout is machine-readable only.** Verdict/pending JSON is the sole stdout output; all human-facing messages go to stderr via `info()`/`fail()`. Agents parse stdout.
2. **Exit codes are API:** 0 approve, 2 request_changes, 3 reject, 4 pending, 5 questions for the agent, 1 error.
3. **The server must outlive the CLI.** Agents run commands with timeouts; the review survives because the server is detached and the verdict lives on disk. Never tie a verdict's fate to the spawning process.
4. **No runtime dependencies, single-file UI, binds 127.0.0.1 only.** The server also rejects requests with a non-local `Host` or `Origin` header (DNS-rebinding/CSRF defense — `rejectNonLocal` in `src/server.ts`); don't weaken it to make a client work, fix the client's headers instead.
5. **`skill/` is part of the contract.** Changing flags, the JSON shape, or exit codes means updating `skill/change-review/SKILL.md` and the README in the same change — and re-running `agent-change-reviewer install claude` / `agent-change-reviewer install codex` so the installed copies match.
6. **`/tmp/change-review` is shared contract too.** SKILL.md tells agents to stage proposal files there *because* `cmdInstall` (`PROPOSAL_STAGING_DIR` in `src/cli.ts`) allowlists exactly that path in `~/.claude/settings.json`. Renaming the dir means changing both, and users must re-run `agent-change-reviewer install claude`.
7. **Approve on a proposal session applies exactly the reviewed bytes — only the CLI writes them.** The server applies the staged snapshot (verified by sha256) at verdict time; agents are told not to re-write the files. Keep it all-or-nothing on conflicts: a half-applied proposal is worse than a refused one.

## Testing changes

No automated tests yet (planned — see [ROADMAP.md](ROADMAP.md) §5). Manual loop:

- `npm run build && npm run demo` exercises the full path with `examples/demo.patch`.
- `agent-change-reviewer serve <id>` runs the server in the foreground to see errors.
- `agent-change-reviewer list` shows sessions; everything lives in `~/.reviewer/sessions/` and is safe to delete.
- `--worktree` needs a git repo with uncommitted changes; `--proposal` and patch mode work anywhere.
- If you're an agent testing this from inside a sandbox: binding localhost is often blocked — re-run unsandboxed.

## Gotchas

- ESM means relative imports need `.js` extensions *in the `.ts` sources* (`./session.js`, not `./session`).
- `parseUnifiedDiff` counts hunk lines from the `@@` header so that content lines starting with `---`/`+++`/`diff ` aren't mistaken for file headers — keep that property when touching it.
- A failed health check does **not** kill the recorded pid (it may have been reused by another process); it just forgets `server.json` and starts fresh.
- `POST /api/submit` returns 409 if a verdict already exists for the round — rounds are single-shot by design — and 409 while question threads are open (user spoke last, thread not closed).
- **Only the server writes `threads.json`** — the CLI posts answers over HTTP so writes serialize through one event loop. Don't add direct CLI writes.
- Question threads are session-long (each carries its `round`); hook sessions never get them — the agent is blocked inside the PreToolUse call and can't run `agent-change-reviewer answer`, so the UI hides the question composer there (`request.kind === "hook"`).
