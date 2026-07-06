// Persona service (T12) + binding/compose wiring through the supervisor (T15).
//   - create a persona and a project overlay
//   - compose layers base prompt + overlay + task context, in order
//   - a workspace created with personaId is bound; the supervisor composes its
//     persona prompt (scoped to the workspace's repo)

import { afterAll, beforeAll, expect, test } from "vitest";
import type { Persona, ComposedPrompt, Workspace } from "@agent-cc/shared";
import { startStack, makeGitRepo, rmDir, type TestStack } from "./helpers.js";

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

async function post(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("compose layers persona base + project overlay + task context", async () => {
  const persona = (await (
    await post(stack.personaUrl, "/personas", { role: "Engineer", basePrompt: "You are a careful engineer." })
  ).json()) as Persona;

  await post(stack.personaUrl, "/personas/overlays", {
    projectPath: repo,
    fragment: "Project rule: use simple-git.",
  });

  const composed = (await (
    await post(stack.personaUrl, "/personas/compose", {
      workspaceId: "ws-1",
      personaId: persona.id,
      taskContext: "Task: fix the parser.",
      projectPath: repo,
    })
  ).json()) as ComposedPrompt;

  expect(composed.prompt).toContain("careful engineer");
  expect(composed.prompt).toContain("use simple-git");
  expect(composed.prompt).toContain("fix the parser");
  // layered in order: persona, then overlay, then task context
  expect(composed.prompt.indexOf("engineer")).toBeLessThan(composed.prompt.indexOf("simple-git"));
  expect(composed.prompt.indexOf("simple-git")).toBeLessThan(composed.prompt.indexOf("fix the parser"));
});

test("a workspace bound to a persona composes its prompt via the supervisor", async () => {
  const persona = (await (
    await post(stack.personaUrl, "/personas", { role: "Reviewer", basePrompt: "You review for security." })
  ).json()) as Persona;

  const ws = (await (
    await post(stack.supervisorUrl, "/workspaces", {
      name: "bound",
      repoRoot: repo,
      personaId: persona.id,
      command: "bash --norc",
    })
  ).json()) as Workspace;
  expect(ws.personaId).toBe(persona.id);

  // The persona binding persisted in the persona service.
  const binding = await fetch(`${stack.personaUrl}/personas/bindings/${ws.id}`);
  expect(binding.status).toBe(200);

  // The supervisor composes the bound persona's prompt for the workspace.
  const composed = (await (await fetch(`${stack.supervisorUrl}/workspaces/${ws.id}/persona`)).json()) as ComposedPrompt;
  expect(composed.prompt).toContain("review for security");
});
