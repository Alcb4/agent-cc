// Per-provider dispatch. Each provider is called with its NATIVE request/response
// shape (Risk 7: don't invent a lowest-common-denominator), and we extract a
// uniform {response, tokens} from each. A "mock" provider needs no network and
// makes the whole path testable without real keys.

import type { Provider } from "@agent-cc/shared";

export interface CallResult {
  response: string;
  inputTokens: number;
  outputTokens: number;
}

const wordCount = (s: string): number => (s.trim() ? s.trim().split(/\s+/).length : 0);

export async function callProvider(args: {
  provider: Provider;
  modelId: string;
  prompt: string;
  apiKey: string | null;
}): Promise<CallResult> {
  const { provider, modelId, prompt, apiKey } = args;

  switch (provider.type) {
    case "mock": {
      const response = `mock(${modelId}): ${prompt.slice(0, 200)}`;
      return { response, inputTokens: wordCount(prompt), outputTokens: wordCount(response) };
    }

    case "anthropic": {
      const base = provider.baseUrl || "https://api.anthropic.com";
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey ?? "",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({ model: modelId, max_tokens: 1024, messages: [{ role: "user", content: prompt }] }),
      });
      if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
      const j = (await res.json()) as {
        content: Array<{ text?: string }>;
        usage: { input_tokens: number; output_tokens: number };
      };
      return {
        response: j.content.map((c) => c.text ?? "").join(""),
        inputTokens: j.usage.input_tokens,
        outputTokens: j.usage.output_tokens,
      };
    }

    case "openai":
    case "openrouter": {
      const base = provider.baseUrl || (provider.type === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1");
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey ?? ""}` },
        body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: prompt }] }),
      });
      if (!res.ok) throw new Error(`${provider.type} ${res.status}: ${await res.text()}`);
      const j = (await res.json()) as {
        choices: Array<{ message: { content: string } }>;
        usage: { prompt_tokens: number; completion_tokens: number };
      };
      return {
        response: j.choices[0]?.message.content ?? "",
        inputTokens: j.usage.prompt_tokens,
        outputTokens: j.usage.completion_tokens,
      };
    }

    case "ollama": {
      const base = provider.baseUrl || "http://localhost:11434";
      const res = await fetch(`${base}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: modelId, prompt, stream: false }),
      });
      if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
      const j = (await res.json()) as { response: string; prompt_eval_count?: number; eval_count?: number };
      return { response: j.response, inputTokens: j.prompt_eval_count ?? 0, outputTokens: j.eval_count ?? 0 };
    }
  }
}
