// LLM gateway HTTP API. Agents and the dashboard call this, never providers
// directly. API keys are written to the secrets vault, never returned.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { Provider, ProviderType } from "@agent-cc/shared";
import type { SecretsVault } from "@agent-cc/secrets";
import {
  type DB,
  insertProvider,
  listProviders,
  getProvider,
  deleteProvider,
  usageSummary,
  listAuditLog,
} from "./db.js";
import { infer } from "./gateway.js";

const VAULT_NS = "gateway";
const PROVIDER_TYPES: ProviderType[] = ["anthropic", "openai", "openrouter", "ollama", "mock"];

export function buildApi(main: DB, audit: DB, vault: SecretsVault, log: Logger) {
  const app = Fastify({ loggerInstance: log });

  app.get("/health", async () => ({ ok: true, service: "gateway" }));

  // Providers (keys are NOT part of these rows; they live in the vault).
  app.get("/providers", async () => listProviders(main));

  app.post("/providers", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.name !== "string" || typeof b.type !== "string" || !PROVIDER_TYPES.includes(b.type as ProviderType)) {
      return reply.code(400).send({ code: "bad_request", message: `name and type (${PROVIDER_TYPES.join("|")}) required` });
    }
    const provider: Provider = {
      id: randomUUID(),
      name: b.name,
      type: b.type as ProviderType,
      baseUrl: typeof b.baseUrl === "string" ? b.baseUrl : "",
      defaultModel: typeof b.defaultModel === "string" ? b.defaultModel : "",
      authType: b.type === "mock" || b.type === "ollama" ? "none" : "api_key",
      createdAt: new Date().toISOString(),
    };
    insertProvider(main, provider);
    return reply.code(201).send(provider);
  });

  app.delete<{ Params: { id: string } }>("/providers/:id", async (req) => {
    deleteProvider(main, req.params.id);
    vault.delete(VAULT_NS, req.params.id);
    return { ok: true };
  });

  // Store/replace a provider's API key (write-only — never read back out).
  app.put<{ Params: { id: string } }>("/providers/:id/key", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.apiKey !== "string" || !b.apiKey) {
      return reply.code(400).send({ code: "bad_request", message: "apiKey required" });
    }
    if (!getProvider(main, req.params.id)) {
      return reply.code(404).send({ code: "not_found", message: "provider not found" });
    }
    vault.set(VAULT_NS, req.params.id, b.apiKey);
    return reply.send({ ok: true });
  });

  // The single inference endpoint.
  app.post("/llm/infer", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.providerId !== "string" || typeof b.prompt !== "string") {
      return reply.code(400).send({ code: "bad_request", message: "providerId and prompt required" });
    }
    const result = await infer(
      { main, audit, vault },
      {
        providerId: b.providerId,
        prompt: b.prompt,
        model: typeof b.model === "string" ? b.model : undefined,
        workspaceId: typeof b.workspaceId === "string" ? b.workspaceId : undefined,
        personaId: typeof b.personaId === "string" ? b.personaId : undefined,
      },
    );
    if (!result.ok) {
      const code = result.error.code === "bad_request" ? 400 : 502;
      return reply.code(code).send(result.error);
    }
    return result.value;
  });

  // Usage rollup for the dashboard meters (default window: last 24h).
  app.get<{ Querystring: { since?: string; workspaceId?: string } }>("/llm/usage/summary", async (req) => {
    const since = req.query.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    return usageSummary(audit, since, req.query.workspaceId);
  });

  // Security / audit-log viewer: recent LLM + OAuth audit rows, newest first.
  app.get<{ Querystring: { limit?: string } }>("/audit/log", async (req) => {
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    return listAuditLog(audit, limit);
  });

  return app;
}
