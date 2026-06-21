# Sociedad Opita — Monumento Digital Vivo

> **El primer monumento digital vivo de una comunidad colombiana.** Tello, Huila.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-≥22.12-green.svg)](https://nodejs.org/)
[![Astro 6](https://img.shields.io/badge/Astro-6.x-FF5D01.svg)](https://astro.build)
[![SST 3](https://img.shields.io/badge/SST-3.x-0064FF.svg)](https://sst.dev)

---

## ¿Qué es?

Sociedad Opita es un **monumento digital vivo** que preserva la forma de hablar y la
vida social de Tello, un pueblo rural del Huila (Colombia) de 12.908 habitantes.

Tello tiene 41 personas documentadas con perfiles psicométricos completos
(**Big Five**, **Lomnitz**, **Dunbar**) y una red social geográficamente anclada
a la plaza del pueblo. Las 10 primeras están validadas por un hablante nativo
del dialecto *opita* y se simulan con IA en una capa de streaming
([`@opita/ocais`](https://github.com/Opita-Code/ocais) v2.0).

No es un juego. No tiene niveles. No tiene mecánicas de *engagement*.
Es un **monumento**: la primera copia preservable de una forma de hablar
que se está perdiendo.

---

## Las 4 dimensiones

El monumento se habita de **cuatro formas**. Cada una tiene su página,
su contrato y su rol en la preservación.

| # | Dimensión | Página | Qué hace | Estado |
|---|-----------|--------|----------|--------|
| 1 | **La Ventana** | [`/ventana`](web/src/pages/ventana.astro) | Observa el pueblo correr. Línea de tiempo de un día en Tello: cada hora, una persona real, con sus muletillas validadas. | DEMOSTRACIÓN (estática) |
| 2 | **El Puente** | [`/puente`](web/src/pages/puente.astro) | Conversa con los personajes. Tres transcripciones de muestra construidas con personas y modos validados del dataset. | DEMOSTRACIÓN (estática) |
| 3 | **La Réplica** | [`/replica`](web/src/pages/replica.astro) | Extiende el monumento a otros municipios (Garzón, Pitalito, La Plata). Curada, no self-service. | ACTIVA |
| 4 | **El Taller** | [`/taller`](web/src/pages/taller.astro) | El detrás de escena académico. El paper, los 41 perfiles, los 10 diálogos validados, los 204 papers en BibTeX, la memoria de la Masacre del Puente de los Decapitados (1950). | ACTIVA |

> **Visual honesty**: la Ventana y el Puente se publican hoy como **stubs
> estáticos** con personas, muletillas y modos *reales* del dataset
> validado. **No** son "próximamente" — son transcripciones fieles del
> opita. Cuando el feed en vivo esté listo, reemplaza el contenido
> sin cambiar el contrato visual.
> Decisión documentada en [ADR-0005](docs/adr/0005-visual-honesty-stubs.md).

---

## Decisiones del operador (honradas)

Estas decisiones guían el proyecto y **no se revisan sin conversación
explícita** con el operador. Si encuentras una que viola una de estas
reglas, es un *bug*, no una optimización.

### v1 (10 decisiones fundacionales)

1. **Masacre del Puente de los Decapitados (1950)** — sección dedicada
   en el Taller. Memoria del pueblo, no dato a explotar.
2. **Español only** — todo el contenido en `es-CO`. Sin i18n.
3. **Personas híbrido** — 10 arquetipos actuales validados + 31 pendientes
   con consentimiento explícito del municipio.
4. **Himno de Tello** — letra de **Álvaro Velásquez**, música de
   **Delia Camacho**. Uso público en actos cívicos.
5. **Banano 91%** — Tello produce el 91% del banano del Huila. Dato
   presente en el home y en el taller.
6. **Mobile-first, <50 KB por página, sin framework JS pesado, sin tracking.**
7. **8+ reportes de Artesanías de Colombia** descargables desde el Taller.
8. **Style lock B/N** — Benjamín de la Calle, Nereo López, Pedro Nel Gómez
   como referencia estética permanente. Sin color poluído.
9. **WhatsApp bridge** como canal principal: `wa.me/573126126085`
   (número real del operador).
10. **204 papers en BibTeX** descargables con filtros por autor/año/tema.

### v2 (4 decisiones del cambio `monumento-cultural-v2`)

11. **Capa de streaming @opita/ocais v2.0** — RAG + estado + persona en
    una sola composición. (ADR-0003, ADR-0006)
12. **Single-table DynamoDB** con dos GSIs (`byPersona`, `byTime`).
    (ADR-0004)
13. **AWS S3 + CloudFront + Lambda** sobre Cloudflare Pages. (ADR-0002)
14. **SST v3** sobre AWS CDK. (ADR-0007)

---

## Stack

Alineado con el ecosistema [Opita-Code](https://github.com/Opita-Code):

| Capa | Tecnología | Versión | Por qué |
|------|-----------|---------|---------|
| **Frontend** | Astro 6 + React 19 islands + Tailwind 4 | `^6.3.1` | HTML estático, hidratación selectiva, sin JS framework pesado |
| **Backend** | SST v3 + TypeScript + Hono 4 + AWS Lambda | `sst ^3.14`, `hono ^4.6` | Lambda arm64, Function URL, integración nativa con DDB |
| **Streaming AI** | [`@opita/ocais`](https://github.com/Opita-Code/ocais) | `v2.0.0` (cross-repo) | OpenAI-compatible; transport con `system` + `messages[]` |
| **Embeddings** | BGE-M3 (Xenova ONNX, q8 quantized) | bge-m3-v1 | Multilingual, 568 tokens, ONNX runtime en Node 22 |
| **Storage** | AWS DynamoDB (single-table) | `^3.600` SDK | Tres tablas: `Sessions`, `Personas`, `SociedadOpitaState` |
| **Secrets** | SST Secret → AWS SSM SecureString | — | `DEEPSEEK_API_KEY` encriptada en reposo (Polish R5) |
| **Deploy FE** | GitHub Actions → S3 + CloudFront | — | Static site, sin SSR adapter |
| **Deploy BE** | GitHub Actions → `sst deploy` | — | Lambda + DDB + Router con custom domain |
| **CI** | GitHub Actions (lint, typecheck, test, build) | — | Concurrency cancel-in-progress para ahorrar minutos |
| **Tests BE** | Vitest + fast-check (property-based) | `vitest ^3.2` | 215+ tests, chaos tests, golden queries |
| **Tests FE** | Playwright | `@playwright/test ^1.42` | E2E para los 5 rutas |

Detalle por módulo: [`api/README.md`](api/README.md) y [`web/README.md`](web/README.md).

---

## Estructura del repositorio

```
sociedad-opita-app/
├── api/                          # SST v3 + Hono 4 + TypeScript
│   ├── src/
│   │   ├── api.ts                # Hono app + AWS_PROXY adapter
│   │   ├── personas.ts           # 10 personas validadas
│   │   ├── llm/                  # provider, cost-tracker, rate-limiter (PR #5)
│   │   ├── rag/                  # retrieve, types, embed-query (PR #6)
│   │   ├── state/                # schema, dynamo-client, persona-state, conversation (PR #7)
│   │   ├── handlers/             # dialogue, personas, validation (PR #9, R5)
│   │   ├── context/              # builder (PR #9, R5)
│   │   └── observability/        # logger, metrics, tracing, middleware, cost (R6)
│   ├── tests/                    # 215+ tests (golden + chaos + property-based)
│   ├── sst.config.ts             # Lambda + DDB + Router + Secret
│   ├── alarms.config.ts          # CloudWatch alarm manifest (typed)
│   └── package.json
│
├── web/                          # Astro 6 + Tailwind 4 (estático)
│   ├── src/
│   │   ├── pages/                # /, /ventana, /puente, /replica, /taller, /pronto
│   │   ├── layouts/Layout.astro
│   │   └── styles/global.css     # Paleta opita (8 colores)
│   ├── public/                   # Imágenes CC-BY-SA + descargables BibTeX
│   ├── scripts/analyze-bundle.ts # Polish R3 budget inspector
│   ├── astro.config.mjs
│   └── package.json
│
├── docs/
│   ├── adr/                      # 7 ADRs (este PR agrega)
│   ├── ocais-rag-integration.md  # Plan de integración OCAIS v2 + RAG
│   └── ...
│
├── runbooks/                     # 5 runbooks (este PR agrega)
├── references/                   # markitdown-tuned corpus + recon OSINT
├── .github/workflows/            # ci.yml, deploy-prod.yml, deploy-api.yml
│
├── DEPLOY-RUNBOOK.md             # Runbook canónico de deploy
├── RUNBOOKS.md                   # Índice de runbooks operativos
├── README-FINETUNE.md            # LoRA fine-tuning (Phase B, deferred)
└── README.md                     # Este archivo
```

---

## Quick start

### Requisitos

- **Node.js ≥ 22.12** (recomendado: `nvm install 22` o `fnm use 22`)
- **pnpm 9** para `api/`
- **npm 10** para `web/`
- **AWS CLI** configurado con un perfil que pueda crear Lambda, DDB y S3
  (solo necesario para deploy; no para dev local)

### Frontend (sin backend)

```bash
cd web
npm install
npm run dev
# → http://localhost:4321
```

Las páginas estáticas (Ventana, Puente) no necesitan API corriendo.

### Backend (SST live Lambda)

```bash
cd api
pnpm install
pnpm dev          # sst dev — Live Lambda en local
# → API en http://localhost:3000 (o el puerto que sst asigne)
```

> **Secret de DeepSeek**: para `sst dev` local, la primera vez SST
> pide el `DEEPSEEK_API_KEY` interactivamente. También funciona un
> `api/.env` con `DEEPSEEK_API_KEY=sk-...` para iteración rápida.
> Ver [`runbooks/dialogue-errors.md`](runbooks/dialogue-errors.md) para
> troubleshooting del provider.

### Full stack (frontend + backend simultáneos)

```bash
# Terminal 1
cd api && pnpm dev

# Terminal 2
cd web && npm run dev
# El frontend hace fetch a la URL del SST dev (ver la consola del terminal 1)
```

---

## Deploy

El procedimiento canónico vive en [`DEPLOY-RUNBOOK.md`](DEPLOY-RUNBOOK.md).
Resumen ejecutivo:

```bash
# Frontend (S3 + CloudFront)
cd web
npm ci
npm run build
aws s3 sync dist s3://sociedad-opita-app-prod --delete \
  --cache-control "public, max-age=86400, stale-while-revalidate=604800" \
  --exclude "*.map"
aws cloudfront create-invalidation \
  --distribution-id "$CLOUDFRONT_DISTRIBUTION_ID" --paths "/*"

# Backend (SST)
cd api
pnpm install --frozen-lockfile
pnpm sst deploy --stage prod
```

> **Primera vez** (`sst deploy --stage prod`): SST pregunta interactivamente
> para confirmar la creación de la stack. Los deploys subsiguientes son
> automáticos vía `workflow_dispatch` (ver `.github/workflows/deploy-api.yml`).

URLs:

| Recurso | URL |
|---------|-----|
| **Producción** | https://sociedad.opitacode.com |
| **API** | https://api.sociedad.opitacode.com (SST Router) |
| **Paper académico** | https://github.com/nicourrutia98/sociedad-opita |
| **Ecosistema Opita-Code** | https://github.com/Opita-Code |

---

## Desarrollo

### Workflow de contribución

1. **Branches**: `feature/<scope>` para features, `fix/<scope>` para
   fixes, `polish/<ronda>-<tema>` para rondas de pulido. Nunca commits
   directos a `main`.
2. **Commits**: [Conventional Commits](https://www.conventionalcommits.org/).
   ```
   feat(api): add persona state to context builder
   fix(web): truncate taller description on mobile
   chore(security): add prompt-injection defense in context/builder.ts
   docs: ADRs + READMEs (polish R4)
   ```
3. **PRs**: una concern por PR. PRs > 400 líneas deben dividirse en
   chained PRs (squash-and-merge por concern) para proteger el foco
   de review del reviewer.
4. **Tests primero**: si tocas lógica de negocio, el test va en el mismo
   PR. PR sin test se rechaza (excepto docs / config).
5. **CI verde**: el merge está bloqueado hasta que `ci.yml` pase. Hay
   pasos tolerantes (`continue-on-error: true`) documentados en
   [`DEPLOY-RUNBOOK.md`](DEPLOY-RUNBOOK.md) pre-deploy checklist.

### Estructura de un commit

Cada commit debe ser una **unidad revisable autocontenida** — un
cambio de comportamiento + sus tests + su doc en un solo commit
(atomico, reversible, y entendible sin leer el PR completo). PRs
con varios commits se mergean con **squash** para preservar
historia lineal en `main`.

### Rondas de pulido (Polish R1–R7)

El proyecto se ha sometido a 7 rondas de pulido sucesivas:

| Ronda | Foco | PR |
|-------|------|-----|
| R1 | Code review (seguridad + perf) | — |
| R2 | Test expansion (10 golden queries + chaos + property-based) | — |
| R3 | Performance baseline + bundle analysis | #12 |
| R4 | **Documentación (este PR)** | TBD |
| R5 | Security hardening (validation, prompt injection, secrets) | #11 |
| R6 | Observability (logger, metrics, tracing, cost tracking) | #13 |
| R7 | Deployment hardening (arm64, CI, runbook, alarms, cost cap) | #10 |

---

## ADRs (Architecture Decision Records)

Decisiones de arquitectura con consecuencias durables. Ver [`docs/adr/`](docs/adr/).

- [ADR-0001](docs/adr/0001-record-architecture-decisions.md) — Plantilla de ADRs
- [ADR-0002](docs/adr/0002-cloudfront-s3-lambda-over-cloudflare-pages.md) — CloudFront+S3+Lambda sobre Cloudflare Pages
- [ADR-0003](docs/adr/0003-bge-m3-plus-lora-finetune.md) — BGE-M3 + LoRA fine-tune (Option C)
- [ADR-0004](docs/adr/0004-single-table-dynamodb.md) — Single-table DynamoDB
- [ADR-0005](docs/adr/0005-visual-honesty-stubs.md) — Visual honesty: stubs con datos reales
- [ADR-0006](docs/adr/0006-ocaiss-v2.0.1-publish-fix.md) — OCAIS v2.0.1 cross-repo publish fix
- [ADR-0007](docs/adr/0007-sst-v3-over-cdk.md) — SST v3 sobre AWS CDK

---

## Runbooks operativos

Para responder a incidentes en producción, ver [`RUNBOOKS.md`](RUNBOOKS.md).

- [`runbooks/dialogue-errors.md`](runbooks/dialogue-errors.md) — patrones comunes de error en `/v1/dialogue`
- [`runbooks/dynamodb-throttling.md`](runbooks/dynamodb-throttling.md) — throttling en `SociedadOpitaState`
- [`runbooks/cost-overrun.md`](runbooks/cost-overrun.md) — spike de costo en Lambda / DDB / DeepSeek
- [`runbooks/lambda-cold-start.md`](runbooks/lambda-cold-start.md) — troubleshooting cold-start BGE-M3
- [`runbooks/corpus-rebuild.md`](runbooks/corpus-rebuild.md) — cómo regenerar `corpus-embeddings.json.gz`

---

## Repos relacionados (ecosistema Opita-Code)

- [`Opita-Code/ocais`](https://github.com/Opita-Code/ocais) — SDK de
  streaming AI (usado por Ventana y Puente cuando se conecten al backend).
- [`Opita-Code/opita-links`](https://github.com/Opita-Code/opita-links) —
  Acortador de URLs del ecosistema.
- [`Opita-Code/www.opitacode.com`](https://github.com/Opita-Code/www.opitacode.com) —
  Landing de Opita-Code (referencia del patrón Astro + S3 + CloudFront).
- [`Opita-Code/sociedad-opita-app`](https://github.com/Opita-Code/sociedad-opita-app) —
  Este repositorio.

---

## Licencia

- **Código**: [MIT](LICENSE)
- **Personas, ground-truth y datos biográficos**: [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/)
- **Paper académico**: [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/)
- **Uso comercial** del benchmark o de los datos de personas requiere
  atribución al autor y notificación previa al operador.

---

## Contacto

**Juan Nicolás Urrutia Salcedo** — operador del proyecto
- WhatsApp: [+57 312 612 6085](https://wa.me/573126126085)
- GitHub: [@nicourrutia98](https://github.com/nicourrutia98)
- Instagram: [@nico98urrutia](https://instagram.com/nico98urrutia)
- Ubicación: Neiva, Huila, Colombia

**Issues**: [github.com/Opita-Code/sociedad-opita-app/issues](https://github.com/Opita-Code/sociedad-opita-app/issues)

> *Hecho por un nativo huilense, en el Huila, con IA, para que Tello no se
> muera cuando los pelaos se vayan pa' Bogotá.*
