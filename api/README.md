# `api/` — Sociedad Opita API

> **Backend del monumento digital vivo.** Hono 4 sobre AWS Lambda
> (SST v3, arm64), con RAG sobre BGE-M3, estado en DynamoDB
> single-table, y streaming AI vía [`@opita/ocais`](https://github.com/Opita-Code/ocais) v2.0.

---

## Arquitectura

```
                ┌──────────────────────┐
   POST /v1/    │   SST Router         │  api.sociedad.opitacode.com
   dialogue ──▶ │   (custom domain)    │  (Lambda Function URL)
                └──────────┬───────────┘
                           │
                ┌──────────▼───────────┐
                │   Lambda (arm64)     │  2048 MB · 60 s · concurrency 10
                │   Hono 4 app         │
                └──────────┬───────────┘
                           │
        ┌──────────┬───────┴────────┬─────────────┐
        │          │                │             │
        ▼          ▼                ▼             ▼
   ┌────────┐ ┌────────┐   ┌──────────────┐ ┌──────────────┐
   │ RAG    │ │ LLM    │   │ State store  │ │ Context      │
   │ bge-m3 │ │ ocais  │   │ DDB single-  │ │ builder      │
   │ +cosine│ │ DeepSeek│  │ table + GSI  │ │ sanitize+    │
   │ top-k  │ │ stream │   │              │ │ 7 layers     │
   └────────┘ └────────┘   └──────────────┘ └──────────────┘
        │          │                │             │
        └──────────┴─────┬──────────┴─────────────┘
                         │
                ┌────────▼─────────┐
                │  Observability   │  structured logger + EMF metrics
                │  (Polish R6)     │  + tracing + cost tracking
                └──────────────────┘
```

El request flow completo está documentado en
[`src/handlers/dialogue.ts`](src/handlers/dialogue.ts) (header comment,
sección "Composition").

---

## Endpoints

### `GET /health`

Liveness check. Sin auth, sin parámetros.

```bash
curl https://api.sociedad.opitacode.com/health
# → {"status":"ok","service":"sociedad-opita-api"}
```

### `GET /v1/cities`

Lista de ciudades con personas documentadas. Por ahora solo `tello`.

```bash
curl https://api.sociedad.opitacode.com/v1/cities
# → {"cities":[{"city_id":"tello","display_name":"Tello, Huila","available_personas":10}]}
```

### `GET /v1/cities/:id/personas`

Personas de una ciudad. Devuelve el array completo de perfiles
psicométricos (Big Five, Lomnitz, Dunbar, muletillas, red).

```bash
curl https://api.sociedad.opitacode.com/v1/cities/tello/personas
```

### `GET /v1/personas/:city_id`

**Alias slimmer** del endpoint anterior, introducido en PR #9 para
reducir el path. Misma respuesta. El frontend usa este.

```bash
curl https://api.sociedad.opitacode.com/v1/personas/tello
```

### `POST /v1/simulate` *(deprecated)*

Genera un diálogo simple con un LLM. **Deprecated** — se conserva por
backward compatibility pero todo código nuevo debe usar `/v1/dialogue`.

```bash
curl -X POST https://api.sociedad.opitacode.com/v1/simulate \
  -H "Content-Type: application/json" \
  -d '{
    "city_id": "tello",
    "persona_id": "dona_rosa_tendera",
    "scene": { "time": "06:00", "place": "la tienda" }
  }'
```

### `POST /v1/dialogue` *(nuevo, recomendado)*

Diálogo SSE con RAG + estado + persona. Reemplaza `/v1/simulate`.

Request:

```bash
curl -N -X POST https://api.sociedad.opitacode.com/v1/dialogue \
  -H "Content-Type: application/json" \
  -d '{
    "persona_id": "dona_rosa_tendera",
    "scene": { "time": "06:00", "place": "la tienda", "weather": "frio" },
    "query": "Mire Doña Rosa, ¿qué chisme hay hoy?",
    "conv_id": "opcional-para-persistencia"
  }'
```

Response (`text/event-stream`):

```
data: {"text":"Mire "}

data: {"text":"ve, "}

data: {"text":"mijo..."}

data: {"cost":0.0000234,"latency":0}
```

Validación (Polish R5): persona whitelist, `time` regex `^\d{2}:\d{2}$`,
`query` ≤ 1000 chars, `conv_id` regex `^[A-Za-z0-9_-]{1,64}$`, control
chars eliminados. Errores: `400 invalid_json` / `400 validation_failed`
/ `404 persona_not_found` / `500 internal_error`.

### Endpoints planeados (Phase 2)

- `GET /v1/stream` — SSE stream del pueblo entero (S2).
- `WS  /v1/chat`  — WebSocket 1:1 con personajes (S2).
- `GET /v1/personas/:city_id/:persona_id/state` — estado actual de una persona.

---

## Estructura de módulos

```
api/src/
├── api.ts                    # Hono app + AWS_PROXY adapter
├── api-test-handler.ts       # Variant para integration tests
├── personas.ts               # 10 personas validadas (single source of truth)
│
├── llm/                      # PR #5 — provider layer
│   ├── provider.ts           # ocaisStream() — wrapper sobre @opita/ocais
│   ├── cost-tracker.ts       # estimateCost(text, model) por modelo
│   └── rate-limiter.ts       # Token bucket per-IP (10/minuto, refil 10/h)
│
├── rag/                      # PR #6 — RAG foundation
│   ├── retrieve.ts           # top-k cosine similarity
│   ├── types.ts              # Chunk / Corpus types
│   └── embed-query.ts        # embedQuery(text) → vector (BGE-M3 ONNX)
│
├── state/                    # PR #7 — single-table DDB
│   ├── schema.ts             # Tipos: Persona | Conv | Event (pk/sk)
│   ├── dynamo-client.ts      # Client tipado (DocumentClient v3)
│   ├── persona-state.ts      # getPersonaState(personaId) — informational Phase 1
│   ├── conversation.ts       # appendTurn() — best-effort persistence
│   └── ventana-events.ts     # Read de GSI byTime
│
├── handlers/                 # PR #9 + Polish R5
│   ├── dialogue.ts           # POST /v1/dialogue (SSE composer)
│   ├── personas.ts           # GET /v1/personas/:city_id
│   └── validation.ts         # validateDialogueRequest() — typed edge cases
│
├── context/                  # PR #9 + Polish R5
│   └── builder.ts            # buildContext() + sanitizeUserInput()
│                              # 7 capas sociolingüísticas + 13 anti-AI-slop
│
└── observability/            # Polish R6
    ├── logger.ts             # Structured JSON logger
    ├── metrics.ts            # CloudWatch EMF metrics
    ├── tracing.ts            # X-Ray segments + custom spans
    ├── middleware.ts         # observabilityMiddleware (timing + logger)
    └── cost.ts               # cost tracking (DeepSeek + DynamoDB)
```

### Por PR

| PR | Foco | Módulos |
|----|------|---------|
| #5 | Provider layer con retry + cost + rate-limit | `llm/*` |
| #6 | RAG foundation + LoRA fine-tune pipeline | `rag/*` |
| #7 | Single-table DDB + 2 GSIs + TTL | `state/*` |
| #9 | Dialogue composition (RAG + state + persona) | `handlers/dialogue.ts`, `context/builder.ts` |
| R5 | Validation + prompt injection defense | `handlers/validation.ts`, `context/builder.ts` sanitize |
| R6 | Structured logging + EMF metrics + cost | `observability/*` |
| R7 | arm64, cost cap, alarms manifest | `sst.config.ts`, `alarms.config.ts` |

---

## Testing

```bash
cd api
pnpm test                  # vitest run — toda la suite (32 archivos, 215+ tests)
pnpm test:watch            # vitest watch
pnpm test -- tests/rag     # solo RAG tests
pnpm typecheck             # tsc --noEmit
```

**Test inventory** (32 archivos):

| Suite | Cobertura |
|-------|-----------|
| `tests/handlers/dialogue.test.ts` | SSE composition, errores, edge cases |
| `tests/handlers/validation-edge-cases.test.ts` | 18+ edge cases del validator (R5) |
| `tests/handlers/dialogue-chaos.test.ts` | Chaos tests (429, 5xx, malformed JSON, abort) |
| `tests/rag/retrieve.test.ts` | Cosine similarity, top-k correctness |
| `tests/rag/retrieve-golden-expanded.test.ts` | 10 golden queries con respuestas esperadas |
| `tests/rag/retrieve-property.test.ts` | Property-based con fast-check |
| `tests/llm/*.test.ts` | Provider retry, cost-tracker, rate-limiter |
| `tests/state/*.test.ts` | DDB schema, TTL, GSIs |
| `tests/context/builder-muletillas.test.ts` | 7 capas + 13 reglas anti-slop |
| `tests/observability/cost-budget.test.ts` | Cost cap enforcement |
| `tests/perf/benchmark.test.ts` | Performance baseline (skipped en CI) |
| `tests/smoke.test.ts` | Hono app smoke |

> Los **chaos tests** simulan comportamiento adversario (provider
> rate-limit, DDB throttling, abortos de cliente) sin tocar AWS real.

---

## Variables de entorno

Configuradas vía SST (ver [`sst.config.ts`](sst.config.ts)):

| Variable | Origen | Default | Descripción |
|----------|--------|---------|-------------|
| `DEEPSEEK_API_KEY` | SST Secret (SSM SecureString) | — | API key de DeepSeek (R5) |
| `DEEPSEEK_BASE_URL` | env | `https://api.deepseek.com/v1` | Endpoint OpenAI-compatible |
| `DDB_TABLE` | SST link | `SociedadOpitaState` | Tabla de estado |
| `CORPUS_PATH` | env | `/tmp/corpus-embeddings.bge-m3-v1.json.gz` | Path del corpus embebido |
| `STAGE` | SST `$app.stage` | `dev` | Stage activo |
| `HF_HOME` | env | `/tmp` (default) | Cache de HuggingFace (Polish R3) |

### Secret management (Polish R5)

```bash
# One-time, per AWS account
cd api
pnpm sst secret set DeepSeekApiKey sk-...
# (pegar el API key cuando lo pida)
```

SST sube el valor encriptado a SSM Parameter Store (SecureString) en el
primer `sst deploy --stage prod`. Local dev: SST lee del state file en
`.sst/`. Más detalles en [`DEPLOY-RUNBOOK.md`](../DEPLOY-RUNBOOK.md) sección "Secrets".

---

## Deployment (SST v3)

El stack está definido en [`sst.config.ts`](sst.config.ts).

### Recursos

- **Lambda `ApiFn`** — `2048 MB`, `60 s` timeout, `arm64` (Graviton2),
  reserved concurrency 10, log retention 1 mes, JSON format.
- **DynamoDB `SociedadOpitaState`** — single-table, `pk` (HASH) + `sk` (RANGE),
  2 GSIs (`byPersona`, `byTime`), TTL en `expiresAt` (90 días para CONV).
- **DynamoDB `Sessions`** — `sessionId` HASH, TTL `expiresAt` (legacy, ephemeral).
- **DynamoDB `Personas`** — `ciudadId` HASH + `personaId` RANGE (snapshot inmutable).
- **Router `ApiRouter`** — custom domain `api.sociedad.opitacode.com` (prod) /
  `api-dev.sociedad.opitacode.com` (otros stages).

### Deploy

```bash
cd api
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test -- --run
pnpm sst deploy --stage prod
```

Ver [`DEPLOY-RUNBOOK.md`](../DEPLOY-RUNBOOK.md) para la checklist pre-deploy completa.

### Observabilidad

- **CloudWatch logs**: JSON format, 1 mes retention.
- **EMF metrics**: `dialogue.*`, `rag.*`, `llm.*`, `state.*` namespaces.
- **X-Ray tracing**: activo en Lambda (modo `PassThrough` por default).
- **Alarms**: ver [`DEPLOY-RUNBOOK.md`](../DEPLOY-RUNBOOK.md) sección "Alarms".
  Manifest tipado en [`alarms.config.ts`](alarms.config.ts).

### Cold-start

BGE-M3 q8 ONNX (~600 MB) se carga en cada cold start: **5–8 s** en
contenedor fresco, **50–150 ms** en warm. Mitigación recomendada en
[`runbooks/lambda-cold-start.md`](../runbooks/lambda-cold-start.md):
**Lambda Layer** pre-empaquetando el modelo (Polish R3, Option A).

---

## Troubleshooting

| Síntoma | Runbook |
|---------|---------|
| `400 validation_failed` con `errors: [...]` | [`runbooks/dialogue-errors.md`](../runbooks/dialogue-errors.md) |
| `500 internal_error` mid-stream | [`runbooks/dialogue-errors.md`](../runbooks/dialogue-errors.md) |
| `429` o `ProvisionedConcurrency...` throttles | [`runbooks/dynamodb-throttling.md`](../runbooks/dynamodb-throttling.md) |
| Lambda cold-start > 8 s | [`runbooks/lambda-cold-start.md`](../runbooks/lambda-cold-start.md) |
| Costo de DeepSeek/Lambda > budget | [`runbooks/cost-overrun.md`](../runbooks/cost-overrun.md) |
| `CORPUS_PATH` no existe o es stale | [`runbooks/corpus-rebuild.md`](../runbooks/corpus-rebuild.md) |

---

## Roadmap (Phase 2)

- [ ] `WS /v1/chat` — WebSocket 1:1 con personajes (stateful).
- [ ] `GET /v1/stream` — SSE feed de eventos del pueblo (Ventana live).
- [ ] Per-persona rate limiter (`api/src/llm/per-persona-rate-limiter.ts`)
      sin tocar `rate-limiter.ts`. (Polish R5 WU-5, deferred.)
- [ ] 31 personas restantes (con consentimiento explícito del municipio).
- [ ] LoRA fine-tuning del modelo de embeddings (Phase B, ver
      [`README-FINETUNE.md`](../README-FINETUNE.md)).
- [ ] SnapStart de Lambda (Polish R3, Option B — verificar compat con
      Function URL streaming).

---

## Pointers

- [`../DEPLOY-RUNBOOK.md`](../DEPLOY-RUNBOOK.md) — Runbook canónico de deploy
- [`../RUNBOOKS.md`](../RUNBOOKS.md) — Índice de runbooks operativos
- [`../docs/adr/`](../docs/adr/) — ADRs (decisiones de arquitectura)
- [`../docs/ocais-rag-integration.md`](../docs/ocais-rag-integration.md) —
  Plan de integración OCAIS v2 + RAG
- [`sst.config.ts`](sst.config.ts) — Definición del stack
- [`src/api.ts`](src/api.ts) — Hono app + AWS_PROXY adapter
- [`src/handlers/dialogue.ts`](src/handlers/dialogue.ts) — POST /v1/dialogue
