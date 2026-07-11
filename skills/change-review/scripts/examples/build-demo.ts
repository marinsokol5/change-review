// Regenerates examples/demo-session — the committed 3-round demo review used by
// `npm run demo` (UI checking, README screenshots). It replays a realistic review
// through the real CLI and server (worktree mode, Discuss threads, --replies), so
// the snapshot always has the exact production session shape.
//
//   node examples/build-demo.ts
//
// Needs git and an unsandboxed run (the review server binds 127.0.0.1).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseUnifiedDiff } from "../src/patch.ts";

const ID = "2026-07-11-9c4e2b";
const TITLE = "Add retry with exponential backoff to ApiClient";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REVIEWER = path.join(HERE, "..", "reviewer.ts");
const DEST = path.join(HERE, "demo-session");

// --- The story: an agent adds retry logic; the reviewer pushes back twice. -----

const BASE = {
  "src/api.py": `import requests


class ApiClient:
    def __init__(self, base_url: str, timeout: float = 10.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def get_user(self, user_id: int) -> dict:
        resp = requests.get(f"{self.base_url}/users/{user_id}", timeout=self.timeout)
        resp.raise_for_status()
        return resp.json()

    def list_orders(self, user_id: int) -> list[dict]:
        resp = requests.get(f"{self.base_url}/users/{user_id}/orders", timeout=self.timeout)
        resp.raise_for_status()
        return resp.json()
`,
};

// Round 1: naive retry — fixed sleep, catches everything.
const ROUND1 = {
  "src/retry.py": `import time


def with_retry(fn, attempts: int = 10):
    """Call fn, retrying on any exception."""
    for i in range(attempts):
        try:
            return fn()
        except Exception:
            if i == attempts - 1:
                raise
            time.sleep(1)
`,
  "src/api.py": `import requests

from retry import with_retry


class ApiClient:
    def __init__(self, base_url: str, timeout: float = 10.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def get_user(self, user_id: int) -> dict:
        return with_retry(lambda: self._get(f"/users/{user_id}"))

    def list_orders(self, user_id: int) -> list[dict]:
        return with_retry(lambda: self._get(f"/users/{user_id}/orders"))

    def _get(self, path: str) -> dict | list:
        resp = requests.get(f"{self.base_url}{path}", timeout=self.timeout)
        resp.raise_for_status()
        return resp.json()
`,
};

// Round 2: backoff + jitter, retries only transient failures, tests added.
const RETRY_R2 = `import random
import time

import requests

RETRYABLE_STATUS = range(500, 600)


def with_retry(fn, attempts: int = 10, base_delay: float = 0.5, max_delay: float = 8.0):
    """Retry fn on 5xx/connection errors with exponential backoff + full jitter; raises the last error (callers own logging)."""
    for i in range(attempts):
        try:
            return fn()
        except requests.HTTPError as err:
            status = err.response.status_code if err.response is not None else None
            if status not in RETRYABLE_STATUS or i == attempts - 1:
                raise
        except requests.ConnectionError:
            if i == attempts - 1:
                raise
        time.sleep(random.uniform(0, min(max_delay, base_delay * 2 ** i)))
`;

const TESTS_R2 = `import pytest
import requests

from retry import with_retry


def test_returns_first_success(monkeypatch):
    monkeypatch.setattr("time.sleep", lambda _: None)
    calls = []

    def flaky():
        calls.append(1)
        if len(calls) < 3:
            raise requests.ConnectionError()
        return "ok"

    assert with_retry(flaky) == "ok"
    assert len(calls) == 3


def test_gives_up_after_max_attempts(monkeypatch):
    monkeypatch.setattr("time.sleep", lambda _: None)

    def always_down():
        raise requests.ConnectionError()

    with pytest.raises(requests.ConnectionError):
        with_retry(always_down, attempts=4)
`;

const ROUND2 = { "src/retry.py": RETRY_R2, "tests/test_retry.py": TESTS_R2 };

// Round 3: attempts defaults to 3, jitter bound pinned by a test.
const ROUND3 = {
  "src/retry.py": RETRY_R2.replace("attempts: int = 10", "attempts: int = 3"),
  "tests/test_retry.py":
    TESTS_R2 +
    `

def test_delay_respects_cap(monkeypatch):
    seen = []

    def fake_uniform(low, high):
        seen.append(high)
        return 0.0

    monkeypatch.setattr("random.uniform", fake_uniform)
    monkeypatch.setattr("time.sleep", lambda _: None)

    def always_down():
        raise requests.ConnectionError()

    with pytest.raises(requests.ConnectionError):
        with_retry(always_down, attempts=6, base_delay=1.0, max_delay=4.0)

    assert seen and max(seen) <= 4.0
`,
};

interface Anchor {
  file: string;
  side: "old" | "new";
  line: number;
}

const Q1: Anchor & { body: string } = {
  file: "src/retry.py",
  side: "new",
  line: 1,
  body: "Did you consider tenacity instead of hand-rolling this?",
};
const A1 =
  "I did — but the project keeps runtime dependencies at zero (stdlib + requests only), " +
  "so I hand-rolled the ~15 lines. tenacity would be the right call otherwise.";

const ROUND1_COMMENTS: Array<Anchor & { body: string; thread?: number }> = [
  { ...Q1, thread: 1 },
  {
    file: "src/retry.py",
    side: "new",
    line: 12,
    body: "A fixed 1-second sleep will hammer an API that's already struggling. Use exponential backoff with jitter.",
  },
  {
    file: "src/retry.py",
    side: "new",
    line: 9,
    body:
      "Retrying on bare Exception hides real bugs — a TypeError or a 404 gets retried ten times. " +
      "Catch only connection errors and 5xx responses.",
  },
  {
    file: "src/api.py",
    side: "new",
    line: 12,
    body:
      "When every attempt fails we surface the last error with no sign that retries happened — " +
      "consider a WARNING log per retry.",
  },
];
const ROUND1_SUMMARY =
  "Right direction, but the retry behavior isn't production-safe yet. " +
  "Also: there are no tests — cover the backoff schedule and the give-up path before this lands.";

const REPLIES_R2 = [
  { comment: 0, reply: "Kept stdlib-only per the discussion — tenacity stays out." },
  { comment: 1, reply: "Fixed — exponential backoff (base 0.5 s, cap 8 s) with full jitter." },
  { comment: 2, reply: "Now retries only requests.ConnectionError and 5xx HTTPError; everything else raises immediately." },
  { comment: 3, reply: "Not changed: kept the helper log-free — callers own observability; the docstring now says so." },
];

const ROUND2_COMMENTS: Array<Anchor & { body: string }> = [
  {
    file: "src/retry.py",
    side: "new",
    line: 9,
    body:
      "attempts=10 with an 8 s cap can hang a user-facing call for the best part of a minute. " +
      "Default to 3; callers can opt into more.",
  },
  {
    file: "tests/test_retry.py",
    side: "new",
    line: 28,
    body:
      "Nothing pins the jitter bound — add a test asserting the delay never exceeds max_delay; " +
      "that's the part most likely to regress.",
  },
];
const ROUND2_SUMMARY = "Close — two small things and it ships.";

const REPLIES_R3 = [
  { comment: 0, reply: "Default is now attempts=3 — callers opt into more explicitly." },
  {
    comment: 1,
    reply:
      "Added test_delay_respects_cap: records uniform()'s upper bound over 6 attempts and asserts it never exceeds max_delay.",
  },
];

const Q2: Anchor & { body: string } = {
  file: "src/retry.py",
  side: "new",
  line: 21,
  body: "random.uniform is unseeded — any chance of flaky timing in CI?",
};
const A2 =
  "None reaches CI: the tests stub random.uniform and time.sleep via monkeypatch. " +
  "In production the jitter must stay unseeded — that's what prevents synchronized retry storms.";

// --- Replay machinery ----------------------------------------------------------

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

function review(repo: string, dataDir: string, ...extra: string[]): void {
  const args = [REVIEWER, "review", "--worktree", "--base", "HEAD", "--session", ID, "--title", TITLE,
    "--timeout", "1", "--no-open", "--dir", dataDir, ...extra];
  const r = spawnSync(process.execPath, args, {
    cwd: repo,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, CHANGE_REVIEW_NO_OPEN: "1" },
  });
  // 4 = pending: the review is open and the detached server is up — exactly what we want.
  if (r.status !== 4) throw new Error(`review exited ${r.status}, expected 4 (pending)`);
}

function serverPort(dataDir: string): number {
  const info = JSON.parse(fs.readFileSync(path.join(dataDir, ID, "server.json"), "utf8")) as { port: number; pid: number };
  return info.port;
}

async function post(dataDir: string, pathname: string, body: unknown): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${serverPort(dataDir)}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${pathname} -> HTTP ${res.status}: ${await res.text()}`);
}

/** Every comment/thread anchor must exist in the round's parsed diff, or the UI silently drops it. */
function assertAnchors(dataDir: string, anchors: Anchor[]): void {
  const files = parseUnifiedDiff(fs.readFileSync(path.join(dataDir, ID, "patch.diff"), "utf8"));
  for (const a of anchors) {
    const ok = files.some(
      (f) =>
        (f.newPath ?? f.oldPath) === a.file &&
        f.hunks.some((h) => h.lines.some((l) => (a.side === "new" ? l.newLine : l.oldLine) === a.line)),
    );
    if (!ok) throw new Error(`anchor not present in round diff: ${a.file} ${a.side}:${a.line}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cr-demo-repo-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cr-demo-data-"));

  writeTree(repo, BASE);
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "-c", "user.email=demo@example.com", "-c", "user.name=Demo", "commit", "-qm", "base");

  // Round 1: naive retry; reviewer discusses one comment, then requests changes.
  writeTree(repo, ROUND1);
  git(repo, "add", "-N", "src/retry.py");
  review(repo, dataDir);
  assertAnchors(dataDir, [Q1, ...ROUND1_COMMENTS]);
  await post(dataDir, "/api/questions", { items: [{ file: Q1.file, side: Q1.side, line: Q1.line, body: Q1.body }] });
  await post(dataDir, "/api/answer", { answers: [{ thread: 1, answer: A1 }] });
  await post(dataDir, "/api/submit", { verdict: "request_changes", summary: ROUND1_SUMMARY, comments: ROUND1_COMMENTS });
  await sleep(800); // the server exits ~500 ms after a verdict

  // Round 2: fixed backoff + tests; reviewer requests two more changes.
  writeTree(repo, ROUND2);
  git(repo, "add", "-N", "tests/test_retry.py");
  const replies2 = path.join(repo, "replies-r2.json");
  fs.writeFileSync(replies2, JSON.stringify(REPLIES_R2));
  review(repo, dataDir, "--replies", replies2);
  assertAnchors(dataDir, ROUND2_COMMENTS);
  await post(dataDir, "/api/submit", { verdict: "request_changes", summary: ROUND2_SUMMARY, comments: ROUND2_COMMENTS });
  await sleep(800);

  // Round 3: final revision, left pending with an answered Discuss thread.
  writeTree(repo, ROUND3);
  const replies3 = path.join(repo, "replies-r3.json");
  fs.writeFileSync(replies3, JSON.stringify(REPLIES_R3));
  review(repo, dataDir, "--replies", replies3);
  assertAnchors(dataDir, [Q2]);
  await post(dataDir, "/api/questions", { items: [{ file: Q2.file, side: Q2.side, line: Q2.line, body: Q2.body }] });
  await post(dataDir, "/api/answer", { answers: [{ thread: 2, answer: A2 }] });

  // Snapshot: stop the server, drop transient state, neutralize the temp cwd.
  const sessionDir = path.join(dataDir, ID);
  const info = JSON.parse(fs.readFileSync(path.join(sessionDir, "server.json"), "utf8")) as { pid: number };
  try {
    process.kill(info.pid);
  } catch {
    // already gone
  }
  await sleep(300);
  fs.rmSync(path.join(sessionDir, "server.json"), { force: true });
  const reqPath = path.join(sessionDir, "request.json");
  const req = JSON.parse(fs.readFileSync(reqPath, "utf8")) as { cwd: string };
  req.cwd = "/home/dev/acme-api";
  fs.writeFileSync(reqPath, JSON.stringify(req, null, 2));

  fs.rmSync(DEST, { recursive: true, force: true });
  fs.mkdirSync(DEST, { recursive: true });
  fs.cpSync(sessionDir, path.join(DEST, ID), { recursive: true });
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.error(`demo session rebuilt at ${path.join(DEST, ID)} (round 3 pending)`);
}

main().catch((err: unknown) => {
  console.error(`build-demo: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
