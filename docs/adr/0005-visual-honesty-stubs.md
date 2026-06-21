# ADR-0005: Visual Honesty — Stubs con Datos Reales

**Status**: Accepted
**Date**: 2026-06-21
**Deciders**: Juan Nicolás Urrutia Salcedo
**Supersedes**: —

---

## Context

Las dos dimensiones interactivas del monumento — **La Ventana** (un
reloj virtual que muestra el pueblo correr) y **El Puente** (chat
1:1 con personajes) — tienen una asimetría temporal:

- **Diseño + copy + dataset** están listos. Las 10 personas validadas
  con sus muletillas, sus roles, sus redes, están en
  [`api/src/personas.ts`](../../api/src/personas.ts). Los 10
  diálogos validados por hablante nativo están escritos. El himno
  está transcrito. La Masacre del 1950 está documentada.
- **El backend en vivo** no está listo. El feed SSE de la Ventana
  requiere un simulador agentic corriendo 24/7 (Phase 2). El chat
  WebSocket del Puente requiere integración WS con autenticación,
  rate-limiting per-persona, y persistencia cross-session (Phase 2).

El patrón habitual ante este gap es uno de tres:

1. **"Próximamente" + spinner** — placeholder vacío, promesa vaga.
   Honesto sobre la ausencia, pero **desperdicia el trabajo de campo**
   ya hecho (10 personas validadas, 10 diálogos, 41 perfiles
   psicométricos, 204 papers).
2. **Demo fabricada** — UI con datos Lorem-Ipsum o "Demo Persona 1"
   para mostrar la mecánica. **Engañoso**: el visitante cree que
   está viendo Tello cuando no es así.
3. **Stubs con datos reales** — UI completa, con personas, muletillas
   y modos del dataset validado, pero **hardcodeados** en el HTML
   estático (no en vivo). El contrato visual está cerrado; el
   contenido se reemplaza cuando el backend esté listo, sin
   cambiar el componente.

La decisión del operador #6 ("Mobile-first, <50 KB, sin JS
framework, sin tracking") refuerza el principio: lo que se muestra
es lo que hay. Sin placeholders.

## Decision

Adoptamos **Opción 3: stubs con datos reales** para `/ventana` y
`/puente` en Phase 1.

- **`/ventana`**: línea de tiempo estática de un día (06:00 a
  22:00) con 16 eventos. Cada evento cita una persona real, su rol,
  y un texto construido con 2-3 de sus muletillas validadas.
  Ver [`web/src/pages/ventana.astro`](../../web/src/pages/ventana.astro).

- **`/puente`**: 3 conversaciones de muestra, cada una con un
  personaje distinto, con texto construido con sus muletillas y su
  speaking_style. **No** es generado por LLM — son transcripciones
  fieles del opita validado.
  Ver [`web/src/pages/puente.astro`](../../web/src/pages/puente.astro).

- **Single source of truth**: ambos stubs importan personas y
  muletillas directamente de `api/src/personas.ts`. Si modificas
  una persona en el dataset, ambos stubs se actualizan al rebuild.

- **Contrato visual cerrado**: la grid, la tipografía, la paleta, el
  layout — todo se mantiene cuando Phase 2 reemplace el contenido
  con feed SSE/WS en vivo. El visitante no nota el cambio de fase
  excepto porque el contenido empieza a actualizarse.

- **Atribución honesta**: cada stub tiene un banner que dice
  "DEMOSTRACIÓN" en el header. El visitante sabe que está viendo
  contenido curado, no live. Esto es la **visual honesty** de la
  decisión del operador.

- **Sin "próximamente"**: la única ruta con "próximamente" es
  `/pronto` (404 fallback), que es explícitamente para rutas que
  no existen. Si ves "próximamente" en `/ventana` o `/puente`, es
  un *bug* — alguien borró el stub.

## Consequences

**Más fácil**:

- **El trabajo de campo se honra desde el día 1**: las 10 personas
  validadas, los 10 diálogos, las 41 fichas psicométricas están
  visibles desde el primer deploy. No se quedan en un Jupyter
  notebook mientras se construye el simulador agentic.
- **SEO + shareability**: las páginas estáticas son indexables,
  citables, descargables. Google Scholar puede enlazar al Taller
  aunque el feed live aún no exista.
- **Testeo del contrato visual sin backend**: diseñadores y
  copywriters pueden iterar sobre la UI sin esperar a que el
  simulador agentic esté listo.
- **Migración trivial a Phase 2**: el componente ya existe, los
  hooks de datos ya están identificados. Phase 2 reemplaza el
  `data-loader` con un SSE/WS client. Cero redesign.
- **Cero LLM cost en Phase 1**: el contenido es estático, no se
  invoca DeepSeek por visita.

**Más difícil**:

- **Costo de authoring**: cada uno de los 16 eventos de la
  Ventana y los 3 diálogos del Puente es **escrito a mano** por
  el operador o curado del trabajo de campo. No hay shortcut
  (no es "generar con LLM y editar después" — eso sería la
  Opción 2 que rechazamos).
- **Riesgo de "stale content"**: si los stubs no se actualizan
  cuando llegan datos nuevos (e.g., 11ª persona validada), se
  desincronizan. Mitigado con un test que cuenta eventos en
  `/ventana` vs personas en `personas.ts` y falla si hay drift.
- **Percepción del visitante**: alguien puede visitar
  `/puente` esperando un chat y encontrar un diálogo escrito.
  La banner "DEMOSTRACIÓN" mitiga, pero no elimina. Aceptamos
  el trade-off.
- **No es "escalable" a 100 personajes**: si en Phase 2 tenemos
  100 personas, escribir 100 eventos de Ventana a mano no
  escala. Ahí Phase 2 (simulador agentic) es la respuesta.

**Trade-off explícito**: invertimos 2-3 horas de curaduría manual
(ya hechas para Phase 1) por visibilidad inmediata del trabajo de
campo + SEO + shareability + migración limpia a Phase 2. El costo
se paga una vez; el beneficio se acumula por años.

## Alternatives considered

- **Opción 1 (Próximamente)**: rechazada por desperdiciar el
  trabajo de campo. Un monumento que dice "próximamente" no es
  un monumento, es un anuncio.
- **Opción 2 (Demo fabricada)**: rechazada por engañosa. La
  decisión del operador #6 lo prohíbe implícitamente: "sin
  tracking" se extiende a "sin false advertising".
- **Opción 4 (Live-only, no Phase 1)**: lanzar el sitio solo
  cuando el simulador agentic esté listo. Significaría no
  lanzar hasta Phase 2 (meses). Perderíamos SEO, shareability,
  y la oportunidad de iterar el diseño con usuarios reales.
  **Rechazado** por perder el momentum del trabajo de campo.
- **Opción 5 (Híbrido: live + stub)**: `/ventana` muestra
  eventos live de un subset (3 personas), stub para el resto.
  Más complejo, doble código path. **Rechazado** por
  complejidad. Si Phase 2 está listo, va 100% live; si no,
  100% stub. Sin estado intermedio.

## Pointers

- [`web/src/pages/ventana.astro`](../../web/src/pages/ventana.astro) — Stub timeline
- [`web/src/pages/puente.astro`](../../web/src/pages/puente.astro) — Stub chat
- [`api/src/personas.ts`](../../api/src/personas.ts) — Single source of truth
- [`web/src/pages/pronto.astro`](../../web/src/pages/pronto.astro) — 404 fallback (única ruta con "próximamente")
- Decisión del operador #6 — Mobile-first, <50KB, sin tracking
- Decisión del operador #5 — Banano 91% (mismo principio: dato real, no placeholder)
