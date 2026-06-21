#!/usr/bin/env python3
"""
train-lora.py — Fine-tune BAAI/bge-m3 with LoRA on synthetic triples.

Requirements:
  - Python 3.11+
  - torch (CUDA build if GPU available)
  - sentence-transformers
  - peft
  - transformers

Install:
  pip install -U sentence-transformers peft transformers accelerate

Usage:
  python scripts/train-lora.py                              # defaults
  python scripts/train-lora.py --epochs 3 --batch-size 32   # tune hyperparams
  python scripts/train-lora.py --dry-run                    # show config, no training

Input:
  references/markitdown-corpus/synthetic-queries.jsonl
  Each line: {"query": str, "positive_id": str, "negative_ids": [str, ...]}

Output:
  references/markitdown-corpus/lora-adapter/    (PEFT adapter, ~8 MB)
  references/markitdown-corpus/training-log.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
CORPUS_DIR = REPO_ROOT / "references" / "markitdown-corpus"
TRIPLES_PATH = CORPUS_DIR / "synthetic-queries.jsonl"
ADAPTER_OUT = CORPUS_DIR / "lora-adapter"
LOG_OUT = CORPUS_DIR / "training-log.json"

BASE_MODEL = "BAAI/bge-m3"
LORA_RANK = 8
LORA_ALPHA = 16
LORA_TARGET_MODULES = ["query", "value"]


def load_triples() -> list[dict[str, Any]]:
    if not TRIPLES_PATH.exists():
        print(f"[train-lora] FATAL: {TRIPLES_PATH} not found.", file=sys.stderr)
        print("  Run `python scripts/synthesize-queries.py` first (requires DEEPSEEK_API_KEY).", file=sys.stderr)
        sys.exit(2)
    triples: list[dict[str, Any]] = []
    with TRIPLES_PATH.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            triples.append(json.loads(line))
    return triples


def triples_to_examples(triples: list[dict[str, Any]]) -> list[Any]:
    """Convert (query, positive, [negatives]) triples to sentence-transformers InputExamples.

    For MultipleNegativesRankingLoss, we build (query, positive, neg1, neg2, ...).
    Each InputExample.texts is [anchor, positive, *negatives].
    """
    from sentence_transformers import InputExample  # type: ignore

    examples: list[InputExample] = []
    for t in triples:
        # The query is the anchor. The "positive" is the first text we want to be
        # close to it; the negatives are texts we want to be far from.
        # Note: we don't have the actual doc texts here — the sentence-transformers
        # MultipleNegativesRankingLoss operates on raw strings. So we treat the
        # query as the anchor and pass the positive_id / negative_ids as labels.
        # This is wrong — we need the doc TEXT, not the id.
        # See note below.
        examples.append(InputExample(texts=[t["query"]], label=1.0))
    return examples


def main() -> None:
    parser = argparse.ArgumentParser(description="LoRA fine-tune BGE-M3 on synthetic triples")
    parser.add_argument("--base-model", default=BASE_MODEL, help="HF model id (default BAAI/bge-m3)")
    parser.add_argument("--epochs", type=int, default=1, help="training epochs (default 1)")
    parser.add_argument("--batch-size", type=int, default=16, help="batch size (default 16)")
    parser.add_argument("--lr", type=float, default=2e-4, help="learning rate (default 2e-4)")
    parser.add_argument("--lora-rank", type=int, default=LORA_RANK, help="LoRA rank (default 8)")
    parser.add_argument("--lora-alpha", type=int, default=LORA_ALPHA, help="LoRA alpha (default 16)")
    parser.add_argument("--lora-target", nargs="+", default=LORA_TARGET_MODULES, help="LoRA target modules")
    parser.add_argument("--max-seq-length", type=int, default=2048, help="max sequence length (default 2048)")
    parser.add_argument("--dry-run", action="store_true", help="print config, skip training")
    parser.add_argument("--allow-cpu", action="store_true", help="allow training on CPU (slow, debug only)")
    args = parser.parse_args()

    print(f"[train-lora] checking environment...", file=sys.stderr)
    try:
        import torch  # type: ignore
    except ImportError:
        print("[train-lora] FATAL: torch not installed.", file=sys.stderr)
        sys.exit(2)

    cuda_available = torch.cuda.is_available()
    device = "cuda" if cuda_available else "cpu"
    print(f"[train-lora] device: {device} (cuda_available={cuda_available})", file=sys.stderr)

    if not cuda_available and not args.allow_cpu:
        print("[train-lora] WARNING: CUDA not available. Skipping training.", file=sys.stderr)
        print("  This is expected on a developer laptop without a GPU.", file=sys.stderr)
        print("  To train, run this script on a machine with a CUDA GPU.", file=sys.stderr)
        print("  Recommended: Google Colab T4 (free tier) or operator's GPU box.", file=sys.stderr)
        print("  Use --allow-cpu to force CPU training (slow; for sanity-checking only).", file=sys.stderr)
        ADAPTER_OUT.mkdir(parents=True, exist_ok=True)
        LOG_OUT.write_text(json.dumps({
            "status": "skipped_no_cuda",
            "base_model": args.base_model,
            "lora_rank": args.lora_rank,
            "epochs": args.epochs,
            "batch_size": args.batch_size,
            "lr": args.lr,
            "reason": "CUDA not available; operator runs this on a GPU machine.",
        }, indent=2), encoding="utf-8")
        sys.exit(0)

    # Import the heavy libs only when we know we're training.
    try:
        from sentence_transformers import SentenceTransformer  # type: ignore
        from peft import LoraConfig, get_peft_model  # type: ignore
        from torch.utils.data import DataLoader  # type: ignore
        from sentence_transformers import losses  # type: ignore
    except ImportError as e:
        print(f"[train-lora] FATAL: {e}.", file=sys.stderr)
        print("  pip install -U sentence-transformers peft transformers accelerate", file=sys.stderr)
        sys.exit(2)

    triples = load_triples()
    print(f"[train-lora] loaded {len(triples)} triples from {TRIPLES_PATH}", file=sys.stderr)

    # NOTE: To train with MultipleNegativesRankingLoss we need the actual document
    # text for each (positive_id, negative_ids) entry, not just the id. The
    # sentence-transformers loss expects lists of strings, not ids. We load the
    # full corpus from RAG-INDEX.json here so we can resolve ids to texts.
    from synthesize_queries import load_index, read_artifact  # type: ignore  # noqa: E402

    index = load_index()
    id_to_text: dict[str, str] = {}
    for art in index["artifacts"]:
        relpath = art["tuned_relpath"]
        try:
            id_to_text[relpath] = read_artifact(relpath)
        except FileNotFoundError:
            continue
    print(f"[train-lora] resolved {len(id_to_text)} doc ids to texts", file=sys.stderr)

    # Build sentence-transformers InputExamples with [anchor, positive, neg1, neg2].
    from sentence_transformers import InputExample  # type: ignore

    examples: list[InputExample] = []
    for t in triples:
        pos_text = id_to_text.get(t["positive_id"])
        if not pos_text:
            continue
        texts = [t["query"], pos_text]
        for neg_id in t.get("negative_ids", []):
            neg_text = id_to_text.get(neg_id)
            if neg_text:
                texts.append(neg_text)
        if len(texts) >= 3:  # need at least 1 negative for MNRL
            examples.append(InputExample(texts=texts))
    print(f"[train-lora] built {len(examples)} InputExamples", file=sys.stderr)

    if args.dry_run:
        print("[train-lora] DRY RUN — exiting before training", file=sys.stderr)
        print(f"  base_model={args.base_model}", file=sys.stderr)
        print(f"  epochs={args.epochs} batch_size={args.batch_size} lr={args.lr}", file=sys.stderr)
        print(f"  lora_rank={args.lora_rank} lora_alpha={args.lora_alpha} target={args.lora_target}", file=sys.stderr)
        return

    print(f"[train-lora] loading base model: {args.base_model}", file=sys.stderr)
    model = SentenceTransformer(args.base_model, device=device)
    model.max_seq_length = args.max_seq_length

    print(f"[train-lora] wrapping with LoRA (rank={args.lora_rank}, alpha={args.lora_alpha})", file=sys.stderr)
    lora_config = LoraConfig(
        r=args.lora_rank,
        lora_alpha=args.lora_alpha,
        target_modules=args.lora_target,
        lora_dropout=0.05,
        bias="none",
        task_type="FEATURE_EXTRACTION",
    )
    model[0].auto_model = get_peft_model(model[0].auto_model, lora_config)
    model[0].auto_model.print_trainable_parameters()

    loader = DataLoader(examples, shuffle=True, batch_size=args.batch_size, pin_memory=(device == "cuda"))
    loss_fn = losses.MultipleNegativesRankingLoss(model)

    ADAPTER_OUT.mkdir(parents=True, exist_ok=True)
    warmup = max(10, int(len(loader) * 0.1))
    start = time.time()
    print(f"[train-lora] training {args.epochs} epoch(s), {len(loader)} batches/epoch...", file=sys.stderr)
    model.fit(
        train_objectives=[(loader, loss_fn)],
        epochs=args.epochs,
        warmup_steps=warmup,
        optimizer_params={"lr": args.lr},
        output_path=str(ADAPTER_OUT),
        show_progress_bar=True,
    )
    elapsed = time.time() - start

    log = {
        "status": "ok",
        "base_model": args.base_model,
        "lora_rank": args.lora_rank,
        "lora_alpha": args.lora_alpha,
        "lora_target_modules": args.lora_target,
        "epochs": args.epochs,
        "batch_size": args.batch_size,
        "lr": args.lr,
        "triple_count": len(triples),
        "example_count": len(examples),
        "elapsed_sec": round(elapsed, 1),
        "adapter_path": str(ADAPTER_OUT),
        "device": device,
    }
    LOG_OUT.write_text(json.dumps(log, indent=2), encoding="utf-8")
    print(f"[train-lora] DONE: adapter at {ADAPTER_OUT}", file=sys.stderr)
    print(f"[train-lora] log: {LOG_OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()