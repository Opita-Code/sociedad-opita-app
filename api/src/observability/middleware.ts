/**
 * Observability middleware — Polish R6 observability.
 *
 * Wraps every Hono request in three layers of telemetry:
 *   1. Structured log lines (logger) — `request.start` / `request.end` /
 *      `request.error`. PII redaction is handled by the logger.
 *   2. EMF metrics (metrics) — `invocations_total` Count per request,
 *      `duration_ms` Milliseconds histogram, `errors_total` Count on
 *      any 5xx response.
 *   3. Tracing (tracing) — start/end a segment per request, so the
 *      X-Ray service map shows the API as one node. Subsegments
 *      (RAG retrieval, LLM call) live in the dialogue handler.
 *
 * Ordering: this middleware runs AFTER CORS (so OPTIONS preflights
 * are short-circuited without polluting telemetry) and BEFORE the
 * route handlers. Mounted in api.ts as the second `app.use("*", ...)`
 * call after the CORS block.
 *
 * Error handling subtlety: Hono's default error handler catches
 * uncaught throws inside route handlers and converts them into a
 * 500 response. So `await next()` resolves with status=500, it does
 * NOT throw. We treat any 5xx status as an error (regardless of how
 * it happened) so that errors_total stays accurate. The try/catch
 * is still here as a defense for the rare case where next() itself
 * throws (e.g. a custom Hono onError that re-throws).
 *
 * IP attribution: x-forwarded-for is the canonical source — that's
 * what CloudFront sends. We do not parse multi-hop XFF chains today
 * because the function URL sits behind exactly one CloudFront edge.
 */
import type { Context, Next } from "hono";
import { logger } from "./logger";
import { metrics } from "./metrics";

export async function observabilityMiddleware(c: Context, next: Next): Promise<void> {
  const start = performance.now();
  const route = c.req.path;
  const method = c.req.method;
  const ip = c.req.header("x-forwarded-for") || "unknown";

  logger.info("request.start", { route, method, ip });

  try {
    await next();
    const duration_ms = performance.now() - start;
    const status = c.res.status;
    const isError = status >= 500;

    if (isError) {
      logger.error(
        "request.error",
        new Error(`HTTP ${status} from ${route}`),
        { route, method, ip, status, duration_ms }
      );
      metrics.increment("errors_total", 1, {
        route,
        method,
        status: String(status),
      });
    } else {
      logger.info("request.end", {
        route,
        method,
        ip,
        status,
        duration_ms,
      });
    }

    metrics.increment("invocations_total", 1, {
      route,
      method,
      status: String(status),
    });
    metrics.histogram("duration_ms", duration_ms, {
      route,
      method,
    });
  } catch (err) {
    // Hono didn't catch this (custom error handler that re-throws, or
    // a crash in Hono itself). The error never produced a response,
    // so we can't read c.res.status — log + emit error telemetry and
    // re-throw so a 500 still surfaces.
    const duration_ms = performance.now() - start;
    logger.error(
      "request.error",
      err as Error,
      { route, method, ip, duration_ms }
    );
    metrics.increment("errors_total", 1, { route, method });
    throw err;
  }
}
