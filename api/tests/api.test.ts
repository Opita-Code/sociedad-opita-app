import { describe, it, expect } from "vitest";
import { app } from "../src/api-test-handler";

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
