// Memory service entrypoint.

import { loadEnv } from "@agent-cc/shared";
import { buildLogger } from "./log.js";
import { openDb } from "./db.js";
import { buildApi } from "./api.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const log = buildLogger(env.nodeEnv);
  const db = openDb(env.paths.db);
  const app = buildApi(db, log);

  const shutdown = (): void => {
    void app.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: env.ports.memory, host: "127.0.0.1" });
  log.info({ port: env.ports.memory }, "memory service listening");
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
