// Shared domain types across services. Service-specific types live in each
// service's src/types.ts; these are the cross-boundary contracts.

export type WorkspaceStatus = "idle" | "running" | "ended" | "error" | "dirty";

// K3: workflow stage — a kanban axis ORTHOGONAL to WorkspaceStatus (which is
// runtime/health). active = working; review = session ended, awaiting a
// merge/discard/keep decision; done = merged or kept; backlog = parked.
export type WorkspaceStage = "backlog" | "active" | "review" | "done";

export interface Project {
  id: string;
  name: string;
  repoRoot: string;
  defaultModel: string;
  createdAt: string;
}

// Project plus rollups for the rail (task count + aggregate status light).
export interface ProjectSummary extends Project {
  workspaceCount: number;
  runningCount: number;
}

export interface Workspace {
  id: string; // stable UUID; path/branch/worktree are mutable metadata
  projectId: string | null;
  name: string;
  repoRoot: string;
  model: string;
  cwdSubpath: string; // default "" (root)
  branch: string;
  baseBranch: string;
  worktreePath: string;
  tmuxSessionName: string;
  command: string;
  status: WorkspaceStatus;
  stage: WorkspaceStage; // K3 workflow stage (see WorkspaceStage)
  prUrl: string | null; // Phase 2: open GitHub PR URL, once pushed (null = none)
  personaId: string | null;
  createdAt: string; // UTC ISO-8601
  updatedAt: string;
}

// ---- OAuth broker ----

export interface OAuthConnection {
  id: string;
  provider: string; // github | slack | mock | ...
  workspaceId: string | null;
  account: string;
  scopes: string[]; // granted operation strings (default-deny: anything not listed is denied)
  createdAt: string;
}

export interface OAuthProxyResult {
  ok: boolean;
  operation: string;
  result: unknown;
}

// ---- LLM gateway ----

export type ProviderType = "anthropic" | "openai" | "openrouter" | "ollama" | "mock";

export interface Provider {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  defaultModel: string;
  authType: "api_key" | "none";
  createdAt: string;
}

export interface InferUsage {
  inputTokens: number;
  outputTokens: number;
  costMicrocents: number; // money in microcents (100_000_000 = $1); never a float
  latencyMs: number;
}

export interface InferResult {
  response: string;
  usage: InferUsage;
  providerId: string;
  modelId: string;
}

export interface UsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costMicrocents: number;
  sinceIso: string;
}

export interface Persona {
  id: string;
  role: string;
  basePrompt: string;
  toolset: string[];
  defaultModel: string;
  createdAt: string;
}

export interface ProjectOverlay {
  id: string;
  projectPath: string;
  fragment: string;
  tags: string[];
  createdAt: string;
}

// Result of /personas/compose: persona base + project overlay + task context,
// layered in that order.
export interface ComposedPrompt {
  personaId: string;
  workspaceId: string;
  prompt: string;
  layers: { persona: string; overlay: string; taskContext: string };
}

export type MemoryItemType =
  | "project_overlay"
  | "persona"
  | "decision"
  | "gotcha"
  | "recent_run_summary";

export interface MemoryItem {
  id: string;
  workspaceId: string;
  type: MemoryItemType;
  body: string;
  tags: string[];
  createdAt: string;
}

export interface MemoryRun {
  id: string;
  workspaceId: string;
  exitCode: number | null;
  trigger: string;
  finalPaneState: string;
  summary: string;
  createdAt: string;
}

// What /memory/get-context returns: the layered context pack for a fresh session.
export interface ContextPack {
  workspaceId: string;
  taskHint: string;
  recentDecisions: MemoryItem[];
  gotchas: MemoryItem[];
  recentRuns: MemoryItem[];
  // Rendered plaintext, ready to inject via tmux paste-buffer -p -r.
  rendered: string;
}

// ---- WebSocket stream protocol (browser <-> supervisor) ----

// Client -> supervisor
export type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

// Supervisor -> client
export type ServerMessage =
  | { type: "output"; data: string }
  | { type: "session.ended"; workspaceId: string; exitCode: number | null }
  // B3 watchdog: the agent went quiet (no pane output for the idle threshold —
  // the "done with the current command" signal) or resumed producing output.
  | { type: "session.idle"; workspaceId: string; idleMs: number }
  | { type: "session.active"; workspaceId: string }
  | { type: "worktree.dirty"; workspaceId: string; fileCount: number }
  | { type: "worktree.orphaned"; workspaceId: string }
  // N4: the workspace's command queue changed (item enqueued / advanced / done).
  | { type: "queue.updated"; workspaceId: string }
  // Multi-tab policy: how many clients are streaming this workspace right now.
  // Output mirrors to all of them; input/resize are last-writer-wins (tmux
  // semantics), so the UI surfaces the mirroring instead of arbitrating it.
  | { type: "presence"; workspaceId: string; count: number }
  | { type: "error"; code: string; message: string };

// N4 command queue: an ordered list of commands run sequentially in a
// workspace's session, advancing when the session goes idle (B3 signal) for the
// queue threshold. pending → running → done; a session death releases a running
// item back to pending (K2 stale-release).
export type QueueItemStatus = "pending" | "running" | "done";
export interface QueueItem {
  id: string;
  workspaceId: string;
  command: string;
  status: QueueItemStatus;
  position: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

// N3 cron scheduler: a recurring job that enqueues `command` onto a workspace's
// N4 queue when its cron expression matches (supervisor-owned; survives the
// dashboard closing). Five-field cron (min hour dom month dow), server local time.
export interface Schedule {
  id: string;
  workspaceId: string;
  cron: string;
  command: string;
  enabled: boolean;
  lastRunAt: string | null;
  createdAt: string;
}

// Security / audit-log viewer: a unified row from audit.db (LLM gateway usage +
// OAuth proxied operations). `summary` is built server-side so the UI stays dumb.
export interface AuditEntry {
  id: string;
  ts: string;
  kind: "llm" | "oauth";
  workspaceId: string | null;
  summary: string;
  status: string; // "ok" | "denied" | "error" | ...
}

// B3 activity snapshot for a workspace. `live: false` means no running session.
export type ActivityState = "active" | "idle";
export interface WorkspaceActivity {
  workspaceId: string;
  live: boolean;
  state: ActivityState | null; // null when not live
  idleMs: number; // ms since last pane output (0 when not live)
}
