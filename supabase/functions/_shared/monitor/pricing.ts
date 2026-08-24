export const MODEL_RATES: Record<string, [number, number]> = {
  "claude-opus-4-8": [15, 75],
  "claude-sonnet-4-6": [3, 15],
  "gemini-2.5-flash": [0.30, 2.50],
  "gemini-flash-latest": [0.30, 2.50],
  "gemini-2.5-pro": [1.25, 10],
  "gemini-pro-latest": [1.25, 10],
  // Batch Mode (logged with @batch suffix) bills at 50% of list.
  "gemini-pro-latest@batch": [0.625, 5],
  "gemini-flash-latest@batch": [0.15, 1.25],
};

export interface PriceableCall {
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  thinking_tokens: number | null;
}

function cacheReadMult(model: string): number {
  return model.startsWith("claude") ? 0.1 : 0.25;
}

export function priceCall(c: PriceableCall): number {
  const model = c.model ?? "";
  const [ri, ro] = MODEL_RATES[model] ?? [0, 0];
  const tin = c.tokens_in ?? 0;
  const tout = c.tokens_out ?? 0;
  const cread = c.cache_read_tokens ?? 0;
  const cwrite = c.cache_write_tokens ?? 0;
  const think = c.thinking_tokens ?? 0;
  const fresh = Math.max(0, tin - cread - cwrite);
  return (
    (fresh / 1e6) * ri +
    (cread / 1e6) * ri * cacheReadMult(model) +
    (cwrite / 1e6) * ri * 1.25 +
    (tout / 1e6) * ro +
    (think / 1e6) * ro
  );
}
