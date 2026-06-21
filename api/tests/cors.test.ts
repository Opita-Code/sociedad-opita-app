/**
 * CORS hardening — Polish R5 (security).
 *
 * Behaviors under test:
 *  - OPTIONS preflight returns 204 (no content) with all CORS headers set
 *  - Access-Control-Allow-Origin is the production origin (no wildcard)
 *  - Access-Control-Allow-Methods includes GET, POST, OPTIONS
 *  - Access-Control-Allow-Headers includes Content-Type
 *  - Access-Control-Allow-Credentials is "false" (no cookies)
 *  - Access-Control-Max-Age is "600" (preflight cache 10 min)
 *  - The same headers appear on a normal GET /health response
 *  - The same headers appear on a normal POST /v1/dialogue response
 *
 * The CORS middleware lives in api/src/api.ts (production). This file
 * imports the real `honoApp` export to assert on the live middleware
 * stack. The OCAIS / RAG / state mocks from api.test.ts are hoisted
 * globally by vitest, so this test can drive the real app without
 * hitting any external service.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (hoisted, identical to api.test.ts) ──────────────────────
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

// Re-import the production app AFTER mocks are hoisted.
import { honoApp } from "../src/api";

beforeEach(() => {
  ocaisStreamMock.mockReset();
  embedQueryMock.mockReset();
  retrieveMock.mockReset();
  loadCorpusMock.mockReset();
  loadCorpusMock.mockResolvedValue([]);
  embedQueryMock.mockResolvedValue(new Float32Array([0.5, 0.5, 0.5]));
  retrieveMock.mockReturnValue([]);
  ocaisStreamMock.mockImplementation(async function* () {
    yield { type: "text", text: "cors test" };
    yield { type: "done", cost: 0.0001 };
  });
});

const ALLOWED_ORIGIN = "https://sociedad.opitacode.com";

describe("CORS hardening — preflight (OPTIONS)", () => {
  it("returns 204 No Content for OPTIONS /v1/dialogue", async () => {
    const res = await honoApp.request("/v1/dialogue", { method: "OPTIONS" });
    expect(res.status).toBe(204);
  });

  it("sets Access-Control-Allow-Origin to the production origin (no wildcard)", async () => {
    const res = await honoApp.request("/v1/dialogue", { method: "OPTIONS" });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
  });

  it("sets Access-Control-Allow-Methods to GET, POST, OPTIONS", async () => {
    const res = await honoApp.request("/v1/dialogue", { method: "OPTIONS" });
    const methods = res.headers.get("Access-Control-Allow-Methods") || "";
    expect(methods).toContain("GET");
    expect(methods).toContain("POST");
    expect(methods).toContain("OPTIONS");
  });

  it("sets Access-Control-Allow-Headers to include Content-Type", async () => {
    const res = await honoApp.request("/v1/dialogue", { method: "OPTIONS" });
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");
  });

  it("sets Access-Control-Allow-Credentials to 'false' (no cookies)", async () => {
    const res = await honoApp.request("/v1/dialogue", { method: "OPTIONS" });
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("false");
  });

  it("sets Access-Control-Max-Age to '600' (10 min preflight cache)", async () => {
    const res = await honoApp.request("/v1/dialogue", { method: "OPTIONS" });
    expect(res.headers.get("Access-Control-Max-Age")).toBe("600");
  });

  it("preflight response has empty body (204 No Content)", async () => {
    const res = await honoApp.request("/v1/dialogue", { method: "OPTIONS" });
    const text = await res.text();
    expect(text).toBe("");
  });
});

describe("CORS hardening — actual responses", () => {
  it("GET /health includes the production CORS headers", async () => {
    const res = await honoApp.request("/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
  });

  it("POST /v1/dialogue (200) includes the production CORS headers", async () => {
    const res = await honoApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        persona_id: "dona_rosa_tendera",
        scene: { time: "06:00", place: "tienda" },
        query: "Hola Doña Rosa",
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
  });

  it("POST /v1/dialogue (400) includes the production CORS headers (so the browser can read the error)", async () => {
    const res = await honoApp.request("/v1/dialogue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ALLOWED_ORIGIN);
  });
});
