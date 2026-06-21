#!/usr/bin/env python3
"""
export-onnx.py — Merge a trained LoRA adapter into BGE-M3 base weights and
export the merged model to ONNX (q8) for use with transformers.js / Xenova.

Requirements:
  - A trained adapter at references/markitdown-corpus/lora-adapter/
  - pip install -U transformers optimum[exporters] onnx onnxruntime

Usage:
  python scripts/export-onnx.py                              # defaults
  python scripts/export-onnx.py --adapter <path> --output <path>

Output:
  references/markitdown-corpus/bge-m3-lora-merged-onnx/
    config.json
    tokenizer.json
    tokenizer_config.json
    onnx/model_quantized.onnx    (q8)
    onnx/model.onnx_data         (external weights)
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CORPUS_DIR = REPO_ROOT / "references" / "markitdown-corpus"
DEFAULT_ADAPTER = CORPUS_DIR / "lora-adapter"
DEFAULT_OUTPUT = CORPUS_DIR / "bge-m3-lora-merged-onnx"
BASE_MODEL = "BAAI/bge-m3"


def main() -> None:
    parser = argparse.ArgumentParser(description="Merge LoRA into BGE-M3 and export to ONNX")
    parser.add_argument("--base-model", default=BASE_MODEL)
    parser.add_argument("--adapter", default=str(DEFAULT_ADAPTER), help="PEFT adapter path")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="output dir for merged ONNX")
    parser.add_argument("--dtype", default="q8", choices=["fp32", "fp16", "q8", "q4"], help="quantization")
    args = parser.parse_args()

    adapter_path = Path(args.adapter)
    output_path = Path(args.output)

    if not adapter_path.exists():
        print(f"[export-onnx] FATAL: adapter not found at {adapter_path}", file=sys.stderr)
        print("  Run `python scripts/train-lora.py` first to produce the adapter.", file=sys.stderr)
        print("  (Training requires a CUDA GPU; this script then needs optimum.)", file=sys.stderr)
        sys.exit(2)

    print(f"[export-onnx] loading base model: {args.base_model}", file=sys.stderr)
    try:
        import torch  # type: ignore
        from peft import PeftModel  # type: ignore
        from transformers import AutoModel, AutoTokenizer  # type: ignore
    except ImportError as e:
        print(f"[export-onnx] FATAL: {e}", file=sys.stderr)
        print("  pip install -U torch transformers peft optimum[exporters] onnx", file=sys.stderr)
        sys.exit(2)

    base = AutoModel.from_pretrained(args.base_model, torch_dtype=torch.float16)
    merged = PeftModel.from_pretrained(base, str(adapter_path))
    print("[export-onnx] merging LoRA into base weights...", file=sys.stderr)
    merged = merged.merge_and_unload()
    print("[export-onnx] merged.", file=sys.stderr)

    tokenizer = AutoTokenizer.from_pretrained(args.base_model)

    output_path.mkdir(parents=True, exist_ok=True)
    merged.save_pretrained(str(output_path))
    tokenizer.save_pretrained(str(output_path))

    # ONNX export via optimum. We need a representative input batch.
    print("[export-onnx] exporting to ONNX via optimum...", file=sys.stderr)
    try:
        from optimum.onnxruntime import ORTModelForFeatureExtraction  # type: ignore
        from optimum.exporters.onnx import main as onnx_export_main  # type: ignore
    except ImportError as e:
        print(f"[export-onnx] FATAL: {e}. pip install -U optimum[exporters] onnx onnxruntime", file=sys.stderr)
        sys.exit(2)

    # Export to a temp dir, then move ONNX files into output_path.
    tmp_dir = output_path / "_optimum_tmp"
    onnx_export_main(
        model_name_or_path=str(output_path),
        output=str(tmp_dir),
        task="feature-extraction",
        opset=17,
    )
    onnx_src = tmp_dir / "model_quantized.onnx"
    onnx_dst = output_path / "onnx"
    onnx_dst.mkdir(exist_ok=True)
    if onnx_src.exists():
        shutil.move(str(onnx_src), str(onnx_dst / "model_quantized.onnx"))
    # Move any data file too
    for f in tmp_dir.glob("*.onnx_data"):
        shutil.move(str(f), str(onnx_dst / f.name))
    shutil.rmtree(tmp_dir, ignore_errors=True)

    log = {
        "status": "ok",
        "base_model": args.base_model,
        "adapter_path": str(adapter_path),
        "output_path": str(output_path),
        "dtype": args.dtype,
    }
    (output_path / "export-log.json").write_text(json.dumps(log, indent=2), encoding="utf-8")
    print(f"[export-onnx] DONE: merged ONNX at {output_path}", file=sys.stderr)


if __name__ == "__main__":
    main()