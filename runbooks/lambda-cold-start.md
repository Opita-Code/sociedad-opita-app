# Runbook — `lambda-cold-start`

> **`POST /v1/dialogue` tarda > 8 s en cold-start, o el TTFB del
> primer request de un visitante es inaceptable.**

**Severidad**: P2 (UX, no afecta funcionalidad)
**Tiempo objetivo de diagnóstico**: < 10 min
**Tiempo objetivo de mitigación**: < 4 h (Lambda Layer build)

---

## Contexto

La Lambda carga **BGE-M3 q8 ONNX** (~600 MB) en cada cold start.
Esto incluye:

- Descarga del modelo (si no está en `/tmp` o en una Layer).
- Extracción del tar/zip.
- Inicialización de `@huggingface/transformers` pipeline.
- Carga del ONNX runtime.

**Baseline medido** (Polish R3): 5–8 s en contenedor fresco.
**Warm** (segundo request dentro de ~15 min): 50–150 ms.

El budget del operador es **< 3 s** de cold-start. Por encima de
eso, el visitante rebota.

---

## Diagnóstico

### 1. Confirmar que el slow TTFB es cold-start, no warm

```bash
# En CloudWatch Logs Insights, comparar primer request de la hora
# vs los siguientes
aws logs start-query \
  --log-group-name /aws/lambda/sociedad-opita-app-ApiFn \
  --start-time $(date -d '1 hour ago' +%s000) \
  --end-time $(date +%s000) \
  --query-string 'fields @timestamp, @duration, @requestId
                  | filter @type = "REPORT"
                  | sort @duration desc
                  | limit 20'
```

Si los 5 requests más lentos son > 5 s y los demás son < 1 s, es
cold-start confirmado.

### 2. ¿Cuánto tarda el cold-start, exactamente?

```bash
# Cold-start duration = BilledDuration - InitDuration
# InitDuration es el tiempo de carga del runtime + código
# (no incluye download del modelo, que aparece como parte de
# InitDuration si está en /tmp, o como "model download" en logs
# de la app).

# Buscar el log line de "Loading BGE-M3"
aws logs filter-log-events \
  --log-group-name /aws/lambda/sociedad-opita-app-ApiFn \
  --filter-pattern "Loading BGE-M3" --start-time $(date -d '1 hour ago' +%s000)
```

Tiempos típicos:

| Fase | Sin Layer | Con Layer |
|------|-----------|-----------|
| Runtime init (Node 22) | 0.3 s | 0.3 s |
| `import('@huggingface/transformers')` | 0.5 s | 0.5 s |
| `pipeline('feature-extraction', ...)` (sin Layer) | 4–7 s (download + extract) | 1.5–2.5 s (extract desde Layer) |
| ONNX runtime init | 0.5 s | 0.5 s |
| **Total** | **5.3–8.3 s** | **2.8–3.8 s** |

---

## Mitigación: Opción A — Lambda Layer (recomendada)

Pre-empaqueta BGE-M3 q8 ONNX como una Lambda Layer y móntala bajo
`/opt/models/`. Set `HF_HOME=/opt/huggingface` para que la pipeline
reuse los pesos pre-extraídos.

### Pros

- Corta el cold-start por 3–5 s.
- Cero costo por invocation.
- Funciona con Function URL (Polish R7 ya lo activa).

### Cons

- El layer zip es ~600 MB.
- 1 paso de deploy adicional.
- Mind el cap de 250 MB split across 5 layers en una cuenta.

### Procedimiento

```bash
# 1. Build del layer (one-time, ~600 MB zip)
mkdir -p /tmp/bge-m3-layer/huggingface
huggingface-cli download Xenova/bge-m3 --include "onnx/*" \
  --local-dir /tmp/bge-m3-layer/huggingface/Xenova/bge-m3

cd /tmp/bge-m3-layer
zip -r ../bge-m3-q8-layer.zip .
cd ..

# 2. Publicar la layer en AWS
aws lambda publish-layer-version \
  --layer-name sociedad-opita-bge-m3-q8 \
  --zip-file fileb://bge-m3-q8-layer.zip \
  --compatible-runtimes nodejs22.x \
  --compatible-architectures arm64

# 3. Wire-up en api/sst.config.ts
#    (ver bloque de código abajo)

# 4. Deploy
cd api
pnpm sst deploy --stage prod

# 5. Medir
curl -w "@%{time_total}\n" -o /dev/null -s \
  https://api.sociedad.opitacode.com/v1/dialogue \
  -X POST -H "Content-Type: application/json" \
  -d '{"persona_id":"dona_rosa_tendera","scene":{"time":"06:00","place":"tienda"},"query":"hola"}'
# Esperado: < 3 s en cold start.
```

### Wire-up en `sst.config.ts`

```ts
const apiFn = new sst.aws.Function("ApiFn", {
  url: true,
  handler: "src/api.handler",
  link: [sessionsTable, personasTable, stateTable],
  layers: [
    // ARN de la layer publicada en el paso 2.
    // Pin a version específica, NO a $LATEST.
    "arn:aws:lambda:us-east-1:123456789012:layer:sociedad-opita-bge-m3-q8:1",
  ],
  environment: {
    // HF_HOME apunta a /opt (donde se montan las layers)
    HF_HOME: "/opt",
    DEEPSEEK_API_KEY: DEEPSEEK_API_KEY_SECRET.value,
    DDB_TABLE: stateTable.name,
    CORPUS_PATH: process.env.CORPUS_PATH || "/tmp/corpus-embeddings.bge-m3-v1.json.gz",
    STAGE: $app.stage,
  },
  // ... resto de la config
});
```

> **Importante**: la pipeline de `@huggingface/transformers` busca
> el modelo en `HF_HOME/<hub>/<repo>/...` — la estructura
> `/opt/huggingface/Xenova/bge-m3/` debe matchear la convención
> de HuggingFace.

---

## Mitigación: Opción B — SnapStart (Phase 2, deferred)

SnapStart snapshot el microVM *después* de que `INIT_ROUTES`
termina, y reuse el snapshot en cold-starts subsiguientes. Latencia
de cold-start cae a **~200 ms**.

### Restricciones (verificar antes de activar)

- SnapStart requiere el **runtime `nodejs22.x`** ✓ (ya estamos ahí).
- SnapStart requiere **AWS X-Ray tracing activo**. SST ya lo
  activa por default.
- SnapStart requiere **`PublishVersion` API**. SST ya lo hace
  automáticamente al hacer deploy.
- **SnapStart NO funciona con Function URL streaming mode
  `RESPONSE_STREAM`**. El modo actual es `BUFFERED` (response
  completa en memoria) — **compatible**. Verificar de nuevo
  después del primer deploy real.

### Costo

- **Por invocation**: igual (sin recargo).
- **Por snapshot storage**: ~$0.03/GB-month. ~600 MB = ~$0.018/mes.
  Despreciable.

### Procedimiento (cuando se active)

```ts
// api/sst.config.ts
const apiFn = new sst.aws.Function("ApiFn", {
  // ... config existente
  snapStart: { applyOn: "PublishedVersions" },
  // ... tracing y publishVersion ya están activos via SST
});
```

---

## Mitigación: Opción C — Provisioned Concurrency (NO recomendado)

Mantiene N instancias de la Lambda **siempre calientes**. Cold-start
= 0 s.

| Memory | Concurrency | Monthly cost |
|--------|-------------|--------------|
| 2048 MB | 1 | ~$22/mes |
| 2048 MB | 3 | ~$66/mes |
| 2048 MB | 10 (cap) | ~$220/mes |

### Veredicto

**Demasiado caro** para el perfil de tráfico actual (10–100
visitantes/día, time-zone concentrado en horas diurnas colombianas,
bursty). Revisar **solo si el tráfico sube a > 1000 visitantes/día**.

---

## Decision matrix (Polish R3)

| Opción | Cold-start | Monthly cost | Operator effort | Risk |
|--------|-----------|--------------|-----------------|------|
| Baseline (sin layer) | 5–8 s | $0 | None | Visitante rebota |
| **A — Layer** | **< 3 s** | **$0 + layer storage** | **Low (4 h)** | **None — recomendado** |
| B — SnapStart | ~0.2 s | ~$0.02 storage | Medium (verificar compat) | Posible incompatibilidad con Function URL |
| C — Provisioned Concurrency | ~0 s | $22–$220 | Low | Alto costo a bajo tráfico |

**Recomendación**: implementar **Opción A** (Lambda Layer) en el
primer deploy prod. Revisar B (SnapStart) si A no es suficiente.

---

## Verificación post-mitigación

Después de aplicar el fix:

```bash
# 1. Forzar cold-start (la Lambda puede estar warm de antes)
#    Esperar 15+ min para que el contenedor expire.
#    O forzar restart con un cambio trivial:
git commit --allow-empty -m "chore: force cold start"
pnpm sst deploy --stage prod

# 2. Medir TTFB del primer request
curl -w "TTFB: %{time_starttransfer}s | Total: %{time_total}s\n" \
  -o /dev/null -s \
  -X POST https://api.sociedad.opitacode.com/v1/dialogue \
  -H "Content-Type: application/json" \
  -d '{"persona_id":"dona_rosa_tendera","scene":{"time":"06:00","place":"tienda"},"query":"hola"}'

# Esperado: < 3 s TTFB en cold start, < 0.5 s warm.
```

Repetir 3-5 veces para confirmar consistencia.

---

## Mitigación temporal: pre-warm con cron

Si la Opción A no se puede hacer inmediatamente y el cold-start
está causando rebote, un workaround temporal es **pre-warm** la
Lambda con un cron que la invoque cada 10 minutos.

```bash
# EventBridge rule → Lambda invoke cada 10 min
aws events put-rule \
  --name sociedad-opita-prewarm \
  --schedule-expression "rate(10 minutes)"

aws events put-targets \
  --rule sociedad-opita-prewarm \
  --targets "Id"="1","Arn"="arn:aws:lambda:us-east-1:123456789012:function:sociedad-opita-app-ApiFn","Input"='{"prewarm":true}'
```

**Costo**: ~144 invocations/día × 2048 MB × 0.5 s = $0.01/día.
**Aceptable** como mitigación temporal de 1-2 semanas. No como
solución permanente.

> **Lambda self-invocation issue**: si la Lambda se invoca a sí
> misma, el event loop puede atascarse. La Lambda tiene que
> responder a un ping sin hacer trabajo pesado. Configurar la
> handler para que `prewarm: true` retorne `200 OK` sin tocar
> OCAIS ni DDB.

---

## Pointers

- [`api/src/rag/embed-query.ts`](../api/src/rag/embed-query.ts) — Carga BGE-M3
- [`api/sst.config.ts`](../api/sst.config.ts) — `memory: "2048 MB"`, `timeout: "60 seconds"`
- [`DEPLOY-RUNBOOK.md`](../DEPLOY-RUNBOOK.md) — Sección "Lambda cold-start optimization"
- [ADR-0003: BGE-M3 + LoRA fine-tune](docs/adr/0003-bge-m3-plus-lora-finetune.md) — Por qué BGE-M3 ONNX
