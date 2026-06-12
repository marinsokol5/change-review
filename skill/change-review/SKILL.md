---
name: change-review
description: Open an interactive human review of proposed file changes. The user sees an inline diff in their browser, leaves line comments, and returns a verdict (approve / request_changes / reject) printed as JSON on stdout. Use before applying substantive or risky changes, whenever the user asks to review a change ("let me review", "show me the diff", "open a review"), or to re-review after addressing feedback.
---

# Human change review (`agent-change-reviewer`)

`agent-change-reviewer` opens an inline diff in the user's browser. The user comments on specific lines and picks a verdict; the command blocks until then and prints the verdict JSON to stdout.

Run it from the repo root. Never run it in the background — the blocking call IS the review. ALWAYS run `agent-change-reviewer` commands with the command sandbox disabled: it binds localhost and writes `~/.reviewer/`, both of which sandboxes block (EPERM).

## Invoking — pick one mode

**Worktree mode (preferred in a git repo).** Apply your changes to the working tree first, then:

```bash
agent-change-reviewer review --worktree --base HEAD --title "Short description of the change"
```

Untracked new files don't show up in `git diff` — run `git add -N <file>` on them first. If the review is rejected, revert with `git restore` (and delete the new files).

**Proposal mode (review BEFORE writing into the repo).** Write each proposed file's *complete new contents* into a fresh subdirectory of `/tmp/change-review/` that mirrors repo-relative paths; the diff is taken against the current working tree automatically:

```bash
# stage the proposal in /tmp/change-review/<unique-dir>/ — e.g. the new version
# of src/auth.py goes to /tmp/change-review/myrepo-x7k2/src/auth.py
agent-change-reviewer review --proposal /tmp/change-review/myrepo-x7k2 --title "Short description"
```

Stage under exactly `/tmp/change-review/` — `agent-change-reviewer install` pre-approved file-tool writes there, so staging never triggers a permission prompt (any other temp dir will). Write the files with your file-write tool, which creates parent directories itself; don't shell out to `mkdir`/`cp` (the command sandbox may block `/tmp`). Pick a fresh, unique subdirectory per proposal and never reuse one — leftover files from an earlier proposal would leak into the diff.

New files are fine (they diff against nothing). File deletions can't be expressed in this mode — use worktree mode for those.

On approve, the CLI itself writes the reviewed files into the repo, byte-for-byte what the user saw — do NOT re-write them yourself. The verdict JSON's `apply` field tells you how it went (see "Approve in proposal mode" below).

**Patch mode.** If you already have a unified diff: `agent-change-reviewer review changes.patch`, or pipe it on stdin.

## Timeouts and pending reviews — important

Humans are slow. Always run `agent-change-reviewer` with the maximum Bash timeout (600000 ms). The CLI itself waits 480 s by default and then exits with code 4 ("pending") while the review UI stays open in the user's browser.

Exit code 4 is not a failure and not permission to abandon the review. The pending JSON's `hint` tells you what to do, based on the user's configured `wait-mode` (`agent-change-reviewer config wait-mode`):

- **`stop` (the default):** end your turn. Tell the user the review is open (use the `url` from the pending JSON) and ask them to tell you when they've submitted a verdict; then run `agent-change-reviewer result <session-id>` to pick it up and act on it. Do NOT re-run `agent-change-reviewer wait` in a loop — the user chose this mode to avoid idle polling turns.
- **`poll`:** run `agent-change-reviewer wait <session-id>` (again with max Bash timeout), repeatedly if needed, until you get a real verdict.

The session id is in the pending JSON and on stderr.

## Handling the outcome

stdout is JSON; the exit code mirrors the verdict:

| exit | verdict | what you do |
|------|---------|-------------|
| 0 | `approve` | worktree/patch mode: keep the changes and continue; proposal mode: the CLI already applied them — check `apply` (below) |
| 2 | `request_changes` | address EVERY comment, then re-submit with `--session <id> --replies replies.json` (see below) |
| 3 | `reject` | discard the changes (worktree mode: `git restore` the touched files), tell the user, ask how to proceed |
| 4 | pending | follow the JSON `hint`: wait-mode `stop` = end your turn, let the user resume you; `poll` = `agent-change-reviewer wait <session-id>` |
| 5 | questions | the user asked clarifying questions instead of deciding — answer them (see below) |

Result shape:

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

- `side: "new"` line numbers refer to the proposed version; `side: "old"` refers to removed lines in the original.
- `summary` may contain instructions even when there are no line comments.
- An approve can still carry comments — they are advisory; the reviewed content was applied as-is. To act on them, make fresh edits and open a new review.

## Approve in proposal mode (the `apply` field)

When a proposal-mode review is approved, the CLI deterministically writes the reviewed bytes into the repo at the moment the user clicks approve. The verdict JSON gains an `apply` field:

```json
{ "verdict": "approve", "apply": { "applied": true, "wrote": ["src/auth.py"] }, ... }
```

- `applied: true` — every proposed file now has exactly its reviewed contents. Do NOT write those files yourself; just continue.
- `applied: false` with `conflicts` — those files changed in the working tree mid-review, so NOTHING was written (all-or-nothing). Rebuild the proposal against the current files and submit a new review round.
- `applied: false` with `error` — an I/O problem; `wrote` lists what landed before it. Tell the user and resolve before retrying.

## Answering questions (exit 5)

Mid-review the user can ask clarifying questions on diff lines ("why was this done?") instead of deciding. The command then exits 5 with the question threads on stdout:

```json
{ "status": "questions", "session": "2026-06-11-a1b2c3",
  "questions": [ { "thread": 1, "file": "src/auth.py", "side": "new", "line": 42,
                   "question": "why not reuse the retry helper?" } ] }
```

Answer **every** thread, honestly and concretely, then keep waiting — the verdict stays locked for the user until all questions are answered:

```bash
# answers.json: [{ "thread": 1, "answer": "the helper retries on 5xx only; this path needs 429 backoff" }]
agent-change-reviewer answer <session-id> answers.json
```

`agent-change-reviewer answer` posts the answers and then blocks like `agent-change-reviewer wait` (same timeout/pending rules). Follow-up questions arrive as another exit 5 with the thread's history attached. Do NOT change files while answering — questions are conversation, not change requests; wait for the verdict.

## Re-submitting after request_changes (exit 2)

Fix — or consciously skip — every comment, then re-submit as the next round of the SAME session, with a reply per comment keyed by its 0-based index in the verdict's `comments` array:

```bash
# replies.json:
# [ { "comment": 0, "reply": "fixed — switched to the retry helper" },
#   { "comment": 1, "reply": "not changed: the null case is handled by the caller in src/api.py" } ]
agent-change-reviewer review --worktree --session <id> --replies replies.json --title "..."
```

Every comment needs a reply — what you changed, or why you deliberately didn't. The CLI rejects incomplete or out-of-range replies (exit 1) and lists the unanswered comments. The user sees your replies threaded under their comments in round 2; also briefly tell them what you changed.

## Troubleshooting

- `command not found: agent-change-reviewer` — ask the user to install it (`npm install -g agent-change-reviewer`, or `npm link` in the agent-change-reviewer repo).
- Network/socket permission error on start — a command sandbox is blocking the local UI server (it only binds 127.0.0.1). Re-run the command with sandbox disabled.
