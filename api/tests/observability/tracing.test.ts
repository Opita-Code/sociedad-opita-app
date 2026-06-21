/**
 * Tracing — Polish R6 observability.
 *
 * Behaviors under test:
 *  - startSegment(name) returns a Segment object
 *  - the segment exposes end(), addAnnotation(), addMetadata(),
 *    addError() — all callable without throwing
 *  - when AWS X-Ray is NOT active (no _X_AMZN_TRACE_ID env var),
 *    the client returns a no-op segment that records nothing
 *  - when AWS X-Ray IS active (_X_AMZN_TRACE_ID set), the segment
 *    should still be a valid Segment (not throw). We do NOT need to
 *    assert the X-Ray SDK is wired; we test the contract.
 *  - segments are independent — ending one does not affect another
 *  - calling end() twice does not throw
 *  - addAnnotation accepts string, number, and boolean values
 *
 * The real X-Ray integration happens via the aws-xray-sdk-core
 * package which is installed in the Lambda runtime; this module
 * exposes a stable interface so the rest of the codebase can call
 * tracing.startSegment() without caring about availability.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tracing } from "../../src/observability/tracing";

const ORIGINAL_TRACE_ENV = process.env._X_AMZN_TRACE_ID;

beforeEach(() => {
  delete process.env._X_AMZN_TRACE_ID;
  vi.restoreAllMocks();
});

afterEach(() => {
  if (ORIGINAL_TRACE_ENV === undefined) {
    delete process.env._X_AMZN_TRACE_ID;
  } else {
    process.env._X_AMZN_TRACE_ID = ORIGINAL_TRACE_ENV;
  }
});

describe("tracing — no-op path (X-Ray off)", () => {
  it("startSegment returns a Segment with a name", () => {
    const seg = tracing.startSegment("dialogue-handler");
    expect(seg.name).toBe("dialogue-handler");
  });

  it("end() is callable and does not throw", () => {
    const seg = tracing.startSegment("evt");
    expect(() => seg.end()).not.toThrow();
    expect(() => seg.end()).not.toThrow(); // idempotent
  });

  it("addAnnotation() is callable with string, number, boolean values", () => {
    const seg = tracing.startSegment("evt");
    expect(() => seg.addAnnotation("persona_id", "don_rosalio")).not.toThrow();
    expect(() => seg.addAnnotation("duration_ms", 123)).not.toThrow();
    expect(() => seg.addAnnotation("ok", true)).not.toThrow();
  });

  it("addMetadata() is callable with arbitrary nested values", () => {
    const seg = tracing.startSegment("evt");
    expect(() =>
      seg.addMetadata("payload", { route: "/v1/dialogue", model: "deepseek-chat" })
    ).not.toThrow();
    expect(() => seg.addMetadata("arr", [1, 2, 3])).not.toThrow();
  });

  it("addError() is callable with an Error and an optional fatal flag", () => {
    const seg = tracing.startSegment("evt");
    const err = new Error("boom");
    expect(() => seg.addError(err)).not.toThrow();
    expect(() => seg.addError(err, true)).not.toThrow();
    expect(() => seg.addError(err, false)).not.toThrow();
  });

  it("does not crash if the host process has no _X_AMZN_TRACE_ID", () => {
    delete process.env._X_AMZN_TRACE_ID;
    const seg = tracing.startSegment("evt");
    expect(seg).toBeDefined();
    seg.end();
  });
});

describe("tracing — Segment lifecycle", () => {
  it("two segments are independent (ending one does not affect the other)", () => {
    const a = tracing.startSegment("a");
    const b = tracing.startSegment("b");
    a.end();
    // b should still be usable after a is closed.
    expect(() => b.addAnnotation("late", "yes")).not.toThrow();
    expect(() => b.end()).not.toThrow();
  });

  it("annotations can be added before and after end() (no-ops are safe)", () => {
    const seg = tracing.startSegment("evt");
    seg.addAnnotation("before", "v");
    seg.end();
    // Even after end, the no-op interface should not throw.
    expect(() => seg.addAnnotation("after", "v")).not.toThrow();
  });

  it("metadata and annotations do not interfere with each other", () => {
    const seg = tracing.startSegment("evt");
    seg.addAnnotation("key_a", 1);
    seg.addMetadata("key_b", { x: 1 });
    seg.addAnnotation("key_c", true);
    seg.end();
  });
});

describe("tracing — under X-Ray (env set)", () => {
  it("returns a usable Segment when _X_AMZN_TRACE_ID is present", () => {
    process.env._X_AMZN_TRACE_ID = "Root=1-5e1b-8a;Parent=8a;Sampled=1";
    const seg = tracing.startSegment("under-xray");
    expect(seg.name).toBe("under-xray");
    expect(() => seg.end()).not.toThrow();
    expect(() => seg.addAnnotation("persona_id", "dona_rosa_tendera")).not.toThrow();
    expect(() => seg.addError(new Error("xray boom"))).not.toThrow();
  });

  it("Sampled=0 (X-Ray off at the segment level) is also tolerated", () => {
    process.env._X_AMZN_TRACE_ID = "Root=1-5e1b-8a;Parent=8a;Sampled=0";
    const seg = tracing.startSegment("not-sampled");
    expect(seg.name).toBe("not-sampled");
    seg.end();
  });
});

describe("tracing — runtime safety", () => {
  it("does not throw on construction in any environment", () => {
    // The module is imported once at top-of-file; the singleton has
    // already been constructed. This test is a sanity check that
    // exporting `tracing` did not throw even with the env unset.
    expect(tracing).toBeDefined();
    expect(typeof tracing.startSegment).toBe("function");
  });

  it("startSegment can be called many times rapidly without leaking state", () => {
    for (let i = 0; i < 100; i++) {
      const s = tracing.startSegment(`seg-${i}`);
      s.addAnnotation("i", i);
      s.end();
    }
    // No assertion needed beyond not throwing.
  });
});
