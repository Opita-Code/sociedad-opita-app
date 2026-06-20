## Resumen

PR #1 del feature-branch-chain `monumento-cultural-v1` en la org `Opita-Code`. **Migración completa al stack del ecosistema Opita-Code**: Astro 6 + Tailwind 4 + SST v3 (TypeScript) + `@opita/ocais` para streaming. Backend en TypeScript con Hono. Frontend deploy a S3+CloudFront. Backend deploy con SST.

## Cambios

### Frontend (`web/`) — Astro 6 + Tailwind 4
- `web/package.json`: Astro 6.3.1, React 19, Tailwind 4.3 (vía `@tailwindcss/vite`, no `@astrojs/tailwind`)
- `web/astro.config.mjs`: minimalista, alineado con `www.opitacode.com/frontend-v2/astro.config.mjs`
- `web/src/styles/global.css`: Tailwind 4 con `@import "tailwindcss"` + `@theme` block para la paleta opita
- `web/src/layouts/Layout.astro`: layout con OG tags y meta description
- `web/src/pages/index.astro`: coming-soon en español colombiano (NO rioplatense)
- `web/tsconfig.json`: strict mode con path aliases

### Backend (`api/`) — SST v3 + TypeScript + Hono + @opita/ocais
- `api/package.json`: SST 3.14, Hono 4.6, @opita/ocais (zero deps, OpenAI-compatible = DeepSeek)
- `api/sst.config.ts`: SST config con `sst.aws.Function` (Lambda Function URL) + `sst.aws.Dynamo` (Sessions, Personas) + `sst.aws.Router` (`api.sociedad.opitacode.com`)
- `api/src/api.ts`: Hono handler con `/health`, `/v1/cities`, `/v1/cities/:id/personas`, `/v1/simulate` (con `@opita/ocais.streamText` + DeepSeek)
- `api/src/personas.ts`: 10 personas validadas de Tello (Big Five + Lomnitz + Dunbar + muletillas + red)
- `api/src/api-test-handler.ts`: wrapper de test sin el SST handler
- `api/tests/api.test.ts`: 5 smoke tests con Vitest
- `api/vitest.config.ts`: config Vitest
- `api/tsconfig.json`: Node 22 + strict

### Deploy (`.github/workflows/`)
- `ci.yml`: 3 jobs paralelos (frontend, api, markdown lint)
- `deploy-web.yml`: Astro build + `aws s3 sync` + CloudFront invalidation (alineado con `www.opitacode.com`)
- `deploy-api.yml`: `sst deploy --stage prod` con env var `DEEPSEEK_API_KEY`

### Raíz
- `README.md`: overview del proyecto con links a la org y al ecosistema
- `.gitignore`: deps, build, env, logs, editor

## Chain Context

```
📍 PR #1 (este) — feature/monumento-cultural-v1 → main
PR #2 (pendiente) — feature/s2-monumento-vivo (base: este PR, target: main)
PR #3 (pendiente) — feature/s3-expansion (base: PR #2, target: main)
```

## Decisiones de arquitectura (del operador)

1. **Backend TypeScript + SST** (migración desde Python + SAM)
2. **Repo en `Opita-Code/sociedad-opita-app`** (migración desde `nicourrutia98/sociedad-opita-app`)
3. **Astro 6 + Tailwind 4** (migración desde Astro 5 + Tailwind 3)

## Out of scope (S2)

- `index.astro` (home "monumento cultural" con 4 dimensiones) — S2
- `ventana.astro` (SSE stream) — S2 (usa `@opita/ocais.createSSEWriter`)
- `puente.astro` (WebSocket chat) — S2
- `replica.astro`, `taller.astro` — S3
- Las 31 personas restantes de Tello (10/41 documentadas en S1) — S2
- Integración con `opita-links` (acortador `go.opitacode.com`) — S2
- 1.10 redirect `web/*` → `/forense` — S3

## Test plan

- [ ] `cd web && npm install && npm run build` sin errores
- [ ] `cd api && npm install && npm test` pasa los 5 smoke tests
- [ ] `cd api && npx sst deploy --stage prod` (primera vez, interactivo)
- [ ] GitHub Actions CI corre verde en este PR

## Size

- **21 archivos, +1154 líneas** (con TODOS los archivos, frontend + backend + deploy)
- Budget: 400 líneas — excedido
- **`size:exception`**: aprobado en `sdd/monumento-cultural-v1/chain-strategy`

## Refs

- `sdd/monumento-cultural-v1/proposal`
- `sdd/monumento-cultural-v1/spec`
- `sdd/monumento-cultural-v1/design` (actualizado a SST + @opita/ocais)
- `sdd/monumento-cultural-v1/tasks`
- `sdd/monumento-cultural-v1/ecosystem-pivot` (decisión del pivote)
- `sdd/monumento-cultural-v1/chain-strategy`
- [Ecosistema Opita-Code](https://github.com/Opita-Code)
