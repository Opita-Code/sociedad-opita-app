# ADR-0003: BGE-M3 + LoRA Fine-tune (Option C)

**Status**: Accepted
**Date**: 2026-06-21
**Deciders**: Juan Nicolás Urrutia Salcedo
**Supersedes**: —

---

## Context

El retrieval del RAG necesita una función de embedding que:

1. **Entienda español colombiano rural del Huila** (muletillas,
   diminutivos, code-switching con quechua residual).
2. Sea **multilingual** (algunos textos del corpus están en
   español peninsular académico, otros en opita).
3. Maneje **documentos largos** (el paper académico, transcripciones
   de 30+ páginas).
4. Corra **server-side en Lambda** (sin llamada externa por
   request).
5. Sea **barato** (el operador corre el proyecto sin financiación).

Las opciones que consideramos:

| Opción | Multilingual | Docs largos | On-prem | Costo | Calidad ES-CO |
|--------|--------------|-------------|---------|-------|----------------|
| **A. OpenAI `text-embedding-3-small`** | ✓ (multilingual) | ✗ (8K tokens) | ✗ (API only) | $0.02/1M | Alta |
| **B. Cohere `embed-multilingual-v3`** | ✓ | ✗ (512 tokens) | ✗ | $0.10/1M | Alta |
| **C. BGE-M3 (Xenova ONNX, q8)** | ✓ (100+ langs) | ✓ (8192 tokens) | ✓ (Node 22) | $0 (compute only) | Alta en ES |
| **D. Sentence-Transformers `paraphrase-multilingual-MiniLM`** | ✓ | ✗ (128 tokens) | ✓ | $0 | Media |

## Decision

Adoptamos **Opción C: BGE-M3 (Xenova ONNX, quantización q8)** ejecutada
server-side en la Lambda vía `@huggingface/transformers`.

- Modelo: `Xenova/bge-m3` desde HuggingFace Hub.
- Quantización: **q8** (int8) — el modelo fp32 son ~2.3 GB, q8 baja
  a ~600 MB. Cabe en 2048 MB de Lambda con activations.
- Runtime: ONNX vía `@huggingface/transformers` en Node 22 arm64.
- Embeddings: 1024 dimensiones, L2-normalized (cosine = dot product).
- Fine-tuning: **LoRA adapter** entrenado sobre el corpus de Tello
  (muletillas, nombres propios, topónimos). Pipeline documentado en
  [`README-FINETUNE.md`](../../README-FINETUNE.md). Phase B, deferred
  al operador — la pipeline de scripts se materializará cuando
  Phase B arranque.

Por qué la letra "C" (no A): el costo de OpenAI es bajo en
absolute terms ($0.02/1M tokens) pero implica (a) llamada externa por
request → +200 ms latencia, (b) dependencia de un vendor con ToS
cambiantes, (c) datos de un pueblo colombiano salen a un servidor
fuera de Colombia. Para un monumento, la **soberanía del embedding**
importa.

## Consequences

**Más fácil**:

- **Cero costo de API**: el modelo corre dentro de la Lambda. La
  inferencia cuesta solo el tiempo de Lambda (~$0.000016 por
  embedQuery de 50 ms en 2048 MB).
- **Sin latencia de red**: `embedQuery()` retorna en 50–150 ms warm,
  5–8 s cold (mitigado con Lambda Layer — ver
  [`runbooks/lambda-cold-start.md`](../../runbooks/lambda-cold-start.md)).
- **Soberanía de datos**: ningún texto del corpus sale del VPC de
  AWS. Importante porque el corpus contiene memoria de la Masacre
  del Puente de los Decapitados (1950).
- **Multilingual robusto**: 100+ idiomas, modelo entrenado en
  pares EN/ZH/ES, fine-tunable con LoRA.
- **LoRA pipeline**: podemos mejorar la calidad en opita sin
  re-entrenar el modelo base (~1 hora de training en una A10 vs
  ~24h para full fine-tune).

**Más difícil**:

- **Cold-start 5–8 s**: cargar el modelo en cada contenedor fresco.
  Mitigación: Lambda Layer pre-empaquetado (~600 MB) ahorra 3–5 s.
  Polish R3 Option A.
- **Memoria ajustada**: 2048 MB. Si añadimos más features (BGE-M3
  full fp32, segundo modelo) hay que subir a 3008 MB ($+5/mes).
- **Calidad ES-CO base**: BGE-M3 es bueno en español, pero el
  opita tiene idiosyncrasias (muletillas, diminutivos -ico/-ica, "mijo"
  como vocativo). **El LoRA fine-tune es necesario**, no opcional.
  Phase B (deferred).
- **Embeddings fijos de 1024 dim**: si el modelo base cambia, hay
  que re-embebir todo el corpus (~45 min con la pipeline actual).
- **Sin SLA de HuggingFace**: el Hub puede caer, versionar el modelo
  localmente con `huggingface-cli download` + commit en S3.

**Trade-off cuantificado**: con 10 conversaciones/día y 4 chunks por
RAG top-k, el costo de embedding es ~$0.005/día (Lambda warm) o
~$0.05/día si todos son cold. vs OpenAI: ~$0.0001/día. La diferencia
es < $2/mes. Lo que pagamos es soberanía + latencia.

## Alternatives considered

- **A. OpenAI `text-embedding-3-small`**: la opción más perezosa.
  Buena calidad, pero (a) latencia +200 ms, (b) datos fuera de
  Colombia, (c) costo variable según tráfico. **Rechazado** por
  soberanía.
- **B. Cohere `embed-multilingual-v3`**: similar a A, peor en
  documentos largos, más caro. **Rechazado**.
- **D. `paraphrase-multilingual-MiniLM`**: corre on-prem, pero el
  límite de 128 tokens trunca los chunks académicos. Habría que
  chunkear agresivamente, perdiendo contexto. **Rechazado** por
  límite de tokens.
- **Hybrid A+C**: BGE-M3 on-prem para la mayoría, OpenAI como
  fallback para casos edge. **Rechazado** por complejidad operacional
  sin beneficio claro a 10 conversaciones/día.
- **Esperar a Phase 2 (vector DB dedicada)**: Pinecone / Weaviate /
  Qdrant. Tentador, pero el corpus cabe en memoria (45 MB
  compressed) y cosine brute-force funciona bien hasta ~10K
  vectores. No necesitamos más. **Rechazado** por over-engineering.

## Pointers

- [`api/src/rag/embed-query.ts`](../../api/src/rag/embed-query.ts) — Implementación
- [`api/src/rag/retrieve.ts`](../../api/src/rag/retrieve.ts) — Cosine top-k
- [`README-FINETUNE.md`](../../README-FINETUNE.md) — Pipeline LoRA (Phase B, deferred)
- [`runbooks/lambda-cold-start.md`](../../runbooks/lambda-cold-start.md) — Mitigación cold-start
- [ADR-0002: CloudFront+S3+Lambda](0002-cloudfront-s3-lambda-over-cloudflare-pages.md) — Por qué Lambda
