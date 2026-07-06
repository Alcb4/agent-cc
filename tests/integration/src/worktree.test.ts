// Worktree lifecycle (T22-T24) against the live supervisor and a real git repo.
//   - create makes an isolated worktree + branch off the base tip
//   - a non-git directory is refused
//   - a workspace branch's commit merges back into the base branch
//   - discard requires confirm and removes the worktree + branch

import { afterAll, beforeAll, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import type { Workspace, ServerMessage } from "@agent-cc/shared";
import { startStack, sleep, makeGitRepo, rmDir, type TestStack } from "./helpers.js";

let stack: TestStack;
let repo: string;

beforeAll(async () => {
  stack = await startStack();
  repo = makeGitRepo();
});

afterAll(() => {
  stack?.stop();
  if (repo) rmDir(repo);
});

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return r.stdout.trim();
}

async function create(name: string): Promise<Workspace> {
  const res = await fetch(`${stack.supervisorUrl}/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, repoRoot: repo, command: "bash --norc --noprofile" }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Workspace;
}

function connect(id: string): { ws: WebSocket; ended: () => boolean; ready: Promise<void> } {
  const ws = new WebSocket(`${stack.supervisorUrl.replace("http", "ws")}/workspaces/${id}/stream`);
  let ended = false;
  ws.on("message", (raw: Buffer) => {
    const m = JSON.parse(raw.toString()) as ServerMessage;
    if (m.type === "session.ended") ended = true;
  });
  const ready = new Promise<void>((r) => ws.on("open", () => r()));
  return { ws, ended: () => ended, ready };
}

async function waitFor(pred: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(100);
  }
  return pred();
}

test("create makes an isolated worktree + branch", async () => {
  const ws = await create("feat");
  expect(ws.branch).toBe(`workspace/feat/${ws.id}`);
  expect(ws.baseBranch).toBe("main");
  expect(ws.worktreePath).toBe(join(repo, ".worktrees", ws.id));
  expect(existsSync(ws.worktreePath)).toBe(true);
  // git knows about the worktree
  const worktrees = git(["worktree", "list"], repo);
  expect(worktrees).toContain(ws.id);
});

test("a non-git directory is refused", async () => {
  const res = await fetch(`${stack.supervisorUrl}/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "x", repoRoot: stack.home, command: "bash" }),
  });
  expect(res.status).toBe(400);
});

test("commit on the workspace branch merges back into base", async () => {
  const ws = await create("merge-me");
  const stream = connect(ws.id);
  await stream.ready;
  await sleep(300);

  // Make a commit inside the worktree via its own shell.
  stream.ws.send(
    JSON.stringify({
      type: "input",
      data: "printf 'hello\\n' > note.txt && git add note.txt && git commit -m 'add note'\r",
    }),
  );
  await sleep(1500);
  stream.ws.send(JSON.stringify({ type: "input", data: "exit\r" }));
  expect(await waitFor(() => stream.ended())).toBe(true);
  stream.ws.close();
  await sleep(200);

  const res = await fetch(`${stack.supervisorUrl}/workspaces/${ws.id}/merge`, { method: "POST" });
  expect(res.status).toBe(200);

  // The base branch tree now contains note.txt (git show on the --no-ff merge
  // commit lists nothing; inspect the tree instead).
  const files = git(["ls-tree", "-r", "--name-only", "main"], repo);
  expect(files).toContain("note.txt");
});

test("discard requires confirm and removes the worktree", async () => {
  const ws = await create("toss");
  const stream = connect(ws.id);
  await stream.ready;
  await sleep(200);
  stream.ws.send(JSON.stringify({ type: "input", data: "exit\r" }));
  expect(await waitFor(() => stream.ended())).toBe(true);
  stream.ws.close();
  await sleep(200);

  // Without confirm -> 400, worktree still present.
  const noConfirm = await fetch(`${stack.supervisorUrl}/workspaces/${ws.id}/discard`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(noConfirm.status).toBe(400);
  expect(existsSync(ws.worktreePath)).toBe(true);

  // With confirm -> removed.
  const confirmed = await fetch(`${stack.supervisorUrl}/workspaces/${ws.id}/discard`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: true }),
  });
  expect(confirmed.status).toBe(200);
  expect(existsSync(ws.worktreePath)).toBe(false);
  const detail = await fetch(`${stack.supervisorUrl}/workspaces/${ws.id}`);
  expect(detail.status).toBe(404);
});
