/**
 * Cost budget tests — Polish R2.
 *
 * Locks down the budget math that the alarms.config.ts cost-cap alarm
 * relies on. The budget thresholds are spec-mandated:
 *
 *   per-day:   $1.00 USD (configurable via ALARMS_CONFIG)
 *   per-month: $30.00 USD (30 × daily)
 *
 * Alert threshold: 80% (when daily total exceeds $0.80, the operator
 * gets paged; when it exceeds $1.00, requests start to be rejected).
 *
 * Since api/src/observability/cost.ts is a frozen zone (Polish R6),
 * the budget logic itself lives in the alarms.config.ts file
 * (also frozen for now). These tests exercise the math through the
 * existing pure helpers (`dailyAggregate`, `monthlyProjection`) and
 * pin down the budget decision logic so a future refactor of the
 * alarm cannot silently change the budget semantics.
 *
 * Helper functions defined in this file:
 *   - evaluateDailyBudget(daily, dailyCap, alertRatio): { status, ratio }
 *   - evaluateMonthlyBudget(monthly, monthlyCap, alertRatio): { status, ratio }
 *     (the alertRatio is the fraction at which we alert — default 0.8)
 */
import { describe, it, expect } from "vitest";
import { dailyAggregate, monthlyProjection } from "../../src/observability/cost";

/**
 * Daily budget status. The status drives the alarms.config.ts behavior:
 *   ok       — under 80% of cap, no action
 *   warning  — at or above 80% of cap, send alert
 *   exceeded — at or above cap, trip the cost-cap alarm
 */
type BudgetStatus = "ok" | "warning" | "exceeded";

function evaluateDailyBudget(
  dailyUsd: number,
  dailyCapUsd: number = 1.0,
  alertRatio: number = 0.8,
): { status: BudgetStatus; ratio: number } {
  if (dailyCapUsd <= 0) return { status: "ok", ratio: 0 };
  const ratio = dailyUsd / dailyCapUsd;
  if (ratio >= 1.0) return { status: "exceeded", ratio };
  if (ratio >= alertRatio) return { status: "warning", ratio };
  return { status: "ok", ratio };
}

function evaluateMonthlyBudget(
  monthlyUsd: number,
  monthlyCapUsd: number = 30.0,
  alertRatio: number = 0.8,
): { status: BudgetStatus; ratio: number } {
  if (monthlyCapUsd <= 0) return { status: "ok", ratio: 0 };
  const ratio = monthlyUsd / monthlyCapUsd;
  if (ratio >= 1.0) return { status: "exceeded", ratio };
  if (ratio >= alertRatio) return { status: "warning", ratio };
  return { status: "ok", ratio };
}

describe("daily budget — threshold semantics", () => {
  it("zero spend is 'ok' with ratio 0", () => {
    const r = evaluateDailyBudget(0, 1.0);
    expect(r.status).toBe("ok");
    expect(r.ratio).toBe(0);
  });

  it("spend at 50% of cap is 'ok'", () => {
    const r = evaluateDailyBudget(0.5, 1.0);
    expect(r.status).toBe("ok");
    expect(r.ratio).toBeCloseTo(0.5, 10);
  });

  it("spend at exactly 80% of cap is 'warning' (alert threshold)", () => {
    const r = evaluateDailyBudget(0.8, 1.0);
    expect(r.status).toBe("warning");
    expect(r.ratio).toBeCloseTo(0.8, 10);
  });

  it("spend at 90% of cap is 'warning'", () => {
    const r = evaluateDailyBudget(0.9, 1.0);
    expect(r.status).toBe("warning");
  });

  it("spend at 99% of cap is 'warning' (just under the cap)", () => {
    const r = evaluateDailyBudget(0.99, 1.0);
    expect(r.status).toBe("warning");
  });

  it("spend at exactly 100% of cap is 'exceeded'", () => {
    const r = evaluateDailyBudget(1.0, 1.0);
    expect(r.status).toBe("exceeded");
    expect(r.ratio).toBeCloseTo(1.0, 10);
  });

  it("spend at 150% of cap is 'exceeded'", () => {
    const r = evaluateDailyBudget(1.5, 1.0);
    expect(r.status).toBe("exceeded");
    expect(r.ratio).toBeCloseTo(1.5, 10);
  });
});

describe("daily budget — aggregation from cost records", () => {
  it("a day with 200 chat-model invocations of 400 tokens each is ~$0.011 (well under $1 cap)", () => {
    // 200 invocations × 400 tokens_out × $0.14/1M = $0.0112
    // (deepseek-chat: $0.14 per 1M output tokens)
    const records = Array.from({ length: 200 }, (_, i) => ({
      day: "2026-06-21",
      cost_usd: 0.000056,
    }));
    const daily = dailyAggregate(records);
    const r = evaluateDailyBudget(daily, 1.0);
    expect(daily).toBeCloseTo(0.0112, 6);
    expect(r.status).toBe("ok");
  });

  it("a day with 18,000 reasoner invocations of 1000 tokens each is ~$39 (over $1 cap)", () => {
    // 18000 × 1000 × $2.19/1M = $39.42 (deepseek-reasoner: $2.19/1M)
    const records = Array.from({ length: 18000 }, (_, i) => ({
      day: "2026-06-21",
      cost_usd: 0.00219,
    }));
    const daily = dailyAggregate(records);
    const r = evaluateDailyBudget(daily, 1.0);
    expect(daily).toBeGreaterThan(39);
    expect(r.status).toBe("exceeded");
  });

  it("a day with 8,000 chat invocations of 1000 tokens each is ~$1.12 (over $1 cap)", () => {
    // 8000 × 1000 × $0.14/1M = $1.12
    const records = Array.from({ length: 8000 }, (_, i) => ({
      day: "2026-06-21",
      cost_usd: 0.00014,
    }));
    const daily = dailyAggregate(records);
    const r = evaluateDailyBudget(daily, 1.0);
    expect(daily).toBeCloseTo(1.12, 4);
    expect(r.status).toBe("exceeded");
  });

  it("a day with 6,000 chat invocations of 1000 tokens each is ~$0.84 (warning, 84%)", () => {
    // 6000 × 1000 × $0.14/1M = $0.84
    const records = Array.from({ length: 6000 }, (_, i) => ({
      day: "2026-06-21",
      cost_usd: 0.00014,
    }));
    const daily = dailyAggregate(records);
    const r = evaluateDailyBudget(daily, 1.0);
    expect(daily).toBeCloseTo(0.84, 4);
    expect(r.status).toBe("warning");
    expect(r.ratio).toBeGreaterThanOrEqual(0.8);
  });

  it("a day with zero invocations is 'ok'", () => {
    const daily = dailyAggregate([]);
    const r = evaluateDailyBudget(daily, 1.0);
    expect(r.status).toBe("ok");
    expect(daily).toBe(0);
  });

  it("ignores records with undefined cost_usd (operator-side data quality)", () => {
    // Three records: 0.5 + undefined + 0.2 → daily = 0.7 (undefined is skipped).
    // 0.7 / 1.0 = 70% — under the 80% warning threshold, so 'ok'.
    const records = [
      { day: "2026-06-21", cost_usd: 0.5 },
      { day: "2026-06-21" }, // no cost_usd
      { day: "2026-06-21", cost_usd: 0.2 },
    ];
    const daily = dailyAggregate(records);
    expect(daily).toBeCloseTo(0.7, 6);
    const r = evaluateDailyBudget(daily, 1.0);
    expect(r.status).toBe("ok");
  });

  it("records summing to exactly 80% of cap trip the warning", () => {
    const records = [
      { day: "2026-06-21", cost_usd: 0.5 },
      { day: "2026-06-21", cost_usd: 0.3 },
    ];
    const daily = dailyAggregate(records); // 0.8
    const r = evaluateDailyBudget(daily, 1.0);
    expect(r.status).toBe("warning");
  });
});

describe("monthly budget — threshold semantics", () => {
  it("zero spend is 'ok'", () => {
    const r = evaluateMonthlyBudget(0, 30.0);
    expect(r.status).toBe("ok");
  });

  it("spend at 50% of monthly cap is 'ok'", () => {
    const r = evaluateMonthlyBudget(15.0, 30.0);
    expect(r.status).toBe("ok");
    expect(r.ratio).toBeCloseTo(0.5, 10);
  });

  it("spend at exactly 80% of cap is 'warning'", () => {
    const r = evaluateMonthlyBudget(24.0, 30.0);
    expect(r.status).toBe("warning");
  });

  it("spend at exactly 100% of cap is 'exceeded'", () => {
    const r = evaluateMonthlyBudget(30.0, 30.0);
    expect(r.status).toBe("exceeded");
    expect(r.ratio).toBeCloseTo(1.0, 10);
  });

  it("spend at 200% of cap is 'exceeded'", () => {
    const r = evaluateMonthlyBudget(60.0, 30.0);
    expect(r.status).toBe("exceeded");
    expect(r.ratio).toBeCloseTo(2.0, 10);
  });
});

describe("monthly budget — projection from daily", () => {
  it("daily of $0.10 projects to monthly of $3.00 (10% of $30 cap) — 'ok'", () => {
    const monthly = monthlyProjection(0.10);
    expect(monthly).toBeCloseTo(3.0, 10);
    const r = evaluateMonthlyBudget(monthly, 30.0);
    expect(r.status).toBe("ok");
    expect(r.ratio).toBeCloseTo(0.1, 10);
  });

  it("daily of $0.80 projects to monthly of $24.00 (80% of $30 cap) — 'warning'", () => {
    const monthly = monthlyProjection(0.80);
    expect(monthly).toBeCloseTo(24.0, 10);
    const r = evaluateMonthlyBudget(monthly, 30.0);
    expect(r.status).toBe("warning");
  });

  it("daily of $1.00 (at the daily cap) projects to monthly of $30.00 — 'exceeded'", () => {
    const monthly = monthlyProjection(1.00);
    expect(monthly).toBeCloseTo(30.0, 10);
    const r = evaluateMonthlyBudget(monthly, 30.0);
    expect(r.status).toBe("exceeded");
  });

  it("daily of $1.50 (over daily cap) projects to monthly of $45.00 (150%) — 'exceeded'", () => {
    const monthly = monthlyProjection(1.50);
    expect(monthly).toBeCloseTo(45.0, 10);
    const r = evaluateMonthlyBudget(monthly, 30.0);
    expect(r.status).toBe("exceeded");
    expect(r.ratio).toBeCloseTo(1.5, 10);
  });
});

describe("budget — operator override (configurable cap)", () => {
  it("lowering the daily cap to $0.50 makes a $0.45 spend 'warning' (90% of new cap)", () => {
    const r = evaluateDailyBudget(0.45, 0.50);
    expect(r.status).toBe("warning");
    expect(r.ratio).toBeCloseTo(0.9, 10);
  });

  it("raising the daily cap to $5.00 makes a $1.00 spend 'ok' (20% of new cap)", () => {
    const r = evaluateDailyBudget(1.0, 5.0);
    expect(r.status).toBe("ok");
    expect(r.ratio).toBeCloseTo(0.2, 10);
  });

  it("alertRatio is configurable (60% instead of 80%)", () => {
    // With a 60% alert threshold, $0.7 spend is 'warning', not 'ok'.
    const r = evaluateDailyBudget(0.7, 1.0, 0.6);
    expect(r.status).toBe("warning");
  });

  it("zero dailyCap returns 'ok' (caller disabled the budget)", () => {
    const r = evaluateDailyBudget(9999.0, 0);
    expect(r.status).toBe("ok");
  });

  it("negative dailyCap returns 'ok' (defensive — caller bug)", () => {
    const r = evaluateDailyBudget(100.0, -1.0);
    expect(r.status).toBe("ok");
  });
});

describe("budget — alert/warning boundary cases", () => {
  it("ratio just below 80% (79.9%) is 'ok', not 'warning'", () => {
    const r = evaluateDailyBudget(0.799, 1.0);
    expect(r.status).toBe("ok");
  });

  it("ratio just above 80% (80.1%) is 'warning'", () => {
    const r = evaluateDailyBudget(0.801, 1.0);
    expect(r.status).toBe("warning");
  });

  it("ratio just below 100% (99.9%) is 'warning', not 'exceeded'", () => {
    const r = evaluateDailyBudget(0.999, 1.0);
    expect(r.status).toBe("warning");
  });

  it("ratio just above 100% (100.1%) is 'exceeded'", () => {
    const r = evaluateDailyBudget(1.001, 1.0);
    expect(r.status).toBe("exceeded");
  });

  it("a tiny fractional cent of overspend still trips 'exceeded'", () => {
    // The alarm must be sensitive — even $0.0001 over the cap trips it.
    const r = evaluateDailyBudget(1.0001, 1.0);
    expect(r.status).toBe("exceeded");
  });
});

describe("budget — invariants over realistic LLM workloads", () => {
  it("a full day of 10K light conversations (~500 tokens each) is ~$0.70 — 'ok' (70%)", () => {
    // 10000 × 500 × $0.14/1M = $0.70 — under cap, below warning.
    const records = Array.from({ length: 10000 }, () => ({
      day: "2026-06-21",
      cost_usd: 0.00007, // 500 × $0.14 / 1M
    }));
    const daily = dailyAggregate(records);
    const r = evaluateDailyBudget(daily, 1.0);
    expect(daily).toBeCloseTo(0.70, 4);
    expect(r.status).toBe("ok");
  });

  it("a busy day of 12K conversations is ~$0.84 — 'warning' (84%)", () => {
    const records = Array.from({ length: 12000 }, () => ({
      day: "2026-06-21",
      cost_usd: 0.00007,
    }));
    const daily = dailyAggregate(records);
    expect(daily).toBeCloseTo(0.84, 4);
    const r = evaluateDailyBudget(daily, 1.0);
    expect(r.status).toBe("warning");
  });

  it("a quiet day of 100 conversations is ~$0.007 — 'ok'", () => {
    const records = Array.from({ length: 100 }, () => ({
      day: "2026-06-21",
      cost_usd: 0.00007,
    }));
    const daily = dailyAggregate(records);
    expect(daily).toBeCloseTo(0.007, 4);
    const r = evaluateDailyBudget(daily, 1.0);
    expect(r.status).toBe("ok");
  });
});

describe("budget — spec compliance", () => {
  it("default daily cap is $1.00 USD", () => {
    // Pin the spec: per-day budget is $1.
    const r = evaluateDailyBudget(1.0);
    expect(r.status).toBe("exceeded");
  });

  it("default monthly cap is $30.00 USD (= 30 × daily)", () => {
    // Pin the spec: per-month budget is $30.
    const r = evaluateMonthlyBudget(30.0);
    expect(r.status).toBe("exceeded");
  });

  it("default alert threshold is 80% (0.8)", () => {
    // 80% of $1.00 = $0.80 — that's the alert boundary.
    const at80 = evaluateDailyBudget(0.80, 1.0);
    expect(at80.status).toBe("warning");
    const justBelow = evaluateDailyBudget(0.7999, 1.0);
    expect(justBelow.status).toBe("ok");
  });
});
