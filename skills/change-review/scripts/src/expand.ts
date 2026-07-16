import fs from "node:fs";
import path from "node:path";
import { readStagedFile } from "./session.ts";
import type { FileDiff, Hunk } from "./types.ts";

// Context expansion ("show the hidden lines around a hunk", like GitHub's ⤒/⤓
// arrows). The patch alone doesn't contain those lines, so they must come from
// real file contents — and serving the *wrong* lines is worse than serving
// none, so a source is only used after verifying it against every line the
// patch does know. Everything here speaks new-side (proposed) line numbers;
// base-side content is mapped through the hunks' gap offsets.

/** First/next line helpers tolerant of zero-count hunks (-U0 diffs), where the
 *  start is by convention the line *before* the hunk's position. */
export const firstNewLine = (h: Hunk): number => (h.newCount === 0 ? h.newStart + 1 : h.newStart);
export const nextNewLine = (h: Hunk): number => firstNewLine(h) + h.newCount;
export const firstOldLine = (h: Hunk): number => (h.oldCount === 0 ? h.oldStart + 1 : h.oldStart);
export const nextOldLine = (h: Hunk): number => firstOldLine(h) + h.oldCount;

/** File text -> lines, without a phantom empty line from a trailing newline. */
export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Which side of the diff a verified content source represents. */
export interface FileContent {
  lines: string[];
  side: "new" | "base";
}

/** True when `lines` agrees with every line the patch knows on the new side (context + adds). */
export function matchesNewSide(f: FileDiff, lines: string[]): boolean {
  for (const h of f.hunks) {
    for (const ln of h.lines) {
      if (ln.newLine != null && lines[ln.newLine - 1] !== ln.text) return false;
    }
  }
  return true;
}

/** True when `lines` agrees with every line the patch knows on the base side (context + dels). */
export function matchesBaseSide(f: FileDiff, lines: string[]): boolean {
  for (const h of f.hunks) {
    for (const ln of h.lines) {
      if (ln.oldLine != null && lines[ln.oldLine - 1] !== ln.text) return false;
    }
  }
  return true;
}

/** Total line count of the proposed (new-side) file, derivable from either side's content. */
export function newTotal(f: FileDiff, c: FileContent): number {
  if (c.side === "new") return c.lines.length;
  const last = f.hunks[f.hunks.length - 1];
  return c.lines.length - (nextOldLine(last) - nextNewLine(last));
}

/**
 * Find verified contents for a diffed file: the staged proposal snapshot first
 * (exact reviewed bytes), then the file in the session's cwd — as the new side
 * (worktree/proposal mode) or, failing that, as the base (an unapplied patch).
 * Returns null when nothing checks out; expansion is then simply unavailable.
 */
export function contentForFile(sessionId: string, cwd: string, f: FileDiff): FileContent | null {
  if ((f.status !== "modified" && f.status !== "renamed") || f.hunks.length === 0) return null;
  const rel = f.newPath ?? f.oldPath;
  if (!rel) return null;

  const staged = readStagedFile(sessionId, rel);
  if (staged) {
    const lines = splitLines(staged.toString("utf8"));
    if (matchesNewSide(f, lines)) return { lines, side: "new" };
  }
  const read = (p: string): string[] | null => {
    try {
      return splitLines(fs.readFileSync(path.resolve(cwd, p), "utf8"));
    } catch {
      return null;
    }
  };
  const cur = read(rel);
  if (cur && matchesNewSide(f, cur)) return { lines: cur, side: "new" };
  const baseRel = f.oldPath ?? rel;
  const base = baseRel === rel ? cur : read(baseRel);
  if (base && matchesBaseSide(f, base)) return { lines: base, side: "base" };
  return null;
}

/**
 * The texts of new-side lines [from, to] (1-based, inclusive), clamped to the
 * file's end. Base-side content can only serve ranges that fall entirely inside
 * one gap between hunks (elsewhere the two sides disagree); the UI only ever
 * asks for gaps, so hitting that error means the request was malformed.
 */
export function sliceNewRange(f: FileDiff, c: FileContent, from: number, to: number): string[] | string {
  const total = newTotal(f, c);
  const end = Math.min(to, total);
  if (from > end) return [];
  if (c.side === "new") return c.lines.slice(from - 1, end);

  const hunks = f.hunks;
  let delta: number | null = null; // old = new + delta, constant within a gap
  if (end < firstNewLine(hunks[0])) {
    delta = firstOldLine(hunks[0]) - firstNewLine(hunks[0]);
  } else {
    for (let i = 0; i < hunks.length; i++) {
      const gapStart = nextNewLine(hunks[i]);
      const gapEnd = i + 1 < hunks.length ? firstNewLine(hunks[i + 1]) - 1 : total;
      if (from >= gapStart && end <= gapEnd) {
        delta = nextOldLine(hunks[i]) - nextNewLine(hunks[i]);
        break;
      }
    }
  }
  if (delta == null) return "the requested range crosses the diff's changed lines";
  return c.lines.slice(from - 1 + delta, end + delta);
}
