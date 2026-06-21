# RUNBOOKS — Sociedad Opita

> **Runbooks operativos** para responder a incidentes en producción.
> Cada runbook es accionable: síntoma → diagnóstico → fix.

---

## Índice

| Runbook | Cuándo usarlo | Severidad típica |
|---------|---------------|-------------------|
| [`runbooks/dialogue-errors.md`](runbooks/dialogue-errors.md) | `/v1/dialogue` retorna 4xx/5xx, o el stream SSE se rompe mid-flight | P1 (funcional) |
| [`runbooks/dynamodb-throttling.md`](runbooks/dynamodb-throttling.md) | `ProvisionedThroughputExceededException` en CloudWatch logs | P1 (latencia) |
| [`runbooks/cost-overrun.md`](runbooks/cost-overrun.md) | Costo diario de AWS supera $5, o factura mensual > $25 | P0 (dinero) |
| [`runbooks/lambda-cold-start.md`](runbooks/lambda-cold-start.md) | `POST /v1/dialogue` tarda > 8 s en cold-start | P2 (UX) |
| [`runbooks/corpus-rebuild.md`](runbooks/corpus-rebuild.md) | El corpus `corpus-embeddings.bge-m3-v1.json.gz` está stale o corrupto | P1 (funcional) |

---

## Severidades

- **P0** — servicio caído, dinero saliendo, pérdida de datos.
  Resolver en < 1 h, pagear al operador.
- **P1** — feature degradada, no pérdida de datos. Resolver en < 4 h.
- **P2** — performance suboptimal, no afecta funcionalidad. Resolver
  en < 1 semana.

---

## Procedimiento general de incidente

1. **Triage** (5 min): ¿es P0/P1/P2? ¿A qué runbook apunta el síntoma?
2. **Diagnóstico**: ejecutar el runbook relevante. Logs de
   CloudWatch son la fuente de verdad.
3. **Mitigación inmediata**: aplicar el fix del runbook. Si no
   funciona en 30 min, escalar al backup o hacer rollback
   (ver [`DEPLOY-RUNBOOK.md`](DEPLOY-RUNBOOK.md) sección Rollback).
4. **Post-mortem**: después de resolver, escribir un resumen en el
   issue tracker. Si el fix es durable, considerar un ADR
   ([`docs/adr/`](docs/adr/)).

### CloudWatch Logs (fuente de verdad)

```bash
# Tail live logs de la Lambda
aws logs tail /aws/lambda/sociedad-opita-app-ApiFn --follow

# Filtrar errores 5xx
aws logs filter-log-events \
  --log-group-name /aws/lambda/sociedad-opita-app-ApiFn \
  --filter-pattern "ERROR" --start-time $(date -d '1 hour ago' +%s000)

# Filtrar throttles de DDB
aws logs filter-log-events \
  --log-group-name /aws/dynamodb/sociedadopitastate \
  --filter-pattern "ThrottlingException"
```

### Métricas clave

| Métrica | Namespace | Umbral |
|---------|-----------|--------|
| `Invocations` | AWS/Lambda | baseline: 10–100/día |
| `Errors` | AWS/Lambda | > 1% durante 5 min |
| `Duration` P95 | AWS/Lambda | > 30 s |
| `ConcurrentExecutions` | AWS/Lambda | > 9 (cap es 10) |
| `ThrottledRequests` (DDB) | AWS/DynamoDB | > 0 |
| `EstimatedCharges` | AWS/Billing | > $5/día |

Alarmas configuradas en [`api/alarms.config.ts`](api/alarms.config.ts) +
sección "Alarms" de [`DEPLOY-RUNBOOK.md`](DEPLOY-RUNBOOK.md).

### On-call

- **Primary**: Juan Nicolás Urrutia Salcedo (operador).
- **Backup**: ninguno — proyecto single-operator.
- **Canal**: WhatsApp personal (decisión del operador #9).
- **SLA**: < 24 h acknowledgement, < 72 h mitigation.

---

## Runbooks específicos

### [`runbooks/dialogue-errors.md`](runbooks/dialogue-errors.md)

Patrones comunes de error en `POST /v1/dialogue`. Cubre:

- `400 invalid_json` — body malformado
- `400 validation_failed` — campos fuera de whitelist
- `404 persona_not_found` — `persona_id` inválido
- `500 internal_error` — corpus / embed / context / state falla
- `stream_error` mid-flight — `data: {"error":"stream_error",...}`
- Cliente cierra EventSource antes del `done` → `stream` cleanup

### [`runbooks/dynamodb-throttling.md`](runbooks/dynamodb-throttling.md)

Cómo responder a `ProvisionedThroughputExceededException` en la
tabla `SociedadOpitaState`. Cubre:

- Diagnóstico de hot partition (key design, GSI skew)
- Auto-scaling configuration
- Backoff strategy en el código
- DAX cache (Phase 2)
- Cuándo pedir quota increase a AWS

### [`runbooks/cost-overrun.md`](runbooks/cost-overrun.md)

Cómo responder a un spike de costo. Cubre:

- Identificar qué servicio (Lambda / DDB / DeepSeek) está spiking
- DeepSeek API abuse (concurrency 10 es el cap duro, pero puede
  haber loops)
- DDB hot partition (alto WCU/RCU)
- Frontend traffic spike (S3 + CloudFront)
- Procedimiento de rollback y configuración de cost cap

### [`runbooks/lambda-cold-start.md`](runbooks/lambda-cold-start.md)

Troubleshooting de cold-start para la Lambda con BGE-M3. Cubre:

- Medir el cold-start (vs warm)
- Opción A: Lambda Layer con modelo pre-empaquetado (recomendada)
- Opción B: SnapStart (deferred a Phase 2)
- Opción C: Provisioned Concurrency (deferred, muy caro)
- Decision matrix

### [`runbooks/corpus-rebuild.md`](runbooks/corpus-rebuild.md)

Cómo regenerar `corpus-embeddings.bge-m3-v1.json.gz`. Cubre:

- Cuándo es necesario rebuild (corpus stale, modelo base cambia)
- Pipeline (markitdown-tune → chunk → embed → gzip)
- Dónde se almacena (S3 en Phase 2, local en Phase 1)
- Cómo verificar que el nuevo corpus funciona (golden queries)

---

## Pointers

- [`DEPLOY-RUNBOOK.md`](DEPLOY-RUNBOOK.md) — Deploy canónico + rollback
- [`api/alarms.config.ts`](api/alarms.config.ts) — Manifest de alarms
- [`docs/adr/`](docs/adr/) — Decisiones de arquitectura (por qué el stack es así)
- [`README.md`](README.md) — Overview del proyecto
