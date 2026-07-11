import fs from "node:fs";
import path from "node:path";

export interface AnnotationPatch {
  patch: string;
  /** Normalized (repo-relative, forward-slash) paths, in input order. */
  files: string[];
}

/**
 * Annotation mode (`review --file`): a unified diff with zero changes — each file
 * rendered as one all-context hunk — so the review UI shows current contents for
 * line comments. The user's comments become the spec; the agent's edits arrive
 * as round 2 of the same session.
 */
export function buildAnnotationPatch(paths: string[], root: string): AnnotationPatch {
  const out: string[] = [];
  const files: string[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    const abs = path.resolve(root, raw);
    let rel = path.relative(root, abs).split(path.sep).join("/");
    if (rel === "" || rel.startsWith("../")) rel = raw.split(path.sep).join("/");
    if (seen.has(rel)) continue;
    seen.add(rel);
    let buf: Buffer;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      throw new Error(`cannot read file: ${raw}`);
    }
    if (buf.includes(0)) throw new Error(`${raw} looks binary — annotation mode needs text files`);
    const text = buf.toString("utf8");
    if (text === "") throw new Error(`${raw} is empty — nothing to annotate`);
    const endsNL = text.endsWith("\n");
    const lines = text.split("\n");
    if (endsNL) lines.pop();
    out.push(`--- a/${rel}`, `+++ b/${rel}`, `@@ -1,${lines.length} +1,${lines.length} @@`);
    for (const ln of lines) out.push(" " + ln);
    if (!endsNL) out.push("\\ No newline at end of file");
    files.push(rel);
  }
  return { patch: out.join("\n") + "\n", files };
}
