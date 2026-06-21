# ADR-0001: Record Architecture Decisions

**Status**: Accepted
**Date**: 2026-06-21
**Deciders**: Juan Nicolás Urrutia Salcedo
**Supersedes**: —

---

## Context

Sociedad Opita es un proyecto con una longevidad prevista de décadas
(monumento digital vivo de Tello, Huila). A lo largo de su vida se
tomarán decenas — quizás cientos — de decisiones de arquitectura que
condicionan trabajo futuro:

- Por qué CloudFront+S3+Lambda en lugar de Cloudflare Pages.
- Por qué BGE-M3 q8 y no OpenAI embeddings.
- Por qué single-table DDB y no relacional.
- Por qué SST y no CDK.

Sin un registro:

1. El operador (y futuros colaboradores) no entiende *por qué* el
   stack es como es. Cuando un DevOps nuevo se une, tiene que
   reconstruir el razonamiento oral o commit-by-commit.
2. Las decisiones se *re-litigan* en cada cambio ("¿y si usamos
   Vercel?"). El equipo pierde tiempo.
3. Las consecuencias no obvias (costos, lock-in, trade-offs) se
   olvidan y se repiten errores.

El proyecto necesita un log ligero, versionado con el código, que
documente **contexto + decisión + consecuencias + alternativas** para
cada decisión de arquitectura durable.

## Decision

Adoptamos **Architecture Decision Records (ADRs)** en formato
ligero Markdown, almacenados en `docs/adr/`, con el siguiente
esquema:

1. **Numeración secuencial** de 4 dígitos (`NNNN-titulo-kebab.md`).
   Nunca se reusa un número, aunque el ADR se superseda.
2. **Plantilla mínima**: Status, Date, Deciders, Context, Decision,
   Consequences, Alternatives considered.
3. **Un ADR por decisión** atómica. Decisiones compuestas se dividen
   en ADRs separados con cross-references.
4. **Status lifecycle**:
   - `Proposed` — en discusión, aún no implementado.
   - `Accepted` — implementado y vigente.
   - `Superseded by ADR-NNNN` — reemplazado. No se borra; se añade
     `**Supersedes**` al nuevo y se enlaza desde el viejo.
   - `Deprecated` — la decisión sigue activa pero se desaconseja para
     trabajo nuevo.

5. **Idioma**: español para el cuerpo (es-CO), inglés para títulos
   técnicos cuando el término es inequívoco en inglés ("SST v3 over
   CDK"). El operador decide por ADR.
6. **Commit discipline**: cada ADR vive en su propio commit (o
   agrupado con un cambio claramente relacionado). El prefijo de
   commit es `docs(adr):` para que `git log --grep` filtre fácil.

## Consequences

**Más fácil**:
- Decidir rápido cuando una pregunta recurrente aparece ("¿y si
  cambiamos a Postgres?"). El ADR explica por qué no.
- Onboarding: leer los 7 ADRs fundacionales da una imagen completa
  del stack y sus trade-offs.
- Auditoría: años después, un periodista o investigador puede
  reconstruir el razonamiento del proyecto.
- Decisiones reversibles: si queremos cambiar, el ADR documenta qué
  *rompemos* y qué *ganamos*.

**Más difícil**:
- Hay que mantenerlos. Un ADR desactualizado es peor que ningún
  ADR.
- Tienden a proliferar. Regla: solo decisiones de arquitectura
  *durables* (afectan > 1 PR, condicionan trabajo futuro, o son
  irreversibles fácilmente). Decisiones tácticas viven en code
  comments o en `DEPLOY-RUNBOOK.md`.

**Trade-off explícito**: invertimos ~30 min/ADR. Recuperamos la
inversión cuando una decisión se re-pregunta, lo cual pasa al menos
una vez por mes en proyectos longevos.

## Alternatives considered

- **Wiki / Notion**: externos al repo, no se versionan con el código.
  Se desactualizan. Se pierden en migraciones de plataforma. **Rechazado**.
- **RFCs largos estilo Google**: útiles para decisiones que afectan
  múltiples equipos. Sociedad Opita es un proyecto *single-operator*;
  el overhead de un RFC con reviewers formales es desproporcionado.
  **Rechazado**.
- **No documentar**: status quo antes de este ADR. La pérdida de
  contexto es real, especialmente entre rondas de pulido separadas
  por semanas. **Rechazado**.
- **ADR con plantilla más rica** (Trade-off sliders, costos
  cuantificados, diagramas): tentador pero desincentiva escribir.
  Mejor plantilla mínima + links a artefactos cuando se necesiten.
  **Rechazado**.

## Pointers

- [`docs/adr/0002-cloudfront-s3-lambda-over-cloudflare-pages.md`](0002-cloudfront-s3-lambda-over-cloudflare-pages.md)
- [`docs/adr/0003-bge-m3-plus-lora-finetune.md`](0003-bge-m3-plus-lora-finetune.md)
- [`docs/adr/0004-single-table-dynamodb.md`](0004-single-table-dynamodb.md)
- [`docs/adr/0005-visual-honesty-stubs.md`](0005-visual-honesty-stubs.md)
- [`docs/adr/0006-ocaiss-v2.0.1-publish-fix.md`](0006-ocaiss-v2.0.1-publish-fix.md)
- [`docs/adr/0007-sst-v3-over-cdk.md`](0007-sst-v3-over-cdk.md)
