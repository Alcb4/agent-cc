// Projects (grouping) against the live supervisor and a real git repo.
//   - create a project (owns its repo)
//   - create a workspace under it -> worktree lands under the project's repo
//   - project summary reports counts + running status
//   - workspace list filters by project

import { afterAll, beforeAll, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Project, ProjectSummary, Workspace } from "@agent-cc/shared";
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

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${stack.supervisorUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("project owns the repo; workspaces are created under it", async () => {
  const pres = await post("/projects", { name: "tank", repoRoot: repo, defaultModel: "claude-opus-4-8" });
  expect(pres.status).toBe(201);
  const project = (await pres.json()) as Project;
  expect(project.repoRoot).toBe(repo);

  // Create a workspace by projectId only (no repoRoot) — repo + model inherited.
  const wres = await post("/workspaces", { name: "task-a", projectId: project.id, command: "bash --norc" });
  expect(wres.status).toBe(201);
  const ws = (await wres.json()) as Workspace;
  expect(ws.projectId).toBe(project.id);
  expect(ws.model).toBe("claude-opus-4-8"); // inherited from project default
  expect(ws.worktreePath).toBe(join(repo, ".worktrees", ws.id));
  expect(existsSync(ws.worktreePath)).toBe(true);

  // Summary reports the rollups (1 workspace, 1 running).
  const summaries = (await (await fetch(`${stack.supervisorUrl}/projects`)).json()) as ProjectSummary[];
  const summary = summaries.find((s) => s.id === project.id)!;
  expect(summary.workspaceCount).toBe(1);
  expect(summary.runningCount).toBe(1);

  // Filter: workspaces?projectId returns only this project's workspaces.
  const filtered = (await (
    await fetch(`${stack.supervisorUrl}/workspaces?projectId=${project.id}`)
  ).json()) as Workspace[];
  expect(filtered).toHaveLength(1);
  expect(filtered[0]!.id).toBe(ws.id);
});

test("a project with workspaces cannot be deleted until emptied", async () => {
  const project = (await (await post("/projects", { name: "iris", repoRoot: repo })).json()) as Project;
  await post("/workspaces", { name: "t", projectId: project.id, command: "bash --norc" });

  const blocked = await fetch(`${stack.supervisorUrl}/projects/${project.id}`, { method: "DELETE" });
  expect(blocked.status).toBe(400);
});
