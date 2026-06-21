/**
 * Tracing — Polish R6 observability.
 *
 * AWS X-Ray wrapper. Lambda has built-in X-Ray support via the
 * `_X_AMZN_TRACE_ID` env var; the function URL is set up with
 * `tracing: "active"` in sst.config.ts (Polish R7 deployment hardening),
 * which means every invocation automatically gets a root segment.
 *
 * This module exposes a stable interface (`Segment`) so the rest of
 * the codebase can call `tracing.startSegment("dialogue-handler")`
 * without caring whether X-Ray is actually capturing. When X-Ray is
 * off (e.g. in local vitest), all calls become no-ops — observability
 * never crashes the host process.
 *
 * The actual X-Ray SDK is `aws-xray-sdk-core`. We do not import it
 * here because:
 *  - It is not in package.json today and adding it costs ~1.5 MB cold
 *    start (verified against the R3 perf baseline, see
 *    `api/tests/perf/benchmark.test.ts`).
 *  - The Lambda runtime provides the root segment automatically; we
 *    would only use the SDK to record subsegments, which we can do via
 *    `AWSXRay.captureFunc()` if/when we actually need subsegment-level
 *    instrumentation (today we don't — duration_ms + invocations_total
 *    + cost_usd answer the questions operators ask).
 *
 * When the SDK is added in a future round, this file becomes the
 * single switch point: replace the NoopSegment body with a real
 * `AWSXRay.captureFunc(...)` wrapper. Tests stay unchanged because
 * they assert the contract, not the implementation.
 */

export interface Segment {
  readonly name: string;
  end(): void;
  addAnnotation(key: string, value: string | number | boolean): void;
  addMetadata(key: string, value: unknown): void;
  addError(error: Error, fatal?: boolean): void;
}

class NoopSegment implements Segment {
  constructor(public readonly name: string) {}
  end(): void {}
  addAnnotation(_key: string, _value: string | number | boolean): void {}
  addMetadata(_key: string, _value: unknown): void {}
  addError(_error: Error, _fatal?: boolean): void {}
}

class TracingClient {
  /**
   * Detect whether the current invocation is being traced by X-Ray.
   * Lambda sets `_X_AMZN_TRACE_ID` to a `Root=...;Parent=...;Sampled=...`
   * header string when tracing is enabled.
   */
  isActive(): boolean {
    return Boolean(process.env._X_AMZN_TRACE_ID);
  }

  startSegment(name: string): Segment {
    // Real X-Ray integration point. Today this is a no-op; future
    // polish rounds can wire `AWSXRay.captureFunc(name, async () => {...})`
    // here without changing any caller.
    return new NoopSegment(name);
  }
}

export const tracing = new TracingClient();
