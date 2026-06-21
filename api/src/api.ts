/**
 * API handler — Hono on AWS Lambda (via SST Function URL).
 *
 * Endpoints:
 * - GET  /v1/cities                  -> lista de ciudades
 * - GET  /v1/cities/:id/personas     -> personas de una ciudad
 * - GET  /v1/personas/:city_id       -> alias slimmer de /v1/cities/:id/personas (PR #9)
 * - POST /v1/simulate                -> genera dialogo LLM con @opita/ocais (kept for backward compat)
 * - POST /v1/dialogue                -> SSE stream con RAG + persona + estado (PR #9) + rate-limit + cost-tracking (R9)
 * - GET  /v1/stream                  -> SSE stream del pueblo (S2)
 * - WS   /v1/chat                    -> WebSocket chat con personajes (S2)
 *
 * Stack: Hono (4KB router) + @opita/ocais (streaming) + PR #5 (provider with
 * retry + cost + rate-limit) + PR #6 (RAG retrieve + corpus loader) + PR #7
 * (state store: persona-state, conversation) + PR #9 (dialogue composition).
 *
 * Polish R9 (HIGH #1 fix): `DEEPSEEK_API_KEY` now reads through a `?? ""`
 * fallback so the strict typecheck is satisfied. The `estimateCost()`
 * import on line 25 is also a R9 change (M1) — it used to be a local
 * copy in this file; it is now the canonical implementation from
 * `llm/cost-tracker.ts`, shared with `observability/cost.ts` and the
 * dialogue handler.
 */

import { Hono } from "hono";
import { streamText, openai, createSSEWriter } from "@opita/ocais";
import type { Context } from "hono";
import { CIUDADES, TELLO_PERSONAS, type Persona } from "./personas";
import dialogueApp from "./handlers/dialogue";
import personasApp from "./handlers/personas";
import { observabilityMiddleware } from "./observability/middleware";
import { estimateCost } from "./llm/cost-tracker";
import { LLM_CONFIG, LLM_MODEL, getLlmApiKey, getDefaultTemperature } from "./llm/config";

const app = new Hono();

// CORS is configured at the Function URL level (sst.config.ts) so the
// response has exactly one Access-Control-Allow-Origin header. The
// Lambda URL's default CORS sets allowOrigins=["*"] which would
// collide with any header we set here. CloudFront Router already
// terminates OPTIONS preflights, so we don't need an OPTIONS handler
// inside the app — Function URL handles preflight before the request
// reaches us.

// Polish R6 (observability): structured logger + CloudWatch EMF metrics.
// Runs AFTER CORS so OPTIONS preflights return 204 without polluting
// telemetry with one short-lived 204 per CORS preflight, and BEFORE
// the route handlers so timing captures the real handler work.
app.use("*", observabilityMiddleware);

// Health check
app.get("/health", (c) => c.json({ status: "ok", service: "sociedad-opita-api" }));

// GET /v1/cities
app.get("/v1/cities", (c) => {
  return c.json({
    cities: CIUDADES.map((ciudad) => ({
      city_id: ciudad.city_id,
      display_name: ciudad.display_name,
      available_personas: ciudad.personas.length,
    })),
  });
});

// GET /v1/cities/:id/personas
app.get("/v1/cities/:id/personas", (c) => {
  const ciudad = CIUDADES.find((x) => x.city_id === c.req.param("id"));
  if (!ciudad) return c.json({ error: `Ciudad '${c.req.param("id")}' no encontrada` }, 404);
  return c.json({ personas: ciudad.personas });
});

// PR #9: alias slimmer para /v1/personas/:city_id (usado por el frontend)
app.route("/", personasApp);

// POST /v1/simulate
app.post("/v1/simulate", async (c) => {
  const body = await c.req.json<{
    city_id: string;
    persona_id: string;
    scene: { time: string; place: string; weather?: string };
    model?: string;
    temperature?: number;
  }>();

  if (body.city_id !== "tello") {
    return c.json({ error: `Ciudad '${body.city_id}' no encontrada` }, 404);
  }

  const persona = TELLO_PERSONAS.find((p) => p.persona_id === body.persona_id);
  if (!persona) {
    return c.json({ error: `Persona '${body.persona_id}' no encontrada` }, 404);
  }

  // Construir prompt con las 7 capas sociolinguisticas + 13 reglas anti-AI-slop
  // (PromptBuilder original vive en prompt_builder.py — se porta a TS en S2)
  const systemPrompt = buildSystemPrompt(persona);

  const startTime = Date.now();
  let fullText = "";

  try {
    const stream = streamText({
      provider: openai({
        // The legacy /v1/simulate endpoint — also driven by LLM_CONFIG
        // so it follows the active provider automatically.
        apiKey: getLlmApiKey(),
        baseURL: LLM_CONFIG.baseURL,
      }),
      model: body.model || LLM_CONFIG.defaultModel,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Escena: ${body.scene.time} en ${body.scene.place}.${body.scene.weather ? ` Clima: ${body.scene.weather}.` : ""} ¿Que haces o dices?`,
        },
      ],
    });

    for await (const chunk of stream) {
      if (chunk.type === "text") fullText += chunk.text;
    }

    const latency_ms = Date.now() - startTime;

    return c.json({
      text: fullText,
      metadata: {
        cost_usd: estimateCost(fullText, body.model || LLM_MODEL.name),
        latency_ms,
        // TODO(opita-r10-tokens-in): track tokens_in from OCAIS provider.
        // Polish R9: switched from the previous "TODO: track desde ocais"
        // form to the "TODO(opita-XXX)" convention adopted in
        // alarms.config.ts — gives the operator a real ticket key to
        // grep for and resolve.
        tokens_in: 0,
        tokens_out: 0,
        model: body.model || LLM_MODEL.name,
        temperature: body.temperature || getDefaultTemperature(body.model || LLM_MODEL.name),
      },
    });
  } catch (e) {
    return c.json(
      {
        error: "Error al simular",
        fallback: `[Simulacion no disponible: ${(e as Error).message}. Persona: ${persona.display_name}, escena: ${body.scene.time} en ${body.scene.place}.]`,
      },
      500
    );
  }
});

// Constructor de prompt — placeholder de las 7 capas sociolinguisticas + 13 anti-slop
// TODO(opita-s2-prompt-builder): portar prompt_builder.py completo a TypeScript.
// (Polish R9: switched from the previous "TODO S2" form to the
// "TODO(opita-XXX)" convention adopted in alarms.config.ts.)
//
// PR #9: el handler /v1/dialogue usa un prompt builder más rico en
// api/src/context/builder.ts (Big Five + Lomnitz + Dunbar + RAG top-k).
function buildSystemPrompt(persona: Persona): string {
  return `Eres ${persona.display_name}, ${persona.role} de Tello, Huila (Colombia).
Tu forma de hablar incluye muletillas como: ${persona.muletillas.slice(0, 3).join(", ")}.
Tu arquetipo es: ${persona.archetype}.

Big Five: O=${persona.big_five.O}, C=${persona.big_five.C}, E=${persona.big_five.E}, A=${persona.big_five.A}, N=${persona.big_five.N}.
Motivaciones: ${persona.motivations.join("; ")}.
Miedos: ${persona.fears.join("; ")}.

Responde SIEMPRE en espanol colombiano rural del Huila, usando tus muletillas.
NO uses registros neutro, argentino, mexicano, chileno ni espanol peninsular.
NO inventes datos sobre tu biografia — lo que sabes esta aqui.`;
}

// PR #9: monta el handler /v1/dialogue (SSE con OCAIS + RAG + estado)
app.route("/", dialogueApp);

/**
 * Named export of the Hono app for integration/smoke tests.
 * The Lambda entry point is still `handler` (below); this is purely for
 * the vitest suite (see tests/smoke.test.ts, tests/api.test.ts).
 */
export { app as honoApp };

// SST Lambda handler — convierte el evento AWS_PROXY a request Hono
export const handler = async (event: any) => {
  const { method, path } = parseEvent(event);
  const headers = parseHeaders(event);
  const body = event.body
    ? event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString()
      : event.body
    : undefined;

  const url = new URL(path, "https://sociedad.opitacode.com");
  const req = new Request(url.toString(), {
    method,
    headers,
    body: method !== "GET" && method !== "HEAD" ? body : undefined,
  });

  const res = await app.fetch(req);
  return {
    statusCode: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body: await res.text(),
    isBase64Encoded: false,
  };
};

function parseEvent(event: any): { method: string; path: string } {
  // Soporta Function URL (v2.0 payload) y API Gateway (v1.0)
  if (event.version === "2.0") {
    return {
      method: event.requestContext.http.method,
      path: event.requestContext.http.path,
    };
  }
  return {
    method: event.httpMethod,
    path: event.path,
  };
}

function parseHeaders(event: any): Record<string, string> {
  if (event.version === "2.0") {
    return Object.fromEntries(
      Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)])
    );
  }
  return event.headers || {};
}
