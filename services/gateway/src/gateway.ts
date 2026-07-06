// Infer orchestration: resolve provider + model, pull the API key from the
// secrets vault, call with bounded exponential-backoff retry, price the usage in
// microcents, log it to audit.db, and return the native response + usage.

import { ok, err, appError, type Result, type InferResult } from "@agent-cc/shared";
import type { SecretsVault } from "@agent-cc/secrets";
import { type DB, getProvider, logUsage } from "./db.js";
import { callProvider } from "./providers.js";
import { costMicrocents } from "./pricing.js";

const VAULT_NS = "gateway";
const MAX_ATTEMPTS = 3;

export interface InferRequest {
  providerId: string;
  model?: string;
  prompt: string;
  workspaceId?: string;
  personaId?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function infer(
  deps: { main: DB; audit: DB; vault: SecretsVault },
  req: InferRequest,
): Promise<Result<InferResult>> {
  const provider = getProvider(deps.main, req.providerId);
  if (!provider) return err(appError("bad_request", `unknown provider ${req.providerId}`));

  const modelId = req.model || provider.defaultModel;
  if (!modelId) return err(appError("bad_request", "no model specified and provider has no default"));

  const apiKey = provider.authType === "api_key" ? deps.vault.get(VAULT_NS, provider.id) : null;
  if (provider.authType === "api_key" && provider.type !== "mock" && !apiKey) {
    return err(appError("bad_request", `no API key set for provider ${provider.id}`));
  }

  const started = Date.now();
  let lastErr = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const out = await callProvider({ provider, modelId, prompt: req.prompt, apiKey });
      const usage = {
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
        costMicrocents: costMicrocents(modelId, out.inputTokens, out.outputTokens),
        latencyMs: Date.now() - started,
      };
      logUsage(deps.audit, {
        providerId: provider.id,
        modelId,
        workspaceId: req.workspaceId ?? null,
        personaId: req.personaId ?? null,
        usage,
      });
      return ok({ response: out.response, usage, providerId: provider.id, modelId });
    } catch (e) {
      lastErr = (e as Error).message;
      if (attempt < MAX_ATTEMPTS - 1) await sleep(200 * 2 ** attempt); // 200ms, 400ms
    }
  }
  return err(appError("internal", `provider call failed after ${MAX_ATTEMPTS} attempts: ${lastErr}`));
}
