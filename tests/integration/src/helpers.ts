// Test harness: spawn the memory + supervisor services as real subprocesses with
// an isolated data dir, ports, and tmux socket, and tear them down cleanly.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(here, "../../..");
const tsxBin = join(repoRoot, "node_modules/.bin/tsx");

export interface TestStack {
  supervisorUrl: string;
  memoryUrl: string;
  personaUrl: string;
  gatewayUrl: string;
  oauthUrl: string;
  tmuxSocket: string;
  home: string;
  stop: () => void;
  // Kill only the supervisor process and start a fresh one against the same
  // socket + db (the tmux server and memory survive) — simulates a crash.
  restartSupervisor: () => Promise<void>;
}

function waitForHealth(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveP, reject) => {
    const tick = async (): Promise<void> => {
      try {
        const r = await fetch(`${url}/health`);
        if (r.ok) return resolveP();
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) return reject(new Error(`health timeout: ${url}`));
      setTimeout(() => void tick(), 150);
    };
    void tick();
  });
}

// Ask the OS for a free ephemeral port. Each test file gets its own ports so
// files (which run serially) never collide on a not-yet-released port.
function freePort(): Promise<number> {
  return new Promise((resolveP, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolveP(port));
    });
  });
}

export async function startStack(): Promise<TestStack> {
  const home = mkdtempSync(join(tmpdir(), "agent-cc-it-"));
  const supervisorPort = await freePort();
  const memoryPort = await freePort();
  const personaPort = await freePort();
  const gatewayPort = await freePort();
  const oauthPort = await freePort();
  const tmuxSocket = `agent-cc-it-${process.pid}-${supervisorPort}`;

  const env = {
    ...process.env,
    NODE_ENV: "test",
    AGENT_CC_HOME: home,
    SUPERVISOR_PORT: String(supervisorPort),
    MEMORY_PORT: String(memoryPort),
    PERSONA_PORT: String(personaPort),
    GATEWAY_PORT: String(gatewayPort),
    OAUTH_PORT: String(oauthPort),
    AGENT_CC_TMUX_SOCKET: tmuxSocket,
  };

  const spawnSvc = (entry: string): ChildProcess =>
    spawn(tsxBin, [join(repoRoot, entry)], { env, stdio: "inherit" });

  const memory = spawnSvc("services/memory/src/index.ts");
  const persona = spawnSvc("services/persona/src/index.ts");
  const gateway = spawnSvc("services/gateway/src/index.ts");
  const oauth = spawnSvc("services/oauth-broker/src/index.ts");
  let supervisor = spawnSvc("services/supervisor/src/index.ts");

  const memoryUrl = `http://127.0.0.1:${memoryPort}`;
  const personaUrl = `http://127.0.0.1:${personaPort}`;
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
  const oauthUrl = `http://127.0.0.1:${oauthPort}`;
  const supervisorUrl = `http://127.0.0.1:${supervisorPort}`;
  await Promise.all([
    waitForHealth(memoryUrl),
    waitForHealth(personaUrl),
    waitForHealth(gatewayUrl),
    waitForHealth(oauthUrl),
    waitForHealth(supervisorUrl),
  ]);

  const waitExit = (p: ChildProcess): Promise<void> =>
    new Promise((r) => (p.exitCode !== null ? r() : p.once("exit", () => r())));

  const restartSupervisor = async (): Promise<void> => {
    supervisor.kill("SIGKILL"); // hard kill: simulate a crash, no graceful shutdown
    await waitExit(supervisor);
    supervisor = spawnSvc("services/supervisor/src/index.ts");
    await waitForHealth(supervisorUrl);
  };

  const stop = (): void => {
    memory.kill("SIGTERM");
    persona.kill("SIGTERM");
    gateway.kill("SIGTERM");
    oauth.kill("SIGTERM");
    supervisor.kill("SIGTERM");
    spawnSync("tmux", ["-L", tmuxSocket, "kill-server"], { stdio: "ignore" });
    rmSync(home, { recursive: true, force: true });
  };

  return { supervisorUrl, memoryUrl, personaUrl, gatewayUrl, oauthUrl, tmuxSocket, home, stop, restartSupervisor };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Create a real temp git repo with one commit (worktree fixtures use real git,
// not mocks, per HANDOVER.md). Returns the repo root.
export function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-cc-repo-"));
  const git = (args: string[]): void => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  };
  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@agent-cc.local"]);
  git(["config", "user.name", "agent-cc test"]);
  writeFileSync(join(dir, "README.md"), "# fixture repo\n");
  git(["add", "."]);
  git(["commit", "-m", "initial commit"]);
  return dir;
}

export function rmDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
