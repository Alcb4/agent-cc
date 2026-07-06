// OAuth broker HTTP API. Tokens are written to the vault on connection create
// and never returned. Full 3-legged OAuth (/oauth/login + callback) is deferred;
// the manual-token path (paste a PAT / bot token) is the day-one local flow.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { OAuthConnection } from "@agent-cc/shared";
import type { SecretsVault } from "@agent-cc/secrets";
import {
  type DB,
  insertConnection,
  listConnections,
  getConnection,
  setScopes,
  deleteConnection,
} from "./db.js";
import { proxy, RateLimiter } from "./broker.js";

const VAULT_NS = "oauth";

export function buildApi(main: DB, audit: DB, vault: SecretsVault, log: Logger) {
  const app = Fastify({ loggerInstance: log });
  const limiter = new RateLimiter(Number(process.env.OAUTH_RATE_LIMIT ?? "120"));

  app.get("/health", async () => ({ ok: true, service: "oauth-broker" }));

  // 3-legged OAuth is not implemented yet; guide the user to the manual path.
  app.post("/oauth/login", async (_req, reply) =>
    reply.code(501).send({ code: "not_implemented", message: "Use POST /oauth/connections with a token (PAT) for now." }),
  );

  // Register a connection by pasting a token (PAT / bot token). Token -> vault.
  app.post("/oauth/connections", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.provider !== "string" || typeof b.token !== "string" || !b.token) {
      return reply.code(400).send({ code: "bad_request", message: "provider and token required" });
    }
    const conn: OAuthConnection = {
      id: randomUUID(),
      provider: b.provider,
      workspaceId: typeof b.workspaceId === "string" ? b.workspaceId : null,
      account: typeof b.account === "string" ? b.account : "",
      scopes: Array.isArray(b.scopes) ? (b.scopes as string[]) : [],
      createdAt: new Date().toISOString(),
    };
    vault.set(VAULT_NS, conn.id, b.token);
    insertConnection(main, conn);
    return reply.code(201).send(conn); // no token in the response
  });

  app.get<{ Querystring: { workspaceId?: string } }>("/oauth/connections", async (req) =>
    listConnections(main, req.query.workspaceId),
  );

  // Grant operations to a connection (default-deny; merge into existing scopes).
  app.post<{ Params: { id: string } }>("/oauth/connections/:id/grant", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const conn = getConnection(main, req.params.id);
    if (!conn) return reply.code(404).send({ code: "not_found", message: "connection not found" });
    const add = Array.isArray(b.operations) ? (b.operations as string[]) : [];
    const merged = Array.from(new Set([...conn.scopes, ...add]));
    setScopes(main, conn.id, merged);
    return reply.send({ ok: true, scopes: merged });
  });

  app.delete<{ Params: { id: string } }>("/oauth/connections/:id", async (req) => {
    deleteConnection(main, req.params.id);
    vault.delete(VAULT_NS, req.params.id);
    return { ok: true };
  });

  // Execute a logical operation against a connection's provider.
  app.post("/oauth/proxy", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.connectionId !== "string" || typeof b.operation !== "string") {
      return reply.code(400).send({ code: "bad_request", message: "connectionId and operation required" });
    }
    const r = await proxy(
      { main, audit, vault, limiter },
      {
        connectionId: b.connectionId,
        operation: b.operation,
        params: (b.params as Record<string, unknown>) ?? {},
      },
    );
    if (!r.ok) {
      const code = r.error.code === "bad_request" ? 403 : 502;
      return reply.code(code).send(r.error);
    }
    return r.value;
  });

  return app;
}
