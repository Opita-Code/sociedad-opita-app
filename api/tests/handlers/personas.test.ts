/**
 * Personas handler — GET /v1/personas/:city_id
 *
 * Behaviors:
 *  - GET /v1/personas/tello → returns the 10 TELLO_PERSONAS wrapped in { personas: [...] }
 *  - GET /v1/personas/<other> → 404 with error: "city_not_found"
 *  - persona_id, display_name, role, muletillas, network all present in payload
 *  - HTTP 200 (Tello) / 404 (unknown city)
 *  - Wrapped envelope is { personas: [...] }, not a bare array (stable contract)
 */
import { describe, it, expect } from "vitest";
import personasApp from "../../src/handlers/personas";

describe("GET /v1/personas/tello", () => {
  it("returns 200 OK", async () => {
    const res = await personasApp.request("/v1/personas/tello");
    expect(res.status).toBe(200);
  });

  it("returns a { personas: [...] } envelope (not a bare array)", async () => {
    const res = await personasApp.request("/v1/personas/tello");
    const body = (await res.json()) as { personas: unknown };
    expect(Array.isArray(body.personas)).toBe(true);
  });

  it("returns the 10 validated personas", async () => {
    const res = await personasApp.request("/v1/personas/tello");
    const body = (await res.json()) as {
      personas: Array<{ persona_id: string }>;
    };
    expect(body.personas).toHaveLength(10);
  });

  it("includes dona_rosa_tendera (super-spreader #1) with full schema", async () => {
    const res = await personasApp.request("/v1/personas/tello");
    const body = (await res.json()) as {
      personas: Array<{
        persona_id: string;
        display_name: string;
        role: string;
        muletillas: string[];
        network: { betweenness: number; degree: number };
        big_five: { O: number; C: number; E: number; A: number; N: number };
      }>;
    };
    const rosa = body.personas.find((p) => p.persona_id === "dona_rosa_tendera");
    expect(rosa).toBeDefined();
    expect(rosa!.display_name).toBe("Doña Rosa Elvira");
    expect(rosa!.role).toBe("tendera_fiadera");
    expect(rosa!.muletillas.length).toBeGreaterThan(0);
    expect(rosa!.network.betweenness).toBeGreaterThan(0.4);
    expect(rosa!.big_five.O).toBeTypeOf("number");
  });

  it("includes don_rosalio_ganadero (ganadero archetype)", async () => {
    const res = await personasApp.request("/v1/personas/tello");
    const body = (await res.json()) as {
      personas: Array<{ persona_id: string; archetype: string }>;
    };
    const rosalio = body.personas.find((p) => p.persona_id === "don_rosalio_ganadero");
    expect(rosalio).toBeDefined();
    expect(rosalio!.archetype).toBe("ganadero_tradicional");
  });
});

describe("GET /v1/personas/<unknown>", () => {
  it("returns 404", async () => {
    const res = await personasApp.request("/v1/personas/nonexistent");
    expect(res.status).toBe(404);
  });

  it("returns error: 'city_not_found' with city_id echoed back", async () => {
    const res = await personasApp.request("/v1/personas/marquetalia");
    const body = (await res.json()) as { error: string; city_id: string };
    expect(body.error).toBe("city_not_found");
    expect(body.city_id).toBe("marquetalia");
  });
});
