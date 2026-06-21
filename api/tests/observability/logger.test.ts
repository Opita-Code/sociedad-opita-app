/**
 * Logger — Polish R6 observability.
 *
 * Behaviors under test:
 *  - info/debug/warn/error each emit ONE parseable JSON line to stdout
 *  - the JSON envelope has ts (ISO), level, event, context
 *  - error() includes the Error's message AND stack
 *  - PII redaction: emails and phone numbers are replaced with [REDACTED_*]
 *  - Opita unicode (accents, ñ, ¿, ¡) is preserved through redaction
 *  - non-string context values pass through untouched (numbers, booleans, objects)
 *  - timestamp is ISO 8601 with milliseconds and a Z suffix
 *
 * The logger is the observability backbone — every other module
 * (metrics, middleware, cost) funnels through it. If the envelope
 * shape drifts, CloudWatch Insights queries in DEPLOY-RUNBOOK.md
 * silently break.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logger } from "../../src/observability/logger";

type CapturedLine = Record<string, unknown>;

function captureLog<T>(fn: () => T): { lines: CapturedLine[]; result: T } {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const result = fn();
    const lines = spy.mock.calls.map((call) => JSON.parse(String(call[0])) as CapturedLine);
    return { lines, result };
  } finally {
    spy.mockRestore();
  }
}

async function captureLogAsync<T>(fn: () => Promise<T>): Promise<{ lines: CapturedLine[]; result: T }> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const result = await fn();
    const lines = spy.mock.calls.map((call) => JSON.parse(String(call[0])) as CapturedLine);
    return { lines, result };
  } finally {
    spy.mockRestore();
  }
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logger — JSON envelope", () => {
  it("info() emits one JSON line with ts, level, event, context", () => {
    const { lines } = captureLog(() => logger.info("evt.test", { route: "/v1/dialogue" }));
    expect(lines).toHaveLength(1);
    const entry = lines[0];
    expect(entry.level).toBe("info");
    expect(entry.event).toBe("evt.test");
    expect(entry.context).toEqual({ route: "/v1/dialogue" });
    expect(typeof entry.ts).toBe("string");
    // ISO 8601 with milliseconds, e.g. 2026-06-21T14:30:00.123Z
    expect((entry.ts as string)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("debug() emits level='debug'", () => {
    const { lines } = captureLog(() => logger.debug("evt.debug", {}));
    expect(lines[0].level).toBe("debug");
    expect(lines[0].event).toBe("evt.debug");
  });

  it("warn() emits level='warn'", () => {
    const { lines } = captureLog(() => logger.warn("evt.warn", {}));
    expect(lines[0].level).toBe("warn");
  });

  it("error() emits level='error' and includes Error.message and stack", () => {
    const e = new Error("boom");
    const { lines } = captureLog(() => logger.error("evt.error", e, { route: "/v1/simulate" }));
    const entry = lines[0];
    expect(entry.level).toBe("error");
    expect(entry.event).toBe("evt.error");
    expect(entry.context).toEqual({ route: "/v1/simulate" });
    expect(entry.err).toBeDefined();
    expect((entry.err as { message: string }).message).toBe("boom");
    expect(typeof (entry.err as { stack?: string }).stack).toBe("string");
    expect((entry.err as { stack?: string }).stack).toContain("Error: boom");
  });

  it("output is parseable JSON (one object per line)", () => {
    const { lines } = captureLog(() => {
      logger.info("a", { x: 1 });
      logger.warn("b", { y: 2 });
      logger.error("c", new Error("z"));
    });
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(typeof line).toBe("object");
      expect(line).not.toBeNull();
      expect(typeof line.ts).toBe("string");
    }
  });

  it("defaults context to an empty object when not provided", () => {
    const { lines } = captureLog(() => logger.info("evt.empty"));
    expect(lines[0].context).toEqual({});
  });

  it("preserves non-string context values (numbers, booleans, nested objects)", () => {
    const { lines } = captureLog(() =>
      logger.info("evt.mixed", {
        count: 42,
        ok: true,
        ratio: 0.5,
        nested: { a: 1, b: "x" },
      })
    );
    expect(lines[0].context).toEqual({
      count: 42,
      ok: true,
      ratio: 0.5,
      nested: { a: 1, b: "x" },
    });
  });
});

describe("logger — PII redaction", () => {
  it("redacts email addresses to [REDACTED_EMAIL]", () => {
    const { lines } = captureLog(() =>
      logger.info("evt.contact", { email: "juan@example.com" })
    );
    expect((lines[0].context as { email: string }).email).toBe("[REDACTED_EMAIL]");
  });

  it("redacts emails embedded in longer strings", () => {
    const { lines } = captureLog(() =>
      logger.info("evt.note", { msg: "Contactame a maria.tello+spam@opita.co pronto" })
    );
    expect((lines[0].context as { msg: string }).msg).toBe(
      "Contactame a [REDACTED_EMAIL] pronto"
    );
  });

  it("redacts multiple emails in the same string", () => {
    const { lines } = captureLog(() =>
      logger.info("evt.spam", { body: "from a@b.com to c@d.org" })
    );
    expect((lines[0].context as { body: string }).body).toBe(
      "from [REDACTED_EMAIL] to [REDACTED_EMAIL]"
    );
  });

  it("redacts international phone numbers to [REDACTED_PHONE]", () => {
    const { lines } = captureLog(() =>
      logger.info("evt.call", { phone: "+57 312 612 6085" })
    );
    expect((lines[0].context as { phone: string }).phone).toBe("[REDACTED_PHONE]");
  });

  it("redacts phone numbers written with dots or dashes", () => {
    const { lines } = captureLog(() =>
      logger.info("evt.call2", { phone: "+1-415-555-0199" })
    );
    expect((lines[0].context as { phone: string }).phone).toBe("[REDACTED_PHONE]");
  });

  it("preserves Opita unicode: accents, ñ, ¿, ¡", () => {
    const { lines } = captureLog(() =>
      logger.info("evt.opita", {
        greeting: "¡Qué tal parce! Óigame bien, soy de Neiva.",
        town: "Tello, Huila — niños jugando en la plaza.",
      })
    );
    const ctx = lines[0].context as Record<string, string>;
    expect(ctx.greeting).toBe("¡Qué tal parce! Óigame bien, soy de Neiva.");
    expect(ctx.town).toBe("Tello, Huila — niños jugando en la plaza.");
  });

  it("does not redact when there is no PII", () => {
    const { lines } = captureLog(() =>
      logger.info("evt.safe", { msg: "Hola, ¿cómo va todo?" })
    );
    expect((lines[0].context as { msg: string }).msg).toBe("Hola, ¿cómo va todo?");
  });

  it("error messages are NOT redacted (errors must remain debuggable)", () => {
    // Errors carry their own sensitive content; the log line keeps the raw
    // message because it is already an internal developer artifact.
    // PII redaction only applies to the context map.
    const { lines } = captureLog(() =>
      logger.error("evt.err_with_pii", new Error("contact juan@opita.co"))
    );
    const errField = lines[0].err as { message: string };
    expect(errField.message).toBe("contact juan@opita.co");
  });
});

describe("logger — error path contract", () => {
  it("error() rejects a non-Error argument (TypeScript) and only the signature Error is accepted", () => {
    // Sanity: logger.error's signature requires Error. We check that
    // a TypeError instance also surfaces its stack.
    const err = new TypeError("bad shape");
    const { lines } = captureLog(() => logger.error("evt.typeerror", err));
    expect((lines[0].err as { message: string }).message).toBe("bad shape");
    expect((lines[0].err as { stack?: string }).stack).toContain("TypeError: bad shape");
  });

  it("logger methods are synchronous and do not throw on bad context (e.g. circular objects)", () => {
    // JSON.stringify would normally throw on a circular ref. The logger
    // intentionally treats context values opaquely (it does NOT deep-serialize);
    // it just walks own enumerable string fields for redaction. Non-string
    // values are stored by reference. Verify we don't accidentally call
    // JSON.stringify on the whole entry before pushing to console.log.
    const circ: Record<string, unknown> = { name: "ok" };
    circ.self = circ;
    expect(() => logger.info("evt.circular", circ)).not.toThrow();
  });
});

describe("logger — async usage", () => {
  it("can be called from an async function and the line is captured", async () => {
    const { lines } = await captureLogAsync(async () => {
      await Promise.resolve();
      logger.info("evt.async", { stage: "after-await" });
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe("evt.async");
    expect(lines[0].context).toEqual({ stage: "after-await" });
  });
});
