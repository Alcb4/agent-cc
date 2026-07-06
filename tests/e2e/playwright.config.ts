import { defineConfig } from "@playwright/test";

// One E2E (per the locked test strategy): drive the real dashboard in a browser
// against the full stack. The stack is booted as deterministic subprocesses in
// global-setup (not `next dev`), on the default ports.
export default defineConfig({
  testDir: "./src",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./src/global-setup.ts",
  use: {
    baseURL: "http://localhost:3000",
    headless: true,
  },
});
