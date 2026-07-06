// LLM gateway (T13) + usage meters (B1).
//   - register a provider; infer through it (mock provider, no network)
//   - usage is logged and the summary aggregates it
//   - the supervisor proxies the usage summary (for the dashboard meter)
//   - a real-provider type without an API key is refused

import { afterAll, beforeAll, expect, test } from "vitest";
import type { Provider, InferResult, UsageSummary } from "@agent-cc/shared";
import { startStack, type TestStack } from "./helpers.js";

let stack: TestStack;

beforeAll(async () => {
  stack = await startStack();
});

afterAll(() => {
  stack?.stop();
});

async function post(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("infer through a mock provider logs usage; summary aggregates it", async () => {
  const provider = (await (
    await post(stack.gatewayUrl, "/providers", { name: "local-mock", type: "mock", defaultModel: "mock-1" })
  ).json()) as Provider;
  expect(provider.authType).toBe("none");

  const infer = (await (
    await post(stack.gatewayUrl, "/llm/infer", {
      providerId: provider.id,
      prompt: "hello gateway world",
      workspaceId: "ws-1",
    })
  ).json()) as InferResult;
  expect(infer.response).toContain("mock");
  expect(infer.usage.inputTokens).toBeGreaterThan(0);
  expect(infer.usage.outputTokens).toBeGreaterThan(0);
  expect(infer.usage.costMicrocents).toBe(0); // mock model is unpriced

  // Gateway's own summary reflects the call.
  const summary = (await (await fetch(`${stack.gatewayUrl}/llm/usage/summary`)).json()) as UsageSummary;
  expect(summary.calls).toBeGreaterThanOrEqual(1);
  expect(summary.inputTokens).toBeGreaterThan(0);

  // Supervisor proxies the same summary (drives the dashboard meter).
  const proxied = (await (await fetch(`${stack.supervisorUrl}/usage/summary`)).json()) as UsageSummary;
  expect(proxied.calls).toBeGreaterThanOrEqual(1);
});

test("cost is priced in microcents for a known model", async () => {
  const provider = (await (
    await post(stack.gatewayUrl, "/providers", { name: "mock-opus", type: "mock", defaultModel: "claude-opus-4-8" })
  ).json()) as Provider;
  const infer = (await (
    await post(stack.gatewayUrl, "/llm/infer", { providerId: provider.id, prompt: "one two three four five" })
  ).json()) as InferResult;
  // opus is priced, so a real (integer) microcent cost is recorded
  expect(infer.usage.costMicrocents).toBeGreaterThan(0);
  expect(Number.isInteger(infer.usage.costMicrocents)).toBe(true);
});

test("a key-requiring provider is refused without a key", async () => {
  const provider = (await (
    await post(stack.gatewayUrl, "/providers", { name: "anthropic", type: "anthropic", defaultModel: "claude-opus-4-8" })
  ).json()) as Provider;
  expect(provider.authType).toBe("api_key");

  const res = await post(stack.gatewayUrl, "/llm/infer", { providerId: provider.id, prompt: "hi" });
  expect(res.status).toBe(400);

  // Setting a key is accepted (write-only; never returned).
  const put = await fetch(`${stack.gatewayUrl}/providers/${provider.id}/key`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "sk-test-not-real" }),
  });
  expect(put.status).toBe(200);
});
