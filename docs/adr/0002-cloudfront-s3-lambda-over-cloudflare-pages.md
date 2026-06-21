# ADR-0002: CloudFront + S3 + Lambda sobre Cloudflare Pages

**Status**: Accepted
**Date**: 2026-06-21
**Deciders**: Juan Nicolás Urrutia Salcedo
**Supersedes**: —

---

## Context

Sociedad Opita es un stack de **dos servicios** (frontend estático +
backend con RAG/estado) que se deployan de forma coordinada pero
distinta:

- **Frontend** — Astro 6 estático, < 2.5 MB total, ~50 KB por página.
  Sin SSR, sin server-side compute.
- **Backend** — Lambda con BGE-M3 ONNX (2048 MB), DynamoDB
  single-table, secrets en SSM, custom domain para la API.

Necesitamos elegir una plataforma de hosting. Las candidatas
razonables en 2026 son:

| Plataforma | Static site | Backend | Latencia (CO↔US) | Costo (10k req/day) |
|------------|-------------|---------|------------------|----------------------|
| **Cloudflare Pages + Workers** | ✓ | ✓ (Workers) | ~30 ms | ~$5 |
| **Vercel + Edge Functions** | ✓ | ✓ (Edge) | ~50 ms | ~$20 |
| **AWS CloudFront + S3 + Lambda** | ✓ | ✓ (Lambda) | ~120 ms | ~$15 |
| **Netlify + Edge Functions** | ✓ | ✓ (Deno) | ~80 ms | ~$15 |

El tráfico previsto es bajo (10–100 visitantes/día, time-zone
concentrado en horas diurnas colombianas). El tráfico de API es aún
menor (chat en `/puente` cuando esté live, ~5 conversaciones/día).

Cloudflare es la opción más barata, rápida y elegante *en superficie*.
Pero el backend necesita **ejecutar BGE-M3 q8 ONNX** (~600 MB de
runtime) — ¿lo soporta Workers?

## Decision

Adoptamos **AWS CloudFront + S3 + Lambda** con **SST v3** como IaC.

- Frontend en **S3** (bucket privado con OAI), servido por
  **CloudFront** con política `max-age=86400` + SWR=7d (Polish R3).
- Backend en **Lambda arm64** (2048 MB, 60 s, concurrency 10),
  expuesto vía **Function URL** + **SST Router** con custom domain
  `api.sociedad.opitacode.com`.
- Persistencia en **DynamoDB** (single-table, 2 GSIs, TTL 90 días).
- Secrets en **SSM Parameter Store** (SecureString) vía `sst.Secret`.
- CI/CD: **GitHub Actions** → `sst deploy` (BE) + `aws s3 sync`
  (FE).

## Consequences

**Más fácil**:

- **Single-vendor**: una sola cuenta AWS, una sola factura, un solo
  IAM role. Cero coordinación cross-cloud.
- **BGE-M3 ONNX funciona nativamente**: Lambda arm64 + Node 22 +
  `@huggingface/transformers` ejecutan el modelo sin fricción. En
  Cloudflare Workers **no correría** (límite de 128 MB para el bundle,
  Workers no soporta `native` modules como ONNX runtime).
- **Ecosistema Opita-Code**: el patrón CloudFront+S3+Lambda ya vive
  en [`Opita-Code/www.opitacode.com`](https://github.com/Opita-Code/www.opitacode.com)
  y [`Opita-Code/opita-links`](https://github.com/Opita-Code/opita-links).
  Reutilizamos prácticas, no las inventamos.
- **Cost predictability**: Lambda + DDB son pay-per-call. Reserved
  concurrency 10 (Polish R7) pone un techo duro al costo de abuso.
  El budget cap mensual del operador es < $25.
- **CloudWatch + X-Ray**: logging, metrics, tracing, alarms —
  integrados sin glue code.

**Más difícil**:

- **Latencia CO→US-East-1 ~120 ms** vs ~30 ms a Cloudflare edge.
  El visitante colombiano siente esto en el TTFB del primer byte.
  Mitigado por CloudFront edge cache (SWR 7d) en el frontend.
- **Vendor lock-in AWS**: DynamoDB, Lambda, CloudFront son
  propietarios. Migrar después es costoso.
- **Cold-start de Lambda** (5–8 s con BGE-M3). Mitigado con Lambda
  Layer (Polish R3, Option A) y, en Phase 2, SnapStart.
- **AWS IAM** sigue siendo el laberinto de siempre. SST abstrae
  mucho, pero los secretos `sst.Secret` requieren entender SSM.

**Trade-off cuantificado**: pagamos ~$10/mes extra (vs Cloudflare)
por la posibilidad de ejecutar BGE-M3 en producción sin reescribir
el backend. Para un proyecto que es un *monumento*, esa flexibilidad
vale más que la diferencia.

## Alternatives considered

- **Cloudflare Pages + Workers**:
  - ✓ Más barato, más rápido en edge, KV store incluido.
  - ✗ Workers no soporta BGE-M3 ONNX (límite 128 MB bundle + sin
    `native` modules). Habría que mover el embedding a un servicio
    externo (HuggingFace Inference API), añadiendo latencia +
    vendor + costo.
  - ✗ Workers runtime es V8 isolates, no Node 22. Re-escribir
    `api/src/*` con `nodejs_compat` agrega fricción.
  - ✗ Ecosistema Opita-Code ya está en AWS. Migrar solo Sociedad
    Opita introduce fragmentación.
  - **Rechazado** por la incompatibilidad con BGE-M3 y la
    fragmentación del ecosistema.

- **Vercel + Edge Functions**:
  - ✓ Excelente DX, preview deploys.
  - ✗ Edge runtime también limita ONNX. Mismo problema.
  - ✗ Costo más alto en tiers razonables ($20/mes vs $15).
  - **Rechazado** por Edge runtime + costo.

- **Render / Fly.io**:
  - ✓ Simple, contenedor completo.
  - ✗ Cold-start aún peor que Lambda para modelos grandes.
  - ✗ No encaja con el patrón del ecosistema Opita-Code.
  - **Rechazado** por cold-start + consistencia del ecosistema.

- **No usar CDN (S3 directo)**:
  - ✗ Latencia CO→S3 es alta (~200 ms). Visitantes colombianos
    sufren.
  - **Rechazado**.

## Pointers

- [`api/sst.config.ts`](../../api/sst.config.ts) — Definición del stack
- [`DEPLOY-RUNBOOK.md`](../../DEPLOY-RUNBOOK.md) — Procedimiento de deploy
- [ADR-0007: SST v3 sobre AWS CDK](0007-sst-v3-over-cdk.md) — Por qué SST, no CDK
- [ADR-0003: BGE-M3 + LoRA fine-tune](0003-bge-m3-plus-lora-finetune.md) — El modelo que requiere Lambda
- [ADR-0004: Single-table DynamoDB](0004-single-table-dynamodb.md) — La persistencia
