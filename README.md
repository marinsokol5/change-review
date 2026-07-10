# change-review

**A pull-request-style review step for AI coding agents.** Your agent proposes changes; you review them in your browser — GitHub-style inline diff, line comments, per-chunk apply — and your verdict flows straight back to the agent as JSON. Ships as an agent skill with its own zero-dependency CLI inside: no package to install, nothing to build.

```
agent ──"node reviewer.ts review …"──▶ CLI
                                        │  serves the diff UI on localhost, opens your browser
you  ───────── line comments + verdict ▶ UI
agent ◀─────── {verdict, comments[]} ─── stdout (exit code mirrors the verdict)
```

Agents ship diffs faster than anyone can read them in a terminal. change-review gives you a proper review surface instead: read the change like a PR, push back with comments the agent actually receives, and land only the parts you approve.

## What you get

- **A real diff UI** — inline, in your browser. Hover a line, click `+`, comment.
- **Pick what lands** — every chunk has a checkbox in the gutter. Untick the parts you don't want; **Apply** lands exactly the rest.
- **Talk before you decide** — **Discuss** sends your comments to the agent and threads its replies inline. Follow up as many turns as you need; you can still submit a verdict at any point.
- **Rounds, not restarts** — on **Request changes** the agent fixes and resubmits to the same review. Its reply threads under each of your comments, earlier rounds stay browsable, and a ⇄ view diffs any two revisions.
- **No moving parts** — zero runtime dependencies, one self-contained HTML file, binds `127.0.0.1` only. The review server outlives the agent's command, so a verdict is never lost to a timeout.

## Install

This repo **is** the skill — installing it is copying it into your agent's skills folder:

```bash
npx skills add <github-owner>/change-review      # via the skills CLI, or plain git:
git clone <repo-url> ~/.claude/skills/change-review    # Claude Code
git clone <repo-url> ~/.codex/skills/change-review     # Codex
```

Requires **Node >= 22.18** — the CLI is TypeScript that `node` runs directly (native type stripping), so there is no build step and no `npm install`. Restart your agent session so it picks the skill up. Updating = `git pull` in the skill folder.

Try it without an agent:

```bash
node reviewer.ts review examples/demo.patch --title "Demo review"   # or: npm run demo
```

## How a review flows

1. The agent runs `node <skill-dir>/reviewer.ts review --worktree --title "Add retry logic" --dir <its-temp-dir>` (or `--proposal <dir>` to review changes *before* they're written, or passes any unified diff). The command blocks.
2. Your browser opens an inline diff. Hover a line, click `+`, leave comments. Every chunk (one contiguous run of changed lines) carries a checkbox in the gutter — untick the ones you don't want, per file or all at once. Then pick an action — **Apply** (lands exactly the selected chunks: all = classic approve, none = reject), **Request changes**, or **Discuss** (send your comments to the agent for a reply before you decide) — optionally with an overall summary.
3. The verdict JSON lands on the agent's stdout:

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

4. Want the agent's take before deciding? Leave your comments, then click **Discuss** — it sends every comment to the agent for a reply-per-comment (a bare ACK when it agrees, exit 5 → the `answer` command) in the same review revision, without touching any files. The replies thread inline, and each thread stays open: hit **Reply** under an answer to write back, and the follow-up goes to the agent for another reply — as many turns as you need. You can still decide at any time (a discussion never blocks the verdict). Your comments ride along with the eventual verdict, now with the whole discussion attached.
5. On `request_changes` the agent fixes every comment and re-submits with `--session <id> --replies replies.json` — round 2 shows each of your comments with the agent's reply threaded under it ("fixed — …" or why it deliberately didn't). One reply per comment, enforced by the CLI. Earlier rounds stay browsable — round pills in the header link to `/round/N`, a read-only snapshot of that round's diff with your comments, the agent's replies, and any discussion in place. The small ⇄ between two pills shows what changed *between* those rounds (`/round/N?diffAgainst=M`) — how the agent's revision evolved — with nothing to comment on or decide there.

A partial Apply is still an `approve` (exit 0): the verdict's `chunks` field says what was skipped, and two ready-made patches (`appliedPatch`, `revertPatch`) let the agent land exactly the approved subset deterministically. In proposal mode the CLI itself writes base-plus-selected-chunks — sha256-verified against what was reviewed, all-or-nothing.

Exit codes: `0` approve · `2` request_changes · `3` reject · `4` pending (no verdict yet) · `5` discussion (reply to each comment) · `1` error.

## Commands

All commands are `node reviewer.ts <command>` and accept `--dir <path>` — the directory sessions live in (default: `<os-tmpdir>/change-review`). The agent picks one temp dir per review session and reuses it for every command of that review; the CLI's JSON output always echoes the exact next command to run, `--dir` included.

| command | what it does |
|---|---|
| `review [patch]` | review a unified diff (file, stdin, or `-`) |
| `review --worktree [--base REF]` | review uncommitted changes (`git diff`); `git add -N` untracked files first |
| `review --proposal <dir>` | review a dir of proposed file contents (repo-relative paths) diffed against the working tree; on approve the CLI writes the reviewed bytes — filtered to the selected chunks — into the repo itself (all-or-nothing, reported under `apply`/`chunks` in the verdict JSON) |
| `wait <id>` | keep waiting on a pending review; restarts the UI server if it died |
| `answer <id> <answers.json>` | reply to the reviewer's Discuss comments, then keep waiting for the verdict |
| `result <id>` | print the verdict or open discussion if any (non-blocking) |
| `list` | list sessions and their status |
| `serve <id>` | run the UI server in the foreground (debugging) |
| `config wait-mode poll\|stop` | what agents do when a review outlives the CLI timeout (default `stop`) |

Useful flags on `review`: `-t/--title`, `-s/--session` (next round of an existing review), `--replies <file>` (with `--session`: per-comment replies to the previous round), `--timeout <secs>` (default 480, `0` = forever), `--port`, `--no-open`.

## How it works

- Each review is a **session** under `<--dir>/<session-id>/` — `request.json`, `patch.diff`, `result.json` once submitted, plus per-round history. The dir is temporary by nature; the agent provides it, and nothing is ever written to a fixed global path (the one exception: `~/.change-review/config.json`, written only when *you* run `config`).
- The UI server runs as a **detached process**, so it survives the agent's command timing out. `review`/`wait` just poll for the result file; if the CLI's own timeout fires, it exits with code 4 ("pending") and the JSON tells the agent what to do next based on `wait-mode`:
  - **`stop` (default):** the agent ends its turn and tells you the review URL; when you've submitted, tell the agent (it picks the verdict up with `result <id>`). No idle agent turns — long reviews cost you nothing while you're away.
  - **`poll`:** the agent keeps re-running `wait` until you submit. Snappier handoff, but each idle cycle is an agent turn — on API billing, a long-unattended review keeps burning tokens. Set it with `node reviewer.ts config wait-mode poll`.
- The UI saves draft comments to localStorage, so a server restart or accidental tab close loses nothing.
- Zero runtime dependencies; the UI is one self-contained HTML file served from `127.0.0.1`.

## Sandbox note

Agents often run commands in a sandbox that blocks binding localhost (`listen EPERM`). If `reviewer.ts` fails with a socket/permission error from inside an agent, let the agent re-run it unsandboxed — the server only ever binds `127.0.0.1`.

## The hook variant

An earlier iteration of this project shipped as an npm package with a `PreToolUse` hook ("review mode": intercept every agent file edit with an allow/review/reject menu). That variant lives on the [`hook-version`](../../tree/hook-version) branch; `main` is deliberately just the skill.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) for the human quickstart; the full development guide (setup, architecture, invariants) is [AGENTS.md](AGENTS.md) — written for coding agents, equally useful for people.

## Roadmap

See [ROADMAP.md](ROADMAP.md). Headlines: range comments + expandable context + syntax highlighting, and an MCP wrapper.
