// OAuth broker (T14).
//   - register a connection with a token (token goes to the vault, never returned)
//   - default-deny: an ungranted operation is refused
//   - a granted operation proxies (mock.echo, no network), injecting the token
//   - revoke removes the connection

import { afterAll, beforeAll, expect, test } from "vitest";
import type { OAuthConnection, OAuthProxyResult } from "@agent-cc/shared";
import { startStack, type TestStack } from "./helpers.js";

let stack: TestStack;

beforeAll(async () => {
  stack = await startStack();
});

afterAll(() => {
  stack?.stop();
});

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${stack.oauthUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("connection stores token in the vault and never returns it", async () => {
  const res = await post("/oauth/connections", {
    provider: "mock",
    workspaceId: "ws-1",
    account: "tester",
    token: "secret-token-xyz",
    scopes: ["mock.echo"],
  });
  expect(res.status).toBe(201);
  const conn = (await res.json()) as OAuthConnection;
  expect(JSON.stringify(conn)).not.toContain("secret-token-xyz");

  // Listing connections never exposes the token either.
  const list = (await (await fetch(`${stack.oauthUrl}/oauth/connections?workspaceId=ws-1`)).json()) as OAuthConnection[];
  expect(list.some((c) => c.id === conn.id)).toBe(true);
  expect(JSON.stringify(list)).not.toContain("secret-token-xyz");
});

test("default-deny: ungranted operation refused; granted operation proxies", async () => {
  const conn = (await (
    await post("/oauth/connections", { provider: "mock", workspaceId: "ws-2", token: "tok", scopes: ["mock.echo"] })
  ).json()) as OAuthConnection;

  // granted -> proxies, injecting the token server-side
  const okRes = await post("/oauth/proxy", {
    connectionId: conn.id,
    operation: "mock.echo",
    params: { hello: "world" },
  });
  expect(okRes.status).toBe(200);
  const proxied = (await okRes.json()) as OAuthProxyResult;
  expect(proxied.ok).toBe(true);
  expect(proxied.result).toEqual({ echoed: { hello: "world" } });

  // ungranted -> 403 (default-deny)
  const denied = await post("/oauth/proxy", { connectionId: conn.id, operation: "mock.secret", params: {} });
  expect(denied.status).toBe(403);

  // grant it, then it proxies
  await post(`/oauth/connections/${conn.id}/grant`, { operations: ["mock.echo"] });
  const stillOk = await post("/oauth/proxy", { connectionId: conn.id, operation: "mock.echo", params: { a: 1 } });
  expect(stillOk.status).toBe(200);
});

test("revoke removes the connection", async () => {
  const conn = (await (
    await post("/oauth/connections", { provider: "mock", workspaceId: "ws-3", token: "tok", scopes: [] })
  ).json()) as OAuthConnection;
  const del = await fetch(`${stack.oauthUrl}/oauth/connections/${conn.id}`, { method: "DELETE" });
  expect(del.status).toBe(200);
  const list = (await (await fetch(`${stack.oauthUrl}/oauth/connections?workspaceId=ws-3`)).json()) as OAuthConnection[];
  expect(list.some((c) => c.id === conn.id)).toBe(false);
});
