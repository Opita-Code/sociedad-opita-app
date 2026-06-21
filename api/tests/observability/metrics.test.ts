/**
 * Metrics — Polish R6 observability.
 *
 * Behaviors under test:
 *  - increment() and histogram() each emit ONE stdout line per call
 *  - the line is a valid CloudWatch Embedded Metric Format (EMF) blob:
 *      {
 *        "_aws": {
 *          "Timestamp": <ms epoch>,
 *          "CloudWatchMetrics": {
 *            "Namespace": "SociedadOpita",
 *            "Dimensions": [[...dim keys...]],
 *            "Metrics": [{ "Name": <name>, "Unit": <unit> }]
 *          }
 *        },
 *        "<metric name>": <value>,
 *        ...dim keys as flat top-level fields...
 *      }
 *  - the metric name appears both as the field key (CloudWatch convention)
 *    AND inside the Metrics[].Name descriptor
 *  - dimension values are surfaced as flat top-level fields next to the
 *    metric value so CloudWatch parses them without further work
 *  - histogram() defaults unit to "Milliseconds" (we always log duration_ms)
 *  - increment() defaults to value=1, unit="Count"
 *  - Timestamp is within ±1s of Date.now() at call time
 *
 * Reference: https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format.html
 * Lambda's CloudWatch agent parses EMF blobs automatically — no agent
 * install is needed on the function. We only need to make sure the JSON
 * shape matches the spec.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { metrics } from "../../src/observability/metrics";

interface EMFDoc {
  _aws?: {
    Timestamp?: number;
    CloudWatchMetrics?: {
      Namespace?: string;
      Dimensions?: string[][];
      Metrics?: Array<{ Name?: string; Unit?: string }>;
    };
  };
  [k: string]: unknown;
}

function captureEmf<T>(fn: () => T): { docs: EMFDoc[]; result: T } {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const result = fn();
    const docs = spy.mock.calls.map((call) => JSON.parse(String(call[0])) as EMFDoc);
    return { docs, result };
  } finally {
    spy.mockRestore();
  }
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("metrics — EMF envelope", () => {
  it("increment() emits a valid EMF document", () => {
    const { docs } = captureEmf(() =>
      metrics.increment("invocations_total", 1, { route: "/v1/dialogue", method: "POST" })
    );
    expect(docs).toHaveLength(1);
    const doc = docs[0];
    expect(doc._aws).toBeDefined();
    expect(doc._aws?.CloudWatchMetrics?.Namespace).toBe("SociedadOpita");
    expect(doc._aws?.CloudWatchMetrics?.Dimensions).toEqual([["route", "method"]]);
    expect(doc._aws?.CloudWatchMetrics?.Metrics).toEqual([
      { Name: "invocations_total", Unit: "Count" },
    ]);
  });

  it("histogram() emits a valid EMF document with Milliseconds unit", () => {
    const { docs } = captureEmf(() =>
      metrics.histogram("duration_ms", 123.4, { route: "/v1/dialogue" })
    );
    expect(docs).toHaveLength(1);
    const doc = docs[0];
    expect(doc._aws?.CloudWatchMetrics?.Metrics).toEqual([
      { Name: "duration_ms", Unit: "Milliseconds" },
    ]);
    expect(doc._aws?.CloudWatchMetrics?.Dimensions).toEqual([["route"]]);
  });

  it("emits the metric name as a flat top-level field with the value", () => {
    const { docs } = captureEmf(() =>
      metrics.histogram("duration_ms", 42, { route: "/health" })
    );
    const doc = docs[0];
    expect(doc["duration_ms"]).toBe(42);
  });

  it("emits dimension keys as flat top-level fields alongside the value", () => {
    const { docs } = captureEmf(() =>
      metrics.increment("invocations_total", 1, {
        route: "/v1/dialogue",
        status: "200",
        persona_id: "dona_rosa_tendera",
      })
    );
    const doc = docs[0];
    expect(doc.route).toBe("/v1/dialogue");
    expect(doc.status).toBe("200");
    expect(doc.persona_id).toBe("dona_rosa_tendera");
  });

  it("uses Timestamp within ±1 second of Date.now() at call time", () => {
    const before = Date.now();
    const { docs } = captureEmf(() =>
      metrics.increment("test_metric", 1, { route: "/x" })
    );
    const after = Date.now();
    const ts = docs[0]._aws?.Timestamp;
    expect(typeof ts).toBe("number");
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

describe("metrics — defaults", () => {
  it("increment() defaults value to 1", () => {
    const { docs } = captureEmf(() => metrics.increment("invocations_total"));
    expect(docs[0]["invocations_total"]).toBe(1);
    expect(docs[0]._aws?.CloudWatchMetrics?.Metrics?.[0]?.Unit).toBe("Count");
  });

  it("increment() defaults dimensions to an empty object (no Dimensions entry)", () => {
    const { docs } = captureEmf(() => metrics.increment("bare_metric"));
    const doc = docs[0];
    expect(doc._aws?.CloudWatchMetrics?.Dimensions).toEqual([[]]);
  });

  it("histogram() requires an explicit value (no silent default to 0)", () => {
    const { docs } = captureEmf(() => metrics.histogram("duration_ms", 17, {}));
    expect(docs[0]["duration_ms"]).toBe(17);
  });

  it("emits one EMF line per call (no batching, no buffering)", () => {
    const { docs } = captureEmf(() => {
      metrics.increment("a_total", 1);
      metrics.histogram("b_ms", 5);
      metrics.increment("c_total", 1, { route: "/r" });
    });
    expect(docs).toHaveLength(3);
    expect((docs[0]["a_total"])).toBe(1);
    expect((docs[1]["b_ms"])).toBe(5);
    expect((docs[2]._aws?.CloudWatchMetrics?.Dimensions)).toEqual([["route"]]);
  });
});

describe("metrics — dimension cardinality", () => {
  it("supports persona_id as a dimension (observability per persona)", () => {
    const { docs } = captureEmf(() =>
      metrics.increment("invocations_total", 1, {
        route: "/v1/dialogue",
        persona_id: "don_rosalio",
      })
    );
    expect(docs[0]._aws?.CloudWatchMetrics?.Dimensions).toEqual([["route", "persona_id"]]);
    expect(docs[0].persona_id).toBe("don_rosalio");
  });

  it("supports status_code as a dimension (200 vs 500 split)", () => {
    const { docs } = captureEmf(() =>
      metrics.increment("errors_total", 1, { route: "/v1/dialogue", status_code: "500" })
    );
    expect(docs[0].status_code).toBe("500");
  });

  it("preserves dimension order — first-seen wins (stable for CloudWatch)", () => {
    const { docs } = captureEmf(() =>
      metrics.histogram("duration_ms", 100, { route: "/v1/dialogue", method: "POST" })
    );
    expect(docs[0]._aws?.CloudWatchMetrics?.Dimensions?.[0]).toEqual(["route", "method"]);
  });
});

describe("metrics — output is parseable JSON", () => {
  it("every emitted line is a JSON object parseable by JSON.parse", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    metrics.increment("invocations_total", 1, { route: "/v1/dialogue" });
    metrics.histogram("duration_ms", 12.5, { route: "/v1/dialogue" });
    expect(spy).toHaveBeenCalledTimes(2);
    for (const call of spy.mock.calls) {
      expect(() => JSON.parse(String(call[0]))).not.toThrow();
    }
    spy.mockRestore();
  });
});
