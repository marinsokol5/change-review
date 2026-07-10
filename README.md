# agent-change-reviewer

Human-in-the-loop review for AI coding agents (Claude Code, Codex, anything that can run a shell command). The agent proposes changes, you review them in a GitHub-style inline diff with line comments, and your verdict is piped straight back to the agent as JSON.

```
agent ──"agent-change-reviewer review …"──▶ CLI
                                             │  serves the diff UI on localhost, opens your browser
you  ────────── line comments + verdict ───▶ UI
agent ◀──────── {verdict, comments[]} ────── stdout (exit code mirrors the verdict)
```

## Quickstart

```bash
npm install        # builds via the prepare script
npm link           # puts `agent-change-reviewer` on your PATH

npm run demo       # opens the bundled example diff in your browser
```

Then wire up your agents:

```bash
agent-change-reviewer install claude   # installs the skill to ~/.claude/skills/change-review
agent-change-reviewer install codex    # installs the same skill to ~/.codex/skills/change-review
```

Both agents auto-discover skills in those folders. For Claude Code, `install` also adds permission rules to `~/.claude/settings.json` allowing file writes under `/tmp/change-review/` — the staging directory the skill uses for proposal mode — so staging a proposal never triggers a permission prompt. (Codex needs no equivalent: its workspace-write sandbox already allows `/tmp`.)

Restart your agent session afterwards so it picks the instructions up.

## How a review flows

1. The agent runs `agent-change-reviewer review --worktree --title "Add retry logic"` (or `--proposal <dir>` to review changes *before* they're written, or passes any unified diff). The command blocks.
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

4. Want the agent's take before deciding? Leave your comments, then click **Discuss** — it sends every comment to the agent for a reply-per-comment (a bare ACK when it agrees, exit 5 → `agent-change-reviewer answer`) in the same review revision, without touching any files. The replies thread inline, and each thread stays open: hit **Reply** under an answer to write back, and the follow-up goes to the agent for another reply — as many turns as you need. You can still decide at any time (a discussion never blocks the verdict). Your comments ride along with the eventual verdict, now with the whole discussion attached.
5. On `request_changes` the agent fixes every comment and re-submits with `--session <id> --replies replies.json` — round 2 shows each of your comments with the agent's reply threaded under it ("fixed — …" or why it deliberately didn't). One reply per comment, enforced by the CLI. Earlier rounds stay browsable — round pills in the header link to `/round/N`, a read-only snapshot of that round's diff with your comments, the agent's replies, and any discussion in place. The small ⇄ between two pills shows what changed *between* those rounds (`/round/N?diffAgainst=M`) — how the agent's revision evolved — with nothing to comment on or decide there.

A partial Apply is still an `approve` (exit 0): the verdict's `chunks` field says what was skipped, and two ready-made patches (`appliedPatch`, `revertPatch`) let the agent land exactly the approved subset deterministically. In proposal mode the CLI itself writes base-plus-selected-chunks — sha256-verified against what was reviewed, all-or-nothing.

Exit codes: `0` approve · `2` request_changes · `3` reject · `4` pending (no verdict yet) · `5` discussion (reply to each comment) · `1` error.

## Commands

| command | what it does |
|---|---|
| `agent-change-reviewer review [patch]` | review a unified diff (file, stdin, or `-`) |
| `agent-change-reviewer review --worktree [--base REF]` | review uncommitted changes (`git diff`); `git add -N` untracked files first |
| `agent-change-reviewer review --proposal <dir>` | review a dir of proposed file contents (repo-relative paths) diffed against the working tree; on approve the CLI writes the reviewed bytes — filtered to the selected chunks — into the repo itself (all-or-nothing, reported under `apply`/`chunks` in the verdict JSON) |
| `agent-change-reviewer wait <id>` | keep waiting on a pending review; restarts the UI server if it died |
| `agent-change-reviewer answer <id> <answers.json>` | reply to the reviewer's Discuss comments, then keep waiting for the verdict |
| `agent-change-reviewer result <id>` | print the verdict or open discussion if any (non-blocking) |
| `agent-change-reviewer list` | list sessions and their status |
| `agent-change-reviewer serve <id>` | run the UI server in the foreground (debugging) |
| `agent-change-reviewer install claude\|codex` | install the change-review skill for that agent (re-run after upgrading); claude: also allowlists the `/tmp/change-review/` proposal staging dir in `~/.claude/settings.json` |
| `agent-change-reviewer hook install claude\|codex` | register the PreToolUse hook (see "Review mode" below) |
| `agent-change-reviewer hook on\|off\|status` | arm/disarm review mode |
| `agent-change-reviewer config wait-mode poll\|stop` | what agents do when a review outlives the CLI timeout (default `stop`) |
| `agent-change-reviewer config review-prefix <string>` | only intercept edits when the triggering user prompt starts with this string (e.g. `cr:`); omit to intercept all edits |

Useful flags on `review`: `-t/--title`, `-s/--session` (next round of an existing review), `--replies <file>` (with `--session`: per-comment replies to the previous round), `--timeout <secs>` (default 480, `0` = forever), `--port`, `--no-open`.

## Review mode (PreToolUse hook)

The skill relies on the agent *choosing* to request a review — it can forget. Review mode intercepts the agent's actual file-edit tool calls (Claude Code `Edit`/`Write`, Codex `apply_patch`) with a `PreToolUse` hook, so no edit lands unreviewed:

```bash
agent-change-reviewer hook install claude   # writes the hook to ~/.claude/settings.json
agent-change-reviewer hook install codex    # writes it to ~/.codex/hooks.json
# restart the agent, then:
agent-change-reviewer hook on               # arm review mode (global, all sessions)
agent-change-reviewer hook off              # back to normal; also clears session allow-flags
```

While armed, every intercepted edit opens a small menu in your browser:

1. **Allow** — this edit only
2. **Allow all edits this session** — stop asking until that agent session ends (flag file keyed by the agent's `session_id`, auto-expires after 7 days)
3. **Review** — the full inline diff UI; approve = allow, request changes/reject = deny with your comments fed back into the agent's context
4. **Reject…** — block the edit, optionally telling the agent what to do instead

When the hook is off (or the menu times out after ~10 minutes), Claude Code falls back to its native permission prompt; Codex gets a deny on timeout since it has no "ask" fallback. Edits the agent makes through raw shell commands (`sed`, `echo >`, …) are not intercepted.

## How it works

- Each review is a **session** under `~/.agent-change-reviewer/sessions/<id>/` — `request.json`, `patch.diff`, `result.json` once submitted, plus per-round history.
- The UI server runs as a **detached process**, so it survives the agent's command timing out. `agent-change-reviewer review`/`wait` just poll for the result file; if the CLI's own timeout fires, it exits with code 4 ("pending") and the JSON tells the agent what to do next based on `wait-mode`:
  - **`stop` (default):** the agent ends its turn and tells you the review URL; when you've submitted, tell the agent (it picks the verdict up with `agent-change-reviewer result <id>`). No idle agent turns — long reviews cost you nothing while you're away.
  - **`poll`:** the agent keeps re-running `agent-change-reviewer wait` until you submit. Snappier handoff, but each idle cycle is an agent turn — on API billing, a long-unattended review keeps burning tokens. Set it with `agent-change-reviewer config wait-mode poll`.
- The UI saves draft comments to localStorage, so a server restart or accidental tab close loses nothing.
- Zero runtime dependencies; the UI is one self-contained HTML file served from `127.0.0.1`.

## Sandbox note

Agents often run commands in a sandbox that blocks binding localhost. If `agent-change-reviewer` fails with a socket/permission error from inside an agent, allowlist the command or let the agent re-run it unsandboxed — the server only ever binds `127.0.0.1`.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) for the human quickstart; the full development guide (setup, architecture, invariants) is [AGENTS.md](AGENTS.md) — written for coding agents, equally useful for people.

## Roadmap

See [ROADMAP.md](ROADMAP.md). Headlines: range comments + expandable context + syntax highlighting, and an MCP wrapper.
