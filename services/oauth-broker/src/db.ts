// OAuth broker storage. Connection rows live in the main agent-cc.db (tokens are
// NOT here — they live in the secrets vault). Operation audit goes to audit.db.

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { applyMigrations, applyAuditMigrations, type OAuthConnection } from "@agent-cc/shared";

export type DB = Database.Database;

export function openMainDb(path: string): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  applyMigrations(db);
  return db;
}

export function openAuditDb(path: string): DB {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  applyAuditMigrations(db);
  return db;
}

interface ConnRow {
  id: string;
  provider: string;
  workspace_id: string | null;
  account: string;
  scopes_json: string;
  created_at: string;
}

function rowToConn(r: ConnRow): OAuthConnection {
  return {
    id: r.id,
    provider: r.provider,
    workspaceId: r.workspace_id,
    account: r.account,
    scopes: JSON.parse(r.scopes_json) as string[],
    createdAt: r.created_at,
  };
}

export function insertConnection(db: DB, c: OAuthConnection): void {
  db.prepare(
    `INSERT INTO oauth_connections (id, provider, workspace_id, account, scopes_json, created_at)
     VALUES (@id, @provider, @workspaceId, @account, @scopesJson, @createdAt)`,
  ).run({
    id: c.id,
    provider: c.provider,
    workspaceId: c.workspaceId,
    account: c.account,
    scopesJson: JSON.stringify(c.scopes),
    createdAt: c.createdAt,
  });
}

export function listConnections(db: DB, workspaceId?: string): OAuthConnection[] {
  const rows = workspaceId
    ? (db.prepare(`SELECT * FROM oauth_connections WHERE workspace_id = ? ORDER BY created_at`).all(workspaceId) as ConnRow[])
    : (db.prepare(`SELECT * FROM oauth_connections ORDER BY created_at`).all() as ConnRow[]);
  return rows.map(rowToConn);
}

export function getConnection(db: DB, id: string): OAuthConnection | null {
  const r = db.prepare(`SELECT * FROM oauth_connections WHERE id = ?`).get(id) as ConnRow | undefined;
  return r ? rowToConn(r) : null;
}

export function setScopes(db: DB, id: string, scopes: string[]): void {
  db.prepare(`UPDATE oauth_connections SET scopes_json = ? WHERE id = ?`).run(JSON.stringify(scopes), id);
}

export function deleteConnection(db: DB, id: string): void {
  db.prepare(`DELETE FROM oauth_connections WHERE id = ?`).run(id);
}

export function logOperation(
  audit: DB,
  row: { connectionId: string; provider: string; workspaceId: string | null; operation: string; status: string },
): void {
  audit
    .prepare(
      `INSERT INTO oauth_operations (id, ts, connection_id, provider, workspace_id, operation, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), new Date().toISOString(), row.connectionId, row.provider, row.workspaceId, row.operation, row.status);
}
