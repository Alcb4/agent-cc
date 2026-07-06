// Persona service HTTP API. Called by the supervisor (and dashboard via the
// supervisor proxy) over localhost.

import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { Persona, ProjectOverlay } from "@agent-cc/shared";
import {
  type DB,
  insertPersona,
  listPersonas,
  getPersona,
  updatePersona,
  deletePersona,
  upsertOverlay,
  overlaysForProject,
  setBinding,
  getBinding,
} from "./db.js";
import { compose } from "./persona.js";

function nowIso(): string {
  return new Date().toISOString();
}

export function buildApi(db: DB, log: Logger) {
  const app = Fastify({ loggerInstance: log });

  app.get("/health", async () => ({ ok: true, service: "persona" }));

  app.get("/personas", async () => listPersonas(db));

  app.post("/personas", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.role !== "string") {
      return reply.code(400).send({ code: "bad_request", message: "role is required" });
    }
    const persona: Persona = {
      id: randomUUID(),
      role: b.role,
      basePrompt: typeof b.basePrompt === "string" ? b.basePrompt : "",
      toolset: Array.isArray(b.toolset) ? (b.toolset as string[]) : [],
      defaultModel: typeof b.defaultModel === "string" ? b.defaultModel : "",
      createdAt: nowIso(),
    };
    insertPersona(db, persona);
    return reply.code(201).send(persona);
  });

  app.get<{ Params: { id: string } }>("/personas/:id", async (req, reply) => {
    const p = getPersona(db, req.params.id);
    if (!p) return reply.code(404).send({ code: "not_found", message: "persona not found" });
    return p;
  });

  app.patch<{ Params: { id: string } }>("/personas/:id", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const updated = updatePersona(db, req.params.id, {
      role: typeof b.role === "string" ? b.role : undefined,
      basePrompt: typeof b.basePrompt === "string" ? b.basePrompt : undefined,
      toolset: Array.isArray(b.toolset) ? (b.toolset as string[]) : undefined,
      defaultModel: typeof b.defaultModel === "string" ? b.defaultModel : undefined,
    });
    if (!updated) return reply.code(404).send({ code: "not_found", message: "persona not found" });
    return updated;
  });

  app.delete<{ Params: { id: string } }>("/personas/:id", async (req) => {
    deletePersona(db, req.params.id);
    return { ok: true };
  });

  // Compose: persona base + project overlay + task context.
  app.post("/personas/compose", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.workspaceId !== "string" || typeof b.personaId !== "string") {
      return reply.code(400).send({ code: "bad_request", message: "workspaceId and personaId required" });
    }
    const result = compose(db, {
      workspaceId: b.workspaceId,
      personaId: b.personaId,
      taskContext: typeof b.taskContext === "string" ? b.taskContext : "",
      projectPath: typeof b.projectPath === "string" ? b.projectPath : undefined,
    });
    if (!result) return reply.code(404).send({ code: "not_found", message: "persona not found" });
    return result;
  });

  app.get<{ Querystring: { project?: string } }>("/personas/overlays", async (req) =>
    overlaysForProject(db, req.query.project ?? ""),
  );

  app.post("/personas/overlays", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.projectPath !== "string") {
      return reply.code(400).send({ code: "bad_request", message: "projectPath is required" });
    }
    const overlay: ProjectOverlay = {
      id: randomUUID(),
      projectPath: b.projectPath,
      fragment: typeof b.fragment === "string" ? b.fragment : "",
      tags: Array.isArray(b.tags) ? (b.tags as string[]) : [],
      createdAt: nowIso(),
    };
    upsertOverlay(db, overlay);
    return reply.code(201).send(overlay);
  });

  // Workspace bindings (one active persona per workspace; multi-persona is Phase 3).
  app.post("/personas/bindings", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.workspaceId !== "string" || typeof b.personaId !== "string") {
      return reply.code(400).send({ code: "bad_request", message: "workspaceId and personaId required" });
    }
    setBinding(db, b.workspaceId, b.personaId, nowIso());
    return reply.code(201).send({ ok: true });
  });

  app.get<{ Params: { workspaceId: string } }>("/personas/bindings/:workspaceId", async (req, reply) => {
    const binding = getBinding(db, req.params.workspaceId);
    if (!binding) return reply.code(404).send({ code: "not_found", message: "no binding" });
    return binding;
  });

  return app;
}
