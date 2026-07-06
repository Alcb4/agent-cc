// Proxy a logical operation: enforce default-deny scopes, rate-limit per
// workspace, inject the token from the vault, dispatch, and audit the call.
// An agent never sees the token.

import { ok, err, appError, type Result, type OAuthProxyResult } from "@agent-cc/shared";
import type { SecretsVault } from "@agent-cc/secrets";
import { type DB, getConnection, logOperation } from "./db.js";
import { dispatch } from "./operations.js";

const VAULT_NS = "oauth";

// Fixed-window per-workspace rate limiter.
export class RateLimiter {
  private buckets = new Map<string, { count: number; windowStart: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const b = this.buckets.get(key);
    if (!b || now - b.windowStart >= this.windowMs) {
      this.buckets.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (b.count >= this.limit) return false;
    b.count += 1;
    return true;
  }
}

export async function proxy(
  deps: { main: DB; audit: DB; vault: SecretsVault; limiter: RateLimiter },
  req: { connectionId: string; operation: string; params?: Record<string, unknown> },
): Promise<Result<OAuthProxyResult>> {
  const conn = getConnection(deps.main, req.connectionId);
  if (!conn) return err(appError("bad_request", `unknown connection ${req.connectionId}`));

  // Default-deny: the operation must be explicitly granted on the connection.
  if (!conn.scopes.includes(req.operation)) {
    logOperation(deps.audit, {
      connectionId: conn.id,
      provider: conn.provider,
      workspaceId: conn.workspaceId,
      operation: req.operation,
      status: "denied_scope",
    });
    return err(appError("bad_request", `operation ${req.operation} not granted for this connection`));
  }

  const limitKey = `${conn.workspaceId ?? "global"}`;
  if (!deps.limiter.allow(limitKey)) {
    logOperation(deps.audit, {
      connectionId: conn.id,
      provider: conn.provider,
      workspaceId: conn.workspaceId,
      operation: req.operation,
      status: "rate_limited",
    });
    return err(appError("bad_request", "rate limit exceeded for this workspace"));
  }

  const token = deps.vault.get(VAULT_NS, conn.id);
  if (!token) return err(appError("bad_request", "no token stored for this connection"));

  try {
    const result = await dispatch(req.operation, { token, params: req.params ?? {} });
    logOperation(deps.audit, {
      connectionId: conn.id,
      provider: conn.provider,
      workspaceId: conn.workspaceId,
      operation: req.operation,
      status: "ok",
    });
    return ok({ ok: true, operation: req.operation, result });
  } catch (e) {
    logOperation(deps.audit, {
      connectionId: conn.id,
      provider: conn.provider,
      workspaceId: conn.workspaceId,
      operation: req.operation,
      status: "error",
    });
    return err(appError("internal", `operation failed: ${(e as Error).message}`));
  }
}
