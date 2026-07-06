#!/usr/bin/env node
// agent-cc CLI — one-shot setup + run. Dependency-free (Node 20+).
//
//   agent-cc setup     prereq check, create .env, ensure data dir, install deps
//   agent-cc start     start all services + dashboard, wait for health, print URL
//   agent-cc stop      stop everything on the known ports
//   agent-cc status    health of every service
//   agent-cc doctor    check prerequisites only
//
// The system is zero-config: DBs auto-create and self-migrate on first start,
// and the secrets vault auto-creates its master key. `setup` just makes the
// first run pleasant; it is not required.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = join(repoRoot, "node_modules/.bin/tsx");
const nextBin = join(repoRoot, "services/dashboard/node_modules/.bin/next");
const dataDir = process.env.AGENT_CC_HOME ?? join(homedir(), ".agent_cc");

// name, port, entrypoint (the dashboard is handled separately).
const SERVICES = [
  { name: "memory", port: 7715, entry: "services/memory/src/index.ts" },
  { name: "persona", port: 7714, entry: "services/persona/src/index.ts" },
  { name: "gateway", port: 7712, entry: "services/gateway/src/index.ts" },
  { name: "oauth", port: 7713, entry: "services/oauth-broker/src/index.ts" },
  { name: "supervisor", port: 7711, entry: "services/supervisor/src/index.ts" },
];
const DASHBOARD_PORT = 3000;

const c = { dim: (s) => `\x1b[90m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` };
const log = (s = "") => process.stdout.write(s + "\n");

function which(bin) {
  return spawnSync("bash", ["-lc", `command -v ${bin}`], { encoding: "utf8" }).stdout.trim();
}

function doctor() {
  let ok = true;
  const node = process.versions.node;
  const nodeOk = Number(node.split(".")[0]) >= 20;
  log(`${nodeOk ? c.green("✓") : c.red("✗")} node ${node} ${nodeOk ? "" : c.red("(need >= 20)")}`);
  ok &&= nodeOk;
  for (const bin of ["pnpm", "tmux", "git"]) {
    const found = which(bin);
    log(`${found ? c.green("✓") : c.red("✗")} ${bin} ${found ? c.dim(found) : c.red("(missing)")}`);
    ok &&= !!found;
  }
  const cc = which("cc") || which("gcc");
  log(`${cc ? c.green("✓") : c.red("✗")} C compiler ${cc ? c.dim(cc) : c.red("(needed for native modules)")}`);
  ok &&= !!cc;
  return ok;
}

function setup() {
  log(c.bold("agent-cc setup"));
  if (!doctor()) {
    log(c.red("\nMissing prerequisites above — install them and re-run `agent-cc setup`."));
    process.exit(1);
  }
  mkdirSync(dataDir, { recursive: true });
  log(`${c.green("✓")} data dir ${c.dim(dataDir)}`);

  const env = join(repoRoot, ".env");
  if (!existsSync(env)) {
    copyFileSync(join(repoRoot, ".env.example"), env);
    log(`${c.green("✓")} created .env ${c.dim("(from .env.example — edit to override ports/paths)")}`);
  } else {
    log(`${c.green("✓")} .env already present`);
  }

  if (!existsSync(join(repoRoot, "node_modules"))) {
    log(c.dim("installing dependencies (pnpm install)…"));
    const r = spawnSync("pnpm", ["install"], { cwd: repoRoot, stdio: "inherit" });
    if (r.status !== 0) process.exit(r.status ?? 1);
  } else {
    log(`${c.green("✓")} dependencies installed`);
  }
  log(`\n${c.green("Setup complete.")} Start everything with:  ${c.bold("agent-cc start")}`);
}

async function waitHealth(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function start() {
  // Auto-setup .env/dir on first run so `start` alone just works.
  mkdirSync(dataDir, { recursive: true });
  if (!existsSync(join(repoRoot, ".env")) && existsSync(join(repoRoot, ".env.example"))) {
    copyFileSync(join(repoRoot, ".env.example"), join(repoRoot, ".env"));
  }
  const env = { ...process.env, NODE_ENV: process.env.NODE_ENV ?? "development" };
  const children = [];
  const spawnProc = (cmd, args, name, cwd = repoRoot) => {
    const p = spawn(cmd, args, { cwd, env, stdio: "inherit" });
    p.on("exit", (code) => log(c.dim(`[${name}] exited (${code})`)));
    children.push(p);
    return p;
  };

  log(c.bold("agent-cc start") + c.dim(" — launching services…"));
  for (const s of SERVICES) spawnProc(tsx, [join(repoRoot, s.entry)], s.name);
  // next must run from the dashboard package, not the repo root, or it can't
  // find its app/ directory.
  spawnProc(nextBin, ["dev", "-p", String(DASHBOARD_PORT)], "dashboard", join(repoRoot, "services/dashboard"));

  const results = await Promise.all([
    ...SERVICES.map((s) => waitHealth(`http://127.0.0.1:${s.port}/health`).then((ok) => [s.name, ok])),
    waitHealth(`http://127.0.0.1:${DASHBOARD_PORT}`, 60000).then((ok) => ["dashboard", ok]),
  ]);
  log("");
  for (const [name, ok] of results) log(`${ok ? c.green("✓") : c.red("✗")} ${name}`);
  if (results.every(([, ok]) => ok)) {
    log(`\n${c.green("agent-cc is up.")}  Open ${c.bold(`http://localhost:${DASHBOARD_PORT}`)}`);
    log(c.dim("Ctrl-C to stop everything."));
  } else {
    log(c.red("\nSome services failed to start — check the logs above."));
  }

  const shutdown = () => {
    log(c.dim("\nstopping…"));
    for (const p of children) p.kill("SIGTERM");
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function stop() {
  const ports = [...SERVICES.map((s) => s.port), DASHBOARD_PORT];
  for (const port of ports) {
    const pid = spawnSync("bash", ["-lc", `ss -ltnp 2>/dev/null | grep ':${port} ' | grep -oP 'pid=\\K[0-9]+' | head -1`], {
      encoding: "utf8",
    }).stdout.trim();
    if (pid) {
      spawnSync("kill", [pid]);
      log(`${c.green("✓")} stopped ${c.dim(`port ${port} (pid ${pid})`)}`);
    }
  }
}

async function status() {
  for (const s of SERVICES) {
    const ok = await waitHealth(`http://127.0.0.1:${s.port}/health`, 1000);
    log(`${ok ? c.green("●") : c.dim("○")} ${s.name} ${c.dim(`:${s.port}`)}`);
  }
  const dash = await waitHealth(`http://127.0.0.1:${DASHBOARD_PORT}`, 1000);
  log(`${dash ? c.green("●") : c.dim("○")} dashboard ${c.dim(`:${DASHBOARD_PORT}`)}`);
}

const cmd = process.argv[2] ?? "help";
const run = { setup, start, stop, status, doctor: () => process.exit(doctor() ? 0 : 1) }[cmd];
if (run) {
  await run();
} else {
  log(`${c.bold("agent-cc")} — ${readFileSync(join(repoRoot, "package.json"), "utf8").match(/"version": "(.*?)"/)?.[1] ?? ""}`);
  log("\nUsage: agent-cc <setup|start|stop|status|doctor>");
}
