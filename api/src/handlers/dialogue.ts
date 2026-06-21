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
 * Error policy:
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
import { retrieve, loadCorpus } from "../rag/retrieve";
import { embedQuery } from "../rag/embed-query";
import { buildContext, type Scene } from "../context/builder";
import { TELLO_PERSONAS } from "../personas";
import { getPersonaState } from "../state/persona-state";
import { appendTurn } from "../state/conversation";
import { validateDialogueRequest } from "./validation";

const app = new Hono();

type Corpus = Awaited<ReturnType<typeof loadCorpus>>;
let corpusCache: Corpus | null = null;

const DEFAULT_CORPUS_PATH =
  "references/markitdown-corpus/corpus-embeddings.bge-m3-v1.json.gz";

/**
 * Lazy-load + memoize the corpus in module scope. One disk read per
 * Lambda cold start; subsequent calls reuse the in-memory array.
 */
async function getOrLoadCorpus(): Promise<Corpus> {
  if (corpusCache) return corpusCache;
  const path = process.env.CORPUS_PATH ?? DEFAULT_CORPUS_PATH;
  corpusCache = await loadCorpus(path);
  return corpusCache;
}

app.post("/v1/dialogue", async (c: Context) => {
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
    return c.json(
      { error: "validation_failed", errors: validation.errors },
      400,
    );
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

    // 5. Persona state (best-effort; informational in Phase 1)
    const personaState = await getPersonaState(persona_id).catch(() => null);

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
        try {
          for await (const chunk of ocaisStream({ system, user })) {
            if (chunk.type === "text") {
              fullText += chunk.text;
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify({ text: chunk.text })}\n\n`),
              );
            } else if (chunk.type === "done") {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    cost: estimateCost(fullText, "deepseek-chat"),
                    latency: 0,
                  })}\n\n`,
                ),
              );

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

              controller.close();
            }
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ error: "stream_error", message })}\n\n`,
            ),
          );
          controller.close();
        }

        // personaState is loaded for future use; mark it referenced so
        // tsc does not complain while we leave the hook in place for Phase 2.
        void personaState;
      },
    });

    return c.body(stream);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return c.json({ error: "internal_error", message }, 500);
  }
});

export default app;
