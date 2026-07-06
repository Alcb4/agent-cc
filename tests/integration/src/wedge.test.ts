// The wedge: prove the Slice 1 compounding loop end to end.
//
//   workspace create -> tmux session starts
//   keystroke in     -> ANSI bytes out (round-trip)
//   shell exits      -> session.ended over the WebSocket
//   on_session_end   -> memory write-run persists a run summary
//   get-context      -> the new run summary is returned
//   inject-context   -> a context pack is pasted into a live pane
//
// This is the Slice 1 exit criterion from build-plan-v1.md.

import { afterAll, beforeAll, expect, test } from "vitest";
import { WebSocket } from "ws";
import type { Workspace, ServerMessage, ContextPack } from "@agent-cc/shared";
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

async function createWorkspace(command: string): Promise<Workspace> {
  const res = await fetch(`${stack.supervisorUrl}/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "wedge", repoRoot: repo, command }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Workspace;
}

function connectStream(id: string): {
  ws: WebSocket;
  output: () => string;
  events: ServerMessage[];
  ready: Promise<void>;
} {
  const ws = new WebSocket(`${stack.supervisorUrl.replace("http", "ws")}/workspaces/${id}/stream`);
  let buf = "";
  const events: ServerMessage[] = [];
  ws.on("message", (raw: Buffer) => {
    const msg = JSON.parse(raw.toString()) as ServerMessage;
    events.push(msg);
    if (msg.type === "output") buf += msg.data;
  });
  const ready = new Promise<void>((r) => ws.on("open", () => r()));
  return { ws, output: () => buf, events, ready };
}

async function waitFor(pred: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(100);
  }
  return pred();
}

test("keystroke round-trips, session end persists memory, context comes back", async () => {
  const ws = await createWorkspace("bash --norc --noprofile");
  expect(ws.id).toMatch(/[0-9a-f-]{36}/);
  expect(ws.status).toBe("running");

  const stream = connectStream(ws.id);
  await stream.ready;
  await sleep(300); // let the control client settle

  // Keystroke in -> bytes out (Enter is CR, matching a real terminal).
  stream.ws.send(JSON.stringify({ type: "input", data: "echo wedge-ok\r" }));
  const sawOutput = await waitFor(() => stream.output().includes("wedge-ok"));
  expect(sawOutput).toBe(true);

  // End the shell -> session.ended event over the WebSocket.
  stream.ws.send(JSON.stringify({ type: "input", data: "exit\r" }));
  const sawEnd = await waitFor(() => stream.events.some((e) => e.type === "session.ended"));
  expect(sawEnd).toBe(true);
  stream.ws.close();

  // on_session_end -> memory write-run. get-context returns the new run summary.
  const gotMemory = await waitFor(async () => {
    const res = await fetch(`${stack.memoryUrl}/memory/get-context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: ws.id, taskHint: "" }),
    });
    if (!res.ok) return false;
    const pack = (await res.json()) as ContextPack;
    return pack.recentRuns.length >= 1;
  });
  expect(gotMemory).toBe(true);

  // The workspace is now marked ended.
  const detail = (await (await fetch(`${stack.supervisorUrl}/workspaces/${ws.id}`)).json()) as Workspace;
  expect(detail.status).toBe("ended");
});

test("inject-context pastes a pack into a live session", async () => {
  const ws = await createWorkspace("bash --norc --noprofile");
  const stream = connectStream(ws.id);
  await stream.ready;
  await sleep(300);

  const res = await fetch(`${stack.supervisorUrl}/workspaces/${ws.id}/inject-context`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "# injected context\nremember: use simple-git\n" }),
  });
  expect(res.ok).toBe(true);
  const body = (await res.json()) as { ok: boolean; bytes: number };
  expect(body.ok).toBe(true);
  expect(body.bytes).toBeGreaterThan(0);

  // The pasted text lands in the pane (bracketed paste preserves it for display).
  const landed = await waitFor(() => stream.output().includes("use simple-git"));
  expect(landed).toBe(true);

  stream.ws.close();
});
