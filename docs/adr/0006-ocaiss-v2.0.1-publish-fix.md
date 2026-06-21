# ADR-0006: OCAIS v2.0.1 Cross-Repo Publish Fix

**Status**: Accepted
**Date**: 2026-06-21
**Deciders**: Juan Nicolás Urrutia Salcedo
**Supersedes**: —

---

## Context

Sociedad Opita depende de [`@opita/ocais`](https://github.com/Opita-Code/ocais),
el SDK de streaming AI del ecosistema Opita-Code. Es un repo
**separado** (`Opita-Code/ocais`) con su propio versionado
semántico, su propio CHANGELOG, y su propio proceso de release.

En el `package.json` del backend, la dependencia se declara así:

```json
"@opita/ocais": "github:Opita-Code/ocais#v2.0.0"
```

El pin a `v2.0.0` (un tag git, no un release npm) se hizo durante
PR #5 con la intención de actualizarlo a `v2.0.1` cuando el upstream
publicara una serie de fixes críticos. Esos fixes — publicados
recientemente — son:

1. **`streamText` abort handling**: v2.0.0 deja el stream colgado
   en cleanup path si el `AbortSignal` se dispara mid-iteration.
   v2.0.1 cierra el controller y emite un `done` con `aborted: true`.
2. **`openai()` provider `baseURL` typing**: v2.0.0 acepta cualquier
   string. v2.0.1 valida que sea URL absoluta y falla rápido con
   `OCAISProviderError` si no.
3. **`createSSEWriter` header order**: v2.0.0 escribe `Content-Type`
   antes de `Cache-Control`, lo cual causa buffering en algunos
   proxies. v2.0.1 invierte el orden.

El problema: `@opita/ocais` v2.0.0 fue publicado como **tag git
+ release de GitHub**, pero el versionado semántico en el
`package.json` interno del repo tiene un bug — el campo
`"version"` quedó en `"2.0.0"` en vez de bumpearse a `"2.0.1"`. El
tag `v2.0.1` existe, pero el manifest del paquete dice `2.0.0`.

Cuando pnpm (o npm) resuelven `github:Opita-Code/ocais#v2.0.1`,
leen el `package.json` del repo en ese ref y ven `"version":
"2.0.0"`. Esto rompe asunciones downstream (alertas de versionado
en CI, cache de layers de Lambda, etc.).

## Decision

Adoptamos una solución **cross-repo** en dos partes:

1. **Cross-repo fix en `Opita-Code/ocais`**: bumpear manualmente el
   campo `"version"` en `package.json` a `"2.0.1"`, agregar
   entrada en `CHANGELOG.md`, y crear un nuevo tag
   `v2.0.1-pinned`. PR abierto en
   `Opita-Code/ocais#fix/version-bump-v2.0.1`.

2. **Pin en Sociedad Opita**: actualizar
   `api/package.json` a `"@opita/ocais": "github:Opita-Code/ocais#v2.0.1-pinned"`.
   Lockfile (`pnpm-lock.yaml`) regenerado.

3. **Layer hygiene en Lambda**: el modelo ONNX cacheado en `/tmp` se
   identifica por hash del `package.json` + `pnpm-lock.yaml`. El
   bump fuerza re-download limpio (no hay riesgo de cache stale).

Por qué cross-repo (no fork): OCAIS es parte del ecosistema
Opita-Code. Forkear y mantener un fork diverge del upstream, lo
cual contradice el principio de "ecosistema". El fix es trivial
(1 línea de `package.json` + 1 tag); hacerlo upstream es la
decisión correcta.

Por qué un nuevo tag `v2.0.1-pinned` (no reusar `v2.0.1`): una vez
que el PR upstream mergee y el `package.json` diga `"version":
"2.0.1"`, el tag `v2.0.1` original queda con el manifest roto.
Forzar a `v2.0.1-pinned` evita ambigüedad: el pinned tag tiene el
manifest correcto *y* la documentación del fix.

## Consequences

**Más fácil**:

- **Stream cleanup funciona**: si el cliente aborta el SSE (cierra
  el tab, navega away), el controller se cierra limpiamente, no
  quedan promesas colgadas en la Lambda.
- **Fail-fast en `baseURL` inválido**: si `DEEPSEEK_BASE_URL` está
  mal configurado (typo, falta el esquema), la Lambda falla en
  el primer request con error tipado en vez de degradarse
  silenciosamente.
- **SSE buffering fix**: en proxies intermedios (CloudFront, ALB),
  el `Content-Type: text/event-stream` se respeta y los chunks
  llegan al browser sin buffering espurio.
- **Versioning honesty**: el `package.json` dice `"2.0.1"`. CI
  checks de versionado, dashboards de "outdated dependencies", y
  alertas de seguridad funcionan correctamente.

**Más difícil**:

- **Coordinación cross-repo**: dependemos de que el PR upstream
  mergee. Si el operador de OCAIS no lo mergea, Sociedad Opita
  queda esperando. Mitigado con un fork temporal en
  `nicourrutia98/ocais` (en cuenta personal) que se descarta
  cuando el upstream mergea.
- **Lockfile churn**: `pnpm install` regenera `pnpm-lock.yaml` con
  el nuevo SHA del ref. CI tarda ~30 s más en el primer build
  después del bump.
- **Documentación en dos lugares**: hay que documentar el fix en
  AMBOS repos. Este ADR es el puente, pero también hay que
  actualizar `Opita-Code/ocais/CHANGELOG.md`.

**Trade-off cuantificado**: pagamos ~2 horas de coordinación
cross-repo (PR + review + merge + lockfile regen) por 3 fixes
críticos (stream cleanup, baseURL validation, SSE header order).
El bug de stream cleanup *ya* había costado 1 hora de debugging
en una sesión de Polish R2; el fix lo previene para siempre.

## Alternatives considered

- **Esperar a v2.1.0 upstream**: OCAIS tiene un v2.1.0 planeado
  para Q3 con breaking changes (typed `messages[]` discriminated
  union). No queremos esperar meses por fixes que son obvios.
  **Rechazado** por urgencia de los fixes.

- **Forkear OCAIS en `Opita-Code/ocais-fork`**: nunca divergir
  del upstream es un principio del ecosistema. **Rechazado** por
  fragmentación.

- **Volver a `v2.0.0` y parchar localmente**: imposible — el
  código vive en `node_modules/`, no tenemos un patch system
  (no usamos `patch-package`). **Rechazado** por inviabilidad
  técnica.

- **Reimplementar OCAIS in-tree**: copy-paste de los ~800 LOC de
  `ocais/src/*` a `api/src/vendor/ocais/`. Tentador para
  autonomía total, pero **duplica trabajo** y rompe el ecosistema.
  **Rechazado** por fragmentación.

- **Pin al SHA exacto del commit (no al tag)**: `github:Opita-Code/ocais#abc1234`.
  Más seguro contra force-push, pero pierde la legibilidad
  semántica (`v2.0.1-pinned` > `abc1234`). **Rechazado** por
  legibilidad; el tag `v2.0.1-pinned` es inmutable por
  convención.

## Pointers

- [`Opita-Code/ocais`](https://github.com/Opita-Code/ocais) — Upstream SDK
- [`api/package.json`](../../api/package.json) — `"@opita/ocais": "github:Opita-Code/ocais#v2.0.1-pinned"`
- [`api/src/llm/provider.ts`](../../api/src/llm/provider.ts) — `ocaisStream()` consumer
- [`docs/ocais-rag-integration.md`](../ocais-rag-integration.md) — Plan de integración completo
- [`api/src/handlers/dialogue.ts`](../../api/src/handlers/dialogue.ts) — `AbortSignal` integration
