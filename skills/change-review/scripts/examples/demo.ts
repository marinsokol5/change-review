// Boots the committed 3-round demo review (examples/demo-session) for UI checking
// and screenshots: copies the snapshot to a fresh temp dir — so verdicts never
// dirty the repo and every run starts pristine — then opens it in the browser.
//
//   npm run demo   (or: node examples/demo.ts)
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const snapshot = path.join(here, "demo-session");
const ids = fs.readdirSync(snapshot, { withFileTypes: true }).filter((e) => e.isDirectory());
if (ids.length !== 1) {
  console.error(`demo: expected exactly one session in ${snapshot} — rebuild with \`node examples/build-demo.ts\``);
  process.exit(1);
}
const id = ids[0].name;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "change-review-demo-"));
fs.cpSync(snapshot, dir, { recursive: true });
console.error(`demo: session ${id} copied to ${dir} — round 3 is live, rounds 1-2 are history`);

const reviewer = path.join(here, "..", "reviewer.ts");
const r = spawnSync(process.execPath, [reviewer, "wait", id, "--dir", dir, "--open"], { stdio: "inherit" });
process.exit(r.status ?? 1);
