// HTTP clients for the services the supervisor depends on. Services never import
// each other's code (per AGENTS.md); they talk over localhost HTTP only.

import { ok, err, appError, type Result, type ContextPack, type ComposedPrompt, type UsageSummary } from "@agent-cc/shared";

export async function getUsageSummary(
  gatewayBaseUrl: string,
  query: { since?: string; workspaceId?: string },
): Promise<Result<UsageSummary>> {
  try {
    const qs = new URLSearchParams();
    if (query.since) qs.set("since", query.since);
    if (query.workspaceId) qs.set("workspaceId", query.workspaceId);
    const res = await fetch(`${gatewayBaseUrl}/llm/usage/summary?${qs.toString()}`);
    if (!res.ok) return err(appError("service.unreachable", `gateway usage ${res.status}`));
    return ok((await res.json()) as UsageSummary);
  } catch (e) {
    return err(appError("service.unreachable", "gateway is down. Restart with: agent-cc start.", {
      cause: (e as Error).message,
    }));
  }
}

export async function getContext(
  memoryBaseUrl: string,
  workspaceId: string,
  taskHint: string,
): Promise<Result<ContextPack>> {
  try {
    const res = await fetch(`${memoryBaseUrl}/memory/get-context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, taskHint }),
    });
    if (!res.ok) {
      return err(appError("service.unreachable", `memory get-context ${res.status}`));
    }
    return ok((await res.json()) as ContextPack);
  } catch (e) {
    return err(
      appError("service.unreachable", "memory service is down. Restart with: agent-cc start.", {
        cause: (e as Error).message,
      }),
    );
  }
}

export async function bindPersona(
  personaBaseUrl: string,
  workspaceId: string,
  personaId: string,
): Promise<Result<void>> {
  try {
    const res = await fetch(`${personaBaseUrl}/personas/bindings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, personaId }),
    });
    if (!res.ok) return err(appError("service.unreachable", `persona bind ${res.status}`));
    return ok(undefined);
  } catch (e) {
    return err(appError("service.unreachable", "persona service is down. Restart with: agent-cc start.", {
      cause: (e as Error).message,
    }));
  }
}

export async function composePersona(
  personaBaseUrl: string,
  args: { workspaceId: string; personaId: string; taskContext: string; projectPath: string },
): Promise<Result<ComposedPrompt>> {
  try {
    const res = await fetch(`${personaBaseUrl}/personas/compose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!res.ok) return err(appError("service.unreachable", `persona compose ${res.status}`));
    return ok((await res.json()) as ComposedPrompt);
  } catch (e) {
    return err(appError("service.unreachable", "persona service is down. Restart with: agent-cc start.", {
      cause: (e as Error).message,
    }));
  }
}

export async function writeRun(
  memoryBaseUrl: string,
  workspaceId: string,
  runOutput: string,
  exitCode: number | null,
): Promise<Result<void>> {
  try {
    const res = await fetch(`${memoryBaseUrl}/memory/write-run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId, runOutput, exitCode }),
    });
    if (!res.ok) {
      return err(appError("memory.write_failed", `memory write-run ${res.status}`));
    }
    return ok(undefined);
  } catch (e) {
    return err(
      appError("service.unreachable", "memory service is down. Restart with: agent-cc start.", {
        cause: (e as Error).message,
      }),
    );
  }
}
