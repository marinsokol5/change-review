export type LineType = "context" | "add" | "del";

export interface DiffLine {
  type: LineType;
  oldLine: number | null;
  newLine: number | null;
  text: string;
  noNewline?: boolean;
}

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  section: string;
  lines: DiffLine[];
}

export type FileStatus = "added" | "deleted" | "modified" | "renamed" | "binary";

export interface FileDiff {
  oldPath: string | null;
  newPath: string | null;
  status: FileStatus;
  hunks: Hunk[];
  /** Set on inter-round comparisons when the rounds disagree about the base contents. */
  warning?: string;
}

export interface ReviewComment {
  file: string;
  /** "new" = line number in the proposed version, "old" = line number in the original (removed lines). */
  side: "old" | "new";
  line: number;
  body: string;
  /** The agent's response, attached when the next round is submitted with --replies. */
  reply?: string;
  /** Present when this comment was sent via "Discuss": the agent's reply plus any follow-ups. */
  discussion?: ThreadMessage[];
}

export interface CommentReply {
  /** 0-based index into the previous round's comments array. */
  comment: number;
  reply: string;
}

export interface ThreadMessage {
  from: "user" | "agent";
  body: string;
  at: string;
}

/** A clarifying-question conversation anchored to a diff line. While the user spoke last
 *  (and the thread isn't closed) it blocks the verdict and is delivered to the agent. */
export interface QuestionThread {
  id: number;
  file: string;
  side: "old" | "new";
  line: number;
  /** Round the question was asked in — anchors refer to that round's diff. */
  round: number;
  /** Closed by the user: no longer blocks the verdict even if unanswered. */
  closed?: boolean;
  messages: ThreadMessage[];
}

export interface AnswerInput {
  /** Id of the question thread being answered. */
  thread: number;
  answer: string;
}

export type Verdict = "approve" | "request_changes" | "reject";

/** Quick-menu actions on hook sessions; absent when the verdict came from the full review UI. */
export type MenuDecision = "accept" | "accept_session" | "reject";

/** Outcome of the CLI deterministically applying an approved proposal to the repo. */
export interface ApplyOutcome {
  /** true: every proposed file now has exactly its reviewed contents. */
  applied: boolean;
  /** Repo-relative files the CLI wrote (files already matching the proposal are not listed). */
  wrote: string[];
  /** Files whose current contents match neither the reviewed base nor the proposal — nothing was written. */
  conflicts?: string[];
  error?: string;
}

/** A chunk (contiguous run of +/- lines, or a whole binary file) the reviewer skipped. */
export interface SkippedChunk {
  file: string;
  /** 0-based hunk index in the round's patch (absent for binary chunks). */
  hunk?: number;
  /** 0-based run index within the hunk (absent for binary chunks). */
  run?: number;
  binary?: boolean;
  kind: "add" | "delete" | "update" | "binary";
  adds?: number;
  dels?: number;
  /** Base-side line number of the run's first deleted line. */
  oldLine?: number;
  /** Proposed-side line number of the run's first added line. */
  newLine?: number;
}

/** Present when the reviewer approved with a per-chunk selection ("Apply N of M"). */
export interface ChunksOutcome {
  total: number;
  applied: number;
  skipped: SkippedChunk[];
  /** Path to the selected-only unified diff (base → what was approved). Only on partial approves. */
  appliedPatch?: string;
  /** Path to the diff that turns a fully-applied tree into the approved subset
   *  (worktree mode: `git apply` it to drop the skipped chunks). Only on partial approves. */
  revertPatch?: string;
}

export interface ReviewResult {
  verdict: Verdict;
  summary: string;
  comments: ReviewComment[];
  session: string;
  round: number;
  submittedAt: string;
  decision?: MenuDecision;
  /** Present on approved proposal-mode reviews: how the deterministic apply went. */
  apply?: ApplyOutcome;
  /** Present when the reviewer approved a per-chunk selection: what was applied vs skipped. */
  chunks?: ChunksOutcome;
}

export interface SessionRequest {
  id: string;
  title: string;
  cwd: string;
  round: number;
  createdAt: string;
  updatedAt: string;
  /** "hook" sessions serve the quick allow/review/reject menu at "/" instead of the diff UI. */
  kind?: "review" | "hook";
  meta?: { tool: string; file: string };
}

export interface ServerInfo {
  pid: number;
  port: number;
  startedAt: string;
}
