/**
 * Dialogue handler — POST /v1/dialogue
 *
 * Behaviors under test (strict TDD):
 *  - Valid request → 200 with text/event-stream and SSE data chunks
 *  - SSE format: `data: {"text": "..."}\n\n` and `data: {"cost": ..., "latency": 0}\n\n`
 *  - Final chunk is the cost/latency envelope
 *  - Invalid persona_id → 404 with { error: "persona_not_found", persona_id }
 *  - Missing required fields (persona_id, scene, query) → 400
 *  - Invalid JSON body → 400 with { error: "invalid_json" }
 *  - Empty topK (no corpus / no matches) → still works
 *  - Conversation turn persisted best-effort (no 500 if DDB fails)
 *
 * The handler composition is:
 *   1. Parse + validate body
 *   2. Load persona from TELLO_PERSONAS
 *   3. Load corpus, embed query, retrieve top-k
 *   4. Build context (persona + scene + RAG + query)
 *   5. Stream OCAIS chunks to SSE
 *   6. Persist conversation turn if conv_id given (best effort)
 *
 * Tests mock the OCAIS stream, the RAG retrieve, the corpus loader, the
 * embed-query function, and the state-store appendTurn so we can exercise
 * the full handler without any external service.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (hoisted by vitest) ──────────────────────────────────────
const { ocaisStreamMock } = vi.hoisted(() => ({
  ocaisStreamMock: vi.fn(),
}));

vi.mock("../../src/llm/provider", () => ({
  ocaisStream: ocaisStreamMock,
}));

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

vi.mock("../../src/rag/embed-query", () => ({
  embedQuery: embedQueryMock,
}));

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

// The handler module caches the corpus at module load. We re-import it
// in beforeEach via vi.resetModules() so each test sees a fresh cache.
let dialogueApp: typeof import("../../src/handlers/dialogue").default;
import type { CorpusDoc } from "../../src/rag/types";

const VALID_DOC: CorpusDoc = {
  id: "personas__dona-rosa-portrait",
  text: "Doña Rosa Elvira, tendera fiadera del pueblo.",
  embedding: [0.1, 0.2, 0.3],
  metadata: {
    topic: "personas/dona-rosa",
    personas: ["dona_rosa_tendera"],
    license: "CC-BY-4.0",
    tier: "free",
    language: "es",
  },
};

const VALID_BODY = {
  persona_id: "dona_rosa_tendera",
  scene: { time: "06:00", place: "tienda" },
  query: "¿Qué me recomienda, Doña Rosa?",
};

beforeEach(async () => {
  // Reset module registry so each test gets a fresh `corpusCache` singleton.
  vi.resetModules();
  const mod = await import("../../src/handlers/dialogue");
  dialogueApp = mod.default;

  ocaisStreamMock.mockReset();
  embedQueryMock.mockReset();
  retrieveMock.mockReset();
  loadCorpusMock.mockReset();
  getPersonaStateMock.mockReset();
  appendTurnMock.mockReset();

  // Default happy-path mocks
  loadCorpusMock.mockResolvedValue([VALID_DOC]);
  embedQueryMock.mockResolvedValue(new Float32Array([0.1, 0.2, 0.3]));
  retrieveMock.mockReturnValue([
    { doc: VALID_DOC, score: 0.91 },
  ]);
  getPersonaStateMock.mockResolvedValue({
    personaId: "dona_rosa_tendera",
    emotionalState: "neutral",
    recentEvents: [],
    lastSeen: "1970-01-01T00:00:00Z",
    networkPosition: { betweenness: 0, degree: 0 },
  });
  appendTurnMock.mockResolvedValue(undefined);
});

async function readSseChunks(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice("data: ".length)) as Record<string, unknown>);
}

describe("POST /v1/dialogue — happy path", () => {
  it("returns 200 with text/event-stream content-type", async () => {
    ocaisStreamMock.mockImplementationOnce(async function* () {
      yield { type: "text", text: "Hola" };
      yield { type: "done", cost: 0.001 };
    });

    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/event-stream/);
  });

  it("returns SSE chunks in order: text -> ... -> done with cost", async () => {
    ocaisStreamMock.mockImplementationOnce(async function* () {
      yield { type: "text", text: "Hola " };
      yield { type: "text", text: "vecino" };
      yield { type: "done", cost: 0.0021 };
    });

    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });

    const chunks = await readSseChunks(res);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ text: "Hola " });
    expect(chunks[1]).toEqual({ text: "vecino" });
    expect(chunks[2]).toHaveProperty("cost");
    expect(typeof (chunks[2] as { cost: number }).cost).toBe("number");
    expect((chunks[2] as { cost: number }).cost).toBeGreaterThan(0);
  });

  it("emits text chunks with verbatim payload (not escaped twice)", async () => {
    ocaisStreamMock.mockImplementationOnce(async function* () {
      yield { type: "text", text: 'Con "comillas" y \\backslash' };
      yield { type: "done", cost: 0.001 };
    });

    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });

    const chunks = await readSseChunks(res);
    const textChunk = chunks[0] as { text: string };
    expect(textChunk.text).toBe('Con "comillas" y \\backslash');
  });

  it("sets Cache-Control: no-cache and Connection: keep-alive for SSE", async () => {
    ocaisStreamMock.mockImplementationOnce(async function* () {
      yield { type: "text", text: "x" };
      yield { type: "done", cost: 0.001 };
    });

    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("Connection")).toBe("keep-alive");
  });
});

describe("POST /v1/dialogue — input validation", () => {
  it("returns 404 for unknown persona_id", async () => {
    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        persona_id: "inexistente",
        scene: { time: "06:00", place: "tienda" },
        query: "hola",
      }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; persona_id: string };
    expect(body.error).toBe("persona_not_found");
    expect(body.persona_id).toBe("inexistente");
  });

  it("returns 400 when persona_id is missing", async () => {
    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scene: { time: "06:00", place: "tienda" },
        query: "hola",
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; required: string[] };
    expect(body.error).toBe("missing_required_fields");
    expect(body.required).toEqual(expect.arrayContaining(["persona_id", "scene", "query"]));
  });

  it("returns 400 when query is missing", async () => {
    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        persona_id: "dona_rosa_tendera",
        scene: { time: "06:00", place: "tienda" },
      }),
    });

    expect(res.status).toBe(400);
  });

  it("returns 400 when scene is missing", async () => {
    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        persona_id: "dona_rosa_tendera",
        query: "hola",
      }),
    });

    expect(res.status).toBe(400);
  });

  it("returns 400 with error: 'invalid_json' on malformed body", async () => {
    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_json");
  });
});

describe("POST /v1/dialogue — RAG pipeline", () => {
  it("loads corpus exactly once (cached across calls)", async () => {
    ocaisStreamMock.mockImplementation(async function* () {
      yield { type: "text", text: "ok" };
      yield { type: "done", cost: 0.001 };
    });

    const r1 = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    await r1.text();

    const r2 = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...VALID_BODY, query: "otra pregunta" }),
    });
    await r2.text();

    expect(loadCorpusMock).toHaveBeenCalledTimes(1);
  });

  it("embeds the user query exactly once per request", async () => {
    ocaisStreamMock.mockImplementation(async function* () {
      yield { type: "text", text: "ok" };
      yield { type: "done", cost: 0.001 };
    });

    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    await res.text();

    expect(embedQueryMock).toHaveBeenCalledTimes(1);
    expect(embedQueryMock).toHaveBeenCalledWith(VALID_BODY.query);
  });

  it("retrieves top-k with the query embedding against the loaded corpus", async () => {
    ocaisStreamMock.mockImplementation(async function* () {
      yield { type: "text", text: "ok" };
      yield { type: "done", cost: 0.001 };
    });

    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    await res.text();

    expect(retrieveMock).toHaveBeenCalledTimes(1);
    const [qEmb, corpus, k] = retrieveMock.mock.calls[0] as [
      Float32Array,
      CorpusDoc[],
      number,
    ];
    expect(qEmb).toBeInstanceOf(Float32Array);
    expect(corpus).toEqual([VALID_DOC]);
    expect(k).toBe(4);
  });

  it("still works when RAG returns empty (no corpus matches)", async () => {
    retrieveMock.mockReturnValueOnce([]);
    ocaisStreamMock.mockImplementationOnce(async function* () {
      yield { type: "text", text: "sin contexto" };
      yield { type: "done", cost: 0.001 };
    });

    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(200);
    const chunks = await readSseChunks(res);
    expect(chunks.length).toBe(2);
  });

  it("builds the system prompt with persona + RAG context (verified via ocaisStream call)", async () => {
    ocaisStreamMock.mockImplementationOnce(async function* () {
      yield { type: "text", text: "ok" };
      yield { type: "done", cost: 0.001 };
    });

    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    await res.text();

    expect(ocaisStreamMock).toHaveBeenCalledTimes(1);
    const call = ocaisStreamMock.mock.calls[0]![0] as { system: string; user: string };
    expect(call.system).toContain("Doña Rosa Elvira");
    expect(call.system).toContain("tendera");
    expect(call.system).toContain("mira ve");
    expect(call.system).toContain("Contexto del pueblo");
    expect(call.system).toContain("personas__dona-rosa-portrait");
    expect(call.user).toContain("Escena: 06:00 en tienda");
    expect(call.user).toContain(VALID_BODY.query);
  });
});

describe("POST /v1/dialogue — conversation persistence (best-effort)", () => {
  it("persists both user + persona turns when conv_id is provided", async () => {
    ocaisStreamMock.mockImplementationOnce(async function* () {
      yield { type: "text", text: "Hola" };
      yield { type: "text", text: " vecino" };
      yield { type: "done", cost: 0.001 };
    });

    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...VALID_BODY, conv_id: "conv-abc" }),
    });
    await res.text();

    // Give the best-effort appendTurn a tick to resolve.
    await new Promise((r) => setTimeout(r, 5));

    expect(appendTurnMock).toHaveBeenCalledTimes(2);
    const calls = appendTurnMock.mock.calls.map((c) => c[0]) as Array<{
      convId: string;
      role: string;
      content: string;
      personaId?: string;
    }>;
    const personaTurn = calls.find((c) => c.role === "persona");
    const userTurn = calls.find((c) => c.role === "user");
    expect(personaTurn).toBeDefined();
    expect(personaTurn!.convId).toBe("conv-abc");
    expect(personaTurn!.personaId).toBe("dona_rosa_tendera");
    expect(personaTurn!.content).toBe("Hola vecino");
    expect(userTurn!.convId).toBe("conv-abc");
    expect(userTurn!.content).toBe(VALID_BODY.query);
  });

  it("does NOT persist when conv_id is absent", async () => {
    ocaisStreamMock.mockImplementationOnce(async function* () {
      yield { type: "text", text: "ok" };
      yield { type: "done", cost: 0.001 };
    });

    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    await res.text();

    await new Promise((r) => setTimeout(r, 5));
    expect(appendTurnMock).not.toHaveBeenCalled();
  });

  it("does NOT fail the response when appendTurn throws (best-effort)", async () => {
    appendTurnMock.mockRejectedValue(new Error("DDB down"));
    ocaisStreamMock.mockImplementationOnce(async function* () {
      yield { type: "text", text: "ok" };
      yield { type: "done", cost: 0.001 };
    });

    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...VALID_BODY, conv_id: "conv-doomed" }),
    });

    expect(res.status).toBe(200);
    await res.text();
  });

  it("does NOT fail the response when getPersonaState throws (best-effort)", async () => {
    getPersonaStateMock.mockRejectedValue(new Error("DDB read fail"));
    ocaisStreamMock.mockImplementationOnce(async function* () {
      yield { type: "text", text: "ok" };
      yield { type: "done", cost: 0.001 };
    });

    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(200);
    await res.text();
  });
});

describe("POST /v1/dialogue — internal error handling", () => {
  it("returns 500 with error: 'internal_error' when corpus load fails", async () => {
    loadCorpusMock.mockRejectedValueOnce(new Error("disk fail"));

    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("internal_error");
    expect(body.message).toContain("disk fail");
  });
});
