import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 30_000,
    // Each stack cold-starts 5 tsx services; give the boot hook margin over the
    // 30s per-service health wait so a loaded machine doesn't trip it.
    hookTimeout: 60_000,
    // Services bind real ports and a tmux socket; run files serially.
    fileParallelism: false,
  },
});
