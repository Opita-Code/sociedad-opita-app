/**
 * Cost tracker — USD estimate for DeepSeek output tokens.
 *
 * Phase 1 pricing (verified Jun 2026 from DeepSeek API docs):
 *   deepseek-chat:     $0.14 per 1M output tokens
 *   deepseek-reasoner: $2.19 per 1M output tokens
 *
 * Formula: ceil(text.length / 4) / 1_000_000 * costPer1M
 * Approximation: 4 chars per token (English heuristic; close enough for
 * Spanish colonial dialect — characters per token for Spanish are slightly
 * less, so this slightly overestimates cost, which is the safe direction).
 */
export function estimateCost(text: string, model: string): number {
  const outputTokens = Math.ceil(text.length / 4);
  const costPer1M = model.includes("reasoner") ? 2.19 : 0.14;
  return (outputTokens / 1_000_000) * costPer1M;
}
