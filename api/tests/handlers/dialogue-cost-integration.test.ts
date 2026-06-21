/**
 * Cost + rate-limit integration — POST /v1/dialogue.
 *
 * Polish R9 (HIGH #2): the dialogue handler is now wired into the
 * observability cost tracker (so every LLM invocation emits a structured
 * `cost.recorded` log + `cost_usd` histogram) and the per-IP token
 * bucket (so abusive visitors are rate-limited with 429 Too Many Requests
 * before any LLM call is made).
 *
 * Test contract:
 *   - cost.recordInvocation() is called once per successful stream,
 *     with model + tokens_out estimated from the accumulated text
 *   - TokenBucket.tryConsume() is called once at the top of the handler,
 *     with the IP from the x-forwarded-for header
 *   - When the bucket returns false, the handler returns 429 and does
 *     NOT call the LLM
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (hoisted) ────────────────────────────────────────────────
const { ocaisStreamMock } = vi.hoisted(() => ({ ocaisStreamMock: vi.fn() }));
vi.mock("../../src/llm/provider", () => ({ ocaisStream: ocaisStreamMock }));

const { embedQueryMock, retrieveMock, loadCorpusMock } = vi.hoisted(() => ({
  embedQueryMock: vi.fn(),
  retrieveMock: vi.fn(),
  loadCorpusMock: vi.fn(),
}));
vi.mock("../../src/rag/retrieve", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/rag/retrieve")>();
  return {
    ...actual,
    loadCorpus: loadCorpusMock,
    retrieve: retrieveMock,
  };
});
vi.mock("../../src/rag/embed-query", () => ({ embedQuery: embedQueryMock }));

const { getPersonaStateMock, appendTurnMock } = vi.hoisted(() => ({
  getPersonaStateMock: vi.fn(),
  appendTurnMock: vi.fn(),
}));
vi.mock("../../src/state/persona-state", () => ({
  getPersonaState: getPersonaStateMock,
}));
vi.mock("../../src/state/conversation", () => ({
  appendTurn: appendTurnMock,
  getConversation: vi.fn(),
}));

// Mock the observability cost surface — we want to assert that
// recordInvocation() is called with the right shape, without depending
// on the internal cost math.
const { costRecordInvocationMock } = vi.hoisted(() => ({
  costRecordInvocationMock: vi.fn(),
}));
vi.mock("../../src/observability/cost", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/observability/cost")>();
  return {
    ...actual,
    cost: {
      ...actual.cost,
      recordInvocation: costRecordInvocationMock,
    },
  };
});

// Mock the rate limiter surface — we want to flip tryConsume() to true
// or false depending on the test, without depending on real wall time.
const { tokenBucketTryConsumeMock, tokenBucketResetMock } = vi.hoisted(() => ({
  tokenBucketTryConsumeMock: vi.fn(),
  tokenBucketResetMock: vi.fn(),
}));
vi.mock("../../src/llm/rate-limiter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/llm/rate-limiter")>();
  return {
    ...actual,
    getDialogueRateLimiter: () => ({
      tryConsume: tokenBucketTryConsumeMock,
      reset: tokenBucketResetMock,
    }),
  };
});

import { TELLO_PERSONAS } from "../../src/personas";
import type { CorpusDoc } from "../../src/rag/types";

let dialogueApp: typeof import("../../src/handlers/dialogue").default;

const VALID_DOC: CorpusDoc = {
  id: "personas__cost-rate",
  text: "Cost/rate integration fixture doc.",
  embedding: [0.1, 0.2, 0.3],
  metadata: {
    topic: "test/cost",
    personas: [],
    license: "CC-BY-4.0",
    tier: "free",
    language: "es",
  },
};

beforeEach(async () => {
  vi.resetModules();
  const mod = await import("../../src/handlers/dialogue");
  dialogueApp = mod.default;

  ocaisStreamMock.mockReset();
  embedQueryMock.mockReset();
  retrieveMock.mockReset();
  loadCorpusMock.mockReset();
  getPersonaStateMock.mockReset();
  appendTurnMock.mockReset();
  costRecordInvocationMock.mockReset();
  tokenBucketTryConsumeMock.mockReset();
  tokenBucketResetMock.mockReset();

  loadCorpusMock.mockResolvedValue([VALID_DOC]);
  embedQueryMock.mockResolvedValue(new Float32Array([0.1, 0.2, 0.3]));
  retrieveMock.mockReturnValue([{ doc: VALID_DOC, score: 0.91 }]);
  getPersonaStateMock.mockResolvedValue({
    personaId: "any",
    emotionalState: "neutral",
    recentEvents: [],
    lastSeen: "1970-01-01T00:00:00Z",
    networkPosition: { betweenness: 0, degree: 0 },
  });
  appendTurnMock.mockResolvedValue(undefined);
  costRecordInvocationMock.mockReturnValue(undefined);
  // Default: bucket allows the request.
  tokenBucketTryConsumeMock.mockReturnValue(true);
});

function mockStream(text: string) {
  ocaisStreamMock.mockImplementation(async function* () {
    yield { type: "text", text };
    yield { type: "done", cost: 0.0001 };
  });
}

describe("Polish R9 — cost.recordInvocation() integration", () => {
  it("calls cost.recordInvocation() once per successful stream", async () => {
    mockStream("buenos dias vecino");
    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        persona_id: "dona_rosa_tendera",
        scene: { time: "06:00", place: "pueblo" },
        query: "Hola",
      }),
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(costRecordInvocationMock).toHaveBeenCalledTimes(1);
  });

  it("passes model + tokens_out estimated from the full text", async () => {
    // 40 chars of text → ceil(40/4) = 10 tokens_out.
    const text = "a".repeat(40);
    mockStream(text);
    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        persona_id: "dona_rosa_tendera",
        scene: { time: "06:00", place: "pueblo" },
        query: "Hola",
      }),
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(costRecordInvocationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "deepseek-chat",
        tokens_out: 10,
      }),
    );
  });

  it("threads conv_id and persona_id into the cost record", async () => {
    mockStream("hola");
    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        persona_id: "dona_rosa_tendera",
        scene: { time: "06:00", place: "pueblo" },
        query: "Hola",
        conv_id: "conv-cost-1",
      }),
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(costRecordInvocationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conv_id: "conv-cost-1",
        persona_id: "dona_rosa_tendera",
      }),
    );
  });

  it("does NOT call cost.recordInvocation() when the stream emits zero text (aborted)", async () => {
    ocaisStreamMock.mockImplementationOnce(async function* () {
      // Yield nothing, then end. Token count is 0; the cost tracker
      // skips zero-cost rows by design, so the handler should also
      // skip the call to keep behavior consistent.
      // eslint-disable-next-line no-empty
    });
    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        persona_id: "dona_rosa_tendera",
        scene: { time: "06:00", place: "pueblo" },
        query: "Hola",
      }),
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(costRecordInvocationMock).not.toHaveBeenCalled();
  });
});

describe("Polish R9 — TokenBucket.tryConsume() rate limit", () => {
  it("calls tryConsume() at the start of every request with the x-forwarded-for IP", async () => {
    mockStream("ok");
    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "203.0.113.42",
      },
      body: JSON.stringify({
        persona_id: "dona_rosa_tendera",
        scene: { time: "06:00", place: "pueblo" },
        query: "Hola",
      }),
    });
    expect(res.status).toBe(200);
    expect(tokenBucketTryConsumeMock).toHaveBeenCalledWith("203.0.113.42");
  });

  it("returns 429 Too Many Requests when tryConsume() returns false", async () => {
    tokenBucketTryConsumeMock.mockReturnValue(false);
    mockStream("ok");
    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "198.51.100.7",
      },
      body: JSON.stringify({
        persona_id: "dona_rosa_tendera",
        scene: { time: "06:00", place: "pueblo" },
        query: "Hola",
      }),
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; retry_after_s?: number };
    expect(body.error).toBe("rate_limited");
    expect(typeof body.retry_after_s).toBe("number");
    expect(body.retry_after_s).toBeGreaterThan(0);
  });

  it("does NOT call OCAIS when the rate limit is exceeded", async () => {
    tokenBucketTryConsumeMock.mockReturnValue(false);
    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "198.51.100.7",
      },
      body: JSON.stringify({
        persona_id: "dona_rosa_tendera",
        scene: { time: "06:00", place: "pueblo" },
        query: "Hola",
      }),
    });
    expect(res.status).toBe(429);
    // The LLM stream must never have been invoked.
    expect(ocaisStreamMock).not.toHaveBeenCalled();
    // And no cost record.
    expect(costRecordInvocationMock).not.toHaveBeenCalled();
  });

  it("falls back to 'unknown' IP when x-forwarded-for is missing", async () => {
    mockStream("ok");
    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        persona_id: "dona_rosa_tendera",
        scene: { time: "06:00", place: "pueblo" },
        query: "Hola",
      }),
    });
    expect(res.status).toBe(200);
    expect(tokenBucketTryConsumeMock).toHaveBeenCalledWith("unknown");
  });

  it("rate limit applies BEFORE validation (cheapest first)", async () => {
    // Even an obviously bad body should be blocked by the rate limit
    // if the bucket says so. The bucket check is the first thing the
    // handler does — before JSON parsing — so it is also a cheap
    // defense against request-flooding bots sending malformed bodies.
    tokenBucketTryConsumeMock.mockReturnValue(false);
    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "198.51.100.7",
      },
      body: "{not json",
    });
    expect(res.status).toBe(429);
  });
});

// Sanity: the rate-limiter mock must be invoked for every persona in
// the corpus (per the existing chaos test), to confirm we don't
// accidentally wire the bucket only for one persona.
describe("Polish R9 — rate limit applies across all personas", () => {
  it("every persona hits the bucket exactly once per request", async () => {
    mockStream("ok");
    const personas = TELLO_PERSONAS.slice(0, 3).map((p) => p.persona_id);
    for (const persona_id of personas) {
      const res = await dialogueApp.request("/v1/dialogue", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": "203.0.113.1",
        },
        body: JSON.stringify({
          persona_id,
          scene: { time: "06:00", place: "pueblo" },
          query: "Hola",
        }),
      });
      expect(res.status).toBe(200);
      await res.text();
    }
    expect(tokenBucketTryConsumeMock).toHaveBeenCalledTimes(personas.length);
  });
});
