// Memory service HTTP API. Called by the supervisor over localhost.

import Fastify from "fastify";
import type { Logger } from "pino";
import type { DB } from "./db.js";
import { copyWorkspaceMemory, getContext, writeRun } from "./memory.js";

export function buildApi(db: DB, log: Logger) {
  const app = Fastify({ loggerInstance: log });

  app.get("/health", async () => ({ ok: true, service: "memory" }));

  app.post("/memory/get-context", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.workspaceId !== "string") {
      return reply.code(400).send({ code: "bad_request", message: "workspaceId required" });
    }
    const taskHint = typeof body.taskHint === "string" ? body.taskHint : "";
    return getContext(db, body.workspaceId, taskHint);
  });

  app.post("/memory/write-run", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.workspaceId !== "string" || typeof body.runOutput !== "string") {
      return reply
        .code(400)
        .send({ code: "bad_request", message: "workspaceId and runOutput required" });
    }
    const exitCode = typeof body.exitCode === "number" ? body.exitCode : null;
    const item = writeRun(db, body.workspaceId, body.runOutput, exitCode);
    return reply.code(201).send(item);
  });

  // Seed a forked workspace's memory from its source (fork continues the same
  // work, so the compounding context comes with it).
  app.post("/memory/copy", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.sourceWorkspaceId !== "string" || typeof body.targetWorkspaceId !== "string") {
      return reply
        .code(400)
        .send({ code: "bad_request", message: "sourceWorkspaceId and targetWorkspaceId required" });
    }
    const copied = copyWorkspaceMemory(db, body.sourceWorkspaceId, body.targetWorkspaceId);
    return reply.code(201).send({ copied });
  });

  return app;
}
