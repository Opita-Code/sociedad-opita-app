# Runbook — `cost-overrun`

> **Costo diario de AWS > $5, o factura mensual > $25, o DeepSeek
> bill se dispara.**

**Severidad**: P0 (dinero saliendo)
**Tiempo objetivo de diagnóstico**: < 10 min
**Tiempo objetivo de mitigación**: < 30 min

---

## Quick reference

| Síntoma | Causa probable | Sección |
|---------|----------------|---------|
| Lambda bill sube | Concurrency cerca del cap o duración excesiva | [§1](#1-lambda-bill) |
| DDB bill sube | Hot partition o WCU/RCU sobre-provisioned | [§2](#2-dynamodb-bill) |
| DeepSeek bill sube | Loop de cliente o abuso | [§3](#3-deepseek-bill) |
| CloudFront bill sube | Cache miss rate sube | [§4](#4-cloudfront-bill) |
| S3 bill sube | GET/PUT inusual (raro) | [§5](#5-s3-bill) |

---

## Diagnóstico rápido

### Billing console (autoridad)

```bash
# Ver el costo del día (delay de ~8h, pero es la verdad)
aws ce get-cost-and-usage \
  --time-period Start=$(date -d '7 days ago' +%Y-%m-%d),End=$(date +%Y-%m-%d) \
  --granularity DAILY \
  --metrics "UnblendedCost" \
  --group-by Type=DIMENSION,Key=SERVICE
```

### CloudWatch metrics (tiempo real, last 24h)

```bash
# Costo estimado (suma de los cargos AWS)
aws cloudwatch get-metric-statistics \
  --namespace AWS/Billing \
  --metric-name EstimatedCharges \
  --dimensions Name=Currency,Value=USD \
  --start-time $(date -d '1 day ago' -u +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 3600 --statistics Maximum

# Lambda invocations (debería ser 10-100/día, si es 10K hay abuse)
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda \
  --metric-name Invocations \
  --dimensions Name=FunctionName,Value=sociedad-opita-app-ApiFn \
  --start-time $(date -d '1 day ago' -u +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 3600 --statistics Sum

# Lambda concurrent (cap es 10, si es 9-10 hay concurrency alta)
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda \
  --metric-name ConcurrentExecutions \
  --dimensions Name=FunctionName,Value=sociedad-opita-app-ApiFn \
  --start-time $(date -d '1 day ago' -u +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 300 --statistics Maximum
```

### Cost cap

El proyecto tiene **dos líneas de defensa** contra costo
descontrolado:

1. **Reserved concurrency = 10** (Polish R7, hard cap en Lambda).
2. **Cost budget $25/mes** (Polish R7, planificado en
   [`api/alarms.config.ts`](../api/alarms.config.ts) — pendiente
   wire-up).

Si algo pasa, es porque el cap falló o el abuse es muy lento (no
alcanza el cap de concurrency pero se acumula en el tiempo).

---

## 1. Lambda bill

### Síntoma

Costo de Lambda sube de ~$0.50/día a > $2/día. Lambda invocations
o duración P95 suben.

### Causa probable

- **Runaway loop** en el cliente (e.g., 1000 requests/día en vez
  de 100).
- **BGE-M3 cold-start excesivo** (cada cold start = 5–8 s × 2048 MB
  = ~$0.0002; si son 1000 cold starts/día, son $0.20/día solo en
  cold starts).
- **Duration P95 muy alto** (> 30s típico, > 60s = timeout =
  full cost).

### Diagnóstico

```bash
# Ver P95 de duración
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda \
  --metric-name Duration \
  --dimensions Name=FunctionName,Value=sociedad-opita-app-ApiFn \
  --start-time $(date -d '1 day ago' -u +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 3600 --statistics p95

# Ver throttles (si está en 9/10 concurrency, hay demanda reprimida)
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda \
  --metric-name Throttles \
  --dimensions Name=FunctionName,Value=sociedad-opita-app-ApiFn \
  --start-time $(date -d '1 day ago' -u +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 3600 --statistics Sum
```

### Mitigación

1. **Si el problema es cold-start** (cada visita es un cold start):
   sigue [`runbooks/lambda-cold-start.md`](lambda-cold-start.md) —
   Lambda Layer con modelo pre-empaquetado baja cold-start de
   5–8s a < 3s.
2. **Si el problema es loop/abuse**:
   - Bajar reserved concurrency a 2 temporalmente:
     ```bash
     aws lambda put-function-concurrency \
       --function-name sociedad-opita-app-ApiFn \
       --reserved-concurrent-executions 2
     ```
   - Activar el rate-limiter per-IP más agresivo (en
     [`api/src/llm/rate-limiter.ts`](../api/src/llm/rate-limiter.ts),
     cambiar `capacity` de 10 a 3).
   - Identificar la IP origen y bloquear en el WAF (cuando esté
     disponible) o vía contact-form de abuse a AWS.
3. **Si el problema es duration P95** (> 30s):
   - Bump memory a 3008 MB (CPU escala con memory). Cuesta más
     por GB-s pero termina más rápido.
   - Investigar qué está tardando: ¿embedQuery? ¿DeepSeek?

---

## 2. DynamoDB bill

### Síntoma

Costo de DDB sube de ~$0.10/día a > $1/día. ThrottledRequests o
ConsumedCapacity suben.

### Causa probable

- **Hot partition** en un GSI (Doña Rosa recibe 1000 requests/día
  en `byPersona`).
- **WCU/RCU sobre-provisioned** (cambió Phase 2 con tráfico live).
- **Backfill loop** ([`runbooks/dynamodb-throttling.md`](dynamodb-throttling.md) §4).

### Diagnóstico

Ver [`runbooks/dynamodb-throttling.md`](dynamodb-throttling.md)
sección 1-5. La metodología es la misma: identificar el patrón y
aplicar backoff/sharding.

### Mitigación

1. **Bajar WCU/RCU** si la tabla está sobre-provisioned (5 WCU/5 RCU
   default):
   ```bash
   aws dynamodb update-table \
     --table-name SociedadOpitaState \
     --provisioned-throughput ReadCapacityUnits=5,WriteCapacityUnits=5
   # Si está actualmente en 20/20, bajar reduce el costo 4x.
   ```
2. **Adaptive capacity** ya está activo (DDB lo hace solo). Confirma
   que el patrón no es *consistente* — si es consistente, el problema
   es de diseño (hot partition real).

---

## 3. DeepSeek bill

### Síntoma

Costo de DeepSeek (no es AWS, está en
[platform.deepseek.com](https://platform.deepseek.com) → Usage) sube
de ~$0.01/día a > $0.50/día.

### Causa probable

- **Loop en el cliente** que no debouncea (envía 100 questions
  seguidas a Doña Rosa).
- **Abuse** (bot scrapea el endpoint).
- **Cambio de modelo** (e.g., de `deepseek-chat` a `deepseek-reasoner`
  que cuesta 15x más).

### Diagnóstico

```bash
# Tail de logs buscando el patrón
aws logs filter-log-events \
  --log-group-name /aws/lambda/sociedad-opita-app-ApiFn \
  --filter-pattern "deepseek" --start-time $(date -d '1 day ago' +%s000) | \
  jq -r '.events[].message' | grep -oE 'cost_usd=[0-9.]+' | awk -F'=' '{sum+=$2} END {print "Total cost 24h: $"sum}'

# Ver el panel de DeepSeek directamente
# https://platform.deepseek.com/usage
```

### Mitigación

1. **Bajar reserved concurrency a 2** (igual que Lambda bill §1).
2. **Verificar que el rate-limiter per-IP está activo** (10/minute
   default, suficiente para 1 usuario pero no para un bot).
3. **Forzar modelo más barato en `api/src/llm/provider.ts`**:
   ```ts
   model: body.model || "deepseek-chat",  // NO usar "deepseek-reasoner" por default
   ```
4. **Cap de tokens de output en el system prompt**:
   ```ts
   const system = `... Responde en máximo 150 palabras.`;
   ```
   Reduce tokens_out, que es lo que más cuesta.
5. **Si es abuse confirmado**: rotar la API key
   (`pnpm sst secret set DeepSeekApiKey sk-<NEW>`) y bloquear la IP.

---

## 4. CloudFront bill

### Síntoma

Costo de CloudFront sube de ~$0.50/día a > $2/día. Cache miss rate
sube o tráfico total sube.

### Causa probable

- **DDoS / scraper agresivo** al frontend.
- **Cambio de cache policy** (Polish R3: `max-age=86400` + SWR=7d,
  miss rate debería ser < 1% en steady state).
- **Tráfico legítimo masivo** (e.g., enlace viral en redes).

### Diagnóstico

```bash
# Ver requests por distribution
aws cloudwatch get-metric-statistics \
  --namespace AWS/CloudFront \
  --metric-name Requests \
  --dimensions Name=DistributionId,Value=$CLOUDFRONT_DISTRIBUTION_ID \
  --start-time $(date -d '1 day ago' -u +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 3600 --statistics Sum

# Cache hit rate (debería ser > 95%)
aws cloudwatch get-metric-statistics \
  --namespace AWS/CloudFront \
  --metric-name CacheHitRate \
  --dimensions Name=DistributionId,Value=$CLOUDFRONT_DISTRIBUTION_ID \
  --start-time $(date -d '1 day ago' -u +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 3600 --statistics Average
```

### Mitigación

1. **Si es tráfico legítimo viral** (felicidades): no mitigues.
   El cache policy con SWR=7d debería mantener el bill manejable.
2. **Si es abuse/scraper**:
   - Activar WAF (rate-based rule, 100 req / 5 min por IP).
   - Cambiar el dominio a uno nuevo y dejar que el viejo expire.
3. **Si cache hit rate bajó** (de 99% a 80%):
   - Verifica que `max-age` y `SWR` están en los headers.
   - Verifica que no hay `Cache-Control: no-store` en algún path.

---

## 5. S3 bill

### Síntoma

Costo de S3 sube. Raro, porque el sitio es estático y la mayoría
de requests van por CloudFront (no por S3 directo).

### Causa probable

- **S3 access directo** (sin CloudFront). Verificar que el bucket
  sigue con OAI y no público.
- **Almacenamiento excesivo** (e.g., deploys no eliminando versiones
  viejas).

### Diagnóstico

```bash
# Ver tamaño del bucket
aws s3api list-objects-v2 \
  --bucket sociedad-opita-app-prod \
  --query "sum(Contents[].Size)" --output text | \
  awk '{ printf "%.1f MB\n", $1/1024/1024 }'

# Si es > 100 MB sin razón, hay versiones viejas acumulándose
```

### Mitigación

```bash
# Habilitar lifecycle policy para limpiar versiones viejas
aws s3api put-bucket-lifecycle-configuration \
  --bucket sociedad-opita-app-prod \
  --lifecycle-configuration '{
    "Rules": [{
      "Id": "cleanup-old-versions",
      "Status": "Enabled",
      "NoncurrentVersionExpiration": { "NoncurrentDays": 30 }
    }]
  }'
```

---

## Cap absoluto: el botón nuclear

Si nada funciona y el bill está fuera de control:

```bash
# 1. Poner la Lambda concurrency en 0 (la API deja de responder)
aws lambda put-function-concurrency \
  --function-name sociedad-opita-app-ApiFn \
  --reserved-concurrent-executions 0

# 2. Invalidar CloudFront (el frontend sigue, pero no carga nuevos assets)
aws cloudfront create-invalidation \
  --distribution-id $CLOUDFRONT_DISTRIBUTION_ID --paths "/*"

# 3. Rotar el secret de DeepSeek
cd api
pnpm sst secret set DeepSeekApiKey sk-DISABLED
pnpm sst deploy --stage prod

# Esto deja:
# - Frontend servido desde CloudFront cache (gratis, hasta expirar SWR).
# - API respondiendo 429 (concurrency=0).
# - DeepSeek bloqueado (key inválida).
```

Después, investigar la causa raíz y resolver antes de volver a
poner `reserved-concurrent-executions = 10`.

---

## Post-mortem

Después de resolver el cost spike:

1. **Determinar el threshold que falló**: ¿concurrency cap? ¿budget
   alarm? ¿rate-limiter per-IP?
2. **Bajar el threshold** o añadir otra línea de defensa.
3. **Si el patrón se repite**, considerar un nuevo ADR explicando
   por qué la decisión original fue insuficiente.

---

## Pointers

- [`api/sst.config.ts`](../api/sst.config.ts) — Reserved concurrency = 10
- [`api/alarms.config.ts`](../api/alarms.config.ts) — Cost alarms
- [`api/src/llm/rate-limiter.ts`](../api/src/llm/rate-limiter.ts) — Per-IP rate limit
- [`api/src/llm/cost-tracker.ts`](../api/src/llm/cost-tracker.ts) — Cost tracking
- [`DEPLOY-RUNBOOK.md`](../DEPLOY-RUNBOOK.md) — Alarms + cost cap
- [`runbooks/lambda-cold-start.md`](lambda-cold-start.md) — Mitigación cold-start
- [`runbooks/dynamodb-throttling.md`](dynamodb-throttling.md) — Throttles
