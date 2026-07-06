// LLM gateway entrypoint. Opens the provider registry (main db), the usage audit
// db, and the secrets vault (for provider API keys).

import { join } from "node:path";
import { loadEnv } from "@agent-cc/shared";
import { resolveMasterKey, openVault } from "@agent-cc/secrets";
import { buildLogger } from "./log.js";
import { openMainDb, openAuditDb } from "./db.js";
import { buildApi } from "./api.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const log = buildLogger(env.nodeEnv);

  const mainDb = openMainDb(env.paths.db);
  const auditDb = openAuditDb(env.paths.auditDb);
  const masterKey = resolveMasterKey(join(env.paths.home, "master.key"));
  const vault = openVault(env.paths.secretsDb, masterKey.key);
  log.info({ provider: masterKey.provider }, "gateway vault ready");

  const app = buildApi(mainDb, auditDb, vault, log);

  const shutdown = (): void => {
    void app.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: env.ports.gateway, host: "127.0.0.1" });
  log.info({ port: env.ports.gateway }, "gateway listening");
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
