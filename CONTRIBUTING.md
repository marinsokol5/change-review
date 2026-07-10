# Contributing

The development guide — setup, repo layout, architecture, invariants, how to test — lives in **[AGENTS.md](AGENTS.md)**. It's written so coding agents can contribute, which makes it exactly the no-fluff reference a human wants too. Read that first; this file only covers the human-specific bits.

## TL;DR

```bash
npm install     # dev deps only (TypeScript, for type-checking — nothing is built)
npm run demo    # see it work: node runs reviewer.ts directly (Node >= 22.18)
npm run check   # tsc --noEmit before you push
```

## What to work on

[ROADMAP.md](ROADMAP.md) is prioritized top-to-bottom from real usage. The most welcome small contribution is unit tests for `src/patch.ts`.

## Ground rules

- Keep the runtime dependency count at zero, the UI a single self-contained HTML file, and the sources runnable by plain `node` (erasable TypeScript only, no build step) — these are deliberate constraints, not accidents (see the invariants section in [AGENTS.md](AGENTS.md)).
- If you change CLI flags, the verdict JSON, or exit codes, update the contract docs in the same change: root `SKILL.md` and the README.
