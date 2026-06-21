/**
 * API handler — Hono on AWS Lambda (via SST Function URL).
 *
 * Endpoints:
 * - GET  /v1/cities                  -> lista de ciudades
 * - GET  /v1/cities/:id/personas     -> personas de una ciudad
 * - GET  /v1/personas/:city_id       -> alias slimmer de /v1/cities/:id/personas (PR #9)
 * - POST /v1/simulate                -> genera dialogo LLM con @opita/ocais (kept for backward compat)
 * - POST /v1/dialogue                -> SSE stream con RAG + persona + estado (PR #9)
 * - GET  /v1/stream                  -> SSE stream del pueblo (S2)
 * - WS   /v1/chat                    -> WebSocket chat con personajes (S2)
 *
 * Stack: Hono (4KB router) + @opita/ocais (streaming) + PR #5 (provider with
 * retry + cost + rate-limit) + PR #6 (RAG retrieve + corpus loader) + PR #7
 * (state store: persona-state, conversation) + PR #9 (dialogue composition).
 */

import { Hono } from "hono";
import { streamText, openai, createSSEWriter } from "@opita/ocais";
import type { Context } from "hono";
import { CIUDADES, TELLO_PERSONAS, type Persona } from "./personas";
import dialogueApp from "./handlers/dialogue";
import personasApp from "./handlers/personas";
import { observabilityMiddleware } from "./observability/middleware";

const app = new Hono();

// CORS para el frontend en sociedad.opitacode.com
// Polish R5 (security hardening):
//   - Allow-Credentials: false — the API is anonymous; no cookies, no
//     Authorization header is read. Removing credentialed CORS closes off
//     a CSRF-via-credentials surface that some browsers expose.
//   - Max-Age: 600 — preflight responses can be cached for 10 minutes,
//     shaving one round-trip per dialogue request without risking
//     stale-policy windows beyond a deploy.
app.use("*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", "https://sociedad.opitacode.com");
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type");
  c.header("Access-Control-Allow-Credentials", "false");
  c.header("Access-Control-Max-Age", "600");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
});

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
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1",
      }),
      model: body.model || "deepseek-chat",
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
        cost_usd: estimateCost(fullText, body.model || "deepseek-chat"),
        latency_ms,
        tokens_in: 0, // TODO: track desde ocais
        tokens_out: 0,
        model: body.model || "deepseek-chat",
        temperature: body.temperature || 1.3,
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
// TODO S2: portar prompt_builder.py completo a TypeScript
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

function estimateCost(text: string, model: string): number {
  // DeepSeek Chat: ~$0.14 per 1M output tokens. Aprox 4 chars per token.
  const outputTokens = Math.ceil(text.length / 4);
  const costPer1M = model.includes("reasoner") ? 2.19 : 0.14;
  return (outputTokens / 1_000_000) * costPer1M;
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
  const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body) : undefined;

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
