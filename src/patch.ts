import type { FileDiff, Hunk } from "./types.js";

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

function stripPathPrefix(raw: string): string | null {
  // "a/path", "b/path", possibly followed by a tab + timestamp (plain `diff -u`)
  const p = raw.split("\t")[0].trim().replace(/^"|"$/g, "");
  if (p === "/dev/null") return null;
  return p.replace(/^[ab]\//, "");
}

export function parseUnifiedDiff(text: string): FileDiff[] {
  const out: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let hunk: Hunk | null = null;
  let oldRemaining = 0;
  let newRemaining = 0;
  let oldNo = 0;
  let newNo = 0;

  // Note: callers must assign the result to `cur` themselves so TypeScript's
  // flow analysis sees the assignment (closures that mutate `cur` don't count).
  const newFile = (): FileDiff => {
    const f: FileDiff = { oldPath: null, newPath: null, status: "modified", hunks: [] };
    out.push(f);
    hunk = null;
    oldRemaining = newRemaining = 0;
    return f;
  };

  for (const line of text.split("\n")) {
    // "\ No newline at end of file" — may also follow the hunk's last line, after
    // the announced counts are exhausted, so it's handled before the count gate.
    if (hunk && line.charAt(0) === "\\") {
      const last = hunk.lines[hunk.lines.length - 1];
      if (last) last.noNewline = true;
      continue;
    }
    // While inside a hunk, consume exactly the announced number of lines so that
    // file content starting with "---", "+++" or "diff " is never mistaken for a header.
    if (hunk && (oldRemaining > 0 || newRemaining > 0)) {
      const c = line.charAt(0);
      if (c === "+" && newRemaining > 0) {
        hunk.lines.push({ type: "add", oldLine: null, newLine: newNo++, text: line.slice(1) });
        newRemaining--;
        continue;
      }
      if (c === "-" && oldRemaining > 0) {
        hunk.lines.push({ type: "del", oldLine: oldNo++, newLine: null, text: line.slice(1) });
        oldRemaining--;
        continue;
      }
      if (c === " " || line === "") {
        hunk.lines.push({ type: "context", oldLine: oldNo++, newLine: newNo++, text: line.slice(1) });
        oldRemaining--;
        newRemaining--;
        continue;
      }
      // Malformed hunk; fall through and try header parsing.
    }

    if (line.startsWith("diff --git ") || line.startsWith("diff -")) {
      cur = newFile();
      continue;
    }
    if (cur && line.startsWith("new file mode")) {
      cur.status = "added";
      continue;
    }
    if (cur && line.startsWith("deleted file mode")) {
      cur.status = "deleted";
      continue;
    }
    if (cur && line.startsWith("rename from ")) {
      cur.status = "renamed";
      cur.oldPath = line.slice("rename from ".length);
      continue;
    }
    if (cur && line.startsWith("rename to ")) {
      cur.newPath = line.slice("rename to ".length);
      continue;
    }
    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      if (!cur) cur = newFile();
      cur.status = "binary";
      continue;
    }
    if (line.startsWith("--- ")) {
      // Plain unified diffs have no "diff --git" marker: a "---" after hunks starts a new file.
      if (!cur || cur.hunks.length > 0) cur = newFile();
      cur.oldPath = stripPathPrefix(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (!cur) cur = newFile();
      cur.newPath = stripPathPrefix(line.slice(4));
      continue;
    }
    const m = HUNK_RE.exec(line);
    if (m) {
      if (!cur) cur = newFile();
      hunk = {
        oldStart: Number(m[1]),
        oldCount: m[2] ? Number(m[2]) : 1,
        newStart: Number(m[3]),
        newCount: m[4] ? Number(m[4]) : 1,
        section: m[5] ?? "",
        lines: [],
      };
      cur.hunks.push(hunk);
      oldRemaining = hunk.oldCount;
      newRemaining = hunk.newCount;
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      continue;
    }
    // Anything else (index, mode, similarity lines) is metadata we don't need.
  }

  for (const f of out) {
    if (f.status === "modified") {
      if (f.oldPath === null && f.newPath !== null) f.status = "added";
      else if (f.oldPath !== null && f.newPath === null) f.status = "deleted";
    }
  }
  return out.filter((f) => f.hunks.length > 0 || f.status === "binary" || f.status === "renamed");
}
