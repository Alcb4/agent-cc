// Liveness probes (T7): the supervisor reports dependent-service status from a
// periodic probe, and flips a service to "down" when it stops responding.

import { afterAll, beforeAll, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { startStack, sleep, type TestStack } from "./helpers.js";

let stack: TestStack;

beforeAll(async () => {
  stack = await startStack();
});

afterAll(() => {
  stack?.stop();
});

interface ServiceStatus {
  name: string;
  status: "up" | "down" | "unknown";
}

async function services(): Promise<ServiceStatus[]> {
  return (await (await fetch(`${stack.supervisorUrl}/services`)).json()) as ServiceStatus[];
}

test("memory shows up, then down after it is killed", async () => {
  // Initially up.
  const up = await (async () => {
    for (let i = 0; i < 20; i++) {
      const s = (await services()).find((x) => x.name === "memory");
      if (s?.status === "up") return true;
      await sleep(250);
    }
    return false;
  })();
  expect(up).toBe(true);

  // Kill the memory service; the probe should flip it to down within a few cycles.
  const memPort = new URL(stack.memoryUrl).port;
  const pid = spawnSync("bash", ["-lc", `ss -ltnp | grep ':${memPort} ' | grep -oP 'pid=\\K[0-9]+' | head -1`], {
    encoding: "utf8",
  }).stdout.trim();
  expect(pid).toMatch(/[0-9]+/);
  spawnSync("kill", ["-9", pid]);

  const wentDown = await (async () => {
    for (let i = 0; i < 64; i++) {
      const s = (await services()).find((x) => x.name === "memory");
      if (s?.status === "down") return true;
      await sleep(250);
    }
    return false;
  })();
  expect(wentDown).toBe(true);
});
