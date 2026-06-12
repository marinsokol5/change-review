import fs from "node:fs";
import path from "node:path";

/**
 * Codex's apply_patch ("V4A") envelope format:
 *
 *   *** Begin Patch
 *   *** Update File: src/app.ts
 *   [*** Move to: src/renamed.ts]
 *   @@ optional locator (e.g. a function header)
 *    context line
 *   -removed line
 *   +added line
 *   *** Add File: src/new.ts
 *   +line 1
 *   *** Delete File: src/old.ts
 *   *** End Patch
 *
 * We apply it in memory against the working tree to get old/new contents per
 * file, so the hook can show a real diff. Any mismatch returns null — the hook
 * then stays silent and lets apply_patch itself succeed or fail.
 */

export interface FileChange {
  rel: string; // display path (the new path for moves)
  oldText: string | null; // null = file is being created
  newText: string | null; // null = file is being deleted
}

function readFileOrNull(cwd: string, rel: string): string | null {
  try {
    return fs.readFileSync(path.resolve(cwd, rel), "utf8");
  } catch {
    return null;
  }
}

export function applyPatchChanges(patch: string, cwd: string): FileChange[] | null {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines[0]?.trim() !== "*** Begin Patch" || lines[lines.length - 1]?.trim() !== "*** End Patch") return null;
  const body = lines.slice(1, -1);

  const changes: FileChange[] = [];
  let i = 0;
  let m: RegExpExecArray | null;
  while (i < body.length) {
    const line = body[i];
    if ((m = /^\*\*\* Add File: (.+)$/.exec(line))) {
      i++;
      const content: string[] = [];
      while (i < body.length && !body[i].startsWith("*** ")) {
        if (!body[i].startsWith("+")) return null;
        content.push(body[i].slice(1));
        i++;
      }
      changes.push({ rel: m[1].trim(), oldText: null, newText: content.join("\n") + (content.length ? "\n" : "") });
    } else if ((m = /^\*\*\* Delete File: (.+)$/.exec(line))) {
      const rel = m[1].trim();
      const old = readFileOrNull(cwd, rel);
      if (old == null) return null;
      changes.push({ rel, oldText: old, newText: null });
      i++;
    } else if ((m = /^\*\*\* Update File: (.+)$/.exec(line))) {
      const rel = m[1].trim();
      i++;
      let moveTo: string | undefined;
      const mv = i < body.length ? /^\*\*\* Move to: (.+)$/.exec(body[i]) : null;
      if (mv) {
        moveTo = mv[1].trim();
        i++;
      }
      const section: string[] = [];
      while (i < body.length && (!body[i].startsWith("*** ") || body[i].trim() === "*** End of File")) {
        section.push(body[i]);
        i++;
      }
      const old = readFileOrNull(cwd, rel);
      if (old == null) return null;
      const updated = applyUpdate(old, section);
      if (updated == null) return null;
      changes.push({ rel: moveTo ?? rel, oldText: old, newText: updated });
    } else if (line.trim() === "") {
      i++;
    } else {
      return null;
    }
  }
  return changes.length ? changes : null;
}

function applyUpdate(oldText: string, section: string[]): string | null {
  const hadNewline = oldText.endsWith("\n");
  const split = oldText.split("\n");
  const src = hadNewline ? split.slice(0, -1) : split;
  const out: string[] = [];
  let index = 0; // next unconsumed line of src

  let i = 0;
  while (i < section.length) {
    const line = section[i];
    if (line.trim() === "*** End of File") {
      i++;
      continue;
    }
    if (line.startsWith("@@")) {
      const locator = line.slice(2).trim();
      i++;
      if (!locator) continue; // bare @@ is just a chunk separator
      let found = -1;
      for (let j = index; j < src.length; j++) {
        if (src[j] === locator || src[j].trim() === locator) {
          found = j;
          break;
        }
      }
      if (found < 0) return null;
      out.push(...src.slice(index, found + 1));
      index = found + 1;
      continue;
    }

    // One chunk: a run of context/removed/added lines.
    const oldChunk: string[] = [];
    const newChunk: string[] = [];
    while (i < section.length && !section[i].startsWith("@@") && section[i].trim() !== "*** End of File") {
      const l = section[i];
      if (l.startsWith(" ") || l === "") {
        // editors sometimes strip the leading space from empty context lines
        const text = l === "" ? "" : l.slice(1);
        oldChunk.push(text);
        newChunk.push(text);
      } else if (l.startsWith("-")) {
        oldChunk.push(l.slice(1));
      } else if (l.startsWith("+")) {
        newChunk.push(l.slice(1));
      } else {
        return null;
      }
      i++;
    }
    const pos = findChunk(src, oldChunk, index);
    if (pos < 0) return null;
    out.push(...src.slice(index, pos));
    out.push(...newChunk);
    index = pos + oldChunk.length;
  }
  out.push(...src.slice(index));
  return out.join("\n") + (hadNewline ? "\n" : "");
}

/** Exact match first, then increasingly whitespace-tolerant (mirrors the reference apply_patch). */
function findChunk(src: string[], chunk: string[], from: number): number {
  if (chunk.length === 0) return from;
  const eqs: Array<(a: string, b: string) => boolean> = [
    (a, b) => a === b,
    (a, b) => a.trimEnd() === b.trimEnd(),
    (a, b) => a.trim() === b.trim(),
  ];
  for (const eq of eqs) {
    for (let j = from; j + chunk.length <= src.length; j++) {
      let ok = true;
      for (let k = 0; k < chunk.length; k++) {
        if (!eq(src[j + k], chunk[k])) {
          ok = false;
          break;
        }
      }
      if (ok) return j;
    }
  }
  return -1;
}
