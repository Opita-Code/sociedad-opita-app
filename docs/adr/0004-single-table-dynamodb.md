# ADR-0004: Single-Table DynamoDB

**Status**: Accepted
**Date**: 2026-06-21
**Deciders**: Juan Nicolás Urrutia Salcedo
**Supersedes**: —

---

## Context

El backend necesita persistir **tres tipos de entidades** con
**patrones de acceso diferentes**:

| Entidad | Patrón de acceso | Cardinalidad | Vida útil |
|---------|------------------|--------------|-----------|
| **Persona** | Read by `persona_id` (snapshot inmutable) | 41 hoy → 100s | Indefinida |
| **Conversación** | Read/write by `conv_id`, scan por `persona_id` | 10/día → 1000s | 90 días (TTL) |
| **Ventana event** | Query por bucket de tiempo (e.g., "eventos de junio 2026") | 100/día → 10K/mes | Indefinida |

Las opciones de persistencia:

1. **Tres tablas relacionales** (Personas, Conversations, Events) —
   clásico, fácil de entender, JOINs en application layer.
2. **Una tabla por entidad en DynamoDB** — natural mapping, GSIs
   por patrón de acceso, sin JOINs.
3. **Single-table DynamoDB** — una sola tabla, `pk` + `sk` discriminan
   el tipo, dos GSIs comparten hotspots, sin JOINs.

DynamoDB es la elección obvia por el stack AWS (ADR-0002) y porque
no necesitamos SQL relacional (no hay JOINs cross-entity, no hay
agregaciones complejas).

La pregunta es: ¿tres tablas o una sola?

## Decision

Adoptamos **Opción 3: single-table DynamoDB** con la siguiente
estructura:

- **Tabla única `SociedadOpitaState`**:
  - `pk` (HASH) = `ENTITY#<TYPE>#<id>`
  - `sk` (RANGE) = `<subkey>` (`STATE`, `MSG#<iso>`, `personaId`)
  - `personaId` (GSI1 hashKey) — `byPersona` index
  - `tsBucket` (GSI2 hashKey) + `ts` (GSI2 rangeKey) — `byTime` index
  - `expiresAt` (TTL, epoch seconds) — auto-expira CONV items a 90 días

- **Dos GSIs**:
  - `byPersona`: hashKey `personaId`, rangeKey `sk` — query "todos
    los eventos/mensajes de esta persona en orden".
  - `byTime`: hashKey `tsBucket` (e.g., `2026-06`), rangeKey `ts` —
    query "todos los eventos del pueblo en junio 2026".

- **Adicionalmente** (legacy bootstrap, no single-table): dos tablas
  separadas `Sessions` y `Personas` con `removal: "remove"` porque
  son regenerables desde el seed.

Por qué single-table:

- **Hot partition mitigation**: una sola tabla con 3 tipos de items
  distribuye el throughput provisioned (5 RCU/5 WCU) entre todos los
  tipos, evitando que un type hot (e.g., Conversación cuando un
  usuario hace spam) acapare el throughput de los otros tipos.
- **Transacciones cross-entity**: `TransactWriteItems` puede crear
  un PERSONA + un EVENT relacionado en una sola operación atómica.
  Con tres tablas esto requiere 2 round-trips y 2 IAM permissions.
- **Cost**: una tabla es más barata en WCU/RCU totales y en
  storage (DynamoDB cobra por tabla, no por item).
- **Forward-only migrations**: añadir un nuevo `sk` prefix (e.g.,
  `VENTANA_EVENT#<ts>`) no rompe readers viejos. El esquema es
  aditivo por diseño.

## Consequences

**Más fácil**:

- **Menos tablas que gestionar**: 1 (single-table) + 2 (legacy) vs
  3. Menos IAM, menos SST resources, menos CloudWatch metrics.
- **Transacciones atómicas cross-entity** cuando se necesitan (e.g.,
  crear un PERSONA + emitir un EVENT "persona creada" en una sola
  `TransactWriteItems`).
- **Forward-compatible**: añadir un nuevo tipo de entidad (e.g.,
  `VENTANA#<id>`) es un cambio de prefijo en `sk`. No requiere
  crear tabla ni migrar datos existentes.
- **Hot partition mitigation**: throughput compartido entre tipos.
  Si un usuario hace 100 messages/min a Doña Rosa, los eventos
  de la plaza y el estado de otras personas no se ven afectados.
- **GSI simple patterns**: los dos GSIs cubren el 100% de los
  patrones de acceso conocidos. No necesitamos sparse indexes ni
  overloading (todavía).

**Más difícil**:

- **Curva de aprendizaje**: single-table es contraintuitivo para
  gente con background SQL. El operador (solo) tiene que
  internalizar la convención `pk`/`sk` y mantenerla disciplinada.
- **Documentación obligatoria**: sin docs claras, un dev nuevo
  (incluso el operador 6 meses después) no entiende qué items
  existen en la tabla. Mitigado con
  [`api/src/state/schema.ts`](../../api/src/state/schema.ts) que
  declara los tipos TypeScript + los prefijos válidos.
- **Debugging harder**: el `aws dynamodb scan` devuelve todos los
  items mezclados. Hay que filtrar por `pk begins_with "ENTITY#"`.
- **NoSQL antipattern real**: si el proyecto crece y aparecen
  agregaciones cross-entity complejas (e.g., "todos los mensajes
  de todas las conversaciones en junio"), el single-table empieza
  a doler. Ahí toca desnormalizar o migrar a una DB relacional.
- **Single-region**: la tabla vive en `us-east-1`. Latencia desde
  Colombia ~120 ms. Mitigado con DAX cache si se vuelve un
  problema (Phase 2).

**Trade-off cuantificado**: pagamos complejidad cognitiva (single-table
es un antipattern conocido) por (a) ~30% menos de costo de DDB,
(b) transacciones atómicas cross-entity, (c) throughput compartido
entre tipos. A la escala actual (10–100 conversations/día) el costo
es marginal; la complejidad cognitiva es la verdadera inversión.

## Alternatives considered

- **Tres tablas (Personas, Conversations, Events)**:
  - ✓ Modelo mental simple, una tabla por tipo, GSIs obvios.
  - ✗ Hot partition: si Conversation recibe spam, Persona se queda
    sin WCU provisioned.
  - ✗ Transacciones cross-entity requieren `TransactWriteItems`
    multi-tabla (más caro, más permissions).
  - ✗ Más tablas = más IAM = más SST config = más costo fijo.
  - **Rechazado** por hot partition + costo.

- **Postgres (RDS)**:
  - ✓ SQL, joins, agregaciones, décadas de tooling.
  - ✗ Provisionar una instancia RDS cuesta > $30/mes incluso
    parada. A 10 conversations/día, es over-engineering puro.
  - ✗ Backups, failover, security groups, monitoring — todo
    manualmente.
  - **Rechazado** por over-engineering + costo.

- **SQLite (en `/tmp` de la Lambda)**:
  - ✓ Cero costo, cero ops.
  - ✗ No escala cross-Lambda. Cada contenedor tiene su propio
    SQLite. La Ventana necesita estado *compartido* entre
    visitantes.
  - **Rechazado** por falta de shared state.

- **Cloudflare KV / Durable Objects**:
  - ✓ Barato, edge-first.
  - ✗ No encaja con el stack AWS (ADR-0002). Migrar solo DDB a
    Cloudflare fragmenta el stack.
  - **Rechazado** por consistencia del stack.

## Pointers

- [`api/src/state/schema.ts`](../../api/src/state/schema.ts) — Tipos y prefijos
- [`api/src/state/dynamo-client.ts`](../../api/src/state/dynamo-client.ts) — Client tipado
- [`api/sst.config.ts`](../../api/sst.config.ts) — Definición de la tabla
- [`runbooks/dynamodb-throttling.md`](../../runbooks/dynamodb-throttling.md) — Troubleshooting throttles
- [ADR-0002: CloudFront+S3+Lambda](0002-cloudfront-s3-lambda-over-cloudflare-pages.md) — El stack que aloja la tabla
