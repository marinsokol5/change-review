# change-review

**Code review for AI coding agents — with you as the reviewer.** Your agent proposes a change, your browser opens a GitHub-style inline diff, and your verdict — with line comments — goes straight back to the agent as JSON.

```
agent ──"node reviewer.ts review …"──▶ diff UI in your browser
you  ───── comments + verdict ──────▶ back to the agent
                                       (JSON on stdout, exit code = verdict)
```

Agents write diffs faster than anyone can read them in a terminal. change-review turns the wall of scrolling green text into a review you can actually do:

- **A real diff UI** — inline, in your browser. Hover a line, click `+`, comment.
- **Apply only what you approve** — every chunk has a checkbox in the gutter. Untick the parts you don't want; **Apply** lands exactly the rest.
- **Discuss before you decide** — send your comments to the agent mid-review; its replies thread inline, as many turns as you need.
- **Rounds, not restarts** — on **Request changes** the agent resubmits to the same review, its replies threaded under your comments. Earlier rounds stay browsable; a ⇄ view diffs any two revisions.
- **Nothing to babysit** — the review server outlives the agent's command, so a verdict is never lost to a timeout. Zero runtime dependencies, one self-contained HTML file, binds `127.0.0.1` only.

## Install

This repo **is** the skill — installing it is copying it into your agent's skills folder:

```bash
git clone https://github.com/marinsokol5/change-review ~/.claude/skills/change-review    # Claude Code
git clone https://github.com/marinsokol5/change-review ~/.codex/skills/change-review     # Codex
```

Requires **Node >= 22.18**: the CLI is TypeScript that `node` runs directly, so there is no build step and no `npm install`. Restart your agent session so it picks the skill up; update later with `git pull`.

Try it without an agent:

```bash
node reviewer.ts review examples/demo.patch --title "Demo review"
```

## How it works

The agent runs `node <skill-dir>/reviewer.ts review` with `--worktree` (review uncommitted changes), `--proposal <dir>` (review *before* anything is written — on approve the CLI itself writes the reviewed bytes, sha256-verified, all-or-nothing, filtered to your chunk selection), or any unified diff. The command blocks until you decide:

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

Exit codes mirror the verdict: `0` approve · `2` request_changes · `3` reject · `4` pending · `5` discussion · `1` error.

Sessions live in a temp directory the agent picks (`--dir`); nothing is written to fixed global paths. The UI server runs detached, so when the agent's command times out the review just keeps waiting — by default the agent ends its turn and picks the verdict up when you're done (`config wait-mode poll` makes it wait in a loop instead). Draft comments persist in localStorage, so a closed tab loses nothing.

- **[SKILL.md](SKILL.md)** — the full agent contract (commands, JSON shapes, exit codes)
- **[AGENTS.md](AGENTS.md)** — development guide (architecture, invariants, how to test)
- **[ROADMAP.md](ROADMAP.md)** — what's next

## License

[MIT](LICENSE)
