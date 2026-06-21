/**
 * CORS hardening — Phase 2 (2026-06-21).
 *
 * History:
 * - Polish R5 set CORS in the Hono middleware (api/src/api.ts) with
 *   Access-Control-Allow-Origin: https://sociedad.opitacode.com.
 *   That worked in dev but in production the AWS Lambda Function URL
 *   adds its own Access-Control-Allow-Origin: * (default CORS) and
 *   the two values end up in the response, which the browser rejects
 *   with "header contains multiple values" — every cross-origin
 *   fetch from sociedad.opitacode.com fails.
 *
 * - The fix is to put the CORS configuration on the Function URL
 *   (sst.config.ts → apiFn.url.cors) with allowOrigins pinned to the
 *   production domain, and remove the Hono middleware. The browser
 *   now sees exactly one Access-Control-Allow-Origin header.
 *
 * What this test asserts (Hono-side):
 *  - The Hono app no longer sets Access-Control-Allow-Origin itself;
 *    CORS is the Function URL's job. If this assertion ever fails,
 *    someone re-introduced a second CORS source.
 *  - OPTIONS preflights fall through to a 404 (Hono has no OPTIONS
 *    route); the Function URL intercepts OPTIONS preflights and
 *    responds 200 with the CORS headers before Hono sees them.
 *  - The Hono middleware stack is CORS-free on real responses.
 *
 * The full CORS contract is verified end-to-end in the live smoke
 * test (see `runbooks/verify-cors.md`): `curl -I` against
 * https://api.sociedad.opitacode.com/v1/dialogue with
 * `-H "Origin: https://sociedad.opitacode.com"` must show exactly
 * one `access-control-allow-origin` header.
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

describe("CORS — Hono is CORS-agnostic (Function URL owns the header)", () => {
  it("does NOT set Access-Control-Allow-Origin in the Hono middleware (avoids duplicate headers)", async () => {
    const res = await honoApp.request("/health");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("does NOT set Access-Control-Allow-Methods in the Hono middleware", async () => {
    const res = await honoApp.request("/health");
    expect(res.headers.get("Access-Control-Allow-Methods")).toBeNull();
  });

  it("does NOT set Access-Control-Allow-Headers in the Hono middleware", async () => {
    const res = await honoApp.request("/health");
    expect(res.headers.get("Access-Control-Allow-Headers")).toBeNull();
  });

  it("does NOT set Access-Control-Allow-Credentials in the Hono middleware", async () => {
    const res = await honoApp.request("/health");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("does NOT set Access-Control-Max-Age in the Hono middleware", async () => {
    const res = await honoApp.request("/health");
    expect(res.headers.get("Access-Control-Max-Age")).toBeNull();
  });

  it("GET /health still works without CORS (200 OK, JSON body)", async () => {
    const res = await honoApp.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("POST /v1/dialogue still works without CORS in Hono", async () => {
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
  });

  it("OPTIONS /v1/dialogue falls through Hono (Function URL intercepts preflight)", async () => {
    // Without the Hono middleware catching OPTIONS, Hono returns 404
    // for unknown methods/paths. In production the Function URL
    // handles OPTIONS preflight before the request reaches Hono.
    const res = await honoApp.request("/v1/dialogue", { method: "OPTIONS" });
    // Hono returns 404 for OPTIONS on a route that doesn't have an
    // OPTIONS handler. This is by design: CORS preflights are
    // answered at the infra layer, not in the app.
    expect([404, 405]).toContain(res.status);
  });
});
