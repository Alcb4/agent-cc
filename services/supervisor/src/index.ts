// Supervisor entrypoint. Opens the shared DB, wires the on_session_end hook to
// the memory service's write-run, recovers surviving sessions, and serves the
// public API on the supervisor port.

import { join } from "node:path";
import { loadEnv } from "@agent-cc/shared";
import { resolveMasterKey, openVault } from "@agent-cc/secrets";
import { loadSupervisorConfig } from "./config.js";
import { buildLogger } from "./log.js";
import { openDb } from "./db.js";
import { HookRegistry } from "./hooks.js";
import { WorkspaceManager } from "./workspace.js";
import { ServiceMonitor } from "./services-monitor.js";
import { buildApi } from "./api.js";
import { writeRun } from "./clients.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const cfg = loadSupervisorConfig();
  const log = buildLogger(env.nodeEnv);

  const db = openDb(env.paths.db);
  const personaBaseUrl = `http://127.0.0.1:${env.ports.persona}`;
  const gatewayBaseUrl = `http://127.0.0.1:${env.ports.gateway}`;
  const oauthBaseUrl = `http://127.0.0.1:${env.ports.oauth}`;

  // Initialize the encrypted secrets vault at boot: ensures the master key exists
  // (OS keychain, or 0600 file fallback) and secrets.db is created. Consumed by
  // the gateway + oauth broker in Slice 3.
  const masterKey = resolveMasterKey(join(env.paths.home, "master.key"));
  const vault = openVault(env.paths.secretsDb, masterKey.key);
  log.info({ provider: masterKey.provider, path: env.paths.secretsDb }, "secrets vault ready");
  void vault; // wired into services in Slice 3

  const hooks = new HookRegistry();
  const memoryBaseUrl = `http://127.0.0.1:${env.ports.memory}`;

  // T10: the compounding loop. on_session_end -> memory write-run.
  hooks.registerSessionEnd(async ({ workspaceId, exitCode, finalPaneState }) => {
    const r = await writeRun(memoryBaseUrl, workspaceId, finalPaneState, exitCode);
    if (!r.ok) log.warn({ err: r.error, workspaceId }, "write-run failed");
  });

  const workspaces = new WorkspaceManager(db, cfg, hooks, log);
  workspaces.recover();
  workspaces.startMonitor();
  workspaces.startActivityMonitor();
  workspaces.startScheduler();

  // Liveness probes for dependent services (gateway/oauth join later in Slice 3).
  const services = new ServiceMonitor(
    [
      { name: "memory", url: memoryBaseUrl },
      { name: "persona", url: personaBaseUrl },
      { name: "gateway", url: gatewayBaseUrl },
      { name: "oauth", url: oauthBaseUrl },
    ],
    log,
  );
  services.start();

  const app = await buildApi({
    workspaces,
    services,
    memoryBaseUrl,
    personaBaseUrl,
    gatewayBaseUrl,
    oauthBaseUrl,
    projectsRoot: cfg.projectsRoot,
    log,
  });

  const shutdown = (): void => {
    services.stop();
    workspaces.shutdown();
    void app.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Restart-after-crash can race the OS freeing the previous listener's port.
  // Retry briefly on EADDRINUSE instead of dying.
  await listenWithRetry(app, env.ports.supervisor, log);
  log.info({ port: env.ports.supervisor }, "supervisor listening");
}

async function listenWithRetry(
  app: Awaited<ReturnType<typeof buildApi>>,
  port: number,
  log: ReturnType<typeof buildLogger>,
  attempts = 10,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await app.listen({ port, host: "127.0.0.1" });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE" || i === attempts - 1) throw e;
      log.warn({ port, attempt: i + 1 }, "port busy, retrying listen");
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
