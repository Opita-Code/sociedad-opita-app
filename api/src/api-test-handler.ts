/**
 * Test handler — wrapper que expone la app de Hono sin el SST handler wrapper.
 * Asi podemos testear con vitest sin necesidad de mockear AWS Lambda.
 *
 * PR #9: mounted the dialogue + personas sub-apps so smoke tests exercise
 * the SAME routing composition that api.ts uses in production. This is the
 * single source of truth for the HTTP-level smoke verification.
 */

import { Hono } from "hono";
import { CIUDADES, TELLO_PERSONAS, type Persona } from "./personas";
import dialogueApp from "./handlers/dialogue";
import personasApp from "./handlers/personas";

export const app = new Hono();

app.use("*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", "*");
  await next();
});

app.get("/health", (c) => c.json({ status: "ok", service: "sociedad-opita-api" }));

app.get("/v1/cities", (c) => {
  return c.json({
    cities: CIUDADES.map((ciudad) => ({
      city_id: ciudad.city_id,
      display_name: ciudad.display_name,
      available_personas: ciudad.personas.length,
    })),
  });
});

app.get("/v1/cities/:id/personas", (c) => {
  const ciudad = CIUDADES.find((x) => x.city_id === c.req.param("id"));
  if (!ciudad) return c.json({ error: `Ciudad '${c.req.param("id")}' no encontrada` }, 404);
  return c.json({ personas: ciudad.personas });
});

app.post("/v1/simulate", async (c) => {
  const body = await c.req.json<{
    city_id: string;
    persona_id: string;
  }>();
  const ciudad = CIUDADES.find((x) => x.city_id === body.city_id);
  if (!ciudad) return c.json({ error: `Ciudad '${body.city_id}' no encontrada` }, 404);
  const persona = TELLO_PERSONAS.find((p) => p.persona_id === body.persona_id);
  if (!persona) return c.json({ error: `Persona '${body.persona_id}' no encontrada` }, 404);
  return c.json({ ok: true, persona: persona.display_name });
});

// PR #9: smoke-test the dialogue composition + personas alias via these mounts.
app.route("/", personasApp);
app.route("/", dialogueApp);

