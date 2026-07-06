// SQLite access for the supervisor. Opens the shared agent-cc.db, runs the
// idempotent migrations, and provides workspace CRUD. Other services open the
// same file; migrations are IF NOT EXISTS so concurrent open is safe under WAL.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  applyMigrations,
  type Workspace,
  type WorkspaceStatus,
  type WorkspaceStage,
  type Project,
  type ProjectSummary,
  type QueueItem,
  type QueueItemStatus,
  type Schedule,
} from "@agent-cc/shared";

export type DB = Database.Database;

export function openDb(path: string): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  applyMigrations(db);
  return db;
}

interface WorkspaceRow {
  id: string;
  project_id: string | null;
  name: string;
  repo_root: string;
  cwd_subpath: string;
  branch: string;
  base_branch: string;
  worktree_path: string;
  tmux_session_name: string;
  command: string;
  model: string;
  status: string;
  stage: string;
  pr_url: string | null;
  persona_id: string | null;
  created_at: string;
  updated_at: string;
}

function rowToWorkspace(r: WorkspaceRow): Workspace {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    repoRoot: r.repo_root,
    model: r.model,
    cwdSubpath: r.cwd_subpath,
    branch: r.branch,
    baseBranch: r.base_branch,
    worktreePath: r.worktree_path,
    tmuxSessionName: r.tmux_session_name,
    command: r.command,
    status: r.status as WorkspaceStatus,
    stage: (r.stage ?? "active") as WorkspaceStage,
    prUrl: r.pr_url ?? null,
    personaId: r.persona_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---- Projects ----

interface ProjectRow {
  id: string;
  name: string;
  repo_root: string;
  default_model: string;
  created_at: string;
}

function rowToProject(r: ProjectRow): Project {
  return {
    id: r.id,
    name: r.name,
    repoRoot: r.repo_root,
    defaultModel: r.default_model,
    createdAt: r.created_at,
  };
}

export function insertProject(db: DB, p: Project): void {
  db.prepare(
    `INSERT INTO supervisor_projects (id, name, repo_root, default_model, created_at)
     VALUES (@id, @name, @repoRoot, @defaultModel, @createdAt)`,
  ).run(p);
}

export function getProject(db: DB, id: string): Project | null {
  const row = db.prepare(`SELECT * FROM supervisor_projects WHERE id = ?`).get(id) as
    | ProjectRow
    | undefined;
  return row ? rowToProject(row) : null;
}

export function deleteProject(db: DB, id: string): void {
  db.prepare(`DELETE FROM supervisor_projects WHERE id = ?`).run(id);
}

export function countProjectWorkspaces(db: DB, id: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM supervisor_workspaces WHERE project_id = ?`)
    .get(id) as { n: number };
  return row.n;
}

// Projects with rollups for the rail (task count + running count).
export function listProjectSummaries(db: DB): ProjectSummary[] {
  const rows = db
    .prepare(
      `SELECT p.*,
              COUNT(w.id) AS workspace_count,
              COALESCE(SUM(CASE WHEN w.status = 'running' THEN 1 ELSE 0 END), 0) AS running_count
         FROM supervisor_projects p
         LEFT JOIN supervisor_workspaces w ON w.project_id = p.id
        GROUP BY p.id
        ORDER BY p.name COLLATE NOCASE`,
    )
    .all() as Array<ProjectRow & { workspace_count: number; running_count: number }>;
  return rows.map((r) => ({
    ...rowToProject(r),
    workspaceCount: r.workspace_count,
    runningCount: r.running_count,
  }));
}

export function insertWorkspace(db: DB, w: Workspace): void {
  db.prepare(
    `INSERT INTO supervisor_workspaces
       (id, project_id, name, repo_root, cwd_subpath, branch, base_branch, worktree_path,
        tmux_session_name, command, model, status, stage, pr_url, persona_id, created_at, updated_at)
     VALUES
       (@id, @projectId, @name, @repoRoot, @cwdSubpath, @branch, @baseBranch, @worktreePath,
        @tmuxSessionName, @command, @model, @status, @stage, @prUrl, @personaId, @createdAt, @updatedAt)`,
  ).run(w);
}

export function listWorkspaces(db: DB, projectId?: string): Workspace[] {
  const rows = projectId
    ? (db
        .prepare(`SELECT * FROM supervisor_workspaces WHERE project_id = ? ORDER BY created_at DESC`)
        .all(projectId) as WorkspaceRow[])
    : (db.prepare(`SELECT * FROM supervisor_workspaces ORDER BY created_at DESC`).all() as WorkspaceRow[]);
  return rows.map(rowToWorkspace);
}

export function getWorkspace(db: DB, id: string): Workspace | null {
  const row = db
    .prepare(`SELECT * FROM supervisor_workspaces WHERE id = ?`)
    .get(id) as WorkspaceRow | undefined;
  return row ? rowToWorkspace(row) : null;
}

export function setWorkspaceStatus(
  db: DB,
  id: string,
  status: WorkspaceStatus,
  updatedAt: string,
): void {
  db.prepare(
    `UPDATE supervisor_workspaces SET status = ?, updated_at = ? WHERE id = ?`,
  ).run(status, updatedAt, id);
}

export function setWorkspaceStage(db: DB, id: string, stage: WorkspaceStage, updatedAt: string): void {
  db.prepare(`UPDATE supervisor_workspaces SET stage = ?, updated_at = ? WHERE id = ?`).run(
    stage,
    updatedAt,
    id,
  );
}

export function setWorkspacePr(db: DB, id: string, prUrl: string | null, updatedAt: string): void {
  db.prepare(`UPDATE supervisor_workspaces SET pr_url = ?, updated_at = ? WHERE id = ?`).run(
    prUrl,
    updatedAt,
    id,
  );
}

export function deleteWorkspace(db: DB, id: string): void {
  db.prepare(`DELETE FROM supervisor_workspaces WHERE id = ?`).run(id);
  db.prepare(`DELETE FROM supervisor_queue_items WHERE workspace_id = ?`).run(id);
  db.prepare(`DELETE FROM supervisor_schedules WHERE workspace_id = ?`).run(id);
}

// ---- N4 command queue ----

interface QueueRow {
  id: string;
  workspace_id: string;
  command: string;
  status: string;
  position: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function rowToQueueItem(r: QueueRow): QueueItem {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    command: r.command,
    status: r.status as QueueItemStatus,
    position: r.position,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

export function insertQueueItem(db: DB, item: QueueItem): void {
  db.prepare(
    `INSERT INTO supervisor_queue_items
       (id, workspace_id, command, status, position, created_at, started_at, finished_at)
     VALUES (@id, @workspaceId, @command, @status, @position, @createdAt, @startedAt, @finishedAt)`,
  ).run(item);
}

export function listQueueItems(db: DB, workspaceId: string): QueueItem[] {
  const rows = db
    .prepare(`SELECT * FROM supervisor_queue_items WHERE workspace_id = ? ORDER BY position`)
    .all(workspaceId) as QueueRow[];
  return rows.map(rowToQueueItem);
}

export function nextQueuePosition(db: DB, workspaceId: string): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(position), -1) AS m FROM supervisor_queue_items WHERE workspace_id = ?`)
    .get(workspaceId) as { m: number };
  return row.m + 1;
}

export function setQueueItemStatus(
  db: DB,
  id: string,
  status: QueueItemStatus,
  opts: { startedAt?: string | null; finishedAt?: string | null } = {},
): void {
  // Build the SET clause from the provided timestamp fields.
  const sets = ["status = @status"];
  const params: Record<string, unknown> = { id, status };
  if ("startedAt" in opts) {
    sets.push("started_at = @startedAt");
    params.startedAt = opts.startedAt ?? null;
  }
  if ("finishedAt" in opts) {
    sets.push("finished_at = @finishedAt");
    params.finishedAt = opts.finishedAt ?? null;
  }
  db.prepare(`UPDATE supervisor_queue_items SET ${sets.join(", ")} WHERE id = @id`).run(params);
}

export function deleteQueueItem(db: DB, id: string): void {
  db.prepare(`DELETE FROM supervisor_queue_items WHERE id = ?`).run(id);
}

export function clearQueue(db: DB, workspaceId: string): void {
  db.prepare(`DELETE FROM supervisor_queue_items WHERE workspace_id = ?`).run(workspaceId);
}

// Distinct workspace ids that currently have a running queue item (for K2).
export function workspacesWithRunningQueueItem(db: DB): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT workspace_id FROM supervisor_queue_items WHERE status = 'running'`)
    .all() as Array<{ workspace_id: string }>;
  return rows.map((r) => r.workspace_id);
}

// K2 stale-release: a running item whose session died goes back to pending.
export function releaseRunningQueueItems(db: DB, workspaceId: string): void {
  db.prepare(
    `UPDATE supervisor_queue_items SET status = 'pending', started_at = NULL
       WHERE workspace_id = ? AND status = 'running'`,
  ).run(workspaceId);
}

// ---- N3 cron scheduler ----

interface ScheduleRow {
  id: string;
  workspace_id: string;
  cron: string;
  command: string;
  enabled: number;
  last_run_at: string | null;
  created_at: string;
}

function rowToSchedule(r: ScheduleRow): Schedule {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    cron: r.cron,
    command: r.command,
    enabled: r.enabled === 1,
    lastRunAt: r.last_run_at,
    createdAt: r.created_at,
  };
}

export function insertSchedule(db: DB, s: Schedule): void {
  db.prepare(
    `INSERT INTO supervisor_schedules (id, workspace_id, cron, command, enabled, last_run_at, created_at)
     VALUES (@id, @workspaceId, @cron, @command, @enabled, @lastRunAt, @createdAt)`,
  ).run({ ...s, enabled: s.enabled ? 1 : 0 });
}

export function listSchedules(db: DB, workspaceId: string): Schedule[] {
  const rows = db
    .prepare(`SELECT * FROM supervisor_schedules WHERE workspace_id = ? ORDER BY created_at`)
    .all(workspaceId) as ScheduleRow[];
  return rows.map(rowToSchedule);
}

export function listEnabledSchedules(db: DB): Schedule[] {
  const rows = db.prepare(`SELECT * FROM supervisor_schedules WHERE enabled = 1`).all() as ScheduleRow[];
  return rows.map(rowToSchedule);
}

export function setScheduleEnabled(db: DB, id: string, enabled: boolean): void {
  db.prepare(`UPDATE supervisor_schedules SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
}

export function setScheduleLastRun(db: DB, id: string, lastRunAt: string): void {
  db.prepare(`UPDATE supervisor_schedules SET last_run_at = ? WHERE id = ?`).run(lastRunAt, id);
}

export function deleteSchedule(db: DB, id: string): void {
  db.prepare(`DELETE FROM supervisor_schedules WHERE id = ?`).run(id);
}
