import type { DiffLine, FileDiff, FileStatus, Hunk } from "./types.js";

// Computes the diff *between two rounds* of the same review: given round A's and
// round B's patches (both produced against the same base tree), emit FileDiffs
// describing how the proposed change evolved from A to B.
//
// A patch only carries the base lines it touches, so each round's proposed file
// is reconstructed as a token sequence where untouched base regions become
// content-less tokens identified by base line number. Both rounds leave those
// regions identical, so the tokens compare equal across reconstructions — and any
// line that actually differs between the rounds was touched by at least one
// patch, meaning its text is always known. Unknown-content tokens can therefore
// only ever be unchanged context; they are never shown and never let two hunks
// merge across them.

/** One line of a round's reconstructed proposed file. `base` is the base-file
 *  line it corresponds to (null for lines the round added, -1 for the shared
 *  "rest of the base file" sentinel); `text` is null when the content appears
 *  in neither round's patch. */
interface Tok {
  text: string | null;
  base: number | null;
  noNewline?: boolean;
}

const CTX = 3;

function tokEq(x: Tok, y: Tok): boolean {
  if (x.text != null && x.text === y.text) return true;
  return x.base != null && x.base === y.base;
}

/** Base-line contents mentioned by either patch (context + deleted lines).
 *  A disagreement means the rounds were diffed against different bases. */
function collectBaseText(files: Array<FileDiff | null>): { map: Map<number, string>; mismatch: boolean } {
  const map = new Map<number, string>();
  let mismatch = false;
  for (const f of files) {
    for (const h of f?.hunks ?? []) {
      for (const l of h.lines) {
        if (l.oldLine == null) continue;
        const seen = map.get(l.oldLine);
        if (seen === undefined) map.set(l.oldLine, l.text);
        else if (seen !== l.text) mismatch = true;
      }
    }
  }
  return { map, mismatch };
}

function lastOldLine(f: FileDiff | null): number {
  let last = 0;
  for (const h of f?.hunks ?? []) last = Math.max(last, h.oldStart + h.oldCount - 1);
  return last;
}

function reconstruct(
  f: FileDiff | null,
  coverEnd: number,
  baseText: Map<number, string>,
  baseExists: boolean,
): Tok[] {
  const out: Tok[] = [];
  let b = 1;
  const gapTo = (end: number) => {
    for (; b < end; b++) out.push({ text: baseText.get(b) ?? null, base: b });
  };
  const hunks = [...(f?.hunks ?? [])].sort((x, y) => x.oldStart - y.oldStart);
  for (const h of hunks) {
    // A zero-oldCount hunk inserts *after* base line oldStart, so that line is still a gap.
    gapTo(h.oldCount === 0 ? h.oldStart + 1 : h.oldStart);
    for (const l of h.lines) {
      if (l.type === "add") out.push({ text: l.text, base: null, ...(l.noNewline && { noNewline: true }) });
      else if (l.type === "context")
        out.push({ text: l.text, base: l.oldLine, ...(l.noNewline && { noNewline: true }) });
      if (l.oldLine != null) b = l.oldLine + 1;
    }
  }
  if (baseExists) {
    gapTo(coverEnd);
    // Base lines past both patches' coverage — identical in both rounds by construction.
    out.push({ text: null, base: -1 });
  }
  return out;
}

/** e: a[ai] ~ b[bi] · d: a[ai] only · a: b[bi] only. Unused index is -1. */
interface Op {
  t: "e" | "d" | "a";
  ai: number;
  bi: number;
}

function diffToks(a: Tok[], b: Tok[]): Op[] {
  const ops: Op[] = [];
  let lo = 0;
  let aHi = a.length;
  let bHi = b.length;
  while (lo < aHi && lo < bHi && tokEq(a[lo], b[lo])) {
    ops.push({ t: "e", ai: lo, bi: lo });
    lo++;
  }
  const tail: Op[] = [];
  while (aHi > lo && bHi > lo && tokEq(a[aHi - 1], b[bHi - 1])) {
    aHi--;
    bHi--;
    tail.push({ t: "e", ai: aHi, bi: bHi });
  }
  ops.push(...myers(a, b, lo, aHi, lo, bHi));
  ops.push(...tail.reverse());
  return ops;
}

/** Classic Myers over a[a0,a1) × b[b0,b1). Falls back to delete-all/add-all when
 *  a side is empty or the region is too large for a minimal diff to matter. */
function myers(a: Tok[], b: Tok[], a0: number, a1: number, b0: number, b1: number): Op[] {
  const n = a1 - a0;
  const m = b1 - b0;
  const fallback = (): Op[] => {
    const ops: Op[] = [];
    for (let i = a0; i < a1; i++) ops.push({ t: "d", ai: i, bi: -1 });
    for (let j = b0; j < b1; j++) ops.push({ t: "a", ai: -1, bi: j });
    return ops;
  };
  if (n === 0 || m === 0 || n + m > 5000) return fallback();
  const max = n + m;
  const off = max;
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];
  let dFound = -1;
  for (let d = 0; d <= max && dFound < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && tokEq(a[a0 + x], b[b0 + y])) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        dFound = d;
        break;
      }
    }
    trace.push(Int32Array.from(v));
  }
  if (dFound < 0) return fallback();

  const rev: Op[] = [];
  let x = n;
  let y = m;
  for (let d = dFound; d > 0; d--) {
    const pv = trace[d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && pv[off + k - 1] < pv[off + k + 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = pv[off + prevK];
    const prevY = prevX - prevK;
    const snakeX = down ? prevX : prevX + 1;
    while (x > snakeX) {
      x--;
      y--;
      rev.push({ t: "e", ai: a0 + x, bi: b0 + y });
    }
    if (down) {
      y--;
      rev.push({ t: "a", ai: -1, bi: b0 + y });
    } else {
      x--;
      rev.push({ t: "d", ai: a0 + x, bi: -1 });
    }
  }
  while (x > 0) {
    x--;
    y--;
    rev.push({ t: "e", ai: a0 + x, bi: b0 + y });
  }
  return rev.reverse();
}

function opsToHunks(a: Tok[], b: Tok[], ops: Op[]): Hunk[] {
  const text = (o: Op): string | null =>
    o.t === "e" ? (a[o.ai].text ?? b[o.bi].text) : o.t === "d" ? a[o.ai].text : b[o.bi].text;
  const showable = (o: Op): boolean => text(o) != null;

  // How many a-side / b-side lines precede each op — for hunk headers.
  const aPos = new Int32Array(ops.length + 1);
  const bPos = new Int32Array(ops.length + 1);
  for (let t = 0; t < ops.length; t++) {
    aPos[t + 1] = aPos[t] + (ops[t].t !== "a" ? 1 : 0);
    bPos[t + 1] = bPos[t] + (ops[t].t !== "d" ? 1 : 0);
  }

  const hunks: Hunk[] = [];
  let i = 0;
  let prevEnd = 0;
  while (i < ops.length) {
    if (ops[i].t === "e") {
      i++;
      continue;
    }
    // Extend the change block across displayable-context gaps of ≤ 2·CTX lines.
    let end = i + 1;
    let j = i + 1;
    while (j < ops.length) {
      if (ops[j].t !== "e") {
        j++;
        end = j;
        continue;
      }
      let k = j;
      let ok = true;
      while (k < ops.length && ops[k].t === "e") {
        if (!showable(ops[k])) ok = false;
        k++;
      }
      if (k >= ops.length || !ok || k - j > 2 * CTX) break;
      j = k;
    }
    let lead = i;
    while (lead > prevEnd && i - lead < CTX && ops[lead - 1].t === "e" && showable(ops[lead - 1])) lead--;
    let trail = end;
    while (trail < ops.length && trail - end < CTX && ops[trail].t === "e" && showable(ops[trail])) trail++;

    const lines: DiffLine[] = [];
    for (let t = lead; t < trail; t++) {
      const o = ops[t];
      if (o.t === "e") {
        lines.push({
          type: "context",
          oldLine: o.ai + 1,
          newLine: o.bi + 1,
          text: text(o) ?? "",
          ...(a[o.ai].noNewline && { noNewline: true }),
        });
      } else if (o.t === "d") {
        lines.push({
          type: "del",
          oldLine: o.ai + 1,
          newLine: null,
          text: a[o.ai].text ?? "…",
          ...(a[o.ai].noNewline && { noNewline: true }),
        });
      } else {
        lines.push({
          type: "add",
          oldLine: null,
          newLine: o.bi + 1,
          text: b[o.bi].text ?? "…",
          ...(b[o.bi].noNewline && { noNewline: true }),
        });
      }
    }
    const oldCount = aPos[trail] - aPos[lead];
    const newCount = bPos[trail] - bPos[lead];
    hunks.push({
      oldStart: oldCount ? aPos[lead] + 1 : aPos[lead],
      oldCount,
      newStart: newCount ? bPos[lead] + 1 : bPos[lead],
      newCount,
      section: "",
      lines,
    });
    prevEnd = trail;
    i = trail;
  }
  return hunks;
}

function interdiffFile(A: FileDiff | null, B: FileDiff | null): FileDiff | null {
  const baseName = A?.oldPath ?? B?.oldPath ?? A?.newPath ?? B?.newPath ?? null;
  if (A?.status === "binary" || B?.status === "binary") {
    return { oldPath: baseName, newPath: baseName, status: "binary", hunks: [] };
  }
  // A round that says "added" diffed against no base file; a round that doesn't
  // mention the file leaves it at its base state.
  const baseExists = !(A?.status === "added" || B?.status === "added");
  const exists1 = A ? A.status !== "deleted" && A.newPath !== null : baseExists;
  const exists2 = B ? B.status !== "deleted" && B.newPath !== null : baseExists;
  if (!exists1 && !exists2) return null;

  const { map, mismatch } = collectBaseText([A, B]);
  const coverEnd = Math.max(lastOldLine(A), lastOldLine(B)) + 1;
  const new1 = reconstruct(A, coverEnd, map, baseExists);
  const new2 = reconstruct(B, coverEnd, map, baseExists);
  const hunks = opsToHunks(new1, new2, diffToks(new1, new2));

  const name1 = A ? A.newPath : baseName;
  const name2 = B ? B.newPath : baseName;
  let status: FileStatus = !exists1 ? "added" : !exists2 ? "deleted" : "modified";
  if (status === "modified" && name1 !== name2) status = "renamed";
  if (status === "modified" && hunks.length === 0) return null; // identical in both rounds

  const fd: FileDiff = { oldPath: name1, newPath: name2, status, hunks };
  if (mismatch) {
    fd.warning =
      "The two rounds disagree about this file's original contents (the base changed between rounds) — this comparison may be inaccurate.";
  }
  return fd;
}

/** Diff round A's patch against round B's, pairing files by path (a file renamed
 *  by one round is paired through its base path). */
export function interdiffFiles(aFiles: FileDiff[], bFiles: FileDiff[]): FileDiff[] {
  const bByPath = new Map<string, FileDiff>();
  for (const f of bFiles) {
    if (f.oldPath) bByPath.set(f.oldPath, f);
    if (f.newPath) bByPath.set(f.newPath, f);
  }
  const usedB = new Set<FileDiff>();
  const pairs: Array<[FileDiff | null, FileDiff | null]> = [];
  for (const f of aFiles) {
    const match = (f.newPath && bByPath.get(f.newPath)) || (f.oldPath && bByPath.get(f.oldPath)) || null;
    if (match) usedB.add(match);
    pairs.push([f, match]);
  }
  for (const f of bFiles) if (!usedB.has(f)) pairs.push([null, f]);

  const out: FileDiff[] = [];
  for (const [A, B] of pairs) {
    const f = interdiffFile(A, B);
    if (f) out.push(f);
  }
  return out;
}
