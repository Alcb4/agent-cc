// Crash recovery (T4): the tmux server runs on its own named socket, so a
// running session survives a supervisor crash. After a hard restart the
// supervisor reattaches and streaming resumes.

import { afterAll, beforeAll, expect, test } from "vitest";
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

function connect(id: string): { ws: WebSocket; output: () => string; ready: Promise<void> } {
  const ws = new WebSocket(`${stack.supervisorUrl.replace("http", "ws")}/workspaces/${id}/stream`);
  let buf = "";
  ws.on("message", (raw: Buffer) => {
    const m = JSON.parse(raw.toString()) as ServerMessage;
    if (m.type === "output") buf += m.data;
  });
  const ready = new Promise<void>((r) => ws.on("open", () => r()));
  return { ws, output: () => buf, ready };
}

async function waitFor(pred: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(100);
  }
  return pred();
}

test("a running session survives a supervisor crash and resumes streaming", async () => {
  const res = await fetch(`${stack.supervisorUrl}/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "survivor", repoRoot: repo, command: "bash --norc --noprofile" }),
  });
  expect(res.status).toBe(201);
  const ws = (await res.json()) as Workspace;

  // Establish the session and prove I/O before the crash.
  const before = connect(ws.id);
  await before.ready;
  await sleep(300);
  before.ws.send(JSON.stringify({ type: "input", data: "echo PRECRASH\r" }));
  expect(await waitFor(() => before.output().includes("PRECRASH"))).toBe(true);
  before.ws.close();

  // Hard-kill the supervisor and bring up a fresh one against the same socket+db.
  await stack.restartSupervisor();

  // The workspace is still running (reattached, not marked ended).
  const detail = (await (await fetch(`${stack.supervisorUrl}/workspaces/${ws.id}`)).json()) as Workspace;
  expect(detail.status).toBe("running");

  // Streaming works against the recovered session: new input round-trips.
  const after = connect(ws.id);
  await after.ready;
  await sleep(300);
  after.ws.send(JSON.stringify({ type: "input", data: "echo POSTCRASH\r" }));
  expect(await waitFor(() => after.output().includes("POSTCRASH"))).toBe(true);
  after.ws.close();
});
