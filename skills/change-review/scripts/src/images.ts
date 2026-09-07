import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readStagedBaseFile, readStagedFile } from "./session.ts";
import type { FileDiff } from "./types.ts";

// Image diff: showing a changed picture as before/after instead of the bare
// "Binary file changed" placeholder. A unified diff carries no pixels, so the
// bytes have to come from somewhere else — and showing the *wrong* picture would
// be worse than showing none (the same rule expand.ts follows for text). Every
// source here is therefore either the session's own staged snapshot or verified
// by content: git's `index <old>..<new>` line names both sides' blob hashes, and
// a candidate is accepted only when it hashes to the one the diff recorded.

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

/** Past this a browser preview stops being a review aid; the file renders as a plain binary. */
const MAX_BYTES = 25 * 1024 * 1024;

/** The image content type for a path, or null if it isn't a picture we show. */
export function imageMime(rel: string): string | null {
  return MIME[path.extname(rel).toLowerCase()] ?? null;
}

/** An abbreviated blob hash worth trusting: hex, long enough not to collide, not the all-zero
 *  "this side doesn't exist" placeholder git writes for added/deleted files. */
function usableSha(sha: string | undefined): sha is string {
  return !!sha && /^[0-9a-f]{7,64}$/.test(sha) && !/^0+$/.test(sha);
}

/** git's object id for these bytes: sha1("blob <length>\0" + content). */
function gitBlobSha(data: Buffer): string {
  return crypto.createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
}

function readFile(p: string): Buffer | null {
  try {
    const data = fs.readFileSync(p);
    return data.length > 0 && data.length <= MAX_BYTES ? data : null;
  } catch {
    return null;
  }
}

/** The blob with this id from the repo's object database, if it holds one. */
function catBlob(cwd: string, sha: string): Buffer | null {
  const r = spawnSync("git", ["cat-file", "blob", sha], { cwd, maxBuffer: MAX_BYTES, encoding: "buffer" });
  if (r.error || r.status !== 0 || !r.stdout || r.stdout.length === 0) return null;
  return r.stdout;
}

export interface ImageBytes {
  data: Buffer;
  mime: string;
}

/**
 * The reviewed bytes of one side of a changed image, or null when nothing verifies.
 * Sources, cheapest first (all equally trustworthy): the session's staged snapshot
 * (proposal mode — the exact reviewed bytes), the working-tree file when it hashes
 * to the blob the diff names (`git diff HEAD` hashes the tree without storing it),
 * and finally that blob itself out of the object database.
 */
export function imageSide(id: string, cwd: string, f: FileDiff, side: "base" | "new"): ImageBytes | null {
  const rel = side === "base" ? f.oldPath ?? f.newPath : f.newPath ?? f.oldPath;
  if (!rel) return null;
  const mime = imageMime(rel);
  if (!mime) return null;

  const staged = side === "base" ? readStagedBaseFile(id, rel) : readStagedFile(id, rel);
  if (staged && staged.length > 0 && staged.length <= MAX_BYTES) return { data: staged, mime };

  const sha = side === "base" ? f.oldSha : f.newSha;
  if (!usableSha(sha)) return null;
  const disk = readFile(path.resolve(cwd, rel));
  if (disk && gitBlobSha(disk).startsWith(sha)) return { data: disk, mime };
  const blob = catBlob(cwd, sha);
  return blob ? { data: blob, mime } : null;
}

export interface ImageSideInfo {
  mime: string;
  bytes: number;
}

/** What the UI can show for one changed image: whichever sides resolved. */
export interface ImageInfo {
  base?: ImageSideInfo;
  proposed?: ImageSideInfo;
}

/**
 * Per-file image availability for the current round — the map /api/session hands the
 * UI so it knows which binary files it can render as pictures, and from which sides
 * (only the new one for an added image, only the base for a deleted one). Files that
 * don't resolve are simply absent and keep the plain "binary file" placeholder.
 */
export function imageInfo(id: string, cwd: string, files: FileDiff[]): Record<string, ImageInfo> | undefined {
  const out: Record<string, ImageInfo> = {};
  for (const f of files) {
    if (f.status !== "binary") continue;
    const rel = f.newPath ?? f.oldPath;
    if (!rel || !imageMime(rel)) continue;
    const base = imageSide(id, cwd, f, "base");
    const proposed = imageSide(id, cwd, f, "new");
    if (!base && !proposed) continue;
    out[rel] = {
      ...(base && { base: { mime: base.mime, bytes: base.data.length } }),
      ...(proposed && { proposed: { mime: proposed.mime, bytes: proposed.data.length } }),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
