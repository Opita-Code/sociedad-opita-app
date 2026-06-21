/**
 * Dialogue handler — POST /v1/dialogue
 *
 * Composition (per .sdd/monumento-cultural-v2/design.md section 5):
 *
 *   POST /v1/dialogue { persona_id, scene, query, conv_id? }
 *     │
 *     ├── 1. Validate body (400 on missing fields / 404 on unknown persona)
 *     │
 *     ├── 2. Load corpus (cached in module scope — loadCorpus() once per cold start)
 *     │
 *     ├── 3. Embed query via Xenova/bge-m3 (server-side, ~50-150ms)
 *     │
 *     ├── 4. Retrieve top-k=4 via cosine similarity
 *     │
 *     ├── 5. getPersonaState(personaId) — informational only in Phase 1
 *     │
 *     ├── 6. buildContext(persona, scene, topK, query) → { system, user }
 *     │       (buildContext also sanitizes the query: strips role markers
 *     │        and control chars, caps at 1000 chars — see builder.ts)
 *     │
 *     ├── 7. ocaisStream(system, user) → SSE chunks
 *     │
 *     └── 8. Persist conversation turns if conv_id given (best-effort)
 *
 * Response: `text/event-stream` with
 *   - `data: {"text": "..."}\n\n` for each OCAIS text chunk
 *   - `data: {"cost": <usd>, "latency": 0}\n\n` final envelope
 *
 * The handler is mounted on the main Hono app from api/src/api.ts via
 * `app.route("/", dialogueApp)` so the /v1/dialogue path is served.
 *
 * Polish R5 (security hardening):
 *   - Validation lives in ./validation.ts (typed, TDD-covered edge cases:
 *     persona whitelist, time regex, length caps, conv_id regex, control
 *     char stripping, opita unicode preservation).
 *   - The query is ALSO sanitized inside buildContext (role-marker
 *     stripping) — defense in depth, not redundant: the validator caps
 *     length and type-checks, the builder neutralizes prompt-injection
 *     shapes (e.g., "system: ..." appearing on a new line in a long
 *     multi-paragraph question).
 *
 * Polish R9 (BUG #1 fix): the ReadableStream's start() uses try/finally
 * to call controller.close() on every exit path of the for-await loop
 * — the "done" chunk path, an unknown chunk type that the loop skips,
 * OR a mid-stream throw. Previously the controller was only closed on
 * the "done" branch, which meant an upstream chunk shape change (or a
 * thrown error before close) would leave the SSE stream open and the
 * client would hang waiting for a terminator.
 *
 * Polish R9 (HIGH #2 integration): the handler now also
 *   - rate-limits per-IP via TokenBucket.tryConsume() (10 req/min) at
 *     the very top, returning 429 with a Spanish retry hint when
 *     the bucket is empty. See `getDialogueRateLimiter()` in
 *     `llm/rate-limiter.ts`.
 *   - records each successful invocation through `cost.recordInvocation()`
 *     in `observability/cost.ts`, with tokens_out estimated from
 *     the full text length (4 chars per token). This produces the
 *     `cost.recorded` structured log line and the `cost_usd` EMF
 *     histogram — the same surfaces that the /v1/simulate handler
 *     writes inline. Cost is recorded only on the "done" path with
 *     tokens_out > 0; aborted or empty streams do not pollute the
 *     dashboard.
 *
 * Error policy:
 *   - 429 rate_limited (per-IP token bucket exhausted; see HIGH #2)
 *   - 400 invalid_json (malformed body)
 *   - 400 validation_failed (per-field errors from validation.ts)
 *   - 400 missing_required_fields (kept for backward compat with PR #9)
 *   - 404 persona_not_found
 *   - 500 internal_error (corpus load / embed / context / state fails)
 *   - SSE errors mid-stream are emitted as `data: {"error": "stream_error", "message": "..."}`
 *     and the stream is closed cleanly. Clients handle per the EventSource contract.
 */
import { Hono, type Context } from "hono";
import { ocaisStream } from "../llm/provider";
import { estimateCost } from "../llm/cost-tracker";
import { LLM_MODEL, LLM_CONFIG } from "../llm/config";
import { retrieve, loadCorpusFromBuffer } from "../rag/retrieve";
import { embedQuery } from "../rag/embed-query";
import { buildContext, type Scene } from "../context/builder";
import { TELLO_PERSONAS } from "../personas";
import { getPersonaState } from "../state/persona-state";
import { appendTurn } from "../state/conversation";
import { validateDialogueRequest } from "./validation";
import { cost } from "../observability/cost";
import { getDialogueRateLimiter } from "../llm/rate-limiter";
// The corpus gz is embedded in the Lambda bundle by esbuild's `binary`
// loader (configured in sst.config.ts). ~1MB Uint8Array, parsed once at
// module init. See api/src/assets/corpus.bge-m3-v1.json.gz for the
// build-time artifact and scripts/embed-corpus.ts for how it's produced.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — esbuild resolves this at bundle time
import corpusGz from "../assets/corpus.bge-m3-v1.json.gz";

const app = new Hono();

type Corpus = Awaited<ReturnType<typeof loadCorpusFromBuffer>>;
let corpusCache: Corpus | null = null;

/**
 * Parse the embedded corpus once at module init. The bytes were
 * produced by scripts/embed-corpus.ts (Xenova/bge-m3 q8, L2-normalized,
 * 1024d) and bundled by esbuild. This runs ~1× per Lambda cold start
 * (~50ms) and the parsed array is reused for the warm lifetime of the
 * container.
 */
async function getOrLoadCorpus(): Promise<Corpus> {
  if (corpusCache) return corpusCache;
  // corpusGz is a Uint8Array (esbuild binary loader). Pass it directly
  // to loadCorpusFromBuffer to skip the disk-read path.
  corpusCache = await loadCorpusFromBuffer(corpusGz as Uint8Array, "embedded:bge-m3-v1");
  return corpusCache;
}

app.post("/v1/dialogue", async (c: Context) => {
  // 0. Rate limit (Polish R9, HIGH #2). Per-IP token bucket: 10 req/min
  // default. This runs BEFORE JSON parsing so request-flooding bots
  // sending malformed bodies also get throttled. The bucket is shared
  // across all dialogue invocations on the same warm Lambda instance;
  // cold start resets it (acceptable — soft limiter, not a billing gate).
  const ip = c.req.header("x-forwarded-for") || "unknown";
  if (!getDialogueRateLimiter().tryConsume(ip)) {
    return c.json(
      {
        error: "rate_limited",
        message:
          "Has superado el limite de 10 dialogos por minuto. Vuelve a intentarlo en unos segundos.",
        retry_after_s: 6,
      },
      429
    );
  }

  // 1. Parse JSON body (raw — validation runs in step 1b).
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  // 1b. Centralized validation (Polish R5).
  const validation = validateDialogueRequest(body);
  if (!validation.ok) {
    return c.json({ error: "validation_failed", errors: validation.errors }, 400);
  }
  const { persona_id, scene, query, conv_id } = validation.data;

  // 1c. Persona lookup (defense in depth — the validator already
  // checked the whitelist, but a future re-shuffling of personas.ts
  // could desync; this lookup is the actual source of truth).
  const persona = TELLO_PERSONAS.find((p) => p.persona_id === persona_id);
  if (!persona) {
    return c.json({ error: "persona_not_found", persona_id }, 404);
  }

  try {
    // 2-4. Load corpus + embed query + retrieve top-k
    const corpus = await getOrLoadCorpus();
    const queryEmb = await embedQuery(query);
    const topK = retrieve(queryEmb, corpus, 4);

    const validatedScene: Scene = {
      time: scene.time,
      place: scene.place,
      weather: scene.weather,
    };

    // 5. Persona state (best-effort; informational in Phase 1).
    // TODO(opita-r10-persona-state): thread personaState into
    // buildContext() so Big Five / network position / recent events
    // reach the LLM. The fetch is already best-effort and cached
    // upstream, so this is a wiring change, not a perf change.
    // (Polish R9: removed the `void personaState;` smell flagged in
    // code-review-r1.md L3 — the variable is unused here, so we no
    // longer need the `void` to silence tsc.)
    await getPersonaState(persona_id).catch(() => null);

    // 6. Build context (also sanitizes the query — see builder.ts)
    const { system, user } = buildContext(persona, validatedScene, topK, query);

    // 7. Stream OCAIS chunks as SSE
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");

    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        let fullText = "";
        // Polish R9 (BUG #1): track whether the stream has been closed so
        // the finally block is idempotent. The for-await loop can exit
        // via (a) the "done" chunk path, (b) an unknown chunk type that
        // the loop silently skips, or (c) a mid-stream throw. In all
        // three cases we MUST call controller.close() — otherwise the
        // SSE stream stays open and the client hangs forever. The
        // try/finally below guarantees close on every exit path.
        let closed = false;
        const safeClose = () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            // Idempotent — ReadableStreamDefaultController.close() is a
            // no-op on an already-closed controller, but be defensive
            // against any internal state mismatch.
          }
        };
        try {
          for await (const chunk of ocaisStream({ system, user })) {
            if (chunk.type === "text") {
              fullText += chunk.text;
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ text: chunk.text })}\n\n`)
              );
            } else if (chunk.type === "done") {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    cost: estimateCost(fullText, LLM_MODEL.name),
                    latency: 0,
                  })}\n\n`
                )
              );

              // Polish R9 (HIGH #2): record the cost via the observability
              // client. We estimate tokens_out from the full text length
              // (4 chars per token — the same heuristic the upstream
              // pricing docs use for English; close enough for Spanish
              // colonial dialect and consistently slightly over-counts,
              // which is the safe direction). tokens_in is 0 today
              // because the OCAIS provider does not surface the upstream
              // usage envelope; the existing estimateCost() handles that
              // case correctly (it only counts tokens_out).
              const tokensOut = Math.ceil(fullText.length / 4);
              if (tokensOut > 0) {
                cost.recordInvocation({
                  model: LLM_MODEL.name,
                  tokens_out: tokensOut,
                  conv_id,
                  persona_id,
                });
              }

              // 8. Persist conversation turns (best-effort).
              if (conv_id) {
                const personaTs = new Date().toISOString();
                const userTs = new Date(Date.now() + 1).toISOString();
                await appendTurn({
                  convId: conv_id,
                  ts: personaTs,
                  role: "persona",
                  personaId: persona_id,
                  content: fullText,
                }).catch(() => undefined);
                await appendTurn({
                  convId: conv_id,
                  ts: userTs,
                  role: "user",
                  content: query,
                }).catch(() => undefined);
              }
            }
            // Unknown chunk types are intentionally ignored — the
            // finally block will close the controller regardless.
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ error: "stream_error", message })}\n\n`)
          );
        } finally {
          // Close on every exit path: success (done chunk), unknown
          // chunk type fall-through, OR mid-stream throw. safeClose is
          // idempotent so multiple exit paths are safe.
          safeClose();
        }
      },
    });

    return c.body(stream);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return c.json({ error: "internal_error", message }, 500);
  }
});

export default app;
