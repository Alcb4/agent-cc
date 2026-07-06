// The locked single E2E: drive the real dashboard in a browser, create a project
// and a task, type into the xterm.js terminal, and assert the agent output is
// rendered in the browser — proving the full browser -> supervisor -> tmux ->
// browser round-trip.

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function fixtureRepo(): string {
  const raw = readFileSync(join(process.cwd(), "fixture.json"), "utf8");
  return (JSON.parse(raw) as { repo: string }).repo;
}

test("create project + task, type in the terminal, see output", async ({ page }) => {
  const repo = fixtureRepo();
  await page.goto("/");

  // Create a project (Projects tab is the default).
  await page.getByPlaceholder("name").fill("e2e");
  await page.getByPlaceholder("repo root (abs path)").fill(repo);
  await page.getByRole("button", { name: "+ New project" }).click();

  // The project appears in the rail.
  await expect(page.locator(".proj-name", { hasText: "e2e" })).toBeVisible();

  // Create a task under it.
  await page.getByPlaceholder("new task name").fill("hello");
  await page.getByRole("button", { name: "+ New task" }).click();

  // The terminal connects (overlay clears), then we type a command.
  await expect(page.locator(".term-overlay")).toBeHidden({ timeout: 20_000 });
  const term = page.locator(".xterm-helper-textarea");
  await term.focus();
  await page.keyboard.type("echo e2e-roundtrip");
  await page.keyboard.press("Enter");

  // The agent output renders in the xterm rows.
  await expect(page.locator(".xterm-rows")).toContainText("e2e-roundtrip", { timeout: 15_000 });

  // Cmd-K command palette opens (the locked primary nav). Blur the terminal
  // first — xterm consumes Ctrl-K (readline kill-line) when it has focus.
  await page.locator(".brand").click();
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(".palette")).toBeVisible();
  await expect(page.locator(".palette-row", { hasText: "Open: hello" })).toBeVisible();
});
