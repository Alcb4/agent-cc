// Token pricing in microcents per token (100_000_000 microcents = $1). Integer
// math only — money never touches a float (AGENTS.md). Matched by substring so
// dated model ids (e.g. claude-haiku-4-5-20251001) still resolve.

interface Price {
  inPerTok: number; // microcents per input token
  outPerTok: number; // microcents per output token
}

// $X per million tokens -> microcents per token = X * 100_000_000 / 1_000_000 = X * 100.
const M = 100; // microcents per token, per $1/Mtok

const TABLE: Array<{ match: RegExp; price: Price }> = [
  { match: /opus/i, price: { inPerTok: 15 * M, outPerTok: 75 * M } },
  { match: /sonnet/i, price: { inPerTok: 3 * M, outPerTok: 15 * M } },
  { match: /haiku/i, price: { inPerTok: 1 * M, outPerTok: 5 * M } },
  { match: /gpt-4o-mini|gpt-4\.1-mini/i, price: { inPerTok: 15, outPerTok: 60 } },
  { match: /gpt-4o|gpt-4\.1/i, price: { inPerTok: 25 * (M / 10), outPerTok: 10 * M } },
];

export function priceFor(modelId: string): Price {
  for (const row of TABLE) if (row.match.test(modelId)) return row.price;
  return { inPerTok: 0, outPerTok: 0 }; // unknown / local / mock = free
}

export function costMicrocents(modelId: string, inputTokens: number, outputTokens: number): number {
  const p = priceFor(modelId);
  return inputTokens * p.inPerTok + outputTokens * p.outPerTok;
}
