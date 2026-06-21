/**
 * Cost tracking — Polish R6 observability.
 *
 * Behaviors under test:
 *  - recordInvocation() logs ONE structured log line with cost_usd
 *  - the cost math uses the existing estimateCost() (frozen zone);
 *    we only verify that the module wires through to it correctly
 *  - histogram metric "cost_usd" is emitted with the model dimension
 *  - optional conv_id and persona_id flow into the log context
 *  - daily aggregate: helper sums per-day costs from a list of records
 *  - monthly projection: daily * 30 (no calendar math, just the operator's
 *    back-of-envelope formula)
 *
 * The cost-tracker lives in api/src/llm/cost-tracker.ts (frozen zone,
 * PR #5). We do not modify it; we only call it. The interface in this
 * file is "give me tokens_out, I'll log + metric".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cost, dailyAggregate, monthlyProjection } from "../../src/observability/cost";

interface LogDoc {
  ts: string;
  level: string;
  event: string;
  context: Record<string, unknown>;
  err?: { message: string; stack?: string };
}

function captureAll<T>(fn: () => T): { logs: LogDoc[]; result: T } {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const result = fn();
    // EMF metrics are also JSON, but they have `_aws.CloudWatchMetrics`.
    // We can tell them apart by checking for that key.
    const logs: LogDoc[] = [];
    for (const call of spy.mock.calls) {
      const parsed = JSON.parse(String(call[0]));
      if (parsed && typeof parsed === "object" && "_aws" in parsed) continue; // EMF
      if (parsed && typeof parsed === "object" && "level" in parsed) {
        logs.push(parsed as LogDoc);
      }
    }
    return { logs, result };
  } finally {
    spy.mockRestore();
  }
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("cost — recordInvocation logging", () => {
  it("emits one log line at level=info with event=cost.recorded", () => {
    const { logs } = captureAll(() =>
      cost.recordInvocation({ model: "deepseek-chat", tokens_out: 400 })
    );
    expect(logs).toHaveLength(1);
    // Polish R11: `!` after the length-1 assertion above so
    // `noUncheckedIndexedAccess` is satisfied — `logs[0]` is typed
    // as `T | undefined` under strict mode.
    expect(logs[0]!.event).toBe("cost.recorded");
    expect(logs[0]!.level).toBe("info");
  });

  it("includes model, tokens_out, and computed cost_usd in the context", () => {
    const { logs } = captureAll(() =>
      cost.recordInvocation({ model: "deepseek-chat", tokens_out: 400 })
    );
    const ctx = logs[0]!.context;
    expect(ctx.model).toBe("deepseek-chat");
    expect(ctx.tokens_out).toBe(400);
    // cost_usd must be a finite non-negative number.
    expect(typeof ctx.cost_usd).toBe("number");
    expect(ctx.cost_usd as number).toBeGreaterThan(0);
  });

  it("computes cost_usd using estimateCost() — reasoner model costs ~16x more", () => {
    const { logs: chatLogs } = captureAll(() =>
      cost.recordInvocation({ model: "deepseek-chat", tokens_out: 4000 })
    );
    const { logs: reasonerLogs } = captureAll(() =>
      cost.recordInvocation({ model: "deepseek-reasoner", tokens_out: 4000 })
    );
    const chatCost = chatLogs[0]!.context.cost_usd as number;
    const reasonerCost = reasonerLogs[0]!.context.cost_usd as number;
    // 4000 tokens × $0.14/1M = $0.00056
    expect(chatCost).toBeCloseTo(0.00056, 8);
    // 4000 × $2.19/1M = $0.00876
    expect(reasonerCost).toBeCloseTo(0.00876, 8);
    expect(reasonerCost / chatCost).toBeCloseTo(2.19 / 0.14, 1);
  });

  it("threads conv_id and persona_id into the log context", () => {
    const { logs } = captureAll(() =>
      cost.recordInvocation({
        model: "deepseek-chat",
        tokens_out: 200,
        conv_id: "conv-abc",
        persona_id: "dona_rosa_tendera",
      })
    );
    expect(logs[0]!.context.conv_id).toBe("conv-abc");
    expect(logs[0]!.context.persona_id).toBe("dona_rosa_tendera");
  });

  it("treats missing conv_id and persona_id as optional (no crash)", () => {
    const { logs } = captureAll(() =>
      cost.recordInvocation({ model: "deepseek-chat", tokens_out: 100 })
    );
    expect(logs[0]!.context.conv_id).toBeUndefined();
    expect(logs[0]!.context.persona_id).toBeUndefined();
  });

  it("does not log when tokens_out is 0 (zero cost = no record)", () => {
    // We don't want to spam CloudWatch with zero-cost empty records.
    // Either: no log emitted, OR a log with cost_usd=0. We pick the
    // former — no record is generated when tokens_out is 0.
    const { logs } = captureAll(() =>
      cost.recordInvocation({ model: "deepseek-chat", tokens_out: 0 })
    );
    expect(logs).toHaveLength(0);
  });
});

describe("cost — metrics emission", () => {
  it("emits an EMF cost_usd histogram with model as a dimension", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    cost.recordInvocation({ model: "deepseek-chat", tokens_out: 800 });
    // Find the EMF doc (has _aws.CloudWatchMetrics).
    const emf = spy.mock.calls
      .map((c) => JSON.parse(String(c[0])))
      .find((d) => d && typeof d === "object" && "_aws" in d);
    expect(emf).toBeDefined();
    expect((emf as Record<string, unknown>)["cost_usd"]).toBeGreaterThan(0);
    expect((emf as Record<string, unknown>).model).toBe("deepseek-chat");
    const cm = (
      emf as { _aws: { CloudWatchMetrics: { Metrics: Array<{ Name: string; Unit: string }> } } }
    )._aws.CloudWatchMetrics;
    expect(cm.Metrics[0]!.Name).toBe("cost_usd");
    expect(cm.Metrics[0]!.Unit).toBe("Milliseconds"); // EMF unit, not cost unit; duration_ms convention
    spy.mockRestore();
  });
});

describe("cost — dailyAggregate helper", () => {
  it("returns the sum of all cost_usd values in the records", () => {
    const total = dailyAggregate([
      { day: "2026-06-21", cost_usd: 0.0001 },
      { day: "2026-06-21", cost_usd: 0.0002 },
      { day: "2026-06-20", cost_usd: 0.0003 },
    ]);
    expect(total).toBeCloseTo(0.0006, 10);
  });

  it("returns 0 for an empty list (no NaN, no Infinity)", () => {
    expect(dailyAggregate([])).toBe(0);
  });

  it("ignores malformed records gracefully (cost_usd undefined or NaN)", () => {
    const total = dailyAggregate([
      { day: "2026-06-21", cost_usd: 0.001 },
      { day: "2026-06-21" }, // no cost_usd
      { day: "2026-06-21", cost_usd: NaN },
    ]);
    expect(total).toBe(0.001);
  });

  it("does not throw on negative costs (operator-side correction)", () => {
    const total = dailyAggregate([{ day: "2026-06-21", cost_usd: -0.0001 }]);
    expect(total).toBe(-0.0001);
  });
});

describe("cost — monthlyProjection helper", () => {
  it("multiplies daily total by 30 (operator back-of-envelope)", () => {
    expect(monthlyProjection(0.1)).toBeCloseTo(3.0, 10);
    expect(monthlyProjection(0.0001)).toBeCloseTo(0.003, 10);
  });

  it("returns 0 for daily = 0 (no surprise negatives)", () => {
    expect(monthlyProjection(0)).toBe(0);
  });

  it("scales linearly — 2x daily gives 2x monthly", () => {
    expect(monthlyProjection(0.05) / monthlyProjection(0.025)).toBeCloseTo(2, 10);
  });
});
