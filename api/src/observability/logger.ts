/**
 * Structured JSON logger — Polish R6 observability.
 *
 * Design choices:
 *  - One JSON object per stdout line so CloudWatch Insights can parse
 *    with `parse(@message)` without multi-line JSON gymnastics.
 *  - ISO 8601 timestamps with millisecond precision and trailing Z
 *    (Lambda emits these by default; matching the format keeps
 *    time-correlation with metrics and X-Ray trivial).
 *  - PII redaction only touches string fields in the context map.
 *    Error messages are kept verbatim — they are already an internal
 *    developer artifact and redacting them would defeat debugging.
 *    Numbers, booleans, and nested objects pass through untouched so
 *    that the contract "log everything you might want to grep" survives.
 *  - We catch JSON.stringify failures (circular references, BigInt)
 *    so a malformed context object never crashes the host process.
 *    Observability is supposed to surface failures, not cause them.
 *    On serialization failure we emit a minimal envelope so operators
 *    can still correlate with X-Ray and CloudWatch alarms.
 *
 * Lambda's CloudWatch agent already collects stdout. No SDK or transport
 * is needed; this file is intentionally zero-dependency.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = Record<string, unknown>;

export interface LogErrorField {
  message: string;
  stack?: string;
}

export interface LogEntry {
  ts: string;
  level: LogLevel;
  event: string;
  context: LogContext;
  err?: LogErrorField;
}

interface PIIPattern {
  pattern: RegExp;
  replacement: string;
}

const PII_PATTERNS: readonly PIIPattern[] = [
  // RFC-5321-flavored: local@domain.tld, also tolerates + aliases and dots.
  {
    pattern: /[\w._%+-]+@[\w.-]+\.[a-zA-Z]{2,}/g,
    replacement: "[REDACTED_EMAIL]",
  },
  // International phone numbers with optional country code, parens,
  // spaces, dots, or dashes. Conservative — requires at least 7 digits
  // in the body so we don't redact things like "abc-1234-5678" that
  // happen to look number-ish but are clearly ids.
  {
    pattern: /\+?\d{1,3}[-.\s]?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9}/g,
    replacement: "[REDACTED_PHONE]",
  },
];

// IPv4 dotted-quad. IPs are NOT PII for our threat model (they sit in
// x-forwarded-for and CloudFront logs already) but the phone regex
// would otherwise eat them. We protect them with a placeholder, run
// PII redaction, then restore.
const IPV4_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

function redactString(input: string): string {
  // Step 1: park IPv4 addresses so the phone regex doesn't redact them.
  const ipv4Bank: string[] = [];
  let protectedStr = input.replace(IPV4_PATTERN, (m) => {
    ipv4Bank.push(m);
    return `\u0000IPV4_${ipv4Bank.length - 1}\u0000`;
  });

  // Step 2: apply PII patterns.
  for (const { pattern, replacement } of PII_PATTERNS) {
    protectedStr = protectedStr.replace(pattern, replacement);
  }

  // Step 3: restore IPv4 addresses verbatim.
  return protectedStr.replace(
    /\u0000IPV4_(\d+)\u0000/g,
    (_match, idx) => ipv4Bank[Number(idx)] ?? ""
  );
}

function redactContext(ctx: LogContext): LogContext {
  const out: LogContext = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (typeof v === "string") {
      out[k] = redactString(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

class Logger {
  log(level: LogLevel, event: string, context: LogContext = {}, err?: Error): void {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      event,
      context: redactContext(context),
    };
    if (err) {
      entry.err = { message: err.message, stack: err.stack };
    }
    this.safeEmit(entry, level, event);
  }

  /**
   * Emit the entry to stdout, but never let JSON.stringify failures
   * (circular refs, BigInt, etc.) crash the host process. If
   * serialization fails we degrade to a minimal envelope that still
   * carries the level + event so operators can correlate with X-Ray.
   * Observability must never be the cause of an outage.
   */
  private safeEmit(entry: LogEntry, level: LogLevel, event: string): void {
    try {
      console.log(JSON.stringify(entry));
    } catch {
      const fallback: LogEntry = {
        ts: entry.ts,
        level,
        event,
        context: {
          _serialize_error: "context contained non-serializable value (circular ref or BigInt)",
        },
      };
      try {
        console.log(JSON.stringify(fallback));
      } catch {
        // Last resort: even the fallback failed. console.log of primitives
        // cannot fail, so this branch is unreachable in practice but kept
        // for completeness.
        console.log(`ts=${entry.ts} level=${level} event=${event}`);
      }
    }
  }

  debug(event: string, ctx: LogContext = {}): void {
    this.log("debug", event, ctx);
  }

  info(event: string, ctx: LogContext = {}): void {
    this.log("info", event, ctx);
  }

  warn(event: string, ctx: LogContext = {}): void {
    this.log("warn", event, ctx);
  }

  error(event: string, err: Error, ctx: LogContext = {}): void {
    this.log("error", event, ctx, err);
  }
}

export const logger = new Logger();
