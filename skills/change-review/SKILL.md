---
name: change-review
description: Open an interactive human review of proposed file changes. The user sees an inline diff in their browser, leaves line comments, and returns a verdict (approve / request_changes / reject) printed as JSON on stdout. Use before applying substantive or risky changes, whenever the user asks to review a change ("let me review", "show me the diff", "open a review"), or to re-review after addressing feedback. Can also open existing files with no diff for line-comment annotation ("let me annotate", "I want to comment on the code") — the user's comments become the spec, and your edits come back as round 2 of the same review.
---

# Human change review (`reviewer.ts`)

This skill ships its own zero-dependency CLI: `scripts/reviewer.ts`, beside this file. It opens an inline diff in the user's browser; the user comments on specific lines and picks a verdict; the command blocks until then and prints the verdict JSON to stdout.

In the commands below:

- **`$REVIEWER`** = this skill's base directory + `scripts/reviewer.ts` (an absolute path).
- **`$DIR`** = the session data directory — a temp directory **you choose**, e.g. `<your scratchpad or $TMPDIR>/change-review`.

Ground rules:

- Requires Node >= 22.18 — the CLI is TypeScript that `node` runs directly via type stripping. No build, no npm install.
- Pick `$DIR` **once per review session** and pass `--dir "$DIR"` to EVERY command of that review — later rounds, `wait`, `answer`, `result` included. All session state lives under it; a different `--dir` simply won't find the session. Every JSON the CLI prints echoes the dir and the exact next command, so follow those verbatim.
- Run it from the repo root. Never run it in the background — the blocking call IS the review. ALWAYS run it with the command sandbox disabled: it binds localhost, which sandboxes block (`listen EPERM`).

## Shorthands — routing `/change-review <args>`

Invoked as a slash command, the text after `/change-review` arrives as `ARGUMENTS`. Route it before anything else:

- **`edit`** — your most recent file edit(s) that did **not** land (a rejected Edit/Write permission prompt, an interrupted turn). Reconstruct each touched file's complete post-edit contents from your own context and review them in **proposal mode** — on approve the CLI writes them. If those edits actually landed already, treat as `diff`.
- **`diff`** — the uncommitted working-tree changes: **worktree mode**.
- **`commit [<ref-or-range>]`** — the last commit (default `HEAD~1 HEAD`) or the given range (e.g. `main...HEAD`): pipe `git diff` into **patch mode** (example below). This reviews history — there is nothing to apply or revert; on request_changes, make fresh edits in the worktree and resubmit as round 2 of the same session.
- **one or more file paths** — **annotation mode** on those files.
- **`resume`** — don't open anything; the user is saying a pending review moved (verdict submitted, or questions asked). Run `node "$REVIEWER" result <session-id> --dir "$DIR"` for the open session.
- **anything else** — free text describing what to review: pick the matching mode. No arguments: with uncommitted changes present, default to `diff`; with a clean tree, ask what to review.

## Invoking — pick one mode

**Worktree mode (preferred in a git repo).** Apply your changes to the working tree first, then:

```bash
node "$REVIEWER" review --worktree --base HEAD --title "Short description of the change" --dir "$DIR"
```

Untracked new files don't show up in `git diff` — run `git add -N <file>` on them first. If the review is rejected, revert with `git restore` (and delete the new files).

**Proposal mode (review BEFORE writing into the repo).** Write each proposed file's *complete new contents* into a fresh staging directory that mirrors repo-relative paths — use a subdirectory of `$DIR`, one per round, so everything about the review lives in one place. The diff is taken against the current working tree automatically:

```bash
# stage the proposal in $DIR/proposal-r1/ — e.g. the new version
# of src/auth.py goes to $DIR/proposal-r1/src/auth.py
node "$REVIEWER" review --proposal "$DIR/proposal-r1" --title "Short description" --dir "$DIR"
```

Write the staged files with your file-write tool (it creates parent directories itself). Use a fresh directory per proposal and never reuse one — leftover files from an earlier proposal would leak into the diff. The CLI snapshots the staged bytes the moment the review opens, so the staging directory doesn't need to survive afterwards.

New files are fine (they diff against nothing). File deletions can't be expressed in this mode — use worktree mode for those.

On approve, the CLI itself writes the reviewed files into the repo, byte-for-byte what the user saw — filtered down to the chunks the user selected if they approved only a subset — do NOT re-write them yourself. The verdict JSON's `apply` field tells you how it went (see "Approve in proposal mode" below), and `chunks` describes a partial selection (see "Partial approve").

**Patch mode.** If you already have a unified diff: `node "$REVIEWER" review changes.patch --dir "$DIR"`, or pipe it on stdin — e.g. the last commit or a branch:

```bash
git diff --no-color HEAD~1 HEAD | node "$REVIEWER" review - --title "Review: last commit" --dir "$DIR"
```

**Annotation mode (comment on existing code — no diff yet).** When the user wants to mark up current files before any change exists ("let me annotate", "I'll comment on the code", planning a change together), open the files as-is:

```bash
node "$REVIEWER" review --file src/auth.py --file src/api.py --title "Annotate auth flow" --dir "$DIR"
```

The UI shows each file's current contents for line comments; text files only, deduplicated, paths relative to the repo root. The user typically finishes with **Request changes** (exit 2) — those comments are the spec: implement them, then resubmit as the next round of the SAME session exactly like any other request_changes (worktree or proposal mode, `--session` + `--replies`), so the user reviews your edits threaded under their annotations. **Looks good** (approve, exit 0) means the code is fine as-is — change nothing. **Discuss** (exit 5) works too: line-anchored questions about existing code that you answer without editing anything.

## Timeouts and pending reviews — important

Humans are slow. Always run the review commands with the maximum Bash timeout (600000 ms). The CLI itself waits 480 s by default and then exits with code 4 ("pending") while the review UI stays open in the user's browser.

Exit code 4 is not a failure and not permission to abandon the review. The pending JSON's `hint` tells you what to do, based on the user's configured `wait-mode` (`node "$REVIEWER" config wait-mode`):

- **`stop` (the default):** end your turn. Tell the user the review is open (use the `url` from the pending JSON) and ask them to tell you when they've submitted a verdict; then run `node "$REVIEWER" result <session-id> --dir "$DIR"` to pick it up and act on it. Do NOT re-run `wait` in a loop — the user chose this mode to avoid idle polling turns.
- **`poll`:** run `node "$REVIEWER" wait <session-id> --dir "$DIR"` (again with max Bash timeout), repeatedly if needed, until you get a real verdict.

The session id is in the pending JSON and on stderr; the JSON's `dir` field is the `--dir` to keep using.

## Handling the outcome

stdout is JSON; the exit code mirrors the verdict:

| exit | verdict | what you do |
|------|---------|-------------|
| 0 | `approve` | worktree/patch mode: keep the changes and continue; proposal mode: the CLI already applied them — check `apply` (below). If `chunks` is present and `applied < total`, the user approved only a subset — see "Partial approve" |
| 2 | `request_changes` | address EVERY comment, then re-submit with `--session <id> --replies replies.json` (see below) |
| 3 | `reject` | discard the changes (worktree mode: `git restore` the touched files), tell the user, ask how to proceed |
| 4 | pending | follow the JSON `hint`: wait-mode `stop` = end your turn, let the user resume you; `poll` = keep waiting with `wait` |
| 5 | discussion | the user opened a discussion instead of deciding — reply to every comment (see below) |

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
- A comment the user discussed with you carries a `discussion` array alongside it (their comment, your reply, any follow-ups).

## Approve in proposal mode (the `apply` field)

When a proposal-mode review is approved, the CLI deterministically writes the reviewed bytes into the repo at the moment the user clicks approve. The verdict JSON gains an `apply` field:

```json
{ "verdict": "approve", "apply": { "applied": true, "wrote": ["src/auth.py"] }, ... }
```

- `applied: true` — every proposed file now has exactly its reviewed contents. Do NOT write those files yourself; just continue.
- `applied: false` with `conflicts` — those files changed in the working tree mid-review, so NOTHING was written (all-or-nothing). Rebuild the proposal against the current files and submit a new review round.
- `applied: false` with `error` — an I/O problem; `wrote` lists what landed before it. Tell the user and resolve before retrying.

## Partial approve — the `chunks` field

The reviewer can deselect individual chunks (a chunk = one contiguous run of changed lines, or a whole binary file) and press "Apply N of M chunks". That is still an `approve` (exit 0), but the verdict JSON gains a `chunks` field:

```json
{ "verdict": "approve",
  "chunks": { "total": 4, "applied": 2,
    "skipped": [ { "file": "src/app.py", "hunk": 1, "run": 0, "kind": "update",
                   "dels": 1, "adds": 1, "oldLine": 21, "newLine": 21 } ],
    "appliedPatch": "<$DIR>/<session-id>/applied.patch",
    "revertPatch": "<$DIR>/<session-id>/revert.patch" } }
```

Skipped chunks are REJECTED content: do not apply them, do not fold them into later edits, and do not re-propose them unless the user asks. What you do next depends on the mode:

- **Proposal mode:** nothing — the CLI already wrote exactly the selected chunks (`apply` reflects it); the skipped ones were never written.
- **Worktree mode:** your working tree still contains ALL the changes, including the skipped ones. Remove them with `git apply <revertPatch>` (verify first with `git apply --check <revertPatch>`) — it deterministically turns the fully-changed tree into the approved subset. A skipped *binary* file cannot be expressed in that patch — restore it yourself (`git restore <file>`).
- **Patch mode:** apply `<appliedPatch>` (the selected-only diff against the base) instead of your original patch.

`skipped[]` coordinates are 0-based `hunk`/`run` indexes into that round's diff (`kind`: add / delete / update / binary; `oldLine`/`newLine` locate the first affected line) — useful to tell the user what you dropped, or to rebuild a later proposal without the rejected parts.

## Discussion — reply to each comment (exit 5)

Instead of deciding, the user can click **Discuss** to send you their line comments and ask you to reply to each. The command then exits 5 with the comments on stdout:

```json
{ "status": "discussion", "session": "2026-06-11-a1b2c3",
  "comments": [ { "thread": 1, "file": "src/auth.py", "side": "new", "line": 42,
                  "comment": "why not reuse the retry helper?" } ] }
```

Reply to **every** comment, honestly and concretely — a brief ACK is fine when you simply agree — then keep waiting for the verdict. A discussion does NOT block the user's decision (they can approve/reject at any time); you reply in the same review revision without changing any files, and they read your replies before deciding:

```bash
# answers.json: [{ "thread": 1, "answer": "the helper retries on 5xx only; this path needs 429 backoff" }]
node "$REVIEWER" answer <session-id> answers.json --dir "$DIR"
```

`answer` posts your replies (keyed by each comment's `thread` id) and then blocks like `wait` (same timeout/pending rules). Discussions are multi-turn: if the user discusses more comments — or replies back to one of your answers — you'll get another exit 5 the same way; a follow-up on an existing thread keeps its `thread` id and carries the earlier exchange in that comment's `history`. Do NOT change files while discussing — a discussion is conversation, not a change request; wait for the verdict.

## Re-submitting after request_changes (exit 2)

Fix — or consciously skip — every comment, then re-submit as the next round of the SAME session (same `--dir`!), with a reply per comment keyed by its 0-based index in the verdict's `comments` array:

```bash
# replies.json:
# [ { "comment": 0, "reply": "fixed — switched to the retry helper" },
#   { "comment": 1, "reply": "not changed: the null case is handled by the caller in src/api.py" } ]
node "$REVIEWER" review --worktree --session <id> --replies replies.json --title "..." --dir "$DIR"
```

Every comment needs a reply — what you changed, or why you deliberately didn't. The CLI rejects incomplete or out-of-range replies (exit 1) and lists the unanswered comments. The user sees your replies threaded under their comments in round 2; also briefly tell them what you changed.

## Troubleshooting

- `Unknown file extension ".ts"` or a syntax error inside `reviewer.ts` — the user's Node is older than 22.18 (no native type stripping). Ask them to upgrade Node; there is nothing to build or install.
- `listen EPERM` / socket permission error on start — a command sandbox is blocking the local UI server (it only binds 127.0.0.1). Re-run the command with the sandbox disabled.
- `unknown session "<id>" in <dir>` — you passed a different `--dir` than the one the review was created with. The pending/discussion JSON's `dir` field has the right one.
