import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".DS_Store") continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p, base));
    else if (entry.isFile()) out.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return out.sort();
}

export interface ProposalPatch {
  patch: string;
  /** Files that actually differ: repo-relative path + absolute path of the proposed contents. */
  files: Array<{ rel: string; src: string }>;
}

/**
 * Build a unified diff between the current working tree and a "proposal" directory
 * that mirrors repo-relative paths with the proposed file contents.
 */
export function buildProposalPatch(proposalDir: string, root: string): ProposalPatch {
  if (!fs.existsSync(proposalDir) || !fs.statSync(proposalDir).isDirectory()) {
    throw new Error(`proposal directory not found: ${proposalDir}`);
  }
  const rels = walk(proposalDir);
  if (rels.length === 0) throw new Error(`proposal directory is empty: ${proposalDir}`);

  const chunks: string[] = [];
  const files: ProposalPatch["files"] = [];
  for (const rel of rels) {
    const proposed = path.join(proposalDir, rel);
    const original = path.join(root, rel);
    const orig = fs.existsSync(original) ? original : "/dev/null";
    const r = spawnSync("git", ["diff", "--no-index", "--no-color", "--", orig, proposed], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    if (r.error) throw new Error(`git diff --no-index failed: ${r.error.message}`);
    if (r.status === 0) continue; // identical
    if (r.status !== 1 || !r.stdout) throw new Error(`git diff --no-index failed for ${rel}: ${r.stderr}`);
    chunks.push(relabel(r.stdout, rel));
    files.push({ rel, src: proposed });
  }
  if (chunks.length === 0) throw new Error("proposal matches the current files — nothing to review");
  return { patch: chunks.join(""), files };
}

export function relabel(diff: string, rel: string): string {
  // Replace the temp-file paths in the headers with the repo-relative path.
  // Only the first match of each pattern is a header; content lines come after the first hunk.
  return diff
    .replace(/^diff --git .*$/m, `diff --git a/${rel} b/${rel}`)
    .replace(/^--- (?!\/dev\/null).*$/m, `--- a/${rel}`)
    .replace(/^\+\+\+ (?!\/dev\/null).*$/m, `+++ b/${rel}`);
}
