import { describe, it, expect, vi, beforeEach } from "vitest";
import { app } from "../src/api-test-handler";

// ── PR #9 mocks (hoisted) ─────────────────────────────────────────
const { ocaisStreamMock } = vi.hoisted(() => ({ ocaisStreamMock: vi.fn() }));
vi.mock("../src/llm/provider", () => ({ ocaisStream: ocaisStreamMock }));

const { embedQueryMock, retrieveMock, loadCorpusMock } = vi.hoisted(() => ({
  embedQueryMock: vi.fn(),
  retrieveMock: vi.fn(),
  loadCorpusMock: vi.fn(),
}));
vi.mock("../src/rag/retrieve", () => ({
  loadCorpus: loadCorpusMock,
  retrieve: retrieveMock,
  cosine: vi.fn(),
  topK: vi.fn(),
  loadCorpusFromBuffer: vi.fn(),
}));
vi.mock("../src/rag/embed-query", () => ({ embedQuery: embedQueryMock }));

vi.mock("../src/state/persona-state", () => ({
  getPersonaState: vi.fn().mockResolvedValue({
    personaId: "dona_rosa_tendera",
    emotionalState: "neutral",
    recentEvents: [],
    lastSeen: "1970-01-01T00:00:00Z",
    networkPosition: { betweenness: 0, degree: 0 },
  }),
}));
vi.mock("../src/state/conversation", () => ({
  appendTurn: vi.fn().mockResolvedValue(undefined),
  getConversation: vi.fn(),
}));

beforeEach(() => {
  ocaisStreamMock.mockReset();
  embedQueryMock.mockReset();
  retrieveMock.mockReset();
  loadCorpusMock.mockReset();

  loadCorpusMock.mockResolvedValue([]);
  embedQueryMock.mockResolvedValue(new Float32Array([0.5, 0.5, 0.5]));
  retrieveMock.mockReturnValue([]);
  ocaisStreamMock.mockImplementation(async function* () {
    yield { type: "text", text: "smoke ok" };
    yield { type: "done", cost: 0.0001 };
  });
});

describe("GET /health", () => {
  it("returns ok status", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("sociedad-opita-api");
  });
});

describe("GET /v1/cities", () => {
  it("returns at least Tello", async () => {
    const res = await app.request("/v1/cities");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cities: Array<{ city_id: string; display_name: string }> };
    expect(body.cities.length).toBeGreaterThanOrEqual(1);
    const tello = body.cities.find((c) => c.city_id === "tello");
    expect(tello).toBeDefined();
    expect(tello?.display_name).toBe("Tello, Huila");
  });
});

describe("GET /v1/cities/tello/personas", () => {
  it("includes Dona Rosa (super-spreader #1)", async () => {
    const res = await app.request("/v1/cities/tello/personas");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { personas: Array<{ persona_id: string; archetype: string; muletillas: string[]; network: { betweenness: number } }> };
    const rosa = body.personas.find((p) => p.persona_id === "dona_rosa_tendera");
    expect(rosa).toBeDefined();
    expect(rosa?.archetype).toBe("tendero_pueblo");
    expect(rosa?.muletillas.length).toBeGreaterThan(0);
    expect(rosa?.network.betweenness).toBeGreaterThan(0.4); // Super-spreader
  });
});

describe("GET /v1/cities/inexistente/personas", () => {
  it("returns 404", async () => {
    const res = await app.request("/v1/cities/inexistente/personas");
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/simulate", () => {
  it("returns 404 for unknown city", async () => {
    const res = await app.request("/v1/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        city_id: "inexistente",
        persona_id: "dona_rosa_tendera",
        scene: { time: "08:00", place: "Tienda" },
      }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for unknown persona", async () => {
    const res = await app.request("/v1/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        city_id: "tello",
        persona_id: "inexistente",
        scene: { time: "08:00", place: "Tienda" },
      }),
    });
    expect(res.status).toBe(404);
  });
});

// ── PR #9 smoke tests ─────────────────────────────────────────────
describe("PR #9: GET /v1/personas/:city_id (alias)", () => {
  it("returns 200 with 10 personas for Tello", async () => {
    const res = await app.request("/v1/personas/tello");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      personas: Array<{ persona_id: string }>;
    };
    expect(body.personas).toHaveLength(10);
  });

  it("returns 404 for unknown city", async () => {
    const res = await app.request("/v1/personas/marquetalia");
    expect(res.status).toBe(404);
  });
});

describe("PR #9: POST /v1/dialogue (smoke)", () => {
  it("returns 400 invalid_json for malformed body", async () => {
    const res = await app.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_json");
  });

  it("returns 400 with validation_failed for unknown persona (whitelist)", async () => {
    const res = await app.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        persona_id: "inexistente",
        scene: { time: "06:00", place: "tienda" },
        query: "hola",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      errors: Array<{ field: string; message: string }>;
    };
    expect(body.error).toBe("validation_failed");
    expect(body.errors.find((e) => e.field === "persona_id")).toBeDefined();
  });

  it("returns 200 SSE with text + cost chunks (mocked OCAIS)", async () => {
    const res = await app.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        persona_id: "dona_rosa_tendera",
        scene: { time: "06:00", place: "tienda" },
        query: "¿Cómo amaneció, Doña Rosa?",
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/text\/event-stream/);
    const text = await res.text();
    expect(text).toMatch(/data: \{"text":"smoke ok"\}/);
    expect(text).toMatch(/data: \{"cost":/);
  });
});
