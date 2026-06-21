import { describe, it, expect } from "vitest";
import { estimateCost } from "../../src/llm/cost-tracker";

describe("estimateCost", () => {
  it("returns 0 for empty text", () => {
    expect(estimateCost("", "deepseek-chat")).toBe(0);
  });

  it("returns > 0 for non-empty text with deepseek-chat", () => {
    expect(estimateCost("hello world", "deepseek-chat")).toBeGreaterThan(0);
  });

  it("returns ~16x cost for deepseek-reasoner vs deepseek-chat", () => {
    const chatCost = estimateCost("hello world", "deepseek-chat");
    const reasonerCost = estimateCost("hello world", "deepseek-reasoner");
    expect(reasonerCost / chatCost).toBeCloseTo(2.19 / 0.14, 1);
  });

  it("scales linearly with text length", () => {
    // Use lengths that are exact multiples of 4 to avoid ceil() quantization noise.
    const cost1 = estimateCost("a".repeat(40), "deepseek-chat");
    const cost10 = estimateCost("a".repeat(400), "deepseek-chat");
    expect(cost10 / cost1).toBeCloseTo(10, 5);
  });

  it("uses 0.14 USD per 1M tokens for chat model", () => {
    // 4 chars per token → "hello world" (11 chars) → ceil(11/4) = 3 tokens
    // 3 / 1_000_000 * 0.14 = 0.00000042
    const expected = (3 / 1_000_000) * 0.14;
    expect(estimateCost("hello world", "deepseek-chat")).toBeCloseTo(expected, 10);
  });

  it("uses 2.19 USD per 1M tokens for reasoner model", () => {
    const expected = (3 / 1_000_000) * 2.19;
    expect(estimateCost("hello world", "deepseek-reasoner")).toBeCloseTo(expected, 10);
  });
});
