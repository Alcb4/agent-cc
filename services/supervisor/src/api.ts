// Public HTTP + WebSocket API on the supervisor (the single public face).
// Slice 1 surface: workspace create/list/get, context preview + inject, and the
// bidirectional stream. Worktree endpoints (merge/discard/keep) arrive in Slice 2.

import Fastify, { type FastifyRequest, type FastifyReply } from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import type { Logger } from "pino";
import type { ClientMessage } from "@agent-cc/shared";
import type { WorkspaceManager } from "./workspace.js";
import type { ServiceMonitor } from "./services-monitor.js";
import { getContext, bindPersona, composePersona, copyMemory, getUsageSummary } from "./clients.js";

export interface ApiDeps {
  workspaces: WorkspaceManager;
  services: ServiceMonitor;
  memoryBaseUrl: string;
  personaBaseUrl: string;
  gatewayBaseUrl: string;
  oauthBaseUrl: string;
  // Default root for the N1 project-root picker.
  projectsRoot: string;
  log: Logger;
}

// Forward every request under `prefix` (and the bare prefix) to `targetBase`,
// preserving method, path, query, and JSON body. Keeps the dashboard talking to
// one origin while the work is done by the leaf service.
function registerProxy(app: ReturnType<typeof Fastify>, prefix: string, targetBase: string): void {
  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const url = `${targetBase}${req.url}`;
    const method = req.method.toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD" && req.body != null;
    try {
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: hasBody ? JSON.stringify(req.body) : undefined,
      });
      const text = await res.text();
      reply.code(res.status);
      reply.header("content-type", res.headers.get("content-type") ?? "application/json");
      return reply.send(text);
    } catch (e) {
      return reply.code(502).send({
        code: "service.unreachable",
        message: `${prefix} service is down. Restart with: agent-cc start.`,
        detail: (e as Error).message,
      });
    }
  };
  app.all(prefix, handler);
  app.all(`${prefix}/*`, handler);
}

export async function buildApi(deps: ApiDeps) {
  const app = Fastify({ loggerInstance: deps.log });
  // Must finish loading before any { websocket: true } route is registered,
  // otherwise the plugin's onRoute hook misses them and they fall back to plain
  // HTTP handlers (the handler then receives (request, reply), not (socket, req)).
  await app.register(websocket);
  // Single-user local tool: the dashboard origin talks to the supervisor.
  await app.register(cors, { origin: true });

  // The supervisor is the single public face: proxy config traffic to the
  // gateway / persona / oauth services so the dashboard only ever hits :7711.
  registerProxy(app, "/providers", deps.gatewayBaseUrl);
  registerProxy(app, "/llm", deps.gatewayBaseUrl);
  registerProxy(app, "/audit", deps.gatewayBaseUrl);
  registerProxy(app, "/personas", deps.personaBaseUrl);
  registerProxy(app, "/oauth", deps.oauthBaseUrl);

  app.get("/health", async () => ({ ok: true, service: "supervisor" }));

  // Live status of dependent services (periodic probe, not startup-only).
  app.get("/services", async () => deps.services.snapshot());

  // Usage rollup for the dashboard meters (proxied from the gateway).
  app.get<{ Querystring: { since?: string; workspaceId?: string } }>("/usage/summary", async (req, reply) => {
    const r = await getUsageSummary(deps.gatewayBaseUrl, {
      since: req.query.since,
      workspaceId: req.query.workspaceId,
    });
    if (!r.ok) return reply.code(502).send(r.error);
    return r.value;
  });

  // ---- Projects ----
  app.get("/projects", async () => deps.workspaces.listProjects());

  // N1 project-root picker: list candidate repos under `root` (default config root).
  app.get<{ Querystring: { root?: string } }>("/projects/scan", async (req, reply) => {
    const root = req.query.root?.trim() ? req.query.root : deps.projectsRoot;
    const r = await deps.workspaces.scanProjectsRoot(root);
    if (!r.ok) return reply.code(400).send(r.error);
    return { root, entries: r.value };
  });

  app.post("/projects", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.name !== "string" || typeof body.repoRoot !== "string") {
      return reply.code(400).send({ code: "bad_request", message: "name and repoRoot are required" });
    }
    const r = deps.workspaces.createProject({
      name: body.name,
      repoRoot: body.repoRoot,
      defaultModel: typeof body.defaultModel === "string" ? body.defaultModel : undefined,
    });
    if (!r.ok) return reply.code(400).send(r.error);
    return reply.code(201).send(r.value);
  });

  app.delete<{ Params: { id: string }; Querystring: { cascade?: string } }>(
    "/projects/:id",
    async (req, reply) => {
      const r = await deps.workspaces.removeProject(req.params.id, req.query.cascade === "true");
      if (!r.ok) {
        const code = r.error.code === "workspace.not_found" ? 404 : 400;
        return reply.code(code).send(r.error);
      }
      return reply.send({ ok: true });
    },
  );

  // B3 watchdog: activity (active/idle) for every live session — the bulk poll
  // the dashboard grid uses and the queue/scheduler will read.
  app.get("/activity", async () => deps.workspaces.activitySnapshot());

  // ---- Workspaces ----
  app.get<{ Querystring: { projectId?: string } }>("/workspaces", async (req) =>
    deps.workspaces.list(req.query.projectId),
  );

  app.get<{ Params: { id: string } }>("/workspaces/:id/activity", async (req) =>
    deps.workspaces.activity(req.params.id),
  );

  // ---- N4 command queue ----
  app.get<{ Params: { id: string } }>("/workspaces/:id/queue", async (req) =>
    deps.workspaces.listQueue(req.params.id),
  );

  app.post<{ Params: { id: string } }>("/workspaces/:id/queue", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.command !== "string") {
      return reply.code(400).send({ code: "bad_request", message: "command is required" });
    }
    const r = deps.workspaces.enqueue(req.params.id, body.command);
    if (!r.ok) {
      const code = r.error.code === "workspace.not_found" ? 404 : 400;
      return reply.code(code).send(r.error);
    }
    return reply.code(201).send(r.value);
  });

  app.delete<{ Params: { id: string } }>("/workspaces/:id/queue", async (req, reply) => {
    deps.workspaces.clearQueue(req.params.id);
    return reply.send({ ok: true });
  });

  app.delete<{ Params: { id: string; itemId: string } }>(
    "/workspaces/:id/queue/:itemId",
    async (req, reply) => {
      deps.workspaces.removeQueueItem(req.params.id, req.params.itemId);
      return reply.send({ ok: true });
    },
  );

  // ---- N3 cron scheduler ----
  app.get<{ Params: { id: string } }>("/workspaces/:id/schedules", async (req) =>
    deps.workspaces.listSchedules(req.params.id),
  );

  app.post<{ Params: { id: string } }>("/workspaces/:id/schedules", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.cron !== "string" || typeof body.command !== "string") {
      return reply.code(400).send({ code: "bad_request", message: "cron and command are required" });
    }
    const r = deps.workspaces.addSchedule(req.params.id, body.cron, body.command);
    if (!r.ok) {
      const code = r.error.code === "workspace.not_found" ? 404 : 400;
      return reply.code(code).send(r.error);
    }
    return reply.code(201).send(r.value);
  });

  app.post<{ Params: { id: string; scheduleId: string }; Body: { enabled?: boolean } }>(
    "/workspaces/:id/schedules/:scheduleId/enabled",
    async (req, reply) => {
      const enabled = (req.body ?? {}).enabled !== false;
      deps.workspaces.setScheduleEnabled(req.params.scheduleId, enabled);
      return reply.send({ ok: true, enabled });
    },
  );

  app.delete<{ Params: { id: string; scheduleId: string } }>(
    "/workspaces/:id/schedules/:scheduleId",
    async (req, reply) => {
      deps.workspaces.removeSchedule(req.params.scheduleId);
      return reply.send({ ok: true });
    },
  );

  // K3: manually move a workspace to another workflow stage (board move).
  app.post<{ Params: { id: string } }>("/workspaces/:id/stage", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const stage = body.stage;
    if (stage !== "backlog" && stage !== "active" && stage !== "review" && stage !== "done") {
      return reply.code(400).send({ code: "bad_request", message: "invalid stage" });
    }
    const r = deps.workspaces.setStage(req.params.id, stage);
    if (!r.ok) return reply.code(404).send(r.error);
    return reply.send({ ok: true });
  });

  app.post("/workspaces", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.name !== "string") {
      return reply.code(400).send({ code: "bad_request", message: "name is required" });
    }
    if (typeof body.projectId !== "string" && typeof body.repoRoot !== "string") {
      return reply.code(400).send({ code: "bad_request", message: "projectId or repoRoot is required" });
    }
    const personaId = typeof body.personaId === "string" ? body.personaId : undefined;
    const result = await deps.workspaces.create({
      name: body.name,
      projectId: typeof body.projectId === "string" ? body.projectId : undefined,
      repoRoot: typeof body.repoRoot === "string" ? body.repoRoot : undefined,
      model: typeof body.model === "string" ? body.model : undefined,
      personaId,
      cwdSubpath: typeof body.cwdSubpath === "string" ? body.cwdSubpath : undefined,
      command: typeof body.command === "string" ? body.command : undefined,
      cols: typeof body.cols === "number" ? body.cols : undefined,
      rows: typeof body.rows === "number" ? body.rows : undefined,
    });
    if (!result.ok) {
      // no_commits / not-a-repo are client errors; the rest are 500.
      const code =
        result.error.code === "workspace.no_commits" || result.error.code === "bad_request" ? 400 : 500;
      return reply.code(code).send(result.error);
    }
    // Bind the persona to the workspace (best-effort; persona may be down).
    if (personaId) {
      const bound = await bindPersona(deps.personaBaseUrl, result.value.id, personaId);
      if (!bound.ok) deps.log.warn({ err: bound.error }, "persona bind failed");
    }
    return reply.code(201).send(result.value);
  });

  // Composed persona prompt for a workspace (base + project overlay + task hint).
  app.get<{ Params: { id: string }; Querystring: { taskHint?: string } }>(
    "/workspaces/:id/persona",
    async (req, reply) => {
      const w = deps.workspaces.get(req.params.id);
      if (!w) return reply.code(404).send({ code: "workspace.not_found", message: "not found" });
      if (!w.personaId) return reply.code(404).send({ code: "not_found", message: "no persona bound" });
      const composed = await composePersona(deps.personaBaseUrl, {
        workspaceId: w.id,
        personaId: w.personaId,
        taskContext: req.query.taskHint ?? "",
        projectPath: w.repoRoot,
      });
      if (!composed.ok) return reply.code(502).send(composed.error);
      return composed.value;
    },
  );

  // Fork: new worktree + branch cut from this workspace's branch tip, same
  // base branch, fresh session. Committed work only.
  app.post<{ Params: { id: string }; Body: { name?: string } | null }>(
    "/workspaces/:id/fork",
    async (req, reply) => {
      const r = await deps.workspaces.fork(req.params.id, req.body?.name);
      if (!r.ok) {
        const code = r.error.code === "workspace.not_found" ? 404 : 500;
        return reply.code(code).send(r.error);
      }
      // Seed the fork's memory from its source — the fork continues the same
      // work, so the compounding context comes with it. Best-effort: a failed
      // copy must not fail the fork.
      const copied = await copyMemory(deps.memoryBaseUrl, req.params.id, r.value.id);
      if (!copied.ok) {
        req.log.warn({ err: copied.error, sourceId: req.params.id, forkId: r.value.id }, "memory copy failed");
      }
      return reply.code(201).send(r.value);
    },
  );

  // Start a new session in an existing worktree (refuses on dirty).
  app.post<{ Params: { id: string } }>("/workspaces/:id/run", async (req, reply) => {
    const r = await deps.workspaces.run(req.params.id);
    if (!r.ok) {
      const code = r.error.code === "workspace.dirty" ? 409 : r.error.code === "workspace.not_found" ? 404 : 500;
      return reply.code(code).send(r.error);
    }
    return reply.send({ ok: true });
  });

  // Merge the workspace branch into its base branch.
  app.post<{ Params: { id: string } }>("/workspaces/:id/merge", async (req, reply) => {
    const r = await deps.workspaces.merge(req.params.id);
    if (!r.ok) {
      const code = r.error.code === "workspace.not_found" ? 404 : r.error.code === "bad_request" ? 400 : 409;
      return reply.code(code).send(r.error);
    }
    return reply.send(r.value);
  });

  // Discard the worktree + branch. Requires confirm: true in the body.
  app.post<{ Params: { id: string } }>("/workspaces/:id/discard", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const r = await deps.workspaces.discard(req.params.id, body.confirm === true);
    if (!r.ok) {
      const code = r.error.code === "workspace.not_found" ? 404 : r.error.code === "bad_request" ? 400 : 500;
      return reply.code(code).send(r.error);
    }
    return reply.send({ ok: true });
  });

  // Keep: mark the ended session as kept (worktree stays alive).
  app.post<{ Params: { id: string } }>("/workspaces/:id/keep", async (req, reply) => {
    const r = deps.workspaces.keep(req.params.id);
    if (!r.ok) return reply.code(404).send(r.error);
    return reply.send({ ok: true });
  });

  // Phase 2: does this workspace's repo have a remote (gate the Open-PR action)?
  app.get<{ Params: { id: string } }>("/workspaces/:id/integration", async (req, reply) => {
    const r = await deps.workspaces.integration(req.params.id);
    if (!r.ok) return reply.code(404).send(r.error);
    return r.value;
  });

  // Phase 2: push the branch + open a GitHub PR.
  app.post<{ Params: { id: string } }>("/workspaces/:id/pr", async (req, reply) => {
    const r = await deps.workspaces.openPr(req.params.id);
    if (!r.ok) {
      const code = r.error.code === "workspace.not_found" ? 404 : 400;
      return reply.code(code).send(r.error);
    }
    return reply.send({ ok: true, ...r.value });
  });

  // Pull base into the workspace worktree; on conflict a session opens to resolve.
  app.post<{ Params: { id: string } }>("/workspaces/:id/sync", async (req, reply) => {
    const r = await deps.workspaces.syncFromBase(req.params.id);
    if (!r.ok) {
      const code = r.error.code === "workspace.not_found" ? 404 : 400;
      return reply.code(code).send(r.error);
    }
    return reply.send({ ok: true, ...r.value });
  });

  app.get<{ Params: { id: string } }>("/workspaces/:id", async (req, reply) => {
    const w = deps.workspaces.get(req.params.id);
    if (!w) return reply.code(404).send({ code: "workspace.not_found", message: "not found" });
    return w;
  });

  // Preview the context pack for a task hint (proxied to the memory service).
  app.get<{ Params: { id: string }; Querystring: { taskHint?: string } }>(
    "/workspaces/:id/context",
    async (req, reply) => {
      const pack = await getContext(deps.memoryBaseUrl, req.params.id, req.query.taskHint ?? "");
      if (!pack.ok) return reply.code(502).send(pack.error);
      return pack.value;
    },
  );

  // Inject a context pack into the live pane. If `text` is given, inject it
  // verbatim; otherwise fetch the pack from memory for `taskHint` and inject it.
  app.post<{ Params: { id: string } }>("/workspaces/:id/inject-context", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const taskHint = typeof body.taskHint === "string" ? body.taskHint : "";
    let text: string;
    if (typeof body.text === "string") {
      text = body.text;
    } else {
      const pack = await getContext(deps.memoryBaseUrl, req.params.id, taskHint);
      if (!pack.ok) return reply.code(502).send(pack.error);
      text = pack.value.rendered;
    }
    // If a persona is bound, prepend its composed system prompt to the pack.
    const w = deps.workspaces.get(req.params.id);
    if (w?.personaId) {
      const composed = await composePersona(deps.personaBaseUrl, {
        workspaceId: w.id,
        personaId: w.personaId,
        taskContext: taskHint,
        projectPath: w.repoRoot,
      });
      if (composed.ok && composed.value.prompt) {
        text = `${composed.value.prompt}\n\n${text}`;
      }
    }
    const injected = deps.workspaces.inject(req.params.id, text);
    if (!injected.ok) return reply.code(409).send(injected.error);
    return reply.send({ ok: true, bytes: Buffer.byteLength(text) });
  });

  // Fire-and-forget keystrokes into a live pane (the quick-CTA path). Unlike
  // inject-context this is raw send-keys, so callers append "\r" to submit.
  app.post<{ Params: { id: string } }>("/workspaces/:id/send", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const data = typeof body.data === "string" ? body.data : "";
    if (!data) return reply.code(400).send({ code: "input.empty", message: "data required" });
    const sent = deps.workspaces.sendInput(req.params.id, data);
    if (!sent.ok) return reply.code(409).send(sent.error);
    return reply.send({ ok: true, bytes: Buffer.byteLength(data) });
  });

  // Bidirectional stream: xterm.js bytes <-> tmux pane + supervisor events.
  app.get<{ Params: { id: string } }>(
    "/workspaces/:id/stream",
    { websocket: true },
    (socket, req) => {
      const id = req.params.id;
      const send = (msg: unknown): void => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      };

      const sub = deps.workspaces.subscribe(id, send);
      if (!sub.ok) {
        send({ type: "error", code: sub.error.code, message: sub.error.message });
        socket.close();
        return;
      }
      const unsubscribe = sub.value;

      socket.on("message", (raw: Buffer) => {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(raw.toString()) as ClientMessage;
        } catch {
          return;
        }
        if (msg.type === "input") {
          deps.workspaces.sendInput(id, msg.data);
        } else if (msg.type === "resize") {
          deps.workspaces.resize(id, msg.cols, msg.rows);
        }
      });

      socket.on("close", () => unsubscribe());
    },
  );

  return app;
}
