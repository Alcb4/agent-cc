// N2 model catalogue. A dropdown of known model IDs per provider type replaces
// free-text entry (which invited typos). Anthropic IDs are the authoritative
// current set from the claude-api reference; other providers list common options.
// Every selector keeps a "Custom…" escape hatch, so this list need not be
// exhaustive — it just covers the common cases without a typo.

export interface ModelOption {
  id: string;
  label: string;
}

export const MODELS_BY_PROVIDER: Record<string, ModelOption[]> = {
  anthropic: [
    { id: "claude-opus-4-8", label: "Claude Opus 4.8 (recommended)" },
    { id: "claude-fable-5", label: "Claude Fable 5 (most capable)" },
    { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (balanced)" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (fast)" },
  ],
  openai: [
    { id: "gpt-5", label: "GPT-5" },
    { id: "gpt-5-mini", label: "GPT-5 mini" },
    { id: "o4", label: "o4" },
  ],
  openrouter: [
    { id: "anthropic/claude-opus-4-8", label: "Claude Opus 4.8" },
    { id: "openai/gpt-5", label: "GPT-5" },
  ],
  ollama: [
    { id: "llama3.3", label: "Llama 3.3" },
    { id: "qwen2.5-coder", label: "Qwen2.5 Coder" },
  ],
  mock: [{ id: "mock-model", label: "Mock model" }],
};

// The product's default model (matches the supervisor's project default).
export const DEFAULT_MODEL = "claude-opus-4-8";

// Flattened, de-duplicated list for selectors not tied to a specific provider
// (e.g. a project's default model). Anthropic first.
export const ALL_MODELS: ModelOption[] = (() => {
  const seen = new Set<string>();
  const out: ModelOption[] = [];
  for (const type of ["anthropic", "openai", "ollama"]) {
    for (const m of MODELS_BY_PROVIDER[type] ?? []) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
  }
  return out;
})();
