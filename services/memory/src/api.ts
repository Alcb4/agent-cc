// Memory service HTTP API. Called by the supervisor over localhost.

import Fastify from "fastify";
import type { Logger } from "pino";
import type { DB } from "./db.js";
import {
  copyWorkspaceMemory,
  getContext,
  projectMemoryId,
  rollUpToProject,
  upgradeRunSummary,
  writeRun,
} from "./memory.js";

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
    const { item, runId, cleanOutput } = writeRun(db, body.workspaceId, body.runOutput, exitCode);
    // Upgrade to a model summary in the background; the response never waits
    // on the CLI and a failure leaves the heuristic in place.
    void upgradeRunSummary(db, { runId, itemId: item.id, cleanOutput, exitCode })
      .then((upgraded) => {
        if (upgraded) log.info({ runId }, "run summary upgraded by model");
      })
      .catch((e: unknown) => log.warn({ runId, err: e }, "model summary upgrade failed"));
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

  // The project's rolled-up memory (the union of its removed tasks' value).
  // Same ContextPack shape as a workspace, over the project memory namespace.
  app.post("/memory/project-context", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.projectId !== "string") {
      return reply.code(400).send({ code: "bad_request", message: "projectId required" });
    }
    const taskHint = typeof body.taskHint === "string" ? body.taskHint : "";
    return getContext(db, projectMemoryId(body.projectId), taskHint);
  });

  // Roll a task's memory up to its project's memory namespace, so its value
  // survives after the task is removed. Idempotent (deduped by body).
  app.post("/memory/roll-up", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.workspaceId !== "string" || typeof body.projectId !== "string") {
      return reply
        .code(400)
        .send({ code: "bad_request", message: "workspaceId and projectId required" });
    }
    const taskName = typeof body.taskName === "string" ? body.taskName : undefined;
    const copied = rollUpToProject(db, {
      workspaceId: body.workspaceId,
      projectId: body.projectId,
      taskName,
    });
    return reply.code(201).send({ copied });
  });

  return app;
}
