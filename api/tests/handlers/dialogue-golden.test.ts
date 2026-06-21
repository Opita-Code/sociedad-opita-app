/**
 * Golden queries integration test — POST /v1/dialogue
 *
 * The spec (REQ-2.1, REQ-2.2, REQ-2.3) demands that for canonical visitor
 * questions, the dialogue handler:
 *
 *   1. Validates the persona_id (404 on unknown)
 *   2. Embeds the query
 *   3. Retrieves top-k=4 RAG docs in the BGE-M3 multilingual space
 *   4. Composes a system prompt that includes persona identity + RAG context
 *   5. Streams a persona-consistent response via OCAIS
 *
 * This test mocks OCAIS (no real LLM call) and verifies that:
 *   - the right persona is selected,
 *   - the right muletilla-bearing system prompt is built,
 *   - the response stream emits text + cost chunks in spec order.
 *
 * The 4 canonical queries mirror the cross-persona + topic + spatial test
 * cases from the spec's golden-query list. We do NOT exercise real BGE-M3
 * here (that lives in rag/retrieve-golden.test.ts) — the goal of THIS test
 * is to lock down the dialogue composition, not the retrieval quality.
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

// ── Imports under test (re-imported per test for cache isolation) ──
import type { CorpusDoc } from "../../src/rag/types";

let dialogueApp: typeof import("../../src/handlers/dialogue").default;

function doc(id: string, text: string, topic: string, personas: string[]): CorpusDoc {
  return {
    id,
    text,
    embedding: [],
    metadata: { topic, personas, license: "CC-BY-4.0", tier: "free", language: "es" },
  };
}

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

  loadCorpusMock.mockResolvedValue([
    doc("dona-rosa-portrait", "Doña Rosa Elvira, tendera fiadera del pueblo.", "personas/dona-rosa", ["dona_rosa_tendera"]),
    doc("don-rosalio-portrait", "Don Rosalio, ganadero propietario del pueblo.", "personas/don-rosalio", ["don_rosalio_ganadero"]),
    doc("padre-cecilio-portrait", "Padre Cecilio, parroco del pueblo.", "personas/padre-cecilio", ["padre_cecilio_sacerdote"]),
    doc("iglesia-san-antonio", "Iglesia San Antonio de Tello.", "iglesia", ["padre_cecilio_sacerdote"]),
    doc("masacre-puente", "Masacre del Puente de los Decapitados, 1950.", "historia/masacre-1950", []),
  ]);
  embedQueryMock.mockResolvedValue(new Float32Array([0.5, 0.5, 0.5]));
  retrieveMock.mockImplementation(
    (_q: Float32Array, corpus: CorpusDoc[], k: number) =>
      corpus.slice(0, k).map((d, i) => ({ doc: d, score: 0.9 - i * 0.05 })),
  );
  getPersonaStateMock.mockResolvedValue({
    personaId: "dona_rosa_tendera",
    emotionalState: "neutral",
    recentEvents: [],
    lastSeen: "1970-01-01T00:00:00Z",
    networkPosition: { betweenness: 0, degree: 0 },
  });
  appendTurnMock.mockResolvedValue(undefined);
});

async function sseChunks(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice("data: ".length)) as Record<string, unknown>);
}

describe("golden query 1 — Don Rosalío ganadero binding", () => {
  it("returns 200 SSE with Don Rosalío persona in system prompt", async () => {
    ocaisStreamMock.mockImplementationOnce(async function* () {
      yield {
        type: "text",
        text: "Asina es la cosa, mijo: la tierra no se negocia, se hereda.",
      };
      yield { type: "done", cost: 0.001 };
    });

    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        persona_id: "don_rosalio_ganadero",
        scene: { time: "06:30", place: "finca" },
        query: "¿Cómo cuida la tierra?",
      }),
    });

    expect(res.status).toBe(200);

    const call = ocaisStreamMock.mock.calls[0]![0] as { system: string; user: string };
    expect(call.system).toContain("Don Rosalio");
    expect(call.system).toContain("ganadero_propietario");
    expect(call.system).toContain("asina es la cosa");
    expect(call.system).toContain("le digo yo");
    expect(call.system).toContain("Ni muerto");
    expect(call.user).toContain("Escena: 06:30 en finca");
    expect(call.user).toContain("¿Cómo cuida la tierra?");

    const chunks = await sseChunks(res);
    const personaTurn = chunks.find((c) => c.text !== undefined) as
      | { text: string }
      | undefined;
    expect(personaTurn).toBeDefined();
    expect(personaTurn!.text).toContain("tierra");
  });
});

describe("golden query 2 — Doña Rosa chismes (betweenness centrality)", () => {
  it("returns SSE with Doña Rosa tendera persona in system prompt", async () => {
    ocaisStreamMock.mockImplementationOnce(async function* () {
      yield {
        type: "text",
        text: "Mire ve, mija: eso sí es verriondo, le cuento.",
      };
      yield { type: "done", cost: 0.001 };
    });

    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        persona_id: "dona_rosa_tendera",
        scene: { time: "08:00", place: "tienda" },
        query: "¿Quién controla los chismes?",
      }),
    });

    expect(res.status).toBe(200);

    const call = ocaisStreamMock.mock.calls[0]![0] as { system: string };
    // Rosa is the chisme-spreader (betweenness 0.55)
    expect(call.system).toContain("Doña Rosa Elvira");
    expect(call.system).toContain("tendera_fiadera");
    expect(call.system).toContain("betweenness=0.55");
    expect(call.system).toContain("degree=18");
    // Muletillas: "mira ve", "le cuento", "eso si es verriondo"
    expect(call.system).toContain("mira ve");
    expect(call.system).toContain("le cuento");
    expect(call.system).toContain("verriondo");
  });
});

describe("golden query 3 — Masacre del Puente (off-persona retrieval)", () => {
  it("still produces a valid response when query is about pueblo history", async () => {
    // For this query, simulate the Masacre doc surfacing as top-1.
    retrieveMock.mockImplementationOnce(
      (_q: Float32Array, _corpus: CorpusDoc[], k: number) => [
        { doc: doc("masacre-puente", "Masacre del Puente de los Decapitados, 1950.", "historia/masacre-1950", []), score: 0.95 },
        { doc: doc("dona-prudencia-portrait", "Doña Prudencia, viuda anfitriona.", "personas/dona-prudencia", ["dona_prudencia_viuda"]), score: 0.7 },
        { doc: doc("historia-pueblo", "Historia del pueblo de Tello.", "historia/general", []), score: 0.6 },
        { doc: doc("costumbres", "Costumbres funerarias del Huila.", "cultura/funerario", []), score: 0.5 },
      ].slice(0, k),
    );

    ocaisStreamMock.mockImplementationOnce(async function* () {
      yield {
        type: "text",
        text: "Mijo, eso pasó en el 50. La gente no lo cuenta, pero pasó.",
      };
      yield { type: "done", cost: 0.001 };
    });

    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        persona_id: "dona_prudencia_viuda",
        scene: { time: "21:00", place: "casa" },
        query: "Cuéntame de la masacre",
      }),
    });

    expect(res.status).toBe(200);
    const call = ocaisStreamMock.mock.calls[0]![0] as { system: string };
    // RAG context block should include the Masacre doc (now forced to top-1).
    expect(call.system).toContain("Contexto del pueblo");
    expect(call.system).toContain("masacre-puente");
    expect(call.system).toContain("Masacre del Puente");
    expect(call.system).toContain("Doña Prudencia");
  });
});

describe("golden query 4 — Padre Cecilio iglesia event", () => {
  it("returns SSE with parroco persona + iglesia RAG context", async () => {
    ocaisStreamMock.mockImplementationOnce(async function* () {
      yield {
        type: "text",
        text: "Dios es el que sabe, mijo. La iglesia está abierta a las seis.",
      };
      yield { type: "done", cost: 0.001 };
    });

    const res = await dialogueApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        persona_id: "padre_cecilio_sacerdote",
        scene: { time: "06:00", place: "iglesia" },
        query: "¿Qué hace Don Cecilio a las 6 de la mañana?",
      }),
    });

    expect(res.status).toBe(200);

    const call = ocaisStreamMock.mock.calls[0]![0] as { system: string; user: string };
    expect(call.system).toContain("Padre Cecilio");
    expect(call.system).toContain("parroco");
    expect(call.system).toContain("Dios es el que sabe");
    // RAG should have surfaced the iglesia doc (top-4 from corpus slice).
    expect(call.system).toContain("iglesia-san-antonio");
    expect(call.user).toContain("Escena: 06:00 en iglesia");
  });
});

describe("golden queries — final cost chunk envelope", () => {
  it("every golden response ends with a cost chunk", async () => {
    ocaisStreamMock.mockImplementation(async function* () {
      yield { type: "text", text: "ok" };
      yield { type: "done", cost: 0.001 };
    });

    const personas = [
      "don_rosalio_ganadero",
      "dona_rosa_tendera",
      "dona_prudencia_viuda",
      "padre_cecilio_sacerdote",
    ];

    for (const persona_id of personas) {
      const res = await dialogueApp.request("/v1/dialogue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          persona_id,
          scene: { time: "06:00", place: "pueblo" },
          query: "test",
        }),
      });
      const chunks = await sseChunks(res);
      const last = chunks[chunks.length - 1]!;
      expect(last).toHaveProperty("cost");
      expect(typeof (last as { cost: number }).cost).toBe("number");
      expect((last as { cost: number }).cost).toBeGreaterThan(0);
    }
  });
});
