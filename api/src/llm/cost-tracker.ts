/**
 * Cost tracker — USD estimate for LLM output tokens.
 *
 * Pricing is sourced from `LLM_CONFIG` (api/src/llm/config.ts) so a
 * provider change in one place is reflected here automatically. The
 * per-model lookup handles the case where a request explicitly named
 * a different model than the active default (e.g., the legacy
 * /v1/simulate endpoint accepts `body.model` from the request).
 *
 * Formula: ceil(text.length / 4) / 1_000_000 * costPer1M
 * Approximation: 4 chars per token (English heuristic; close enough for
 * Spanish colonial dialect — characters per token for Spanish are slightly
 * less, so this slightly overestimates cost, which is the safe direction).
 */
import { getOutputCostPer1MUsd } from "./config";

export function estimateCost(text: string, model: string): number {
  const outputTokens = Math.ceil(text.length / 4);
  const costPer1M = getOutputCostPer1MUsd(model);
  return (outputTokens / 1_000_000) * costPer1M;
}
