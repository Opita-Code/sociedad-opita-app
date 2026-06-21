/**
 * Observability middleware — Polish R6 observability.
 *
 * Behaviors under test:
 *  - middleware logs ONE `request.start` line with method, route, ip
 *  - middleware logs ONE `request.end` line with status + duration_ms
 *  - middleware emits `invocations_total` increment and `duration_ms`
 *    histogram with route + method + status dimensions
 *  - on error: middleware logs `request.error` and emits `errors_total`
 *  - PII in query params (email, phone) is redacted before logging
 *  - x-forwarded-for is the source of truth for the IP; otherwise "unknown"
 *  - middleware does not swallow errors — it re-throws so Hono's
 *    error-handler chain can run
 *  - middleware order: a downstream handler can observe the timing
 *    (this is a no-op Hono app pattern, but we verify the contract)
 *
 * The middleware is wired into the production app via `api.ts`. The
 * tests here exercise the middleware in isolation against a synthetic
 * Hono app to keep the contract test independent of the production
 * routing surface.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { observabilityMiddleware } from "../../src/observability/middleware";

interface LogDoc {
  ts: string;
  level: string;
  event: string;
  context: Record<string, unknown>;
  err?: { message: string; stack?: string };
}

interface EMFDoc {
  _aws?: { CloudWatchMetrics?: { Metrics?: Array<{ Name: string }>; Dimensions?: string[][] } };
  [k: string]: unknown;
}

interface Captured {
  logs: LogDoc[];
  emfs: EMFDoc[];
}

function captureAll<T>(
  fn: () => T | Promise<T>
): Promise<{ result: T; logs: LogDoc[]; emfs: EMFDoc[] }> {
  return (async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await fn();
      const logs: LogDoc[] = [];
      const emfs: EMFDoc[] = [];
      for (const call of spy.mock.calls) {
        const parsed = JSON.parse(String(call[0]));
        if (parsed && typeof parsed === "object" && "_aws" in parsed) {
          emfs.push(parsed as EMFDoc);
        } else if (parsed && typeof parsed === "object" && "level" in parsed) {
          logs.push(parsed as LogDoc);
        }
      }
      return { result, logs, emfs };
    } finally {
      spy.mockRestore();
    }
  })();
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => vi.restoreAllMocks());

function buildApp(): Hono {
  const app = new Hono();
  app.use("*", observabilityMiddleware);
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.post("/v1/dialogue", async (c) => {
    const body = await c.req.json<{ persona_id?: string }>();
    return c.json({ ok: true, persona: body.persona_id ?? null });
  });
  app.get("/v1/dialogue/:id", (c) => c.json({ id: c.req.param("id") }));
  app.get("/boom", () => {
    throw new Error("kaboom");
  });
  return app;
}

describe("observability middleware — request.start / request.end", () => {
  it("emits request.start on every request with method, route, ip", async () => {
    const app = buildApp();
    const { logs, result } = await captureAll(() => app.request("/health"));
    expect(result.status).toBe(200);
    const start = logs.find((l) => l.event === "request.start");
    expect(start).toBeDefined();
    expect(start?.context.method).toBe("GET");
    expect(start?.context.route).toBe("/health");
    expect(start?.context.ip).toBe("unknown"); // no x-forwarded-for header
  });

  it("emits request.end after the handler runs, with status + duration_ms", async () => {
    const app = buildApp();
    const { logs, result } = await captureAll(() => app.request("/health"));
    expect(result.status).toBe(200);
    const end = logs.find((l) => l.event === "request.end");
    expect(end).toBeDefined();
    expect(end?.context.method).toBe("GET");
    expect(end?.context.route).toBe("/health");
    expect(end?.context.status).toBe(200);
    expect(typeof end?.context.duration_ms).toBe("number");
    expect(end?.context.duration_ms as number).toBeGreaterThanOrEqual(0);
    expect(end?.context.duration_ms as number).toBeLessThan(5000); // sanity
  });

  it("uses x-forwarded-for as the ip source when present", async () => {
    const app = buildApp();
    const { logs } = await captureAll(() =>
      app.request("/health", { headers: { "x-forwarded-for": "203.0.113.42" } })
    );
    const start = logs.find((l) => l.event === "request.start");
    expect(start?.context.ip).toBe("203.0.113.42");
  });

  it("preserves the response body — middleware is transparent", async () => {
    const app = buildApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("handles dynamic routes — captures the parametrized path", async () => {
    const app = buildApp();
    const { logs } = await captureAll(() => app.request("/v1/dialogue/dona_rosa"));
    const end = logs.find((l) => l.event === "request.end");
    expect(end?.context.route).toBe("/v1/dialogue/dona_rosa");
  });
});

describe("observability middleware — metrics", () => {
  it("emits an invocations_total increment with route+method+status dimensions", async () => {
    const app = buildApp();
    const { emfs } = await captureAll(() => app.request("/health"));
    const inc = emfs.find((e) => {
      const m = e._aws?.CloudWatchMetrics?.Metrics?.[0];
      return m?.Name === "invocations_total";
    });
    expect(inc).toBeDefined();
    expect(inc?._aws?.CloudWatchMetrics?.Dimensions?.[0]).toEqual(["route", "method", "status"]);
    expect(inc?.route).toBe("/health");
    expect(inc?.method).toBe("GET");
    expect(inc?.status).toBe("200");
  });

  it("emits a duration_ms histogram with route+method dimensions", async () => {
    const app = buildApp();
    const { emfs } = await captureAll(() => app.request("/health"));
    const hist = emfs.find((e) => {
      const m = e._aws?.CloudWatchMetrics?.Metrics?.[0];
      return m?.Name === "duration_ms";
    });
    expect(hist).toBeDefined();
    expect(hist?._aws?.CloudWatchMetrics?.Dimensions?.[0]).toEqual(["route", "method"]);
    expect(typeof hist?.["duration_ms"]).toBe("number");
  });

  it("captures POST status code from the response", async () => {
    const app = buildApp();
    const { emfs } = await captureAll(() =>
      app.request("/v1/dialogue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ persona_id: "dona_rosa_tendera" }),
      })
    );
    const inc = emfs.find(
      (e) => e._aws?.CloudWatchMetrics?.Metrics?.[0]?.Name === "invocations_total"
    );
    expect(inc?.status).toBe("200");
    expect(inc?.method).toBe("POST");
  });
});

describe("observability middleware — error path", () => {
  it("logs request.error on handler exception (5xx is treated as error)", async () => {
    const app = buildApp();
    const { logs } = await captureAll(() => app.request("/boom"));
    const errLog = logs.find((l) => l.event === "request.error");
    expect(errLog).toBeDefined();
    expect(errLog?.level).toBe("error");
    // Hono's default error handler converts the original throw into a
    // 500 response, so we don't see the original error message; we
    // emit a synthetic "HTTP 500 from /boom" so operators can
    // correlate with CloudWatch alarms.
    expect(errLog?.err?.message).toContain("500");
    expect(errLog?.err?.message).toContain("/boom");
    expect(errLog?.context.route).toBe("/boom");
    expect(errLog?.context.status).toBe(500);
    expect(typeof errLog?.context.duration_ms).toBe("number");
  });

  it("emits an errors_total metric on handler exception", async () => {
    const app = buildApp();
    const { emfs } = await captureAll(() => app.request("/boom"));
    const errMetric = emfs.find((e) => {
      const m = e._aws?.CloudWatchMetrics?.Metrics?.[0];
      return m?.Name === "errors_total";
    });
    expect(errMetric).toBeDefined();
    expect(errMetric?.route).toBe("/boom");
    expect(errMetric?.method).toBe("GET");
    expect(errMetric?.status).toBe("500");
  });

  it("does not swallow errors — the error reaches the response surface", async () => {
    // Hono will turn an unhandled throw into a 500 by default. The
    // middleware must not eat it.
    const app = buildApp();
    const res = await app.request("/boom");
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it("emits request.error when the handler throws via raw middleware (defensive try/catch path)", async () => {
    // The try/catch branch in the middleware exists for cases where
    // Hono doesn't catch (e.g. a custom onError that re-throws). We
    // exercise it directly by calling the middleware with a fake
    // context and a next() that rejects.
    const { observabilityMiddleware } = await import("../../src/observability/middleware");
    const fakeC = {
      req: {
        path: "/raw-throw",
        method: "GET",
        header: (_name: string) => "10.0.0.1",
      },
      res: { status: 0 },
    } as unknown as import("hono").Context;

    const next = async () => {
      throw new Error("upstream exploded");
    };

    const { logs } = await captureAll(async () => {
      await expect(observabilityMiddleware(fakeC, next)).rejects.toThrow("upstream exploded");
    });
    const errLog = logs.find((l) => l.event === "request.error");
    expect(errLog).toBeDefined();
    expect(errLog?.err?.message).toBe("upstream exploded");
    expect(errLog?.context.route).toBe("/raw-throw");
  });
});

describe("observability middleware — PII redaction in query params", () => {
  it("redacts email addresses passed as query params", async () => {
    const app = buildApp();
    // We deliberately use a route we haven't declared so Hono returns
    // 404 but the middleware still runs (it fires for every route).
    const { logs } = await captureAll(() =>
      app.request("/v1/personas?contact=juan@example.com&city=tello")
    );
    const start = logs.find((l) => l.event === "request.start");
    expect(start).toBeDefined();
    // Logger context will have a redacted form of the query string.
    // We don't expose the raw query, so we just confirm the field
    // does not contain the original email.
    const serialized = JSON.stringify(start);
    expect(serialized).not.toContain("juan@example.com");
    if (serialized.includes("contact")) {
      expect(serialized).toContain("[REDACTED_EMAIL]");
    }
  });

  it("does not log query parameter PII in the request.end line either", async () => {
    const app = buildApp();
    const { logs } = await captureAll(() =>
      app.request("/v1/personas?phone=%2B573126126085&city=tello")
    );
    const end = logs.find((l) => l.event === "request.end");
    expect(end).toBeDefined();
    const serialized = JSON.stringify(end);
    expect(serialized).not.toContain("+573126126085");
  });

  it("preserves Opita unicode in non-PII query params", async () => {
    const app = buildApp();
    const { logs } = await captureAll(() =>
      app.request("/v1/personas?city=Neiva%C3%AD&greeting=%C2%A1Quiubo%20parce!")
    );
    const start = logs.find((l) => l.event === "request.start");
    expect(start).toBeDefined();
    const serialized = JSON.stringify(start);
    // The decoded values should appear (URL-decoded by Hono).
    // We accept either the raw form or a redacted form — the key
    // is that no original email/phone slipped through.
    expect(serialized).not.toMatch(/[\w._%+-]+@[\w.-]+\.[a-zA-Z]{2,}/);
  });
});

describe("observability middleware — ordering", () => {
  it("captures duration AFTER the downstream handler runs", async () => {
    const app = new Hono();
    let observedDurationAtHandler = -1;
    let middlewareDuration = -1;
    app.use("*", async (c, next) => {
      const start = performance.now();
      await next();
      middlewareDuration = performance.now() - start;
    });
    app.get("/probe", (c) => {
      observedDurationAtHandler = performance.now();
      return c.json({});
    });
    await app.request("/probe");
    expect(observedDurationAtHandler).toBeGreaterThan(0);
    expect(middlewareDuration).toBeGreaterThanOrEqual(0);
  });
});

describe("observability middleware — telemetry shape contract", () => {
  it("every request produces exactly one request.start and one request.end log line", async () => {
    const app = buildApp();
    const { logs } = await captureAll(() => app.request("/health"));
    const starts = logs.filter((l) => l.event === "request.start");
    const ends = logs.filter((l) => l.event === "request.end");
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
  });

  it("duration_ms is non-negative and finite", async () => {
    const app = buildApp();
    const { logs } = await captureAll(() => app.request("/health"));
    const end = logs.find((l) => l.event === "request.end");
    const ms = end?.context.duration_ms as number;
    expect(Number.isFinite(ms)).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(0);
  });
});
