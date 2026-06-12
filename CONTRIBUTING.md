# Contributing

The development guide — setup, repo layout, architecture, invariants, how to test — lives in **[AGENTS.md](AGENTS.md)**. It's written so coding agents can contribute, which makes it exactly the no-fluff reference a human wants too. Read that first; this file only covers the human-specific bits.

## TL;DR

```bash
npm install && npm link   # build + put `agent-change-reviewer` on PATH
npm run demo              # see it work
npm run dev               # tsc --watch while you hack
```

## What to work on

[ROADMAP.md](ROADMAP.md) is prioritized top-to-bottom from real usage. The headline item is the Claude Code `PreToolUse` hook; the most welcome small contribution is unit tests for `src/patch.ts`.

## Ground rules

- Keep the runtime dependency count at zero and the UI a single self-contained HTML file — these are deliberate constraints, not accidents (see the invariants section in [AGENTS.md](AGENTS.md)).
- If you change CLI flags, the verdict JSON, or exit codes, update the contract docs in the same change: `skill/change-review/SKILL.md` and the README (then re-run `agent-change-reviewer install claude|codex`).
