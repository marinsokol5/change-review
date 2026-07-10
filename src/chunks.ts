import type { DiffLine, FileDiff, FileStatus, Hunk, SkippedChunk } from "./types.js";

/**
 * A "chunk" is the unit the review UI lets the user apply or skip: one contiguous
 * run of +/- lines inside a hunk (an update, a pure delete, or a pure add), or a
 * whole binary file. Chunk identity is (file, hunk index, run index) against the
 * round's parsed patch — the UI derives runs the same way (hunkRuns in ui/index.html),
 * so the two MUST stay in sync.
 */
export interface ChunkRef {
  file: string;
  hunk?: number;
  run?: number;
  binary?: boolean;
}

interface Run {
  start: number;
  end: number;
}

/** Contiguous blocks of +/- lines inside a hunk — mirror of hunkRuns in ui/index.html. */
export function hunkRuns(lines: DiffLine[]): Run[] {
  const runs: Run[] = [];
  let start = -1;
  lines.forEach((ln, i) => {
    const changed = ln.type === "add" || ln.type === "del";
    if (changed && start < 0) start = i;
    if (!changed && start >= 0) {
      runs.push({ start, end: i - 1 });
      start = -1;
    }
  });
  if (start >= 0) runs.push({ start, end: lines.length - 1 });
  return runs;
}

export function filePathOf(f: FileDiff): string {
  return f.newPath ?? f.oldPath ?? "(unknown)";
}

export function fileChunkCount(f: FileDiff): number {
  if (f.status === "binary") return 1;
  return f.hunks.reduce((n, h) => n + hunkRuns(h.lines).length, 0);
}

export function totalChunks(files: FileDiff[]): number {
  return files.reduce((n, f) => n + fileChunkCount(f), 0);
}

const runKey = (hi: number, ri: number) => `${hi}.${ri}`;

function skippedSetFor(file: string, refs: ChunkRef[]): Set<string> {
  const s = new Set<string>();
  for (const r of refs) {
    if (r.file === file) s.add(r.binary ? "bin" : runKey(r.hunk!, r.run!));
  }
  return s;
}

function runIndexOfLines(h: Hunk, runs: Run[]): Array<number | null> {
  const runOf: Array<number | null> = h.lines.map(() => null);
  runs.forEach((r, ri) => {
    for (let i = r.start; i <= r.end; i++) runOf[i] = ri;
  });
  return runOf;
}

/** Validate raw skipped-chunk refs from a submission against the round's parsed diff. */
export function validateChunkRefs(files: FileDiff[], raw: unknown): ChunkRef[] | string {
  if (!Array.isArray(raw)) return "skipped must be an array of chunk refs";
  const byPath = new Map(files.map((f) => [filePathOf(f), f]));
  const seen = new Set<string>();
  const out: ChunkRef[] = [];
  for (const r of raw as Array<Record<string, unknown>>) {
    if (!r || typeof r.file !== "string") return "each skipped chunk needs a file (string)";
    const f = byPath.get(r.file);
    if (!f) return `skipped chunk references unknown file "${r.file}"`;
    if (r.binary === true) {
      if (f.status !== "binary") return `"${r.file}" is not a binary file`;
      const key = `${r.file}#bin`;
      if (seen.has(key)) return `duplicate skipped chunk for "${r.file}"`;
      seen.add(key);
      out.push({ file: r.file, binary: true });
      continue;
    }
    if (!Number.isInteger(r.hunk) || !Number.isInteger(r.run)) {
      return "each skipped chunk needs hunk and run (integers), or binary: true";
    }
    const hi = r.hunk as number;
    const ri = r.run as number;
    const h = f.hunks[hi];
    if (!h) return `"${r.file}" has no hunk ${hi}`;
    const runs = hunkRuns(h.lines);
    if (ri < 0 || ri >= runs.length) return `"${r.file}" hunk ${hi} has no chunk ${ri}`;
    const key = `${r.file}#${runKey(hi, ri)}`;
    if (seen.has(key)) return `duplicate skipped chunk ${key}`;
    seen.add(key);
    out.push({ file: r.file, hunk: hi, run: ri });
  }
  return out;
}

/** Human/agent-facing description of each skipped chunk for the verdict JSON. */
export function describeSkipped(files: FileDiff[], refs: ChunkRef[]): SkippedChunk[] {
  const byPath = new Map(files.map((f) => [filePathOf(f), f]));
  const sorted = [...refs].sort(
    (a, b) =>
      a.file.localeCompare(b.file) || (a.hunk ?? -1) - (b.hunk ?? -1) || (a.run ?? -1) - (b.run ?? -1),
  );
  return sorted.map((r) => {
    if (r.binary) return { file: r.file, binary: true, kind: "binary" as const };
    const h = byPath.get(r.file)!.hunks[r.hunk!];
    const run = hunkRuns(h.lines)[r.run!];
    const lines = h.lines.slice(run.start, run.end + 1);
    const dels = lines.filter((l) => l.type === "del");
    const adds = lines.filter((l) => l.type === "add");
    const kind = dels.length > 0 && adds.length > 0 ? "update" : adds.length > 0 ? "add" : "delete";
    return {
      file: r.file,
      hunk: r.hunk!,
      run: r.run!,
      kind: kind as SkippedChunk["kind"],
      ...(adds.length > 0 && { adds: adds.length, newLine: adds[0].newLine ?? undefined }),
      ...(dels.length > 0 && { dels: dels.length, oldLine: dels[0].oldLine ?? undefined }),
    };
  });
}

/**
 * The selected-only diff (base → partial): skipped runs' deletions revert to context,
 * their additions vanish, and new-side line numbers are renumbered as if only the kept
 * runs were applied. Files/hunks left without changes are dropped. Skipped binary files
 * are dropped (a binary file is a single all-or-nothing chunk).
 */
export function filterFiles(files: FileDiff[], skipped: ChunkRef[]): FileDiff[] {
  const out: FileDiff[] = [];
  for (const f of files) {
    const skip = skippedSetFor(filePathOf(f), skipped);
    if (f.status === "binary") {
      if (!skip.has("bin")) out.push(f);
      continue;
    }
    if (skip.size === 0) {
      out.push(f);
      continue;
    }
    const nf: FileDiff = { ...f, hunks: [] };
    // Cumulative (adds - dels) of skipped runs so far: how much the new-side numbering
    // of everything after them shifts down once those runs are no longer applied.
    let shift = 0;
    for (const [hi, h] of f.hunks.entries()) {
      const runs = hunkRuns(h.lines);
      const runOf = runIndexOfLines(h, runs);
      const isSkipped = (ri: number | null) => ri != null && skip.has(runKey(hi, ri));
      const newStart = h.newStart - shift;
      let lastNew = newStart - 1;
      const lines: DiffLine[] = [];
      let changed = false;
      for (const [li, ln] of h.lines.entries()) {
        const drop = isSkipped(runOf[li]);
        if (ln.type === "add") {
          if (drop) continue; // the skipped addition never happens
          lines.push({ ...ln, newLine: ++lastNew });
          changed = true;
        } else if (ln.type === "del") {
          if (drop) {
            // the skipped deletion never happens — the base line stays, as context
            lines.push({
              type: "context",
              oldLine: ln.oldLine,
              newLine: ++lastNew,
              text: ln.text,
              ...(ln.noNewline && { noNewline: true }),
            });
          } else {
            lines.push({ ...ln });
            changed = true;
          }
        } else {
          lines.push({ ...ln, newLine: ++lastNew });
        }
      }
      for (const [ri, r] of runs.entries()) {
        if (!skip.has(runKey(hi, ri))) continue;
        const ls = h.lines.slice(r.start, r.end + 1);
        shift += ls.filter((l) => l.type === "add").length - ls.filter((l) => l.type === "del").length;
      }
      if (!changed) continue; // every run skipped — the hunk is pure context now
      const oldCount = lines.filter((l) => l.type !== "add").length;
      const newCount = lines.filter((l) => l.type !== "del").length;
      nf.hunks.push({ oldStart: h.oldStart, oldCount, newStart, newCount, section: h.section, lines });
    }
    if (nf.hunks.length === 0) continue; // whole file skipped
    out.push(nf);
  }
  return out;
}

/**
 * The diff that turns a FULLY-applied tree into the selected-only tree (worktree mode:
 * the working tree already has every change; `git apply` this to drop the skipped ones).
 * Kept runs become context, skipped runs are reversed: their additions get deleted,
 * their deletions restored. Old side = proposed numbering, new side = partial numbering.
 * Skipped binary files can't be expressed and are omitted (reported in `chunks.skipped`).
 */
export function revertFiles(files: FileDiff[], skipped: ChunkRef[]): FileDiff[] {
  const out: FileDiff[] = [];
  for (const f of files) {
    const fp = filePathOf(f);
    const skip = skippedSetFor(fp, skipped);
    if (skip.size === 0 || f.status === "binary") continue;
    const total = fileChunkCount(f);
    let status: FileStatus = "modified";
    if (f.status === "added" && skip.size >= total) status = "deleted"; // un-create the new file
    if (f.status === "deleted" && skip.size >= total) status = "added"; // restore the deleted file
    const onDisk = f.newPath ?? f.oldPath;
    const nf: FileDiff = { oldPath: onDisk, newPath: onDisk, status, hunks: [] };
    let shift = 0; // cumulative (adds - dels) of skipped runs so far
    for (const [hi, h] of f.hunks.entries()) {
      const runs = hunkRuns(h.lines);
      const hasSkipped = runs.some((_, ri) => skip.has(runKey(hi, ri)));
      if (!hasSkipped) continue; // nothing to revert in this hunk
      const runOf = runIndexOfLines(h, runs);
      // If the original hunk was pure deletion, its newStart uses git's "line before"
      // convention — the first restored line actually lands one past it.
      const newStartSeed = h.newStart - shift + (h.newCount === 0 ? 1 : 0);
      let lastNew = newStartSeed - 1;
      const lines: DiffLine[] = [];
      const flagOf = (ln: DiffLine) => (ln.noNewline ? { noNewline: true as const } : {});
      let li = 0;
      while (li < h.lines.length) {
        const ri = runOf[li];
        if (ri == null) {
          const ln = h.lines[li];
          lines.push({ type: "context", oldLine: ln.newLine, newLine: ++lastNew, text: ln.text, ...flagOf(ln) });
          li++;
          continue;
        }
        const runLines = h.lines.slice(runs[ri].start, runs[ri].end + 1);
        if (skip.has(runKey(hi, ri))) {
          // Reverse the run — deletions first, then additions, so the `\ No newline`
          // markers stay attached to the last line of each side.
          for (const ln of runLines) {
            if (ln.type === "add") lines.push({ type: "del", oldLine: ln.newLine, newLine: null, text: ln.text, ...flagOf(ln) });
          }
          for (const ln of runLines) {
            if (ln.type === "del") lines.push({ type: "add", oldLine: null, newLine: ++lastNew, text: ln.text, ...flagOf(ln) });
          }
        } else {
          // Kept run: its additions exist on both sides (context); its deletions on neither.
          for (const ln of runLines) {
            if (ln.type === "add") lines.push({ type: "context", oldLine: ln.newLine, newLine: ++lastNew, text: ln.text, ...flagOf(ln) });
          }
        }
        li = runs[ri].end + 1;
      }
      for (const [ri, r] of runs.entries()) {
        if (!skip.has(runKey(hi, ri))) continue;
        const ls = h.lines.slice(r.start, r.end + 1);
        shift += ls.filter((l) => l.type === "add").length - ls.filter((l) => l.type === "del").length;
      }
      const oldCount = lines.filter((l) => l.type !== "add").length;
      const newCount = lines.filter((l) => l.type !== "del").length;
      // An emptied new side gets the "line before" convention too (mirrors git).
      const newStart = newCount === 0 ? newStartSeed - 1 : newStartSeed;
      nf.hunks.push({ oldStart: h.newStart, oldCount, newStart, newCount, section: h.section, lines });
    }
    if (nf.hunks.length === 0) continue;
    out.push(nf);
  }
  return out;
}

const NO_NEWLINE = "\\ No newline at end of file";

/** Serialize parsed diffs back to unified-diff text that `git apply` accepts. */
export function serializePatch(files: FileDiff[]): string {
  const out: string[] = [];
  for (const f of files) {
    const oldP = f.oldPath ?? f.newPath ?? "(unknown)";
    const newP = f.newPath ?? f.oldPath ?? "(unknown)";
    out.push(`diff --git a/${oldP} b/${newP}`);
    if (f.status === "binary") {
      out.push(`Binary files a/${oldP} and b/${newP} differ`);
      continue;
    }
    if (f.status === "added") out.push("new file mode 100644");
    if (f.status === "deleted") out.push("deleted file mode 100644");
    if (f.status === "renamed") {
      out.push(`rename from ${oldP}`);
      out.push(`rename to ${newP}`);
    }
    if (f.hunks.length === 0) continue; // pure rename
    out.push(f.status === "added" ? "--- /dev/null" : `--- a/${oldP}`);
    out.push(f.status === "deleted" ? "+++ /dev/null" : `+++ b/${newP}`);
    for (const h of f.hunks) {
      out.push(`@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@${h.section ? " " + h.section : ""}`);
      for (const ln of h.lines) {
        const sign = ln.type === "add" ? "+" : ln.type === "del" ? "-" : " ";
        out.push(sign + ln.text);
        if (ln.noNewline) out.push(NO_NEWLINE);
      }
    }
  }
  return out.length > 0 ? out.join("\n") + "\n" : "";
}

/**
 * Apply a (possibly filtered) FileDiff to the base text, byte-for-byte deterministic:
 * every context and deleted line must match the base exactly at its stated position,
 * otherwise this throws — no fuzzing, no drift.
 */
export function applyFileDiffToContent(base: string, f: FileDiff): string {
  const baseEndsNL = base === "" || base.endsWith("\n");
  const baseLines = base === "" ? [] : base.split("\n");
  if (baseEndsNL && baseLines.length > 0) baseLines.pop();

  const outLines: string[] = [];
  let lastNoNL = false; // whether the current last output line ends without a newline
  let cursor = 0; // 0-based index into baseLines of the next unconsumed base line

  const copyBase = (untilExclusive: number) => {
    for (; cursor < untilExclusive; cursor++) {
      outLines.push(baseLines[cursor]);
      lastNoNL = cursor === baseLines.length - 1 && !baseEndsNL;
    }
  };

  for (const h of f.hunks) {
    const hunkBase = h.oldCount === 0 ? h.oldStart : h.oldStart - 1; // -N,0 inserts AFTER line N
    if (hunkBase < cursor) throw new Error(`overlapping hunks at -${h.oldStart}`);
    copyBase(hunkBase);
    for (const ln of h.lines) {
      if (ln.type === "add") {
        outLines.push(ln.text);
        lastNoNL = ln.noNewline === true;
        continue;
      }
      if (cursor >= baseLines.length) {
        throw new Error(`hunk at -${h.oldStart} runs past the end of the base file`);
      }
      if (baseLines[cursor] !== ln.text) {
        throw new Error(
          `base mismatch at line ${cursor + 1}: expected ${JSON.stringify(ln.text)}, found ${JSON.stringify(baseLines[cursor])}`,
        );
      }
      if (ln.type === "context") {
        outLines.push(ln.text);
        lastNoNL = ln.noNewline === true || (cursor === baseLines.length - 1 && !baseEndsNL);
      }
      cursor++;
    }
  }
  copyBase(baseLines.length);

  if (outLines.length === 0) return "";
  return outLines.join("\n") + (lastNoNL ? "" : "\n");
}
