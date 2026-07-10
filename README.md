# agent-change-reviewer

**A pull-request-style review step for AI coding agents.** Your agent proposes changes; you review them in your browser — GitHub-style inline diff, line comments, per-chunk apply — and your verdict flows straight back to the agent as JSON. Ships with an Agent Skill for Claude Code and Codex, and works with anything that can run a shell command.

```
agent ──"agent-change-reviewer review …"──▶ CLI
                                             │  serves the diff UI on localhost, opens your browser
you  ────────── line comments + verdict ───▶ UI
agent ◀──────── {verdict, comments[]} ────── stdout (exit code mirrors the verdict)
```

Agents ship diffs faster than anyone can read them in a terminal. change-review gives you a proper review surface instead: read the change like a PR, push back with comments the agent actually receives, and land only the parts you approve.

## What you get

- **A real diff UI** — inline, in your browser. Hover a line, click `+`, comment.
- **Pick what lands** — every chunk has a checkbox in the gutter. Untick the parts you don't want; **Apply** lands exactly the rest.
- **Talk before you decide** — **Discuss** sends your comments to the agent and threads its replies inline. Follow up as many turns as you need; you can still submit a verdict at any point.
- **Rounds, not restarts** — on **Request changes** the agent fixes and resubmits to the same review. Its reply threads under each of your comments, earlier rounds stay browsable, and a ⇄ view diffs any two revisions.
- **Nothing lands unreviewed** (optional) — review mode hooks the agent's file-edit tools so every edit stops for your approval first.
- **No moving parts** — zero runtime dependencies, one self-contained HTML file, binds `127.0.0.1` only. The review server outlives the agent's command, so a verdict is never lost to a timeout.

## Install

```bash
npm install -g agent-change-reviewer
```

Wire up your agent — this installs the change-review **Agent Skill**, which the agent discovers automatically and which teaches it when and how to ask you for review:

```bash
agent-change-reviewer install claude   # Claude Code
agent-change-reviewer install codex    # Codex
```

(The Claude install also allowlists the skill's staging dir `/tmp/change-review/` in `~/.claude/settings.json`, so proposal reviews never trip a permission prompt.)

Restart your agent session, then ask it to "open a review" — or try the UI right now, no agent needed:

```bash
cd some-repo-with-uncommitted-changes
agent-change-reviewer review --worktree
```

## A review, start to finish

1. The agent runs `agent-change-reviewer review --worktree --title "Add retry logic"` (uncommitted changes; `--proposal <dir>` reviews changes *before* they're written, or pass any unified diff). The command blocks until you decide.
2. Your browser opens the diff. Comment on lines, untick chunks you don't want, then pick **Apply**, **Request changes**, or **Discuss** — optionally with a summary.
3. Your verdict lands on the agent's stdout:

```json
{
  "verdict": "request_changes",
  "summary": "Direction is right, two fixes needed.",
  "comments": [
    { "file": "src/auth.py", "side": "new", "line": 42, "body": "use the existing retry helper here" }
  ],
  "session": "2026-06-11-a1b2c3",
  "round": 1
}
```

4. On `request_changes`, the agent addresses every comment and resubmits — round 2 shows its reply threaded under each one. On **Apply**, exactly the chunks you kept are applied (in proposal mode the CLI writes them itself, verified byte-for-byte against what you reviewed).

Exit codes are the API: `0` approve · `2` request_changes · `3` reject · `4` pending · `5` discussion open · `1` error.

## Review mode: nothing lands unreviewed

The skill relies on the agent *choosing* to ask for review — it can forget. Review mode intercepts the agent's file-edit tool calls (Claude Code `Edit`/`Write`, Codex `apply_patch`) so every edit stops in your browser first: allow it, allow the whole session, open the full review UI, or reject with a note the agent sees.

```bash
agent-change-reviewer hook install claude   # or codex; restart the agent
agent-change-reviewer hook on               # arm review mode (global)
agent-change-reviewer hook off              # back to normal
```

(Edits made through raw shell commands — `sed`, `echo >` — are not intercepted.)

## Commands

| command | what it does |
|---|---|
| `review --worktree [--base REF]` | review uncommitted changes (`git diff`); `git add -N` untracked files first |
| `review --proposal <dir>` | review proposed file contents *before* they're written; approve applies them |
| `review [patch]` | review any unified diff (file, stdin, or `-`) |
| `wait <id>` | keep waiting on a pending review |
| `answer <id> <answers.json>` | reply to Discuss comments, then keep waiting |
| `result <id>` | print the verdict or open discussion (non-blocking) |
| `list` | list sessions and their status |
| `install claude\|codex` | install the agent skill (re-run after upgrading) |
| `hook install\|on\|off\|status` | review mode (see above) |
| `config wait-mode stop\|poll` | when a review outlives the agent's timeout: end the turn (default) or keep polling |
| `config review-prefix <string>` | only intercept edits when your prompt starts with this prefix (e.g. `cr:`) |

Useful flags on `review`: `-t/--title`, `-s/--session` (next round of an existing review), `--replies <file>` (per-comment replies to the previous round), `--timeout <secs>` (default 480, `0` = forever), `--port`, `--no-open`.

## Good to know

- Every review is a session under `~/.agent-change-reviewer/sessions/<id>/`, served by a detached process. Agent's command timed out? The review is still live — submit whenever, the agent picks the verdict up with `result <id>`.
- Draft comments persist in localStorage; a closed tab or restarted server loses nothing.
- Agent sandboxes often block binding localhost. If `review` fails with a socket error from inside an agent, allowlist the command or re-run it unsandboxed — the server only ever binds `127.0.0.1`.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) for the quickstart; [AGENTS.md](AGENTS.md) is the full development guide — written for coding agents, equally useful for people.

## Roadmap

See [ROADMAP.md](ROADMAP.md). Headlines: range comments + expandable context + syntax highlighting, and an MCP wrapper.
