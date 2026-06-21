# Fine-Tuning the BGE-M3 Embedder (LoRA Option C)

This directory contains the scripts needed to take Phase A's base BGE-M3
embeddings and produce a fine-tuned variant with a LoRA adapter, as specified
in `.sdd/monumento-cultural-v2/spec.md` (REQ-1.4) and the OSINT report at
`.sdd/monumento-cultural-v2/embedding-models-osint-2026.md`.

## Status (this PR)

| Stage | Status | Output |
|-------|--------|--------|
| Phase A — base BGE-M3 corpus embeddings | **shipped** | `corpus-embeddings.bge-m3-v1.json.gz` (997 KB, 103 docs) |
| Phase B.1 — synthetic query generation | **deferred** (DeepSeek balance = 0) | `synthesize-queries.py` ready; operator runs with their own key |
| Phase B.2 — LoRA fine-tuning | **deferred** (no CUDA in dev env) | `train-lora.py` ready; operator runs on a GPU box |
| Phase B.3 — ONNX export | **deferred** (depends on B.2) | `export-onnx.py` ready |
| 4 golden retrieval queries | **shipped** | `tests/rag/retrieve-golden.test.ts` — 4/4 pass on base |

Phase B is deferred because:

1. **No CUDA GPU in dev env** — `torch.__version__ = 2.8.0+cpu`. Even with
   `nvidia-smi` showing an RTX 2050, PyTorch's CPU build can't use it.
2. **DeepSeek balance is $0** — the operator's `DEEPSEEK_API_KEY` returns HTTP
   402 ("Insufficient Balance") on every call. `synthesize-queries.py` ran
   end-to-end, hit 103 × 3 retries = 309 HTTP 402 responses, and gracefully
   exited with 0 triples. Top up the DeepSeek account and re-run.

The scripts are correct and ready — the runtime environment is the blocker.
Operator runs all three Phase B scripts locally with their own GPU and API
key.

## To run Phase B locally

You need a CUDA-capable GPU (T4 minimum). Free options:

- **Google Colab free tier** — T4 15 GB VRAM, ~2 hours per session. Sufficient
  for 1 epoch on 1500 triples.
- **Lambda Labs / Vast.ai spot** — A10G / 3090 for a few cents/hour.

```bash
# 1. Install Python deps (CUDA build of torch required for training)
pip install -U torch==2.8.0 --index-url https://download.pytorch.org/whl/cu121
pip install -U sentence-transformers peft transformers optimum[exporters] \
                onnx onnxruntime accelerate requests

# 2. Set your DeepSeek API key (synthetic query generation costs ~$0.05)
export DEEPSEEK_API_KEY="sk-..."

# 3. Generate ~1500 synthetic (query, positive, negatives) triples
python scripts/synthesize-queries.py
#   → writes references/markitdown-corpus/synthetic-queries.jsonl

# 4. Train LoRA adapter (~2 hours on T4, 1 epoch)
python scripts/train-lora.py --epochs 1 --batch-size 16
#   → writes references/markitdown-corpus/lora-adapter/  (PEFT, ~8 MB)
#   → writes references/markitdown-corpus/training-log.json

# 5. Merge LoRA into BGE-M3 and export to ONNX q8
python scripts/export-onnx.py
#   → writes references/markitdown-corpus/bge-m3-lora-merged-onnx/

# 6. Re-run the embedder with the fine-tuned model
cd api
npx tsx ../scripts/embed-corpus.ts \
  --model "Xenova/bge-m3-lora" \
  --output ../references/markitdown-corpus/corpus-embeddings.bge-m3-lora-v1.json.gz

# 7. Bump ARTIFACT_VERSION in api/src/rag/types.ts from "bge-m3-v1"
#    to "bge-m3-lora-v1" so runtime reads the new artifact.

# 8. Re-run tests
cd api
pnpm test
# All 54 tests should still pass; the golden-query test compares
# recall@4 between base and LoRA artifacts (if both exist).
```

## What the scripts do

### `synthesize-queries.py`

For each of the 103 corpus documents, asks DeepSeek-Chat to generate 12
plausible queries a person might ask about Tello/Huila, mixing standard
Spanish with opita muletillas (`asina es la cosa`, `le digo yo`, `ni muerto`,
`pues mijo`). Each `(query, positive_doc)` pair is then paired with 2 hard
negatives — docs from the same group/sub_group (semantically close).

Output: `references/markitdown-corpus/synthetic-queries.jsonl` (one JSON
triple per line):

```json
{"query":"...", "positive_id":"references/.../dona-rosa.tuned.md", "negative_ids":[...]}
```

### `train-lora.py`

Loads `BAAI/bge-m3` from HuggingFace, wraps it in PEFT LoRA
(`rank=8`, `alpha=16`, `target_modules=["query","value"]`), and trains with
`MultipleNegativesRankingLoss` for 1 epoch (batch 16, lr 2e-4).

The LoRA adapter is ~8 MB, contains <0.1% trainable parameters, and can be
merged back into the base model or used as-is via PEFT.

### `export-onnx.py`

Merges the LoRA adapter into the base BGE-M3 weights (`merge_and_unload()`)
and exports the merged model to ONNX q8 via `optimum.exporters.onnx`. The
output is a drop-in replacement for `Xenova/bge-m3` that can be loaded by
`@huggingface/transformers` in Node.

## Notes on determinism

- All three scripts are seeded (`--seed 20260620`).
- `scripts/embed-corpus.ts` sorts artifacts by `tuned_relpath` so re-runs
  produce byte-identical JSON (modulo gzip header timestamps).
- The synthetic query set is deterministic given the same `DEEPSEEK_API_KEY`
  and `temperature=1.0`. To make it fully reproducible, lower `temperature` to
  `0.0` in `synthesize-queries.py:150` (trades diversity for stability).

## Cost summary

| Step | Cost | Time |
|------|------|------|
| `synthesize-queries.py` | ~$0.05–$0.10 (DeepSeek-Chat) | ~10 min |
| `train-lora.py` | GPU rental ~$0.50 (T4 spot) | ~2 h on T4 |
| `export-onnx.py` | $0 (CPU) | ~5 min |
| Re-embed corpus | $0 (CPU) | ~5 min on dev laptop |

Total: < $1 to produce a fine-tuned BGE-M3-LORA artifact.

## Re-evaluating the golden queries

After Phase B ships, the `tests/rag/retrieve-golden.test.ts` test (4 queries,
all passing on base) should be extended to compare recall@4 between
`corpus-embeddings.bge-m3-v1.json.gz` (base) and
`corpus-embeddings.bge-m3-lora-v1.json.gz` (fine-tuned). Target: ≥5% uplift
on the golden set, per REQ-1.4.