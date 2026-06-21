# `web/` — Sociedad Opita Web

> **Frontend del monumento digital vivo.** Astro 6 + Tailwind 4.
> HTML estático, sin SSR adapter, deploy a S3 + CloudFront.

---

## Arquitectura

```
        ┌─────────────────────────────────────────────┐
        │            CloudFront (CDN)                 │
        │   max-age=86400 · SWR=604800 (Polish R3)    │
        └──────────────────┬──────────────────────────┘
                           │
                ┌──────────▼───────────┐
                │   S3 (private, OAI)  │  sociedad-opita-app-prod
                │   web/dist/*         │
                └──────────┬───────────┘
                           │
        ┌──────────────────▼──────────────────┐
        │   Astro 6 build (npm run build)     │
        │   - HTML estático por ruta         │
        │   - Tailwind 4 JIT (vía PostCSS)   │
        │   - React 19 islands (selectivos)  │
        └─────────────────────────────────────┘
```

- **Sin SSR adapter** — el sitio es 100% estático. Astro compila las
  páginas a HTML + assets, y S3 los sirve directamente.
- **Sin framework JS pesado** — solo React islands en componentes
  interactivos (chat del Puente, formulario del Réplica). Cada ruta
  es < 50 KB de HTML, total dist < 2.5 MB (Polish R3 budget).
- **Sin tracking** — decisión del operador #6. Ni Google Analytics,
  ni Plausible, ni siquiera `navigator.sendBeacon()`.

---

## Stack

| Capa | Tecnología | Versión | Por qué |
|------|-----------|---------|---------|
| **Build** | Astro | `^6.3.1` | SSG-first, hidratación selectiva, zero-JS por default |
| **CSS** | Tailwind 4 (vía PostCSS) | `^4.3.0` | JIT compile, `@theme` con tokens custom |
| **UI framework** | React 19 islands | `^19.2.6` | Solo donde se necesita estado (`/puente`, `/replica`) |
| **TypeScript** | TypeScript 5.7 strict | `^5.7.0` | `astro check` + `tsc --noEmit` |
| **E2E tests** | Playwright | `^1.42.0` | E2E para las 5 rutas |
| **Deploy** | S3 + CloudFront (GitHub Actions) | — | Static site, sin Lambda@Edge |

> **Nota sobre Tailwind 4 vía PostCSS** (workaround): en Astro 6
> `@tailwindcss/vite` tiene incompatibilidades con `rolldown` /
> `oxcResolvePlugin`. Se usa `@tailwindcss/postcss` como workaround.
> Ver [`astro.config.mjs`](astro.config.mjs) y
> [`postcss.config.mjs`](postcss.config.mjs).

---

## Páginas

| Ruta | Archivo | Tipo | Descripción |
|------|---------|------|-------------|
| `/` | [`src/pages/index.astro`](src/pages/index.astro) | Hero + 4 dimensiones | Landing con hero fotográfico, hallazgo de Doña Rosa, pueblo-en-números, himno |
| `/ventana` | [`src/pages/ventana.astro`](src/pages/ventana.astro) | Timeline estático | Línea de tiempo de un día en Tello: 6:00 a 22:00, hora por hora con personas y muletillas validadas (DEMOSTRACIÓN) |
| `/puente` | [`src/pages/puente.astro`](src/pages/puente.astro) | Chat estático | 3 conversaciones de muestra con personajes (transcripciones fieles del opita validado, no LLM) (DEMOSTRACIÓN) |
| `/replica` | [`src/pages/replica.astro`](src/pages/replica.astro) | Form curado | 3 pasos para llevar el monumento a otro municipio (Garzón, Pitalito, La Plata) — WhatsApp bridge |
| `/taller` | [`src/pages/taller.astro`](src/pages/taller.astro) | Académico | Paper, 41 perfiles psicométricos, 10 diálogos validados, 204 papers BibTeX, memoria del 1950 |
| `/pronto` | [`src/pages/pronto.astro`](src/pages/pronto.astro) | 404 fallback | Stub para rutas que aún no tienen contenido |

### Visual honesty (decisión del operador #6 + ADR-0005)

**Ventana** y **Puente** se publican hoy como stubs estáticos con
**personas, muletillas y modos reales** del dataset validado. **No**
son "próximamente" — son transcripciones fieles del opita. El contrato
visual está cerrado:

- Mismo grid, misma tipografía, misma paleta.
- Cuando el feed en vivo esté listo (Phase 2), reemplaza el contenido
  sin tocar el componente.
- `decisión 5`: si ves "próximamente" en este repo, es un *bug*.

> El stub consume personas y muletillas directamente de
> `api/src/personas.ts` (single source of truth). Si modificas una
> persona, **ambas dimensiones se actualizan**.

---

## Paleta opita

Definida en [`src/styles/global.css`](src/styles/global.css) como
tokens de Tailwind 4 (`@theme`). **8 colores**, todos extraídos del
branding original:

| Token | Hex | Uso |
|-------|-----|-----|
| `--color-opita-tierra` | `#6b3e2e` | CTAs, acentos primarios, links |
| `--color-opita-adobe` | `#a87856` | Borders secundarios, hover |
| `--color-opita-arena` | `#faf6ed` | Background principal |
| `--color-opita-hueso` | `#d7ccc8` | Borders sutiles, separadores |
| `--color-opita-cafe` | `#2c1810` | Texto principal, "El pueblo en números" |
| `--color-opita-plaza` | `#b8d4a0` | WhatsApp bridge, badge de réplica |
| `--color-opita-magdalena` | `#6892b0` | El Puente (río) |
| `--color-opita-verriondo` | `#8b5a3c` | Hover tierra, "Verriondo" (muletilla icónica) |

**Tipografía**: Georgia/serif para todo. Sin fuentes web — `system-ui`
fallback si Georgia no está disponible. Decisión #6: sin Google Fonts,
sin CLS, sin 200 KB de WOFF2.

**Style lock B/N (decisión #8)**: las fotos de los tiles son
CC-BY-SA-4.0 de Wikimedia Commons, en blanco y negro o con paleta
desaturada. Benjamín de la Calle, Nereo López y Pedro Nel Gómez son
la referencia permanente. Sin gradientes de Instagram.

---

## WhatsApp bridge

Todas las rutas terminan en una llamada a la acción de WhatsApp:

```
https://wa.me/573126126085
```

Número real del operador. Aparece en:

- Home (CTA principal, "Conversemos")
- Réplica (paso 1, "Nos escribes")
- Taller (footer + sección de contacto)
- Pronto (fallback)

No hay formulario. No hay email. La conversión es conversacional
porque la réplica es curada, no self-service (decisión #11).

---

## Estructura

```
web/
├── src/
│   ├── pages/
│   │   ├── index.astro        # /
│   │   ├── ventana.astro      # /ventana
│   │   ├── puente.astro       # /puente
│   │   ├── replica.astro      # /replica
│   │   ├── taller.astro       # /taller
│   │   └── pronto.astro       # /pronto (404 stub)
│   ├── layouts/
│   │   └── Layout.astro       # HTML shell, <head>, font preload
│   └── styles/
│       └── global.css         # @import "tailwindcss" + @theme tokens
│
├── public/                    # Assets estáticos servidos tal cual
│   ├── hero-tello-landscape.jpg    # Wikimedia CC-BY-SA-4.0
│   ├── tile-ventana.jpg            # Wikimedia CC-BY-SA-4.0
│   ├── tile-puente.jpg             # Wikimedia CC-BY-SA-4.0
│   ├── tile-replica.jpg            # Wikimedia CC-BY-SA-4.0
│   ├── tile-taller.jpg             # Wikimedia CC-BY-SA-4.0
│   ├── og-image.jpg                # Open Graph (1200×630)
│   └── downloads/                  # 204 papers BibTeX + 8+ reportes Artesanías
│
├── scripts/
│   └── analyze-bundle.ts      # Polish R3 budget inspector
│
├── astro.config.mjs           # @astrojs/react integration
├── postcss.config.mjs         # @tailwindcss/postcss workaround
├── tsconfig.json
└── package.json
```

---

## Desarrollo local

```bash
cd web
npm install
npm run dev          # http://localhost:4321
```

El servidor de Astro detecta cambios en `src/` y recarga. Las páginas
estáticas (Ventana, Puente) no requieren el backend.

### Build

```bash
cd web
npm run build        # → dist/
npm run preview      # sirve dist/ localmente en :4321
```

### Typecheck + astro check

```bash
cd web
npm run check        # astro check && tsc --noEmit
```

### Bundle analysis (Polish R3)

```bash
cd web
npm run build
npx tsx scripts/analyze-bundle.ts
```

Reporta por página el HTML, el peso total (HTML + CSS/JS compartido),
y el budget remaining. Budgets: **< 50 KB por página, < 2.5 MB total dist**.

**Snapshot actual (post-R5 merge)**:

| Ruta | HTML | Total |
|------|------|-------|
| `/` | 14.0 KB | 224.4 KB |
| `/pronto` | 1.8 KB | 212.2 KB |
| `/puente` | 10.2 KB | 220.5 KB |
| `/replica` | 11.7 KB | 222.0 KB |
| `/taller` | 39.6 KB | 249.9 KB |
| `/ventana` | 13.3 KB | 223.7 KB |

**Total dist**: ~2.1 MB across 46 files (incluye imágenes + portraits + tiles).
Compartido dominante: `_astro/client.*.js` (~189 KB React + ReactDOM hydration).
Si supera 200 KB, dividir los React islands por ruta.

### E2E tests (Playwright)

```bash
cd web
npx playwright install     # one-time
npm run test:e2e
```

Cubre: navegación entre las 5 rutas, hero cargado, WhatsApp link
presente, sin errores de consola, viewport mobile (375×667).

---

## Imágenes y atribución

Todas las imágenes del hero, tiles y galería del Taller son de
**Wikimedia Commons con licencia CC-BY-SA-4.0**, atribuidas inline
(figcaption en cada imagen). Ver
[`src/pages/index.astro`](src/pages/index.astro) líneas 86–89 para
el patrón de atribución.

**Honestidad visual**: la foto del hero (`hero-tello-landscape.jpg`)
es del **valle del Gigante, Huila** — el mismo terreno que Tello, no
es foto de Tello. Tello no tiene archivo fotográfico público abierto
todavía. La figcaption lo declara explícitamente y enlaza a la
sección de honestidad visual.

Si añades una imagen:

1. Verifica la licencia (CC-BY-SA-4.0 o CC-BY-4.0 ideal; sin "todos
   los derechos reservados").
2. Atribución inline (autor + fuente + licencia).
3. Optimización: < 200 KB por imagen, formato WebP con fallback JPEG.
4. Sin texto de "próximamente" en el alt.

---

## Deployment

```bash
cd web
npm ci
npm run build

# Dry-run
aws s3 sync dist s3://sociedad-opita-app-prod --delete --dryrun \
  --cache-control "public, max-age=86400, stale-while-revalidate=604800" \
  --exclude "*.map"

# Real deploy
aws s3 sync dist s3://sociedad-opita-app-prod --delete \
  --cache-control "public, max-age=86400, stale-while-revalidate=604800" \
  --exclude "*.map"

# Invalidate CloudFront
aws cloudfront create-invalidation \
  --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" --paths "/*"
```

**Polish R3 cache policy**: `max-age=86400` (1 día) +
`stale-while-revalidate=604800` (7 días SWR) para todos los assets.
SWR = CloudFront sirve la versión cacheada hasta 7 días después de
expirar mientras pull una copia fresca en background. Los visitantes
nunca esperan al origin durante un deploy. Astro hashea `_astro/*`,
así que URLs viejas siguen siendo válidas.

Rollback: ver [`../DEPLOY-RUNBOOK.md`](../DEPLOY-RUNBOOK.md) sección
"Rollback procedure".

---

## Decisiones del operador (referenciadas)

| # | Decisión | Cumplimiento en `web/` |
|---|----------|------------------------|
| 1 | Masacre del Puente de los Decapitados (1950) | Sección dedicada en `/taller` |
| 2 | ES only | Sin i18n, sin selector de idioma |
| 3 | Personas híbrido (10 + 31 pendientes) | Solo 10 actuales mostradas; 31 referenciadas en `/taller` |
| 4 | Himno de Tello (Velásquez / Camacho) | Cita en `/` con atribución y contacto |
| 5 | Banano 91% | `/` (Pueblo en números) y `/taller` |
| 6 | Mobile-first, <50KB, sin tracking | Cumplido (ver bundle analysis) |
| 7 | 8+ reportes Artesanías de Colombia | `public/downloads/artesanias/` |
| 8 | Style lock B/N (Calle, López, Gómez) | Paleta opita + fotos CC-BY-SA desaturadas |
| 9 | WhatsApp bridge | `wa.me/573126126085` en 4+ lugares |
| 10 | 204 papers BibTeX | `public/downloads/papers-tello*.bib` |

---

## Pointers

- [`../DEPLOY-RUNBOOK.md`](../DEPLOY-RUNBOOK.md) — Deploy canónico (S3 + CloudFront)
- [`../README.md`](../README.md) — Overview del proyecto
- [`../docs/adr/0005-visual-honesty-stubs.md`](../docs/adr/0005-visual-honesty-stubs.md) —
  Por qué Ventana y Puente son stubs con datos reales
- [`astro.config.mjs`](astro.config.mjs) — Config de Astro 6
- [`src/styles/global.css`](src/styles/global.css) — Paleta opita + tokens
- [`scripts/analyze-bundle.ts`](scripts/analyze-bundle.ts) — Budget inspector
