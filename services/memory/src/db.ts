// SQLite access for the memory service. Opens the same shared agent-cc.db as the
// supervisor (idempotent migrations) and provides memory item + run persistence
// plus FTS5 search. Slice 1 is FTS5 only; sqlite-vec embeddings are deferred
// until keyword recall proves insufficient (per build-plan-v1).

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { applyMigrations, type MemoryItem, type MemoryItemType } from "@agent-cc/shared";

export type DB = Database.Database;

export function openDb(path: string): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  applyMigrations(db);
  return db;
}

interface ItemRow {
  id: string;
  workspace_id: string;
  type: string;
  body: string;
  tags_json: string;
  created_at: string;
}

function rowToItem(r: ItemRow): MemoryItem {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    type: r.type as MemoryItemType,
    body: r.body,
    tags: JSON.parse(r.tags_json) as string[],
    createdAt: r.created_at,
  };
}

export function insertItem(db: DB, item: MemoryItem): void {
  db.prepare(
    `INSERT INTO memory_items (id, workspace_id, type, body, tags_json, created_at)
     VALUES (@id, @workspaceId, @type, @body, @tagsJson, @createdAt)`,
  ).run({
    id: item.id,
    workspaceId: item.workspaceId,
    type: item.type,
    body: item.body,
    tagsJson: JSON.stringify(item.tags),
    createdAt: item.createdAt,
  });
}

export function insertRun(
  db: DB,
  run: { id: string; workspaceId: string; exitCode: number | null; finalPaneState: string; summary: string; createdAt: string },
): void {
  db.prepare(
    `INSERT INTO memory_runs (id, workspace_id, exit_code, trigger, final_pane_state, summary, created_at)
     VALUES (@id, @workspaceId, @exitCode, 'session_end', @finalPaneState, @summary, @createdAt)`,
  ).run(run);
}

// Background summary upgrade: replace the heuristic summary once the model
// path succeeds. The FTS update trigger keeps memory_items_fts in sync.
export function updateRunSummary(db: DB, runId: string, summary: string): void {
  db.prepare(`UPDATE memory_runs SET summary = ? WHERE id = ?`).run(summary, runId);
}

export function updateItemBody(db: DB, itemId: string, body: string): void {
  db.prepare(`UPDATE memory_items SET body = ? WHERE id = ?`).run(body, itemId);
}

export function recentByType(
  db: DB,
  workspaceId: string,
  type: MemoryItemType,
  limit: number,
): MemoryItem[] {
  const rows = db
    .prepare(
      `SELECT * FROM memory_items
       WHERE workspace_id = ? AND type = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(workspaceId, type, limit) as ItemRow[];
  return rows.map(rowToItem);
}

// FTS5 keyword search scoped to a workspace. Returns top-K by rank.
export function searchItems(
  db: DB,
  workspaceId: string,
  query: string,
  limit: number,
): MemoryItem[] {
  const match = toFtsMatch(query);
  if (!match) return [];
  const rows = db
    .prepare(
      `SELECT mi.* FROM memory_items_fts f
         JOIN memory_items mi ON mi.rowid = f.rowid
        WHERE f.memory_items_fts MATCH ? AND mi.workspace_id = ?
        ORDER BY rank LIMIT ?`,
    )
    .all(match, workspaceId, limit) as ItemRow[];
  return rows.map(rowToItem);
}

// Build a safe FTS5 MATCH expression: keep alphanumeric tokens, quote each,
// OR them together. Avoids FTS5 syntax errors from arbitrary user input.
export function toFtsMatch(query: string): string {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length > 1);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" OR ");
}
