# Runbook — `corpus-rebuild`

> **Cómo regenerar `corpus-embeddings.bge-m3-v1.json.gz` cuando
> el corpus está stale, corrupto, o el modelo base cambia.**

**Severidad**: P1 (sin corpus, `/v1/dialogue` retorna 500)
**Tiempo objetivo de regeneración**: ~2 h (manual), ~30 min
(automatizado, Phase 2)

---

## Cuándo es necesario rebuild

| Trigger | Síntoma | Acción |
|---------|---------|--------|
| **Corpus source cambió** (nuevos papers, nuevas entrevistas) | `/v1/dialogue` da respuestas desactualizadas | Rebuild |
| **Modelo base cambió** (e.g., Xenova/bge-m3 → bge-m3-v2) | Embeddings incompatibles, cosine no funciona | Rebuild + bump de version |
| **LoRA fine-tune aplicado** (Phase B) | Embeddings mejorados, pero vector shape cambia | Rebuild con LoRA weights |
| **Corpus corrupto** (file fails to decompress, JSON parse error) | `/v1/dialogue` retorna `500 internal_error` con `corpus-embeddings...` en el log | Rebuild |
| **Lambda Layer bump** | Si el modelo en la Layer cambia, el embedder cambia, embeddings incompatibles | Rebuild |

---

## Qué es el corpus

El corpus es un **archivo JSON.gz** con chunks del paper académico,
las entrevistas de campo, los papers BibTeX descargables, y las
transcripciones validadas. Cada chunk tiene:

```ts
{
  id: string;          // "paper-2024-rural-colombia-001"
  text: string;        // el chunk de texto (max ~512 tokens)
  embedding: number[]; // 1024-dim vector, L2-normalized
  source: string;      // "paper" | "interview" | "transcript" | "bibtex"
  metadata: {
    title?: string;
    author?: string;
    year?: number;
    section?: string;
  }
}
```

**Ubicación**:

- **Local dev**: `references/markitdown-corpus/corpus-embeddings.bge-m3-v1.json.gz`
- **Lambda** (Phase 1): `/tmp/corpus-embeddings.bge-m3-v1.json.gz`
- **Lambda** (Phase 2): S3 `s3://sociedad-opita-corpus-prod/corpus-embeddings.bge-m3-v1.json.gz`,
  descargado a `/tmp` en cold start

**Tamaño típico**: 30–80 MB compressed, ~3K–10K chunks.

---

## Pipeline de regeneración

### Inputs

1. **Source documents** en `references/markitdown-corpus/` (o
   `references/external-data/`, `references/tello/`):
   - Papers académicos (PDF, BibTeX)
   - Entrevistas de campo (audio transcrito)
   - Transcripciones validadas de opita
   - 204 papers en BibTeX
2. **Modelo de embedding**: `Xenova/bge-m3` v1 (o v2 cuando se
   bumpe).
3. **LoRA adapter** (Phase B): `models/bge-m3-opita-lora/`.

### Steps

```bash
# 1. Activar el venv del proyecto (si no está activo)
cd api
source .venv/bin/activate  # o el path correspondiente

# 2. Descargar el modelo base (si no está cacheado)
python -c "from transformers import AutoModel; \
  m = AutoModel.from_pretrained('Xenova/bge-m3', cache_dir='./models/')"

# 3. Cargar LoRA adapter (Phase B, si aplica)
# python -c "from peft import PeftModel; \
#   base = AutoModel.from_pretrained('Xenova/bge-m3'); \
#   m = PeftModel.from_pretrained(base, './models/bge-m3-opita-lora/')"

# 4. Ejecutar el pipeline de rebuild
python scripts/rebuild-corpus.py \
  --source-dir ../references/markitdown-corpus/ \
  --output ../references/markitdown-corpus/corpus-embeddings.bge-m3-v1.json.gz \
  --model Xenova/bge-m3 \
  --chunk-size 512 \
  --chunk-overlap 64 \
  --batch-size 16
```

### Qué hace `scripts/rebuild-corpus.py`

1. **Lee los source documents** (PDF, MD, TXT, BibTeX).
2. **Chunking**:
   - Papers académicos: por sección (Abstract, Intro, Methods, etc.).
   - Entrevistas: por turno de hablante.
   - BibTeX: por entrada (un chunk por paper).
   - Chunk size: 512 tokens, overlap 64 tokens.
3. **Embeddings**:
   - BGE-M3 (o +LoRA si Phase B).
   - L2-normalized.
   - Batch size 16 (ajustar a memoria disponible).
4. **Output**:
   - JSON.gz con la estructura `{chunks: [...]}`.
   - Metadata: `generated_at`, `model`, `lora` (si aplica),
     `chunk_count`, `total_tokens`.

### Tiempo esperado

- 3K chunks: ~5 min.
- 10K chunks: ~15 min.
- 50K chunks: ~60 min (con LoRA, +20%).

En CPU (no GPU), los números son ~3x. Si tienes GPU disponible,
usar `device=cuda` reduce el tiempo a < 5 min para 50K chunks.

---

## Verificación post-rebuild

### 1. Test de integridad

```bash
# El archivo descomprime y es JSON válido
gunzip -t ../references/markitdown-corpus/corpus-embeddings.bge-m3-v1.json.gz
echo "✓ gzip OK"

# JSON parsea
python -c "
import gzip, json
with gzip.open('../references/markitdown-corpus/corpus-embeddings.bge-m3-v1.json.gz') as f:
    data = json.load(f)
print(f'✓ chunks: {len(data[\"chunks\"])}')
print(f'✓ first chunk dim: {len(data[\"chunks\"][0][\"embedding\"])}')
assert len(data['chunks'][0]['embedding']) == 1024, 'dim mismatch'
print('✓ embedding dim = 1024')
"
```

### 2. Golden queries test

```bash
# Ejecutar la suite de tests RAG con el nuevo corpus
cd api
pnpm test -- tests/rag/retrieve-golden-expanded.test.ts
# Esperado: 10/10 pass
```

Si fallan:

- **¿Las respuestas esperadas cambiaron?** Si el corpus tiene
  contenido nuevo, los golden tests pueden necesitar update.
  Esto es expected, pero requiere revisión manual.
- **¿Las dimensiones del embedding cambiaron?** Si cambiaste el
  modelo (v1 → v2), necesitas actualizar el `embedQuery()` para
  usar el nuevo modelo, y bumpear el filename a `bge-m3-v2`.

### 3. Smoke test en local dev

```bash
# Local dev (sin deploy)
pnpm dev  # sst dev

# En otra terminal
curl -N -X POST http://localhost:3000/v1/dialogue \
  -H "Content-Type: application/json" \
  -d '{"persona_id":"dona_rosa_tendera","scene":{"time":"06:00","place":"tienda"},"query":"que chisme hay"}'

# Esperado: SSE stream con respuesta coherente en opita
```

---

## Deploy del nuevo corpus

### Opción A: S3 (Phase 2 — preferido)

```bash
# 1. Upload a S3
aws s3 cp references/markitdown-corpus/corpus-embeddings.bge-m3-v1.json.gz \
  s3://sociedad-opita-corpus-prod/corpus-embeddings.bge-m3-v1.json.gz

# 2. La Lambda descarga a /tmp en cold start (sst.config.ts ya
#    configura CORPUS_PATH apuntando a /tmp).
#    Si quieres forzar el download sin esperar cold start:
aws lambda invoke \
  --function-name sociedad-opita-app-ApiFn \
  --payload '{"warmup":true}' \
  /dev/null

# 3. Verificar que el corpus está en /tmp (requiere Lambda exec role
#    con s3:GetObject sobre el bucket, ya configurado en sst.config.ts)
```

### Opción B: Local file (Phase 1 — actual)

```bash
# 1. El archivo ya está en el repo
ls -la references/markitdown-corpus/corpus-embeddings.bge-m3-v1.json.gz

# 2. En deploy, SST sincroniza el repo al bundle de la Lambda.
#    El archivo se incluye automáticamente porque está bajo
#    `references/`. Si lo moviste a otro path, actualizar
#    CORPUS_PATH en sst.config.ts.

# 3. Deploy
cd api
pnpm sst deploy --stage prod
```

### Opción C: Lambda Layer (Phase 2)

Si el corpus crece > 100 MB, moverlo a una Layer separada (no
incluir en el bundle de la Lambda — eso aumenta cold-start).

```bash
zip -r corpus-layer.zip corpus-embeddings.bge-m3-v1.json.gz
aws lambda publish-layer-version \
  --layer-name sociedad-opita-corpus \
  --zip-file fileb://corpus-layer.zip \
  --compatible-runtimes nodejs22.x \
  --compatible-architectures arm64
```

---

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|--------|-----------|
| El rebuild cambia el orden de los chunks | **No problemático**: `retrieve.ts` hace cosine similarity, no asume orden. |
| El nuevo corpus omite contenido importante | Verificar con `git diff` o comparación de chunk counts antes de desplegar. |
| El modelo de embedding cambia (v1 → v2) | Bump filename (`bge-m3-v2`), actualizar `embedQuery()`. NO mezclar embeddings de modelos diferentes. |
| LoRA fine-tune degrada el modelo | Re-evaluar con la suite de golden queries. Si baja el score, rollback. |
| El archivo es > 250 MB (Lambda Layer cap) | Usar S3 (Opción A) en lugar de Layer. |

---

## Automatización (Phase 2, deferred)

El rebuild manual es propenso a error. Plan para Phase 2:

- **Trigger**: GitHub Action `corpus-rebuild.yml` que corre en
  push a `main` cuando cambia `references/markitdown-corpus/*` o
  `api/scripts/rebuild-corpus.py`.
- **Steps**: install deps → run `rebuild-corpus.py` → run golden
  tests → upload to S3 (si tests pass) → notify operator.
- **Cache**: el modelo BGE-M3 se cachea en GitHub Actions cache
  (`~/.cache/huggingface/`) para evitar re-download de 600 MB.
- **Costo**: ~$0.10/run en GH Actions (15 min en runner medium).

---

## Pointers

- [`api/src/rag/retrieve.ts`](../api/src/rag/retrieve.ts) — Cosine top-k
- [`api/src/rag/embed-query.ts`](../api/src/rag/embed-query.ts) — Embedder
- [`references/markitdown-corpus/`](../references/markitdown-corpus/) — Source documents
- [`docs/ocais-rag-integration.md`](../docs/ocais-rag-integration.md) — Plan RAG completo
- [ADR-0003: BGE-M3 + LoRA fine-tune](docs/adr/0003-bge-m3-plus-lora-finetune.md) — Modelo + LoRA
- [`README-FINETUNE.md`](../README-FINETUNE.md) — LoRA fine-tuning pipeline (Phase B)
- [`api/tests/rag/retrieve-golden-expanded.test.ts`](../api/tests/rag/retrieve-golden-expanded.test.ts) — Golden queries
- [`runbooks/lambda-cold-start.md`](lambda-cold-start.md) — Si el corpus afecta cold-start
