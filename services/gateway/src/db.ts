// Gateway storage. Provider registry lives in the main agent-cc.db; usage rows
// go to the separate audit.db (bulk data off the hot path).

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  applyMigrations,
  applyAuditMigrations,
  type Provider,
  type ProviderType,
  type InferUsage,
  type UsageSummary,
  type AuditEntry,
} from "@agent-cc/shared";

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

interface ProviderRow {
  id: string;
  name: string;
  type: string;
  base_url: string;
  default_model: string;
  auth_type: string;
  created_at: string;
}

function rowToProvider(r: ProviderRow): Provider {
  return {
    id: r.id,
    name: r.name,
    type: r.type as ProviderType,
    baseUrl: r.base_url,
    defaultModel: r.default_model,
    authType: r.auth_type as Provider["authType"],
    createdAt: r.created_at,
  };
}

export function insertProvider(db: DB, p: Provider): void {
  db.prepare(
    `INSERT INTO gateway_providers (id, name, type, base_url, default_model, auth_type, created_at)
     VALUES (@id, @name, @type, @baseUrl, @defaultModel, @authType, @createdAt)`,
  ).run(p);
}

export function listProviders(db: DB): Provider[] {
  return (db.prepare(`SELECT * FROM gateway_providers ORDER BY name`).all() as ProviderRow[]).map(rowToProvider);
}

export function getProvider(db: DB, id: string): Provider | null {
  const r = db.prepare(`SELECT * FROM gateway_providers WHERE id = ?`).get(id) as ProviderRow | undefined;
  return r ? rowToProvider(r) : null;
}

export function deleteProvider(db: DB, id: string): void {
  db.prepare(`DELETE FROM gateway_providers WHERE id = ?`).run(id);
}

export function logUsage(
  audit: DB,
  row: { providerId: string; modelId: string; workspaceId: string | null; personaId: string | null; usage: InferUsage },
): void {
  audit
    .prepare(
      `INSERT INTO gateway_usage
        (id, ts, provider_id, model_id, workspace_id, persona_id, input_tokens, output_tokens, cost_microcents, latency_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      new Date().toISOString(),
      row.providerId,
      row.modelId,
      row.workspaceId,
      row.personaId,
      row.usage.inputTokens,
      row.usage.outputTokens,
      row.usage.costMicrocents,
      row.usage.latencyMs,
    );
}

// Unified recent audit log: LLM gateway usage + OAuth proxied operations, both
// from audit.db (the oauth-broker writes oauth_operations into the same file),
// merged newest-first. summary is built here so the dashboard stays dumb.
export function listAuditLog(audit: DB, limit: number): AuditEntry[] {
  const usage = audit
    .prepare(
      `SELECT id, ts, provider_id, model_id, workspace_id, input_tokens, output_tokens, cost_microcents
         FROM gateway_usage ORDER BY ts DESC LIMIT ?`,
    )
    .all(limit) as Array<{
    id: string;
    ts: string;
    provider_id: string;
    model_id: string;
    workspace_id: string | null;
    input_tokens: number;
    output_tokens: number;
    cost_microcents: number;
  }>;
  const ops = audit
    .prepare(
      `SELECT id, ts, provider, workspace_id, operation, status
         FROM oauth_operations ORDER BY ts DESC LIMIT ?`,
    )
    .all(limit) as Array<{
    id: string;
    ts: string;
    provider: string;
    workspace_id: string | null;
    operation: string;
    status: string;
  }>;

  const entries: AuditEntry[] = [];
  for (const u of usage) {
    entries.push({
      id: u.id,
      ts: u.ts,
      kind: "llm",
      workspaceId: u.workspace_id,
      summary: `${u.provider_id}/${u.model_id} · ${u.input_tokens}→${u.output_tokens} tok · $${(u.cost_microcents / 100_000_000).toFixed(4)}`,
      status: "ok",
    });
  }
  for (const o of ops) {
    entries.push({
      id: o.id,
      ts: o.ts,
      kind: "oauth",
      workspaceId: o.workspace_id,
      summary: `${o.provider} · ${o.operation}`,
      status: o.status,
    });
  }
  entries.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  return entries.slice(0, limit);
}

// Aggregate usage since an ISO timestamp (optionally scoped to a workspace).
export function usageSummary(audit: DB, sinceIso: string, workspaceId?: string): UsageSummary {
  const where = workspaceId ? `WHERE ts >= ? AND workspace_id = ?` : `WHERE ts >= ?`;
  const params = workspaceId ? [sinceIso, workspaceId] : [sinceIso];
  const r = audit
    .prepare(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(input_tokens),0) AS input_tokens,
              COALESCE(SUM(output_tokens),0) AS output_tokens,
              COALESCE(SUM(cost_microcents),0) AS cost_microcents
         FROM gateway_usage ${where}`,
    )
    .get(...params) as { calls: number; input_tokens: number; output_tokens: number; cost_microcents: number };
  return {
    calls: r.calls,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costMicrocents: r.cost_microcents,
    sinceIso,
  };
}
