# Runbook — `dynamodb-throttling`

> **`ProvisionedThroughputExceededException` en la tabla
> `SociedadOpitaState` (o sus GSIs).**

**Severidad**: P1 (latencia + posible 5xx)
**Tiempo objetivo de diagnóstico**: < 10 min
**Tiempo objetivo de mitigación**: < 30 min

---

## Quick reference

| Síntoma | Causa probable | Sección |
|---------|----------------|---------|
| Latencia > 500 ms en `GetItem`/`PutItem` | Hot partition en una `pk` | [§1](#1-diagnóstico-rápido) |
| `ThrottlingException` consistente en una GSI | GSI hot partition (e.g., `byPersona` skew) | [§2](#2-gsi-hot-partition) |
| `ThrottlingException` aleatorio | Throughput provisioned insuficiente | [§3](#3-throughput-insuficiente) |
| Throttles solo en deploy/cleanup | Backfill loop | [§4](#4-backfill-loop) |
| Throttles masivos (> 100/s) | Abuse o runaway loop | [§5](#5-abuse--runaway-loop) |

---

## Diagnóstico rápido

```bash
# 1. Confirmar que el throttle viene de DDB y no de otro servicio
aws logs filter-log-events \
  --log-group-name /aws/lambda/sociedad-opita-app-ApiFn \
  --filter-pattern "ProvisionedThroughputExceededException" \
  --start-time $(date -d '15 min ago' +%s000) | head -20

# 2. Identificar QUÉ operación falla
# Patrones comunes en el log:
#   - "Failed operation: GetItem"     → Read throttle
#   - "Failed operation: PutItem"     → Write throttle
#   - "Failed operation: Query"       → GSI throttle

# 3. Métricas CloudWatch (última hora)
aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB \
  --metric-name ThrottledRequests \
  --dimensions Name=TableName,Value=SociedadOpitaState \
  --start-time $(date -d '1 hour ago' -u +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 60 --statistics Sum

# 4. Ver qué GSI está hot
aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB \
  --metric-name ConsumedWriteCapacityUnits \
  --dimensions Name=TableName,Value=SociedadOpitaState Name=GlobalSecondaryIndex,Value=byPersona \
  --start-time $(date -d '1 hour ago' -u +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 60 --statistics Sum
```

---

## 1. Hot partition en `pk`

### Síntoma

Throttles **consistentes** en operaciones sobre un subset de items.
Típicamente:

- Un usuario hace 100 requests/min al mismo `persona_id`.
- Un script de backfill escribe 10K items con la misma `pk`.

### Diagnóstico

```bash
# Buscar el trace_id del request que throttleó
aws logs filter-log-events \
  --log-group-name /aws/lambda/sociedad-opita-app-ApiFn \
  --filter-pattern "throttled" --start-time $(date -d '5 min ago' +%s000) | \
  jq '.events[].message' | grep -oE 'pk=[^,]+' | sort | uniq -c | sort -rn | head
```

### Causa

DynamoDB particiona por `pk` HASH. Si una `pk` recibe
disproporcionadamente más throughput que otras, esa partición se
satura aunque el throughput total de la tabla esté bien.

### Mitigación inmediata

1. **Backoff exponencial con jitter** en el código
   ([`api/src/state/dynamo-client.ts`](../api/src/state/dynamo-client.ts)).
   El SDK de `@aws-sdk/lib-dynamodb` v3 tiene retry automático,
   pero **sin jitter** por default. Configurar jitter:
   ```ts
   import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
   const client = new DynamoDBClient({
     region: "us-east-1",
     maxAttempts: 5,
     retryMode: "adaptive",  // ← adaptive incluye jitter
   });
   ```
2. **Rate-limiter per-persona** (Polish R5 WU-5, deferred a Phase 2):
   `api/src/llm/per-persona-rate-limiter.ts`. Documentado en
   [`DEPLOY-RUNBOOK.md`](../DEPLOY-RUNBOOK.md) sección "Deferred".

### Mitigación durable

- **Shard write pattern**: si una `pk` está caliente, dividir en N
  shards con `pk#0`, `pk#1`, ..., `pk#N` y elegir shard con
  hash modulo. Solo si el patrón persiste > 24h.
- **DAX cache** (Phase 2): cachea reads de items frecuentes.
  Reduce reads hasta 10x. ~$0.04/hora additional cost.

---

## 2. GSI hot partition

### Síntoma

`ThrottledRequests` reportados específicamente en `byPersona` o
`byTime` GSI, no en la tabla base.

### Causa

Los GSIs en DynamoDB tienen su **propio throughput provisioned**,
separado de la tabla base. La tabla puede estar OK pero un GSI
estar saturado.

GSI `byPersona`:
- `personaId` (HASH) + `sk` (RANGE)
- Patrón de acceso: "todos los eventos de esta persona en orden"
- Skew probable: una persona muy popular (Doña Rosa) tiene
  muchos más items que otras.

GSI `byTime`:
- `tsBucket` (HASH, e.g., "2026-06") + `ts` (RANGE)
- Patrón de acceso: "eventos del pueblo en junio 2026"
- Skew probable: el bucket del mes actual concentra escrituras.

### Diagnóstico

```bash
# Ver consumo por GSI
aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB \
  --metric-name ConsumedWriteCapacityUnits \
  --dimensions Name=TableName,Value=SociedadOpitaState \
              Name=GlobalSecondaryIndex,Value=byPersona \
  --start-time $(date -d '1 hour ago' -u +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 60 --statistics Sum,Average
```

### Mitigación

1. **Adaptive capacity**: DynamoDB automáticamente escala
   particiones "calientes" dentro del throughput total de la tabla
   base. Si el GSI está en el mismo provisioned, **el adaptive
   capacity lo rescata** siempre y cuando la tabla base no esté
   al 100%.
2. **Bajar el ratio de proyección del GSI**: el GSI `byPersona`
   proyecta solo `personaId` y `sk`. Si proyecta todo el item,
   cada write al GSI cuesta más. Ya está optimizado.
3. **Sparse GSI trick** (Phase 2): añadir un campo `gsi2pk` que
   solo existe en items que se consultan por time bucket. Reduce
  escrituras al GSI en ~80%.

### Auto-scaling

La tabla en `sst.config.ts` está configurada con auto-scaling
**explícito** (Polish R7 documenta el plan; pendiente wire-up en
[`api/alarms.config.ts`](../api/alarms.config.ts)). Mientras
tanto, el throughput es fijo (5 WCU / 5 RCU). Si ves throttles
sostenidos > 1 hora:

```bash
# Aumentar throughput manualmente (one-time, hasta el wire-up de auto-scaling)
aws dynamodb update-table \
  --table-name SociedadOpitaState \
  --provisioned-throughput ReadCapacityUnits=10,WriteCapacityUnits=10
```

> **Costo**: doblar el provisioned cuesta ~$3/mes. Aceptable como
> mitigación temporal.

---

## 3. Throughput insuficiente

### Síntoma

Throttles **aleatorios** distribuidos en toda la tabla, no skew
visible. Throughput consumed > provisioned.

### Causa

El baseline de 5 WCU/5 RCU es insuficiente para el tráfico actual.
Esto pasa si:

- Tráfico de chat subió (Phase 2 live, con WebSockets).
- Backfill masivo en proceso.
- Test E2E con muchas escrituras en poco tiempo.

### Mitigación

```bash
# Medir consumo actual
aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB \
  --metric-name ConsumedWriteCapacityUnits \
  --dimensions Name=TableName,Value=SociedadOpitaState \
  --start-time $(date -d '1 day ago' -u +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 3600 --statistics Maximum

# Si Max ≈ 5 (el provisioned), aumentar
aws dynamodb update-table \
  --table-name SociedadOpitaState \
  --provisioned-throughput ReadCapacityUnits=20,WriteCapacityUnits=20
```

> **Mitigación durable**: wire-up de auto-scaling en
> `sst.config.ts`. Documentado en [`DEPLOY-RUNBOOK.md`](../DEPLOY-RUNBOOK.md)
> sección "Alarms" — sigue en TODO.

---

## 4. Backfill loop

### Síntoma

Throttles **solo durante deploys o scripts de backfill** (e.g.,
[`runbooks/corpus-rebuild.md`](corpus-rebuild.md) escribiendo
metadata a DDB).

### Causa

El script escribe 10K items en < 1 minuto, lo cual excede el
throughput provisioned.

### Mitigación

En el script, añadir sleep entre batches:

```python
import time

BATCH = 25  # DynamoDB BatchWriteItem max
for chunk in chunks(corpus_items, BATCH):
    dynamodb.batch_write_item(RequestItems={...})
    time.sleep(0.5)  # 25 items / 0.5s = 50 WCU, suficiente para 5 provisioned con retry
```

O mejor, usar `BatchWriteItem` con retry de `UnprocessedItems`.

---

## 5. Abuse / runaway loop

### Síntoma

Throttles masivos (> 100/s) sin tráfico legítimo correspondiente.
Típicamente coincide con un spike en `ConcurrentExecutions` de Lambda.

### Causa

- Bot scrapea `/v1/dialogue` con un loop.
- Cliente con bug que no debouncea (envía 10 requests/s).
- Concurrency de Lambda al cap (10), cada uno escribiendo a DDB.

### Mitigación inmediata

```bash
# 1. Identificar la IP origen (si el rate-limiter tiene telemetría)
aws logs filter-log-events \
  --log-group-name /aws/lambda/sociedad-opita-app-ApiFn \
  --filter-pattern "rate_limited" --start-time $(date -d '5 min ago' +%s000) | \
  jq -r '.events[].message' | grep -oE 'ip=[^,]+' | sort | uniq -c | sort -rn | head

# 2. Bajar reserved concurrency temporalmente (cap más agresivo)
aws lambda put-function-concurrency \
  --function-name sociedad-opita-app-ApiFn \
  --reserved-concurrent-executions 2

# Esto hace que Lambda throttlle EN LA LAMBDA, no en DDB.
# El rate-limiter per-IP (en api/src/llm/rate-limiter.ts) hace
# el resto: 10/min per-IP.

# 3. Si es una IP específica, bloquear en CloudFront (si se sirve
#    la API por ahí) o en el WAF. La API va por Function URL, no
#    por CloudFront → WAF no aplica. Bloquear con VPC + NACL es
#    excesivo para Phase 1.
```

### Mitigación durable

- **Rate-limiter per-persona** (Phase 2): ver
  [`DEPLOY-RUNBOOK.md`](../DEPLOY-RUNBOOK.md) sección "Deferred".
- **WAF delante de Function URL**: AWS WAF se puede asociar a
  Function URLs desde 2024. Documentar y activar en Phase 2.

---

## Post-mortem

Después de resolver el throttle:

1. Abrir issue con: timestamp, throughput consumed, throughput
   provisioned, operación que throttleó, mitigation aplicada.
2. Si el throttle duró > 1h, considerar un ADR explicando por qué
   el throughput baseline es insuficiente y cómo prevenirlo.
3. Si fue abuse, considerar bloquear la IP o activar WAF.

---

## Pointers

- [`api/src/state/dynamo-client.ts`](../api/src/state/dynamo-client.ts) — Client tipado
- [`api/src/state/schema.ts`](../api/src/state/schema.ts) — `pk`/`sk` design
- [`api/sst.config.ts`](../api/sst.config.ts) — `SociedadOpitaState` config
- [`api/alarms.config.ts`](../api/alarms.config.ts) — DDB alarms
- [ADR-0004: Single-table DynamoDB](docs/adr/0004-single-table-dynamodb.md) — Por qué este diseño
- [`DEPLOY-RUNBOOK.md`](../DEPLOY-RUNBOOK.md) — Sección "Alarms"
