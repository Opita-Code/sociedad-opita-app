/**
 * Chaos testing — POST /v1/dialogue.
 *
 * Polish R2 (test expansion). Goal: prove the handler is robust against
 * realistic fuzz input — random persona/scene/query combos, concurrent
 * requests, and stream interruption. We do NOT use a property-based
 * generator here (that's covered by retrieve-property.test.ts); we use
 * deterministic seeded loops so failures are reproducible.
 *
 * Invariants under chaos:
 *   - The handler never returns 5xx for valid input shapes. 4xx only.
 *   - The handler never panics or hangs.
 *   - Concurrent requests all complete (each gets its own SSE stream).
 *   - Stream interruption mid-flight yields a clean `data: {error, message}`
 *     chunk and the response closes — no half-written SSE frames.
 *
 * Any failure here is a real bug — log to engram and surface to operator.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (hoisted) ────────────────────────────────────────────────
const { ocaisStreamMock } = vi.hoisted(() => ({ ocaisStreamMock: vi.fn() }));
vi.mock("../../src/llm/provider", () => ({ ocaisStream: ocaisStreamMock }));

const { embedQueryMock, retrieveMock, loadCorpusFromBufferMock } = vi.hoisted(() => ({
  embedQueryMock: vi.fn(),
  retrieveMock: vi.fn(),
  loadCorpusFromBufferMock: vi.fn(),
}));
vi.mock("../../src/rag/retrieve", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/rag/retrieve")>();
  return {
    ...actual,
    loadCorpusFromBuffer: loadCorpusFromBufferMock,
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

import { TELLO_PERSONAS } from "../../src/personas";
import type { CorpusDoc } from "../../src/rag/types";

let dialogueApp: typeof import("../../src/handlers/dialogue").default;

const VALID_DOC: CorpusDoc = {
  id: "personas__chaos-portrait",
  text: "Chaos test fixture doc.",
  embedding: [0.1, 0.2, 0.3],
  metadata: {
    topic: "test/chaos",
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
  loadCorpusFromBufferMock.mockReset();
  getPersonaStateMock.mockReset();
  appendTurnMock.mockReset();

  loadCorpusFromBufferMock.mockResolvedValue([VALID_DOC]);
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
});

// ── Seeded PRNG (Mulberry32) — reproducible chaos ──────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

const SCENES: Array<{ time: string; place: string; weather?: string }> = [
  { time: "06:00", place: "tienda" },
  { time: "12:30", place: "plaza" },
  { time: "18:45", place: "finca", weather: "lluvioso" },
  { time: "21:00", place: "casa" },
  { time: "08:15", place: "iglesia" },
  { time: "14:00", place: "parque", weather: "soleado" },
  { time: "23:30", place: "carrera" },
  { time: "05:00", place: "trapiche" },
];

const QUERIES = [
  "Hola vecino, ¿cómo amaneció?",
  "¿Qué me recomienda, Doña Rosa?",
  "Mire ve, le cuento que vengo de Neiva",
  "Don Rosalio, ¿cómo cuida la tierra?",
  "Padre Cecilio, ¿qué dice la procesión?",
  "Jhon Fredy, ¿por qué volviste a Tello?",
  "Don Octavio, ¿cómo cura la fiebre?",
  "Don Emigdio, ¿qué tal la cosecha?",
  "Doña Prudencia, ¿me regala un tinto?",
  "asina es la cosa, mijo",
  "Dios proveerá, ¿no?",
  "Qué pueblo tan bonito el de ustedes",
  "no hay nada peor que un mal año",
  "ni modo, aquí toca aguantarse",
  "¿Cómo se llama la iglesia?",
  "¿Cuántas fincas hay en la vereda?",
];

const PERSONAS = TELLO_PERSONAS.map((p) => p.persona_id);

async function postDialogue(body: object, ip: string = "203.0.113.1"): Promise<Response> {
  // Polish R9: each call gets a unique x-forwarded-for IP so the
  // per-IP rate limiter (HIGH #2) doesn't reject the chaos loops
  // after 10 hits. In production, every visitor comes from a
  // distinct source IP; this matches that reality.
  return dialogueApp.request("/v1/dialogue", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify(body),
  });
}

let chaosIpCounter = 0;
function nextChaosIp(): string {
  chaosIpCounter += 1;
  // 198.51.100.0/24 is documentation-reserved (RFC 5737) — safe for tests.
  return `198.51.100.${(chaosIpCounter % 250) + 1}`;
}

function mockHappyStream(text: string = "ok") {
  ocaisStreamMock.mockImplementation(async function* () {
    yield { type: "text", text };
    yield { type: "done", cost: 0.0008 };
  });
}

describe("chaos — random persona/scene/query loops", () => {
  it("100 random valid combinations all return 200 (no 5xx)", async () => {
    const rng = mulberry32(0xc0ffee);
    mockHappyStream();

    let pass = 0;
    let fail = 0;
    const failures: Array<{ persona: string; scene: unknown; query: string; status: number }> = [];

    for (let i = 0; i < 100; i++) {
      const persona_id = pick(rng, PERSONAS);
      const scene = pick(rng, SCENES);
      const query = pick(rng, QUERIES);

      const res = await postDialogue({ persona_id, scene, query }, nextChaosIp());
      if (res.status === 200) {
        pass++;
        await res.text();
      } else {
        fail++;
        failures.push({ persona: persona_id, scene, query, status: res.status });
      }
    }

    // eslint-disable-next-line no-console
    console.log(`chaos-loop: pass=${pass} fail=${fail}`);
    if (failures.length > 0) {
      // eslint-disable-next-line no-console
      console.log("chaos failures:", JSON.stringify(failures.slice(0, 5), null, 2));
    }
    expect(fail).toBe(0);
    expect(pass).toBe(100);
  }, 60_000);

  it("every persona (all 10) responds at least once successfully", async () => {
    mockHappyStream();
    const results: Record<string, number> = {};
    for (const persona_id of PERSONAS) {
      const res = await postDialogue(
        {
          persona_id,
          scene: { time: "06:00", place: "pueblo" },
          query: "Hola",
        },
        nextChaosIp()
      );
      results[persona_id] = res.status;
      await res.text();
    }
    for (const [pid, status] of Object.entries(results)) {
      expect(status, `persona ${pid} returned ${status}`).toBe(200);
    }
  }, 60_000);

  it("every scene (8) responds at least once successfully", async () => {
    mockHappyStream();
    for (const scene of SCENES) {
      const res = await postDialogue(
        {
          persona_id: "dona_rosa_tendera",
          scene,
          query: "Hola",
        },
        nextChaosIp()
      );
      expect(res.status, `scene ${scene.time}/${scene.place}`).toBe(200);
      await res.text();
    }
  }, 60_000);

  it("every canned query (16) responds at least once successfully", async () => {
    mockHappyStream();
    for (const query of QUERIES) {
      const res = await postDialogue(
        {
          persona_id: "dona_rosa_tendera",
          scene: { time: "06:00", place: "pueblo" },
          query,
        },
        nextChaosIp()
      );
      expect(res.status, `query "${query}"`).toBe(200);
      await res.text();
    }
  }, 60_000);
});

describe("chaos — malformed inputs always yield 4xx, never 5xx", () => {
  const badBodies: Array<[string, unknown]> = [
    ["empty object", {}],
    ["array body", []],
    ["string body", "hola"],
    ["number body", 42],
    ["null body", null],
    ["nested wrong types", { persona_id: 42, scene: "tienda", query: "x" }],
    ["scene as string", { persona_id: "dona_rosa_tendera", scene: "tienda", query: "x" }],
    [
      "query as number",
      { persona_id: "dona_rosa_tendera", scene: { time: "06:00", place: "t" }, query: 99 },
    ],
    [
      "persona_id with spaces",
      { persona_id: "dona rosa", scene: { time: "06:00", place: "t" }, query: "x" },
    ],
    [
      "scene.time out of range",
      { persona_id: "dona_rosa_tendera", scene: { time: "25:99", place: "t" }, query: "x" },
    ],
    [
      "scene.place too long",
      {
        persona_id: "dona_rosa_tendera",
        scene: { time: "06:00", place: "x".repeat(201) },
        query: "x",
      },
    ],
    [
      "query empty string",
      { persona_id: "dona_rosa_tendera", scene: { time: "06:00", place: "t" }, query: "" },
    ],
    [
      "query too long",
      {
        persona_id: "dona_rosa_tendera",
        scene: { time: "06:00", place: "t" },
        query: "x".repeat(1001),
      },
    ],
    [
      "unknown persona",
      { persona_id: "inexistente", scene: { time: "06:00", place: "t" }, query: "x" },
    ],
    ["malformed JSON", "{not json"],
  ];

  for (const [label, body] of badBodies) {
    it(`bad input "${label}" returns 4xx (no 5xx)`, async () => {
      const init: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      };
      if (typeof body === "string") {
        init.body = body;
      } else {
        init.body = JSON.stringify(body);
      }
      const res = await dialogueApp.request("/v1/dialogue", init);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      // Drain the body so the stream is consumed.
      await res.text();
    });
  }
});

describe("chaos — concurrent requests", () => {
  it("5 simultaneous requests all complete with 200", async () => {
    mockHappyStream("concurrent");
    const personas = [
      "dona_rosa_tendera",
      "don_rosalio_ganadero",
      "padre_cecilio_sacerdote",
      "dona_prudencia_viuda",
      "jhon_fredy_joven",
    ];
    const requests = personas.map((persona_id) =>
      postDialogue(
        {
          persona_id,
          scene: { time: "06:00", place: "pueblo" },
          query: "Pregunta concurrente",
        },
        nextChaosIp()
      )
    );

    const responses = await Promise.all(requests);
    const statuses = responses.map((r) => r.status);
    expect(statuses).toEqual([200, 200, 200, 200, 200]);

    // Each response should carry its own SSE stream.
    const allChunks = await Promise.all(responses.map((r) => r.text()));
    for (const body of allChunks) {
      expect(body).toMatch(/data: \{/);
      expect(body).toMatch(/data: \{"text":"concurrent"\}/);
    }
  }, 30_000);

  it("10 simultaneous requests don't crash and don't share state", async () => {
    let callCount = 0;
    ocaisStreamMock.mockImplementation(async function* () {
      callCount++;
      yield { type: "text", text: `resp-${callCount}` };
      yield { type: "done", cost: 0.0001 };
    });
    const requests = Array.from({ length: 10 }, (_, i) =>
      postDialogue(
        {
          persona_id: "dona_rosa_tendera",
          scene: { time: "06:00", place: "pueblo" },
          query: `q-${i}`,
        },
        nextChaosIp()
      )
    );
    const responses = await Promise.all(requests);
    for (const r of responses) {
      expect(r.status).toBe(200);
    }
    const bodies = await Promise.all(responses.map((r) => r.text()));
    // Each response should carry its own incrementing resp-N text.
    for (const body of bodies) {
      expect(body).toMatch(/data: \{"text":"resp-\d+"\}/);
    }
  }, 30_000);
});

describe("chaos — stream interruption mid-flight", () => {
  it("graceful error chunk when OCAIS throws mid-stream", async () => {
    ocaisStreamMock.mockImplementationOnce(async function* () {
      yield { type: "text", text: "Empezando... " };
      // Simulate a mid-flight network/timeout failure.
      throw new Error("stream aborted");
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
    const text = await res.text();
    // The stream must contain the partial text + a graceful error chunk.
    expect(text).toContain('"text":"Empezando... "');
    expect(text).toContain('"error":"stream_error"');
    expect(text).toContain('"message":"stream aborted"');
  });

  // Polish R9 (BUG #1 fix): the handler's for-await loop now uses a
  // try/finally to call controller.close() on every exit path
  // (success, error, or yield of an unknown chunk). Previously, when
  // OCAIS yielded a non-"text"/non-"done" chunk and then returned, the
  // SSE stream stayed open and the client hung.
  it(
    "controller.close() called when OCAIS yields an unknown chunk type",
    { timeout: 3000 },
    async () => {
      ocaisStreamMock.mockImplementationOnce(async function* () {
        yield { type: "text", text: "ok " };
        yield { type: "weird_future_type" as "text", payload: "???" } as never;
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

      const readPromise = res.text();
      const timeoutPromise = new Promise<string>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                "STREAM HUNG — known bug: handler does not close SSE controller after for-await loop returns without a 'done' chunk"
              )
            ),
          1000
        )
      );

      const text = await Promise.race([readPromise, timeoutPromise]);
      expect(text).toContain('"text":"ok "');
    }
  );

  it(
    "controller.close() called even on partial stream (text-only, no done chunk)",
    { timeout: 3000 },
    async () => {
      // Stream yields one text chunk and ends without a "done" envelope.
      // The handler must still close the controller — otherwise the client hangs.
      ocaisStreamMock.mockImplementationOnce(async function* () {
        yield { type: "text", text: "partial answer" };
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

      const readPromise = res.text();
      const timeoutPromise = new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("STREAM HUNG on partial text-only stream")), 1000)
      );
      const text = await Promise.race([readPromise, timeoutPromise]);
      expect(text).toContain('"text":"partial answer"');
    }
  );

  it(
    "controller.close() called after done chunk is yielded (normal happy path)",
    { timeout: 3000 },
    async () => {
      // The happy path: text chunk + done chunk. The controller should be
      // closed after the done envelope is enqueued (and try/finally must
      // not enqueue a second close or error on the already-closed stream).
      ocaisStreamMock.mockImplementationOnce(async function* () {
        yield { type: "text", text: "buenos dias" };
        yield { type: "done", cost: 0.0001 };
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
      const text = await res.text();
      expect(text).toContain('"text":"buenos dias"');
      expect(text).toContain('"cost":');
    }
  );

  it("graceful degradation when getPersonaState throws on every request", async () => {
    getPersonaStateMock.mockRejectedValue(new Error("DDB down"));
    mockHappyStream();
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
  });

  it("graceful degradation when appendTurn throws on every request", async () => {
    appendTurnMock.mockRejectedValue(new Error("DDB write down"));
    mockHappyStream();
    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        persona_id: "dona_rosa_tendera",
        scene: { time: "06:00", place: "pueblo" },
        query: "Hola",
        conv_id: "conv-broken",
      }),
    });
    expect(res.status).toBe(200);
    await res.text();
    // Give the best-effort appendTurn a tick to resolve.
    await new Promise((r) => setTimeout(r, 10));
  });
});
