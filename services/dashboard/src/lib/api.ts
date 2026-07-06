import type {
  Workspace,
  ContextPack,
  ProjectSummary,
  Project,
  UsageSummary,
  Provider,
  Persona,
  ProjectOverlay,
  OAuthConnection,
  WorkspaceActivity,
  QueueItem,
  Schedule,
  AuditEntry,
} from "@agent-cc/shared";
import { SUPERVISOR_URL } from "./config";

// N4 command queue.
export async function listQueue(id: string): Promise<QueueItem[]> {
  const r = await fetch(`${SUPERVISOR_URL}/workspaces/${id}/queue`);
  if (!r.ok) throw new Error(`listQueue ${r.status}`);
  return (await r.json()) as QueueItem[];
}
export async function enqueueCommand(id: string, command: string): Promise<QueueItem> {
  const r = await fetch(`${SUPERVISOR_URL}/workspaces/${id}/queue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command }),
  });
  const data = (await r.json().catch(() => ({}))) as QueueItem & { message?: string };
  if (!r.ok) throw new Error(data.message ?? `enqueue ${r.status}`);
  return data;
}
export async function removeQueueItem(id: string, itemId: string): Promise<void> {
  const r = await fetch(`${SUPERVISOR_URL}/workspaces/${id}/queue/${itemId}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`removeQueueItem ${r.status}`);
}
export async function clearQueue(id: string): Promise<void> {
  const r = await fetch(`${SUPERVISOR_URL}/workspaces/${id}/queue`, { method: "DELETE" });
  if (!r.ok) throw new Error(`clearQueue ${r.status}`);
}

// N3 cron scheduler.
export async function listSchedules(id: string): Promise<Schedule[]> {
  const r = await fetch(`${SUPERVISOR_URL}/workspaces/${id}/schedules`);
  if (!r.ok) throw new Error(`listSchedules ${r.status}`);
  return (await r.json()) as Schedule[];
}
export async function addSchedule(id: string, cron: string, command: string): Promise<Schedule> {
  const r = await fetch(`${SUPERVISOR_URL}/workspaces/${id}/schedules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cron, command }),
  });
  const data = (await r.json().catch(() => ({}))) as Schedule & { message?: string };
  if (!r.ok) throw new Error(data.message ?? `addSchedule ${r.status}`);
  return data;
}
export async function setScheduleEnabled(id: string, scheduleId: string, enabled: boolean): Promise<void> {
  const r = await fetch(`${SUPERVISOR_URL}/workspaces/${id}/schedules/${scheduleId}/enabled`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!r.ok) throw new Error(`setScheduleEnabled ${r.status}`);
}
export async function removeSchedule(id: string, scheduleId: string): Promise<void> {
  const r = await fetch(`${SUPERVISOR_URL}/workspaces/${id}/schedules/${scheduleId}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`removeSchedule ${r.status}`);
}

// B3 watchdog: active/idle for every live session. Returns a map keyed by
// workspace id for easy per-pane lookup.
export async function getActivity(): Promise<Record<string, WorkspaceActivity>> {
  const r = await fetch(`${SUPERVISOR_URL}/activity`);
  if (!r.ok) throw new Error(`getActivity ${r.status}`);
  const list = (await r.json()) as WorkspaceActivity[];
  return Object.fromEntries(list.map((a) => [a.workspaceId, a]));
}

// Security / audit-log viewer.
export async function getAuditLog(limit = 100): Promise<AuditEntry[]> {
  const r = await fetch(`${SUPERVISOR_URL}/audit/log?limit=${limit}`);
  if (!r.ok) throw new Error(`getAuditLog ${r.status}`);
  return (await r.json()) as AuditEntry[];
}

export async function getUsage(): Promise<UsageSummary> {
  const r = await fetch(`${SUPERVISOR_URL}/usage/summary`);
  if (!r.ok) throw new Error(`getUsage ${r.status}`);
  return (await r.json()) as UsageSummary;
}

// ---- Config (all proxied through the supervisor to the leaf services) ----

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${SUPERVISOR_URL}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await r.json().catch(() => ({}))) as T & { message?: string };
  if (!r.ok) throw new Error((data as { message?: string }).message ?? `${method} ${path} ${r.status}`);
  return data;
}

// Providers (LLM gateway)
export const listProviders2 = () => req<Provider[]>("GET", "/providers");
export const createProvider = (b: { name: string; type: string; defaultModel?: string; baseUrl?: string }) =>
  req<Provider>("POST", "/providers", b);
export const deleteProvider = (id: string) => req<unknown>("DELETE", `/providers/${id}`);
export const setProviderKey = (id: string, apiKey: string) => req<unknown>("PUT", `/providers/${id}/key`, { apiKey });

// Personas
export const listPersonas = () => req<Persona[]>("GET", "/personas");
export const createPersona = (b: { role: string; basePrompt?: string; defaultModel?: string }) =>
  req<Persona>("POST", "/personas", b);
export const deletePersona = (id: string) => req<unknown>("DELETE", `/personas/${id}`);

// Project overlays — a per-project prompt fragment layered between the persona
// base prompt and the task context for every task in that project.
export const listOverlays = (projectPath: string) =>
  req<ProjectOverlay[]>("GET", `/personas/overlays?project=${encodeURIComponent(projectPath)}`);
export const saveOverlay = (b: { projectPath: string; fragment: string; tags?: string[] }) =>
  req<ProjectOverlay>("POST", "/personas/overlays", b);

// OAuth connections
export const listConnections = (workspaceId?: string) =>
  req<OAuthConnection[]>("GET", `/oauth/connections${workspaceId ? `?workspaceId=${workspaceId}` : ""}`);
export const createConnection = (b: { provider: string; token: string; scopes?: string[]; account?: string }) =>
  req<OAuthConnection>("POST", "/oauth/connections", b);
export const grantOps = (id: string, operations: string[]) =>
  req<unknown>("POST", `/oauth/connections/${id}/grant`, { operations });
export const deleteConnection = (id: string) => req<unknown>("DELETE", `/oauth/connections/${id}`);

export async function listProjects(): Promise<ProjectSummary[]> {
  const r = await fetch(`${SUPERVISOR_URL}/projects`);
  if (!r.ok) throw new Error(`listProjects ${r.status}`);
  return (await r.json()) as ProjectSummary[];
}

export interface ScanEntry {
  name: string;
  path: string;
  isRepo: boolean;
  hasCommits: boolean;
  dirty: boolean;
  alreadyAdded: boolean;
}

// N1 project-root picker: list candidate repos under `root` (default: server config).
export async function scanProjects(root?: string): Promise<{ root: string; entries: ScanEntry[] }> {
  const q = root ? `?root=${encodeURIComponent(root)}` : "";
  const r = await fetch(`${SUPERVISOR_URL}/projects/scan${q}`);
  const data = (await r.json().catch(() => ({}))) as { root?: string; entries?: ScanEntry[]; message?: string };
  if (!r.ok) throw new Error(data.message ?? `scanProjects ${r.status}`);
  return { root: data.root ?? "", entries: data.entries ?? [] };
}

export async function createProject(input: {
  name: string;
  repoRoot: string;
  defaultModel?: string;
}): Promise<Project> {
  const r = await fetch(`${SUPERVISOR_URL}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await r.json().catch(() => ({}))) as Project & { message?: string };
  if (!r.ok) throw new Error(data.message ?? `createProject ${r.status}`);
  return data;
}

export async function deleteProject(id: string, cascade = false): Promise<void> {
  const r = await fetch(`${SUPERVISOR_URL}/projects/${id}${cascade ? "?cascade=true" : ""}`, {
    method: "DELETE",
  });
  const data = (await r.json().catch(() => ({}))) as { message?: string };
  if (!r.ok) throw new Error(data.message ?? `deleteProject ${r.status}`);
}

export async function listWorkspaces(projectId?: string): Promise<Workspace[]> {
  const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
  const r = await fetch(`${SUPERVISOR_URL}/workspaces${q}`);
  if (!r.ok) throw new Error(`listWorkspaces ${r.status}`);
  return (await r.json()) as Workspace[];
}

export async function createWorkspace(input: {
  name: string;
  projectId?: string;
  repoRoot?: string;
  model?: string;
  command?: string;
  personaId?: string;
}): Promise<Workspace> {
  const r = await fetch(`${SUPERVISOR_URL}/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await r.json().catch(() => ({}))) as Workspace & { message?: string };
  if (!r.ok) throw new Error(data.message ?? `createWorkspace ${r.status}`);
  return data;
}

export async function getContext(id: string, taskHint = ""): Promise<ContextPack> {
  const r = await fetch(
    `${SUPERVISOR_URL}/workspaces/${id}/context?taskHint=${encodeURIComponent(taskHint)}`,
  );
  if (!r.ok) throw new Error(`getContext ${r.status}`);
  return (await r.json()) as ContextPack;
}

// A project's rolled-up memory — value carried over from its removed tasks.
export async function getProjectContext(projectId: string): Promise<ContextPack> {
  const r = await fetch(`${SUPERVISOR_URL}/projects/${projectId}/context`);
  if (!r.ok) throw new Error(`getProjectContext ${r.status}`);
  return (await r.json()) as ContextPack;
}

export async function injectContext(id: string, taskHint = ""): Promise<{ bytes: number }> {
  const r = await fetch(`${SUPERVISOR_URL}/workspaces/${id}/inject-context`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskHint }),
  });
  if (!r.ok) throw new Error(`injectContext ${r.status}`);
  return (await r.json()) as { bytes: number };
}

// Worktree lifecycle (Slice 2). Each returns the parsed body or throws with the
// supervisor's structured error message.
async function post(id: string, action: string, body?: unknown): Promise<unknown> {
  const r = await fetch(`${SUPERVISOR_URL}/workspaces/${id}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await r.json().catch(() => ({}))) as { message?: string };
  if (!r.ok) throw new Error(data.message ?? `${action} ${r.status}`);
  return data;
}

export interface ServiceStatus {
  name: string;
  url: string;
  status: "up" | "down" | "unknown";
  lastError: string | null;
  lastCheck: string | null;
}

export async function listServices(): Promise<ServiceStatus[]> {
  const r = await fetch(`${SUPERVISOR_URL}/services`);
  if (!r.ok) throw new Error(`listServices ${r.status}`);
  return (await r.json()) as ServiceStatus[];
}

// Fire-and-forget keystrokes into a live pane (quick-CTA buttons). The caller
// includes any trailing "\r" needed to submit the command.
export async function sendInput(id: string, data: string): Promise<{ bytes: number }> {
  const r = await fetch(`${SUPERVISOR_URL}/workspaces/${id}/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data }),
  });
  const body = (await r.json().catch(() => ({}))) as { bytes?: number; message?: string };
  if (!r.ok) throw new Error(body.message ?? `sendInput ${r.status}`);
  return { bytes: body.bytes ?? 0 };
}

export const runWorkspace = (id: string) => post(id, "run");
export const mergeWorkspace = (id: string) => post(id, "merge");
// Fork: new worktree + branch off this workspace's branch tip (committed work
// only), same base branch, fresh session. Returns the new workspace.
export async function forkWorkspace(id: string, name?: string): Promise<Workspace> {
  const r = await fetch(`${SUPERVISOR_URL}/workspaces/${id}/fork`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(name ? { name } : {}),
  });
  const body = (await r.json().catch(() => ({}))) as Workspace & { message?: string };
  if (!r.ok) throw new Error(body.message ?? `fork ${r.status}`);
  return body;
}
export const keepWorkspace = (id: string) => post(id, "keep");
// Pull base into the worktree; resolves/avoids conflicts before a merge.
export const syncWorkspace = (id: string) => post(id, "sync");

// Phase 2: GitHub PR flow.
export async function getIntegration(id: string): Promise<{ hasRemote: boolean }> {
  const r = await fetch(`${SUPERVISOR_URL}/workspaces/${id}/integration`);
  if (!r.ok) throw new Error(`getIntegration ${r.status}`);
  return (await r.json()) as { hasRemote: boolean };
}
export async function openPr(id: string): Promise<{ url: string }> {
  const r = await fetch(`${SUPERVISOR_URL}/workspaces/${id}/pr`, { method: "POST" });
  const data = (await r.json().catch(() => ({}))) as { url?: string; message?: string };
  if (!r.ok) throw new Error(data.message ?? `openPr ${r.status}`);
  return { url: data.url ?? "" };
}
export const discardWorkspace = (id: string) => post(id, "discard", { confirm: true });

// K3: move a workspace to another workflow stage (board move).
export const setStage = (id: string, stage: string) => post(id, "stage", { stage });
