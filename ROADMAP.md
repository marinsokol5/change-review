# Roadmap

Prioritized from real usage. Top to bottom ≈ build order.

## 1. Review-mode refinements

The PreToolUse hook shipped (see Done) — remaining polish:

- Per-path patterns (only intercept `src/**`) and a size threshold (only edits above N lines).
- Per-project toggle (`agent-change-reviewer hook on` is currently global across all agent sessions).
- Codex edits via raw shell commands (`sed`, `echo >`) bypass the hook; consider a Bash matcher heuristic for `apply_patch`-in-shell.
- Hook sessions are one-shot: a retried edit after "request changes" starts a fresh session instead of round 2 of the same review.

## 2. Review ergonomics for non-trivial diffs

In rough order of value:

- **Multi-line range comments** — shift-click two gutter lines; schema already supports `line_range`.
- **Expandable context** — the server knows the session `cwd`, so it can read full files and serve hidden lines around hunks (worktree/proposal modes).
- **Syntax highlighting** — bundle a lightweight highlighter into the single-file UI (no CDN).
- **Keyboard navigation** — j/k between changes, n/p between files, c to comment.
- File-level "viewed" checkboxes for large diffs.

## 3. MCP wrapper

A thin MCP server exposing a `request_review` tool over the existing session/server core. Kills the Bash-timeout/pending dance (MCP calls can block longer), works for Claude Code and Codex from one config entry, and the tool description replaces half the skill. Low effort since the session layer already exists.

## 4. Housekeeping

- Unit tests for `src/patch.ts` — the most edge-case-prone code (renames, binary, `\ No newline`, content lines starting with `---`), currently untested.
- `agent-change-reviewer clean [--older-than 7d]` — prune finished/abandoned sessions (demo sessions already accumulate).
- Publish to npm — one-command install instead of clone-and-link.
- Auto-`git add -N` for untracked files in worktree mode (`--include-untracked`).
- Proposal mode can't express deletions — support a deletion marker or document worktree mode as the only path.

## Done

- v0.3 (2026-06-12): **Review conversations.** In-round clarifying **question threads**: comments can be questions, batched to the agent mid-review (exit 5 → `agent-change-reviewer answer <id> answers.json`, all open questions required, then it keeps waiting), answers thread in place, follow-ups reopen, user can withdraw; verdict locked (UI + `/api/submit` 409) while questions are open. Cross-round **`--replies`**: resubmits require one reply per previous-round comment (fixed or justified-skip, CLI-enforced), merged into the archived result and threaded under the comments in the history panel (auto-opened). New exit code 5; threads in `~/.reviewer/sessions/<id>/threads.json`, server is the only writer. Not built on purpose: structured per-hunk reject (a change comment in prose covers it), re-anchoring old threads onto new-round diffs.
- v0.2 (2026-06-12): **PreToolUse hook (review mode)** for Claude Code (`Edit|Write`) *and* Codex (`apply_patch`, V4A envelope applied in memory): `agent-change-reviewer hook install claude|codex`, `hook on|off|status`, quick menu (allow / allow-session / review / reject) served before the full diff UI, decisions returned as `permissionDecision` JSON, per-agent-session allow-flags, timeout → `ask` (Claude) / deny (Codex). Manual e2e: `test-hook.sh`.
- v0.1 (2026-06-11): CLI (review/wait/result/serve/list/install), detached UI server that survives agent timeouts, sessions + rounds with history, single-file dark diff UI with line comments and draft persistence, intra-line token-level highlighting, Claude Code skill, Codex AGENTS.md section.
