/**
 * Cost tracking — Polish R6 observability.
 *
 * Records per-invocation cost in USD. Two surfaces:
 *
 *   1. Structured log line via `logger.info("cost.recorded", {...})`
 *      so operators can grep CloudWatch Insights for cost spikes.
 *   2. EMF metric `cost_usd` histogram with `model` as a dimension
 *      so CloudWatch auto-builds a per-model cost dashboard.
 *
 * The actual cost math lives in `api/src/llm/cost-tracker.ts` (frozen
 * zone — PR #5). We do not duplicate it; we adapt `tokens_out` (which
 * is what the OCAIS provider yields) into the `text` shape that
 * `estimateCost()` expects (chars ≈ tokens × 4, see cost-tracker.ts).
 *
 * Daily/monthly aggregation helpers (`dailyAggregate`, `monthlyProjection`)
 * are pure functions; they exist so the operator can paste a day's
 * records into a notebook and get a back-of-envelope projection.
 * They are not invoked from the hot path.
 */
import { estimateCost } from "../llm/cost-tracker";
import { logger } from "./logger";
import { metrics } from "./metrics";

export interface CostRecord {
  model: string;
  tokens_out: number;
  tokens_in?: number;
  conv_id?: string;
  persona_id?: string;
}

export interface DailyCost {
  day: string;
  cost_usd?: number;
}

const CHARS_PER_TOKEN = 4;

function tokensOutToText(tokens: number): string {
  // OCAIS gives us tokens; cost-tracker wants text length.
  // Inverting the formula: text.length = tokens * 4.
  return "a".repeat(Math.max(0, tokens) * CHARS_PER_TOKEN);
}

class CostTracker {
  /**
   * Record one LLM invocation. If tokens_out is 0 (e.g. aborted before
   * the first token landed), we skip the log + metric entirely — a
   * zero-cost row is just noise.
   */
  recordInvocation(record: CostRecord): void {
    if (!record.tokens_out || record.tokens_out <= 0) return;

    const text = tokensOutToText(record.tokens_out);
    const costUsd = estimateCost(text, record.model);

    logger.info("cost.recorded", {
      model: record.model,
      tokens_in: record.tokens_in,
      tokens_out: record.tokens_out,
      conv_id: record.conv_id,
      persona_id: record.persona_id,
      cost_usd: costUsd,
    });

    metrics.histogram("cost_usd", costUsd, { model: record.model });
  }
}

/**
 * Sum the `cost_usd` field across a day's records. Records missing
 * `cost_usd` or carrying NaN are skipped — they would otherwise
 * poison the total.
 */
export function dailyAggregate(records: readonly DailyCost[]): number {
  let total = 0;
  for (const r of records) {
    const v = r.cost_usd;
    if (typeof v !== "number" || Number.isNaN(v)) continue;
    total += v;
  }
  return total;
}

/**
 * Operator's back-of-envelope: daily total × 30 days.
 * Conservative (slightly under-counts) because months vary, but it
 * is the formula the alarms.config.ts cost-cap alarm uses, so keeping
 * the same multiplier makes the dashboard and the alarm agree.
 */
export function monthlyProjection(dailyUsd: number): number {
  return dailyUsd * 30;
}

export const cost = new CostTracker();
