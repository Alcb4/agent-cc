// SQLite schema definitions for the shared agent-cc.db.
//
// SQLite has no Postgres-style schemas, so the design doc's "per-service schemas"
// are implemented as table-name prefixes (supervisor_*, memory_*, gateway_*, ...).
// ATTACH DATABASE is reserved for the separate audit.db / secrets.db files, not
// for namespacing inside this one file. Schema is intentionally non-overlapping.
//
// Slice 1 covers supervisor_* and memory_*. Other services add their tables in
// later slices.

export const SCHEMA_VERSION = 1;

// Run once at startup. Idempotent (IF NOT EXISTS). Order matters: base tables
// before the FTS5 virtual table and its sync triggers.
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS supervisor_projects (
     id             TEXT PRIMARY KEY,
     name           TEXT NOT NULL,
     repo_root      TEXT NOT NULL,
     default_model  TEXT NOT NULL DEFAULT '',
     created_at     TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS supervisor_workspaces (
     id                 TEXT PRIMARY KEY,
     project_id         TEXT,
     name               TEXT NOT NULL,
     repo_root          TEXT NOT NULL,
     cwd_subpath        TEXT NOT NULL DEFAULT '',
     branch             TEXT NOT NULL,
     base_branch        TEXT NOT NULL DEFAULT 'main',
     worktree_path      TEXT NOT NULL,
     tmux_session_name  TEXT NOT NULL UNIQUE,
     command            TEXT NOT NULL DEFAULT '',
     model              TEXT NOT NULL DEFAULT '',
     status             TEXT NOT NULL DEFAULT 'idle',
     persona_id         TEXT,
     created_at         TEXT NOT NULL,
     updated_at         TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_workspaces_project
     ON supervisor_workspaces (project_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS memory_items (
     id            TEXT PRIMARY KEY,
     workspace_id  TEXT NOT NULL,
     type          TEXT NOT NULL,
     body          TEXT NOT NULL,
     tags_json     TEXT NOT NULL DEFAULT '[]',
     embedding     BLOB,
     created_at    TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_memory_items_ws
     ON memory_items (workspace_id, type, created_at)`,

  `CREATE TABLE IF NOT EXISTS memory_runs (
     id               TEXT PRIMARY KEY,
     workspace_id     TEXT NOT NULL,
     exit_code        INTEGER,
     trigger          TEXT NOT NULL DEFAULT 'session_end',
     final_pane_state TEXT NOT NULL DEFAULT '',
     summary          TEXT NOT NULL DEFAULT '',
     created_at       TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_memory_runs_ws
     ON memory_runs (workspace_id, created_at)`,

  // FTS5 over memory item bodies. external-content table keyed to memory_items.
  `CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts USING fts5(
     body,
     content='memory_items',
     content_rowid='rowid'
   )`,

  // Keep the FTS index in sync with memory_items.
  `CREATE TRIGGER IF NOT EXISTS memory_items_ai AFTER INSERT ON memory_items BEGIN
     INSERT INTO memory_items_fts(rowid, body) VALUES (new.rowid, new.body);
   END`,
  `CREATE TRIGGER IF NOT EXISTS memory_items_ad AFTER DELETE ON memory_items BEGIN
     INSERT INTO memory_items_fts(memory_items_fts, rowid, body)
       VALUES ('delete', old.rowid, old.body);
   END`,
  `CREATE TRIGGER IF NOT EXISTS memory_items_au AFTER UPDATE ON memory_items BEGIN
     INSERT INTO memory_items_fts(memory_items_fts, rowid, body)
       VALUES ('delete', old.rowid, old.body);
     INSERT INTO memory_items_fts(rowid, body) VALUES (new.rowid, new.body);
   END`,

  // ---- persona service (Slice 3, T12) ----
  `CREATE TABLE IF NOT EXISTS persona_personas (
     id            TEXT PRIMARY KEY,
     role          TEXT NOT NULL,
     base_prompt   TEXT NOT NULL DEFAULT '',
     toolset_json  TEXT NOT NULL DEFAULT '[]',
     default_model TEXT NOT NULL DEFAULT '',
     created_at    TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS persona_project_overlays (
     id           TEXT PRIMARY KEY,
     project_path TEXT NOT NULL,
     fragment     TEXT NOT NULL DEFAULT '',
     tags_json    TEXT NOT NULL DEFAULT '[]',
     created_at   TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_overlays_project
     ON persona_project_overlays (project_path)`,
  `CREATE TABLE IF NOT EXISTS persona_workspace_bindings (
     workspace_id TEXT PRIMARY KEY,
     persona_id   TEXT NOT NULL,
     is_active    INTEGER NOT NULL DEFAULT 1,
     created_at   TEXT NOT NULL
   )`,

  // ---- LLM gateway (Slice 3, T13) — provider registry lives in the main db ----
  `CREATE TABLE IF NOT EXISTS gateway_providers (
     id            TEXT PRIMARY KEY,
     name          TEXT NOT NULL,
     type          TEXT NOT NULL,
     base_url      TEXT NOT NULL DEFAULT '',
     default_model TEXT NOT NULL DEFAULT '',
     auth_type     TEXT NOT NULL DEFAULT 'api_key',
     created_at    TEXT NOT NULL
   )`,

  // ---- OAuth broker (Slice 3, T14) — connection rows; tokens live in the vault ----
  `CREATE TABLE IF NOT EXISTS oauth_connections (
     id           TEXT PRIMARY KEY,
     provider     TEXT NOT NULL,
     workspace_id TEXT,
     account      TEXT NOT NULL DEFAULT '',
     scopes_json  TEXT NOT NULL DEFAULT '[]',
     created_at   TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_oauth_ws ON oauth_connections (workspace_id)`,

  // ---- K3 workflow stage (kanban axis, orthogonal to status) ----
  `ALTER TABLE supervisor_workspaces ADD COLUMN stage TEXT NOT NULL DEFAULT 'active'`,
  // Backfill: an already-ended workspace is awaiting a merge decision → review.
  `UPDATE supervisor_workspaces SET stage = 'review' WHERE status = 'ended'`,

  // ---- N4 command queue (per-workspace, sequential) ----
  `CREATE TABLE IF NOT EXISTS supervisor_queue_items (
     id            TEXT PRIMARY KEY,
     workspace_id  TEXT NOT NULL,
     command       TEXT NOT NULL,
     status        TEXT NOT NULL DEFAULT 'pending',
     position      INTEGER NOT NULL,
     created_at    TEXT NOT NULL,
     started_at    TEXT,
     finished_at   TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_queue_ws
     ON supervisor_queue_items (workspace_id, position)`,

  // ---- Phase 2: GitHub PR integration ----
  `ALTER TABLE supervisor_workspaces ADD COLUMN pr_url TEXT`,

  // ---- N3 cron scheduler ----
  `CREATE TABLE IF NOT EXISTS supervisor_schedules (
     id            TEXT PRIMARY KEY,
     workspace_id  TEXT NOT NULL,
     cron          TEXT NOT NULL,
     command       TEXT NOT NULL,
     enabled       INTEGER NOT NULL DEFAULT 1,
     last_run_at   TEXT,
     created_at    TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_schedules_ws ON supervisor_schedules (workspace_id)`,
];

// audit.db is a separate file (bulk audit data off the hot path). The gateway
// applies this to its audit connection.
export const AUDIT_MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS gateway_usage (
     id             TEXT PRIMARY KEY,
     ts             TEXT NOT NULL,
     provider_id    TEXT NOT NULL,
     model_id       TEXT NOT NULL,
     workspace_id   TEXT,
     persona_id     TEXT,
     input_tokens   INTEGER NOT NULL DEFAULT 0,
     output_tokens  INTEGER NOT NULL DEFAULT 0,
     cost_microcents INTEGER NOT NULL DEFAULT 0,
     latency_ms     INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE INDEX IF NOT EXISTS idx_usage_ts ON gateway_usage (ts)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_ws ON gateway_usage (workspace_id, ts)`,

  // OAuth operation audit (every proxied call: who, what, result).
  `CREATE TABLE IF NOT EXISTS oauth_operations (
     id            TEXT PRIMARY KEY,
     ts            TEXT NOT NULL,
     connection_id TEXT NOT NULL,
     provider      TEXT NOT NULL,
     workspace_id  TEXT,
     operation     TEXT NOT NULL,
     status        TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_oauth_ops_ts ON oauth_operations (ts)`,
];

export function applyAuditMigrations(db: MigratableDb): void {
  runMigrations(db, AUDIT_MIGRATIONS);
}

// Structural shape of a better-sqlite3 Database, kept here so the migration
// runner can live in shared without shared depending on the native driver.
export interface MigratableDb {
  pragma(source: string, options?: { simple?: boolean }): unknown;
  exec(source: string): unknown;
}

// Apply pending migrations exactly once, tracked by PRAGMA user_version (the
// count of applied statements; only statements beyond the stored version run).
// All six services open the shared db concurrently, so the read-check-apply must
// be atomic: BEGIN IMMEDIATE takes the write lock up front, and any second opener
// blocks on it (busy_timeout) then re-reads the bumped version and does nothing.
// This is what makes a NON-idempotent migration (e.g. ALTER TABLE ADD COLUMN)
// safe under concurrent open — without the lock, two openers both pass the
// version check and the second ALTER throws "duplicate column".
function runMigrations(db: MigratableDb, migrations: readonly string[]): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db.pragma("user_version") as Array<{ user_version: number }>;
    const current = rows[0]?.user_version ?? 0;
    for (let i = current; i < migrations.length; i++) db.exec(migrations[i]!);
    if (current < migrations.length) db.exec(`PRAGMA user_version = ${migrations.length}`);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function applyMigrations(db: MigratableDb): void {
  runMigrations(db, MIGRATIONS);
}
