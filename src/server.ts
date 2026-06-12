import http from "node:http";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseUnifiedDiff } from "./patch.js";
import * as session from "./session.js";
import type { MenuDecision, ReviewComment, ReviewResult, Verdict } from "./types.js";

const UI_FILE = fileURLToPath(new URL("../ui/index.html", import.meta.url));
const MENU_FILE = fileURLToPath(new URL("../ui/menu.html", import.meta.url));

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

// Binding 127.0.0.1 alone doesn't keep malicious webpages out: DNS rebinding
// forges the Host, and POSTs without a preflight (text/plain) cross origins
// freely. So every request must carry a local Host, and a browser-sent Origin
// must be local too. The CLI's fetch and curl send no Origin and pass.
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLocalUrl(value: string): boolean {
  try {
    return LOCAL_HOSTNAMES.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

function rejectNonLocal(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const host = req.headers.host;
  if (!host || !isLocalUrl(`http://${host}`)) {
    json(res, 403, { error: "forbidden: non-local Host header" });
    return true;
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !isLocalUrl(origin)) {
    json(res, 403, { error: "forbidden: cross-origin request" });
    return true;
  }
  return false;
}

function readBody(req: http.IncomingMessage, limit = 10 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

interface Submission {
  verdict: Verdict;
  summary: string;
  comments: ReviewComment[];
}

function validateSubmission(body: unknown): Submission | string {
  const verdicts: Verdict[] = ["approve", "request_changes", "reject"];
  if (!body || typeof body !== "object") return "body must be a JSON object";
  const b = body as Record<string, unknown>;
  if (!verdicts.includes(b.verdict as Verdict)) return `verdict must be one of: ${verdicts.join(", ")}`;
  const summary = typeof b.summary === "string" ? b.summary : "";
  if (!Array.isArray(b.comments)) return "comments must be an array";
  const comments: ReviewComment[] = [];
  for (const c of b.comments as Array<Record<string, unknown>>) {
    if (
      !c ||
      typeof c.file !== "string" ||
      (c.side !== "old" && c.side !== "new") ||
      !Number.isInteger(c.line) ||
      typeof c.body !== "string" ||
      c.body.trim() === ""
    ) {
      return "each comment needs: file (string), side ('old'|'new'), line (integer), body (non-empty string)";
    }
    comments.push({ file: c.file, side: c.side, line: c.line as number, body: c.body.trim() });
  }
  return { verdict: b.verdict as Verdict, summary, comments };
}

function listenWithFallback(server: http.Server, preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryListen = (p: number, fallback: boolean) => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (fallback && err.code === "EADDRINUSE") tryListen(0, false);
        else reject(err);
      });
      server.listen(p, "127.0.0.1", () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : p);
      });
    };
    tryListen(preferred, preferred !== 0);
  });
}

export async function runServe(id: string, portArg?: number): Promise<void> {
  const request = session.readRequest(id);
  if (!request) throw new Error(`unknown session "${id}"`);
  if (session.readResult(id)) {
    console.error(`agent-change-reviewer: session ${id} already has a verdict for round ${request.round}`);
    return;
  }

  let shuttingDown = false;
  const finishAfterVerdict = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    setTimeout(() => {
      session.clearServerInfo(id);
      process.exit(0);
    }, 500);
  };
  const sendHtml = (res: http.ServerResponse, file: string) => {
    const html = fs.readFileSync(file);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (rejectNonLocal(req, res)) return;
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/") {
        // Hook sessions get the quick allow/review/reject menu first; "Review" links to /review.
        sendHtml(res, request.kind === "hook" ? MENU_FILE : UI_FILE);
      } else if (req.method === "GET" && url.pathname === "/review") {
        sendHtml(res, UI_FILE);
      } else if (req.method === "GET" && url.pathname === "/api/health") {
        json(res, 200, { ok: true, session: id });
      } else if (req.method === "GET" && url.pathname === "/api/session") {
        const r = session.readRequest(id);
        const patch = session.readPatch(id) ?? "";
        json(res, 200, {
          request: r,
          files: parseUnifiedDiff(patch),
          history: session.readHistory(id),
          threads: session.readThreads(id),
        });
      } else if (req.method === "GET" && url.pathname === "/api/threads") {
        json(res, 200, { threads: session.readThreads(id) });
      } else if (req.method === "POST" && url.pathname === "/api/questions") {
        if (session.readResult(id)) {
          json(res, 409, { error: "a verdict was already submitted for this round" });
          return;
        }
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        const items = body.items;
        if (!Array.isArray(items) || items.length === 0) {
          json(res, 400, { error: "items must be a non-empty array" });
          return;
        }
        const threads = session.readThreads(id);
        const current = session.readRequest(id) ?? request;
        const now = new Date().toISOString();
        let nextId = threads.reduce((m, t) => Math.max(m, t.id), 0) + 1;
        for (const it of items as Array<Record<string, unknown>>) {
          if (!it || typeof it.body !== "string" || it.body.trim() === "") {
            json(res, 400, { error: "each item needs a non-empty body" });
            return;
          }
          if (Number.isInteger(it.thread)) {
            const t = threads.find((x) => x.id === it.thread);
            if (!t) {
              json(res, 400, { error: `unknown thread ${it.thread}` });
              return;
            }
            t.messages.push({ from: "user", body: it.body.trim(), at: now });
            delete t.closed; // a follow-up reopens a closed thread
          } else if (typeof it.file === "string" && (it.side === "old" || it.side === "new") && Number.isInteger(it.line)) {
            threads.push({
              id: nextId++,
              file: it.file,
              side: it.side,
              line: it.line as number,
              round: current.round,
              messages: [{ from: "user", body: it.body.trim(), at: now }],
            });
          } else {
            json(res, 400, { error: "each item needs either thread (follow-up) or file/side/line (new question)" });
            return;
          }
        }
        session.writeThreads(id, threads);
        json(res, 200, { ok: true, threads });
      } else if (req.method === "POST" && url.pathname === "/api/answer") {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        const threads = session.readThreads(id);
        const v = session.validateAnswers(threads, body.answers);
        if (typeof v === "string") {
          json(res, 400, { error: v });
          return;
        }
        const now = new Date().toISOString();
        for (const a of v) {
          const t = threads.find((x) => x.id === a.thread);
          if (t) t.messages.push({ from: "agent", body: a.answer, at: now });
        }
        session.writeThreads(id, threads);
        json(res, 200, { ok: true, threads });
      } else if (req.method === "POST" && url.pathname === "/api/close-thread") {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        const threads = session.readThreads(id);
        const t = threads.find((x) => x.id === body.thread);
        if (!t) {
          json(res, 400, { error: `unknown thread ${body.thread}` });
          return;
        }
        t.closed = true;
        session.writeThreads(id, threads);
        json(res, 200, { ok: true, threads });
      } else if (req.method === "POST" && url.pathname === "/api/submit") {
        if (session.readResult(id)) {
          json(res, 409, { error: "a verdict was already submitted for this round" });
          return;
        }
        const open = session.openQuestions(session.readThreads(id));
        if (open.length > 0) {
          json(res, 409, {
            error: `${open.length} question thread(s) are still waiting on the agent — the verdict unlocks when they are answered or closed`,
          });
          return;
        }
        let body: unknown;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        const v = validateSubmission(body);
        if (typeof v === "string") {
          json(res, 400, { error: v });
          return;
        }
        const current = session.readRequest(id) ?? request;
        // Approving a proposal-mode review applies the reviewed bytes to the repo
        // right here, so "approve" deterministically lands exactly what was shown.
        const apply = v.verdict === "approve" ? session.applyProposal(id, current.cwd) : undefined;
        const result: ReviewResult = {
          ...v,
          session: id,
          round: current.round,
          submittedAt: new Date().toISOString(),
          ...(apply && { apply }),
        };
        session.writeResult(id, result);
        json(res, 200, { ok: true, ...(apply && { apply }) });
        finishAfterVerdict();
      } else if (req.method === "POST" && url.pathname === "/api/decision") {
        // Quick-menu decisions on hook sessions; "review" is not posted — the menu navigates to /review.
        if (session.readResult(id)) {
          json(res, 409, { error: "a verdict was already submitted for this round" });
          return;
        }
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        } catch {
          json(res, 400, { error: "invalid JSON body" });
          return;
        }
        const action = body.action as MenuDecision;
        if (action !== "accept" && action !== "accept_session" && action !== "reject") {
          json(res, 400, { error: "action must be one of: accept, accept_session, reject" });
          return;
        }
        const reason = typeof body.reason === "string" ? body.reason.trim() : "";
        const current = session.readRequest(id) ?? request;
        const result: ReviewResult = {
          verdict: action === "reject" ? "reject" : "approve",
          summary:
            action === "reject"
              ? reason
              : action === "accept_session"
                ? "Accepted — and auto-allow the rest of this agent session."
                : "Accepted from the quick menu.",
          comments: [],
          session: id,
          round: current.round,
          submittedAt: new Date().toISOString(),
          decision: action,
        };
        session.writeResult(id, result);
        json(res, 200, { ok: true });
        finishAfterVerdict();
      } else if (url.pathname === "/favicon.ico") {
        res.writeHead(204);
        res.end();
      } else {
        json(res, 404, { error: "not found" });
      }
    } catch (err) {
      try {
        json(res, 500, { error: String(err) });
      } catch {
        // response already started
      }
    }
  });

  const preferred = portArg ?? session.readServerInfo(id)?.port ?? 0;
  const port = await listenWithFallback(server, preferred);
  session.writeServerInfo(id, { pid: process.pid, port, startedAt: new Date().toISOString() });
  console.error(`agent-change-reviewer: serving session ${id} at http://localhost:${port}/`);

  const cleanup = () => {
    session.clearServerInfo(id);
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}
