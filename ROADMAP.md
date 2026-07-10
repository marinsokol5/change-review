# Roadmap

Prioritized from real usage. Top to bottom ≈ build order.

## 1. Review ergonomics for non-trivial diffs

In rough order of value:

- **Multi-line range comments** — shift-click two gutter lines; schema already supports `line_range`.
- **Expandable context** — the server knows the session `cwd`, so it can read full files and serve hidden lines around hunks (worktree/proposal modes).
- **Syntax highlighting** — bundle a lightweight highlighter into the single-file UI (no CDN).
- **Keyboard navigation** — j/k between changes, n/p between files, c to comment.
- File-level "viewed" checkboxes for large diffs.

## 2. MCP wrapper

A thin MCP server exposing a `request_review` tool over the existing session/server core. Kills the Bash-timeout/pending dance (MCP calls can block longer), works for Claude Code and Codex from one config entry, and the tool description replaces half the skill. Low effort since the session layer already exists.

## 3. Housekeeping

- Unit tests for `src/patch.ts` — the most edge-case-prone code (renames, binary, `\ No newline`, content lines starting with `---`), currently untested.
- `node reviewer.ts clean [--older-than 7d]` — prune finished/abandoned sessions in a data dir (demo sessions already accumulate).
- Publish to a skills registry (e.g. `npx skills add`) once the GitHub repo is up.
- Auto-`git add -N` for untracked files in worktree mode (`--include-untracked`).
- Proposal mode can't express deletions — support a deletion marker or document worktree mode as the only path.

## Parked: the PreToolUse hook ("review mode")

v0.2 shipped a hook that intercepted the agent's file-edit tools so no edit landed unreviewed, plus per-agent install commands (`install claude|codex`, `hook install`, settings.json surgery). That whole surface was removed from `main` in v0.4 in favor of pure skill-folder distribution — it lives on, unmaintained, on the [`hook-version`](../../tree/hook-version) branch. Its old refinement list (per-path patterns, size threshold, per-project toggle, shell-edit interception, hook round 2) moves there with it.

## Done

- v0.4 (2026-07-10): **Skill-only distribution.** The repo is now the skill: root `SKILL.md` + `reviewer.ts` run directly by Node >= 22.18 (native type stripping — no build, no npm install, no `bin/`). Sessions live under an agent-chosen `--dir` (default `<os-tmpdir>/change-review`) instead of `~/.agent-change-reviewer`; every emitted hint embeds the script path and dir, so follow-up commands are copy-paste runnable. Removed: `install claude|codex` (skill copying + settings.json allowlisting of `/tmp/change-review`), the PreToolUse hook and quick menu (→ `hook-version` branch), `review-prefix` config. Config shrank to `wait-mode` at `~/.change-review/config.json`.
- v0.3 (2026-06-12): **Review conversations.** In-round clarifying **question threads**: comments can be questions, batched to the agent mid-review (exit 5 → the `answer` command, all open questions required, then it keeps waiting), answers thread in place, follow-ups reopen, user can withdraw; verdict locked (UI + `/api/submit` 409) while questions are open. Cross-round **`--replies`**: resubmits require one reply per previous-round comment (fixed or justified-skip, CLI-enforced), merged into the archived result and threaded under the comments in the history panel (auto-opened). New exit code 5; threads in the session's `threads.json`, server is the only writer. Not built on purpose: structured per-hunk reject (a change comment in prose covers it), re-anchoring old threads onto new-round diffs.
- v0.2 (2026-06-12): **PreToolUse hook (review mode)** for Claude Code (`Edit|Write`) *and* Codex (`apply_patch`, V4A envelope applied in memory): quick menu (allow / allow-session / review / reject) served before the full diff UI, decisions returned as `permissionDecision` JSON, per-agent-session allow-flags, timeout → `ask` (Claude) / deny (Codex). Removed from `main` in v0.4; see the `hook-version` branch.
- v0.1 (2026-06-11): CLI (review/wait/result/serve/list/install), detached UI server that survives agent timeouts, sessions + rounds with history, single-file dark diff UI with line comments and draft persistence, intra-line token-level highlighting, Claude Code skill, Codex AGENTS.md section.
