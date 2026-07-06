// Boots the full stack (memory + supervisor + dashboard) as subprocesses on the
// default ports, in an isolated data dir + tmux socket, and creates a git repo
// fixture. Writes the fixture path to fixture.json for the test, and returns a
// teardown that tears it all down.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(process.cwd(), "../..");
const tsxBin = join(repoRoot, "node_modules/.bin/tsx");
const nextBin = join(repoRoot, "services/dashboard/node_modules/.bin/next");

async function waitForHealth(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const home = mkdtempSync(join(tmpdir(), "agent-cc-e2e-"));
  const tmuxSocket = `agent-cc-e2e-${process.pid}`;

  // git repo fixture
  const repo = mkdtempSync(join(tmpdir(), "agent-cc-e2e-repo-"));
  const git = (args: string[]): void => {
    const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  git(["init", "-b", "main"]);
  git(["config", "user.email", "e2e@agent-cc.local"]);
  git(["config", "user.name", "e2e"]);
  writeFileSync(join(repo, "README.md"), "# e2e fixture\n");
  git(["add", "."]);
  git(["commit", "-m", "initial"]);

  const env = {
    ...process.env,
    NODE_ENV: "production",
    AGENT_CC_HOME: home,
    AGENT_CC_TMUX_SOCKET: tmuxSocket,
    LOG_LEVEL: "error",
  };

  const procs: ChildProcess[] = [];
  const spawnSvc = (cmd: string, args: string[], cwd: string): void => {
    procs.push(spawn(cmd, args, { cwd, env, stdio: "inherit" }));
  };

  spawnSvc(tsxBin, [join(repoRoot, "services/memory/src/index.ts")], repoRoot);
  spawnSvc(tsxBin, [join(repoRoot, "services/supervisor/src/index.ts")], repoRoot);
  spawnSvc(nextBin, ["start", "-p", "3000"], join(repoRoot, "services/dashboard"));

  await waitForHealth("http://127.0.0.1:7715/health");
  await waitForHealth("http://127.0.0.1:7711/health");
  await waitForHealth("http://127.0.0.1:3000");

  writeFileSync(join(process.cwd(), "fixture.json"), JSON.stringify({ repo }));

  return async () => {
    for (const p of procs) p.kill("SIGTERM");
    spawnSync("tmux", ["-L", tmuxSocket, "kill-server"], { stdio: "ignore" });
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
    rmSync(join(process.cwd(), "fixture.json"), { force: true });
  };
}
