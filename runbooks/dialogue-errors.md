# Runbook — `dialogue-errors`

> **`POST /v1/dialogue` retorna 4xx/5xx, o el stream SSE se rompe
> mid-flight.**

**Severidad**: P1 (funcional degradado)
**Tiempo objetivo de diagnóstico**: < 15 min
**Tiempo objetivo de mitigación**: < 1 h

---

## Quick reference

| Síntoma | HTTP | Sección |
|---------|------|---------|
| Body malformado | 400 `invalid_json` | [§1](#1-400-invalid_json) |
| Campo fuera de whitelist | 400 `validation_failed` | [§2](#2-400-validation_failed) |
| `persona_id` no existe | 404 `persona_not_found` | [§3](#3-404-persona_not_found) |
| Error mid-handler (corpus/embed/context/state) | 500 `internal_error` | [§4](#4-500-internal_error) |
| Error mid-stream SSE | `data: {"error":"stream_error",...}` | [§5](#5-stream_error-mid-flight) |
| Cliente cierra antes del `done` | (no error, OCAIS aborta) | [§6](#6-cliente-aborta-antes-de-done) |

---

## 1. `400 invalid_json`

### Síntoma

```json
{ "error": "invalid_json" }
```

### Causa

El body del request no es JSON válido. Típico:

- `Content-Type` incorrecto (e.g., `text/plain` en vez de
  `application/json`).
- JSON con `,` trailing.
- Body vacío (`""` o `null`).
- Body con encoding incorrecto (UTF-16 BOM).

### Diagnóstico

```bash
# Reproducir con un body inválido
curl -X POST https://api.sociedad.opitacode.com/v1/dialogue \
  -H "Content-Type: application/json" \
  -d 'persona_id, scene}'  # ← JSON malformado
# → {"error":"invalid_json"}
```

### Fix

1. Verifica el `Content-Type: application/json` en el request.
2. Valida el JSON con `jq` antes de enviar:
   ```bash
   echo '{"persona_id":"dona_rosa_tendera","scene":{...},"query":"..."}' | jq .
   ```
3. Si el cliente es JavaScript, usa `JSON.stringify(obj)` y
   `fetch(url, { method: "POST", body: JSON.stringify(obj),
   headers: {"Content-Type":"application/json"} })`.

### Prevención

- Cliente: tests E2E con bodies válidos.
- Backend: el validator ([`api/src/handlers/validation.ts`](../api/src/handlers/validation.ts))
  es estricto. Si el cliente ve este error, es un bug del cliente,
  no del backend.

---

## 2. `400 validation_failed`

### Síntoma

```json
{
  "error": "validation_failed",
  "errors": [
    "persona_id must be a non-empty string",
    "scene.time must match /^\\d{2}:\\d{2}$/",
    "query length 1234 exceeds max 1000",
    "query contains control characters",
    "conv_id must match /^[A-Za-z0-9_-]{1,64}$/"
  ]
}
```

### Causa

Uno o más campos no cumplen el schema. Reglas (Polish R5):

| Campo | Regla |
|-------|-------|
| `persona_id` | string, no vacío, **whitelist** de `api/src/personas.ts` |
| `scene.time` | regex `^\d{2}:\d{2}$` (e.g., `"06:00"`, no `"6:00 AM"`) |
| `scene.place` | string, 1–200 chars |
| `scene.weather` | opcional, string, 1–100 chars |
| `query` | string, 1–1000 chars, sin control chars |
| `conv_id` | opcional, regex `^[A-Za-z0-9_-]{1,64}$` |

### Diagnóstico

```bash
# Test con campo faltante
curl -X POST https://api.sociedad.opitacode.com/v1/dialogue \
  -H "Content-Type: application/json" \
  -d '{"persona_id":"dona_rosa_tendera","query":"hola"}'
# → errors: ["scene is required", ...]

# Test con persona_id fuera de whitelist
curl -X POST https://api.sociedad.opitacode.com/v1/dialogue \
  -H "Content-Type: application/json" \
  -d '{"persona_id":"hacker_prompt","scene":{"time":"06:00","place":"tienda"},"query":"hola"}'
# → errors: ["persona_id must be one of: don_rosalio_ganadero, dona_rosa_tendera, ..."]
```

### Fix

1. Corrige el campo según el mensaje de error.
2. Si `persona_id` debe ser válido pero el validator lo rechaza,
   es que la persona **no está en la whitelist** de Phase 1. Solo
   las 10 personas en `api/src/personas.ts` son válidas. Las 31
   restantes requieren consent + Phase 2.

### Edge cases cubiertos por tests

Ver [`api/tests/handlers/validation-edge-cases.test.ts`](../api/tests/handlers/validation-edge-cases.test.ts)
— 18+ edge cases. Si ves un caso no cubierto, es un *bug* del
validator: añadir test primero, después el fix.

---

## 3. `404 persona_not_found`

### Síntoma

```json
{ "error": "persona_not_found", "persona_id": "hacker_prompt" }
```

### Causa

`persona_id` pasa la regex pero no está en el array `TELLO_PERSONAS`
de `api/src/personas.ts`. **No es lo mismo** que `validation_failed`
— el validator acepta el formato pero el lookup falla.

### Diagnóstico

```bash
# Listar personas válidas
curl https://api.sociedad.opitacode.com/v1/personas/tello | jq '.personas[].persona_id'
# → "don_rosalio_ganadero"
# → "dona_rosa_tendera"
# → "padre_cecilio_sacerdote"
# → ... (10 total)
```

### Fix

1. Usa uno de los IDs válidos del listado anterior.
2. Si necesitas una persona nueva, agrégala a
   `api/src/personas.ts` con todos los campos psicométricos. Esto
   es un cambio de código → PR separado.

---

## 4. `500 internal_error`

### Síntoma

```json
{ "error": "internal_error", "message": "..." }
```

### Causa

Una de las cuatro fases del handler falló:

1. **Corpus load** — `loadCorpus()` no encontró `corpus-embeddings.bge-m3-v1.json.gz`.
2. **Embed query** — `embedQuery()` falló cargando BGE-M3 ONNX.
3. **RAG retrieve** — cosine similarity excepción (típicamente shape mismatch).
4. **State load** — `getPersonaState()` falló contactando DDB.
5. **Context build** — `buildContext()` excepción (raro, schema mismatch).

### Diagnóstico

```bash
# Tail de CloudWatch logs filtrando por el request
aws logs tail /aws/lambda/sociedad-opita-app-ApiFn --follow \
  | grep -A 20 "internal_error"

# Buscar el trace_id del request
aws logs filter-log-events \
  --log-group-name /aws/lambda/sociedad-opita-app-ApiFn \
  --filter-pattern "ERROR" --start-time $(date -d '10 min ago' +%s000)
```

Mensajes comunes:

| Mensaje | Causa | Sección |
|---------|-------|---------|
| `CORPUS_PATH ... not found` | Corpus no en `/tmp` ni en S3 | [§4.1](#41-corpus-not-found) |
| `Failed to load BGE-M3` | Cold-start falló | [`runbooks/lambda-cold-start.md`](lambda-cold-start.md) |
| `ThrottlingException` | DDB throttle | [`runbooks/dynamodb-throttling.md`](dynamodb-throttling.md) |
| `Cannot read properties of undefined` | Bug en `buildContext` | Revisar `api/src/context/builder.ts` |

### 4.1 Corpus not found

**Causa**: el archivo `corpus-embeddings.bge-m3-v1.json.gz` no está
en la ubicación esperada. Por default:
`/tmp/corpus-embeddings.bge-m3-v1.json.gz` (Lambda) o
`references/markitdown-corpus/corpus-embeddings.bge-m3-v1.json.gz`
(local dev).

**Fix**:

1. Verificar que la env var `CORPUS_PATH` apunta a un archivo
   existente.
2. Si el archivo no existe, seguir
   [`runbooks/corpus-rebuild.md`](corpus-rebuild.md) para regenerarlo.
3. Si el archivo existe pero está corrupto (no descomprime, no es
   JSON válido), regenerar.

### Mitigación inmediata

Si no puedes resolver en 5 min:

```bash
# Rollback al último deploy bueno
cd api
git checkout v0.1.0  # o el último tag bueno
pnpm sst deploy --stage prod
git checkout main
```

Ver [`DEPLOY-RUNBOOK.md`](../DEPLOY-RUNBOOK.md) sección "Rollback".

---

## 5. `stream_error` mid-flight

### Síntoma

El response es `text/event-stream` y el cliente recibe:

```
data: {"text":"Mire "}

data: {"text":"ve, "}

data: {"error":"stream_error","message":"..."}
```

(El stream se cierra inmediatamente).

### Causa

OCAIS (`streamText`) lanzó una excepción durante la generación. Las
causas más comunes:

1. **DeepSeek rate-limit** (429 upstream). El provider en
   [`api/src/llm/provider.ts`](../api/src/llm/provider.ts) hace
   retry con backoff exponencial (3 intentos). Si los 3 fallan,
   emite `stream_error`.
2. **DeepSeek API key inválida** (401). El provider emite
   `stream_error` con `message: "Incorrect API key"`.
3. **DeepSeek server error** (5xx). Retry, pero si persistente,
   stream_error.
4. **Network timeout**. El provider tiene `timeoutMs: 30000` (30s).

### Diagnóstico

```bash
# Buscar el error específico
aws logs filter-log-events \
  --log-group-name /aws/lambda/sociedad-opita-app-ApiFn \
  --filter-pattern "stream_error" --start-time $(date -d '10 min ago' +%s000)

# Verificar status de DeepSeek
curl -I https://api.deepseek.com/v1/models
# Si 5xx → DeepSeek está caído, esperar.
```

### Fix

1. **Si DeepSeek está caído** ([status.deepseek.com](https://status.deepseek.com)):
   esperar el incidente. No hay fix local.
2. **Si la API key es inválida**:
   ```bash
   cd api
   pnpm sst secret set DeepSeekApiKey sk-<NEW_KEY>
   pnpm sst deploy --stage prod
   ```
3. **Si es rate-limit persistente** (nuestro lado):
   - Verificar que `api/src/llm/rate-limiter.ts` está en su config
     default (10/minute per-IP).
   - Si es un ataque, considerar bajar el `reservedConcurrency`
     en `sst.config.ts`.

### Frontend handling

El cliente debe cerrar el SSE limpiamente cuando recibe
`stream_error`. El patrón en `web/src/pages/puente.astro` (cuando
se conecte al backend) debe ser:

```js
eventSource.addEventListener("error", (e) => {
  if (e.data?.error === "stream_error") {
    showUserError("El pueblo no responde. Intenta de nuevo en un minuto.");
    eventSource.close();
  }
});
```

---

## 6. Cliente aborta antes de `done`

### Síntoma

No hay error visible. El cliente cierra el tab o navega away
mientras el stream está abierto.

### Causa

El navegador cierra el `EventSource`. La Lambda está generando
texto. El código en
[`api/src/handlers/dialogue.ts`](../api/src/handlers/dialogue.ts)
(Polish R5, OCAIS v2.0.1) detecta el cierre y emite un `done` con
`aborted: true`. El `controller.close()` se llama limpiamente, no
quedan promesas colgadas.

### ¿Es un problema?

No. Es comportamiento esperado. CloudWatch metrics pueden mostrar
que la duración de la Lambda excede el tiempo de respuesta del
cliente — eso es normal. La Lambda sigue hasta `done` o el
timeout (60s), luego termina.

### Acción

Nada. Monitorear `ConcurrentExecutions` para detectar acumulación
de Lambdas zombie. El cap de 10 (Polish R7) previene el abuse.

---

## Escalación

Si después de 30 min no resuelves:

1. **P0** (servicio caído, 5xx rate > 5%): rollback al último
   deploy bueno (ver [`DEPLOY-RUNBOOK.md`](../DEPLOY-RUNBOOK.md)).
2. **P1** (feature degradada): abrir issue en GitHub con
   `trace_id` + `request_id` + logs relevantes.
3. **P2** (cosmetic): posponer al próximo sprint.

---

## Pointers

- [`api/src/handlers/dialogue.ts`](../api/src/handlers/dialogue.ts) — handler
- [`api/src/handlers/validation.ts`](../api/src/handlers/validation.ts) — validator
- [`api/src/llm/provider.ts`](../api/src/llm/provider.ts) — OCAIS wrapper
- [`api/src/llm/cost-tracker.ts`](../api/src/llm/cost-tracker.ts) — cost tracking
- [`api/src/rag/retrieve.ts`](../api/src/rag/retrieve.ts) — RAG
- [`api/src/state/persona-state.ts`](../api/src/state/persona-state.ts) — state
- [`api/tests/handlers/dialogue.test.ts`](../api/tests/handlers/dialogue.test.ts) — tests
- [`DEPLOY-RUNBOOK.md`](../DEPLOY-RUNBOOK.md) — Rollback
- [`runbooks/lambda-cold-start.md`](lambda-cold-start.md) — Cold-start
- [`runbooks/corpus-rebuild.md`](corpus-rebuild.md) — Corpus
