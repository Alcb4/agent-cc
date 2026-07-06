// Typed environment parsing. All env access goes through here; no scattered
// process.env reads (per AGENTS.md conventions). Defaults are the locked values
// from HANDOVER.md.

import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { config as loadDotenv } from "dotenv";

// Load a repo-root .env once, before any var is read. Done inside loadEnv (not at
// module top) so the dashboard's type-only imports never pull node:fs into the
// browser bundle. Real process env always wins over the file (no override).
let dotenvLoaded = false;
function loadDotenvOnce(): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  try {
    const here = dirname(fileURLToPath(import.meta.url)); // packages/shared/src
    const repoRoot = resolve(here, "../../..");
    const envPath = process.env.AGENT_CC_ENV_FILE ?? join(repoRoot, ".env");
    if (existsSync(envPath)) loadDotenv({ path: envPath });
  } catch {
    // no .env / unreadable — fall back to process env + defaults
  }
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) {
    throw new Error(`env ${name} is not an integer: ${JSON.stringify(raw)}`);
  }
  return n;
}

function strEnv(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

const dataRoot = strEnv("AGENT_CC_HOME", join(homedir(), ".agent_cc"));

export interface Env {
  ports: {
    supervisor: number;
    dashboard: number;
    gateway: number;
    oauth: number;
    persona: number;
    memory: number;
  };
  paths: {
    home: string;
    db: string;
    auditDb: string;
    secretsDb: string;
    logDir: string;
  };
  nodeEnv: "development" | "production" | "test";
}

export function loadEnv(): Env {
  loadDotenvOnce();
  const nodeEnv = strEnv("NODE_ENV", "development");
  return {
    ports: {
      supervisor: intEnv("SUPERVISOR_PORT", 7711),
      dashboard: intEnv("DASHBOARD_PORT", 3000),
      gateway: intEnv("GATEWAY_PORT", 7712),
      oauth: intEnv("OAUTH_PORT", 7713),
      persona: intEnv("PERSONA_PORT", 7714),
      memory: intEnv("MEMORY_PORT", 7715),
    },
    paths: {
      home: dataRoot,
      db: strEnv("AGENT_CC_DB_PATH", join(dataRoot, "agent-cc.db")),
      auditDb: strEnv("AGENT_CC_AUDIT_DB_PATH", join(dataRoot, "audit.db")),
      secretsDb: strEnv("AGENT_CC_SECRETS_DB_PATH", join(dataRoot, "secrets.db")),
      logDir: strEnv("AGENT_CC_LOG_DIR", join(dataRoot, "logs")),
    },
    nodeEnv: nodeEnv === "production" || nodeEnv === "test" ? nodeEnv : "development",
  };
}
