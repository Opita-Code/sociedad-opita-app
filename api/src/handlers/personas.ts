/**
 * Personas handler — GET /v1/personas/:city_id
 *
 * Spec contract:
 *   - 200 with { personas: [...] } for known cities (only "tello" for now)
 *   - 404 with { error: "city_not_found", city_id } for everything else
 *
 * Why a separate handler instead of just /v1/cities/:id/personas?
 *   The original /v1/cities/:id/personas is the canonical city-scoped endpoint.
 *   /v1/personas/:city_id is a slimmer alias used by the web frontend's
 *   sample-fetch (ventana/puente stubs) so it doesn't have to load the whole
 *   /v1/cities envelope just to discover the personas.
 *
 * Both endpoints return the same data — they are intentional aliases.
 */
import { Hono } from "hono";
import { TELLO_PERSONAS } from "../personas";

const app = new Hono();

app.get("/v1/personas/:city_id", (c) => {
  const cityId = c.req.param("city_id");
  if (cityId !== "tello") {
    return c.json({ error: "city_not_found", city_id: cityId }, 404);
  }
  return c.json({ personas: TELLO_PERSONAS });
});

export default app;
