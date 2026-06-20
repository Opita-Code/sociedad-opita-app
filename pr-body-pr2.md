## S2: Home del Monumento Cultural con las 4 Dimensiones

Reemplaza el coming-soon temporal con la home real del producto: las 4 dimensiones para habitar el pueblo de Tello.

## Cambios

### Home (`web/src/pages/index.astro`)

Reescrita como home del **monumento cultural vivo**, no como SaaS:

- **Hero**: "Sociedad Opita — el primer monumento digital vivo de una comunidad colombiana" con subtitle emocional
- **El hallazgo de Doña Rosa**: la sección del super-spreader que hace el paper compartible. "No es la más popular, es la super-spreader porque su tienda queda en la intersección geométrica del pueblo"
- **Las 4 dimensiones**: Ventana / Puente / Réplica / Taller. Cada una con su descripción, no solo CTAs fríos. Explican QUÉ se vive.
- **El pueblo en números**: 41 personas, 34 edificios, 10 diálogos validados, 7 capas sociolingüísticas
- **La promesa**: "Hecho por un nativo huilense, en el Huila, con IA, para que Tello no se muera cuando los pelaos se vayan pa' Bogotá"
- **Footer con links**: paper académico + coming-soon de la versión anterior

### Coming-soon movido a `/pronto`

`web/src/pages/pronto.astro` es el coming-soon. Antes era `/` (que se reemplazó por la home nueva).

### Dependencias actualizadas

- `api/package.json`: `@opita/ocais` actualizado de `#master` a `#v2.0.0` (tag oficial recién creado y mergeado)

## Chain Context

```
PR #1 ✅ MERGED — feature/monumento-cultural-v1 → main
📍 PR #2 (este) — feature/s2-monumento-vivo → main
PR #3 (pendiente) — feature/s3-expansion (Ventana + Puente + Réplica + Taller)
```

## Out of scope (PR #3)

- `ventana.astro` — SSE stream del pueblo en vivo (usa OCAIS v2 con `signal`, `timeoutMs`, observability hooks)
- `puente.astro` — WebSocket chat con personajes (idem)
- `replica.astro` — Template para réplicas municipales
- `taller.astro` — Paper, datos validados, BibTeX
- `api/src/stream.ts` — SSE handler con `@opita/ocais.streamText`
- `api/src/chat.ts` — WebSocket handler con `@opita/ocais.streamText`
- Las 31 personas restantes de Tello (10/41 documentadas en S1)
- Portar `prompt_builder.py` (7 capas + 13 anti-AI-slop) a TypeScript

## Test plan

- [ ] `cd web && npm install && npm run build` sin errores
- [ ] `cd web && npm run dev` → http://localhost:4321 muestra la home con las 4 dimensiones
- [ ] Las 4 dimensiones linkean a `/ventana`, `/puente`, `/replica`, `/taller` (que aún no existen — muestran coming-soon)
- [ ] Copy en español colombiano, NO rioplatense
- [ ] Paleta opita se aplica correctamente
- [ ] No hay emojis en el copy (per repo convention)

## Size

- **3 archivos, +202/-28** (dentro del budget de 400 ✅)
- Sin `size:exception` necesaria

## Refs

- `sdd/monumento-cultural-v1/proposal`
- `sdd/monumento-cultural-v1/spec`
- `sdd/monumento-cultural-v1/design`
- `sdd/monumento-cultural-v1/tasks`
- `sdd/monumento-cultural-v1/ecosystem-pivot`
- `sdd/ocais-v2/completed` (OCAIS v2.0 ya mergeado en master)
