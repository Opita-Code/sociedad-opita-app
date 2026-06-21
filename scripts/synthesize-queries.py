#!/usr/bin/env python3
"""
synthesize-queries.py — Generate synthetic (query, positive_doc, negative_docs)
triples for LoRA fine-tuning of BGE-M3 on the Tello/Huila corpus.

Pipeline:
  1. Load all *.tuned.md artifacts referenced in RAG-INDEX.json.
  2. For each doc, ask DeepSeek-Chat to generate ~12 plausible queries a person
     might ask (mix of standard Spanish with opita muletillas).
  3. For each (doc, query) pair: positive_doc = doc itself; pick 2 hard negatives
     from the corpus (semantically close, but different).
  4. Write JSONL triples to references/markitdown-corpus/synthetic-queries.jsonl

Cost (DeepSeek chat):
  - ~12 queries × 106 docs = 1272 generations, each ~500 input + ~300 output tokens
  - 1272 × 800 tokens ≈ 1.0M tokens total
  - DeepSeek-Chat: $0.14/M output + $0.27/M cache-miss input ≈ $0.05-$0.10

Requirements:
  - Python 3.11+
  - requests (pip install requests)
  - DEEPSEEK_API_KEY env var (or set in api/.env)

Usage:
  python scripts/synthesize-queries.py                  # default: 12 queries/doc, 2 negatives
  python scripts/synthesize-queries.py --queries 5     # fewer queries (faster)
  python scripts/synthesize-queries.py --dry-run       # show prompt, no API calls

Output:
  references/markitdown-corpus/synthetic-queries.jsonl
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from pathlib import Path
from typing import Any

try:
    import requests
except ImportError:
    print("[synthesize-queries] FATAL: requests not installed. pip install requests", file=sys.stderr)
    sys.exit(1)


REPO_ROOT = Path(__file__).resolve().parent.parent
CORPUS_DIR = REPO_ROOT / "references" / "markitdown-corpus"
INDEX_PATH = CORPUS_DIR / "RAG-INDEX.json"
OUTPUT_PATH = CORPUS_DIR / "synthetic-queries.jsonl"

DEEPSEEK_BASE_URL = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
DEEPSEEK_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")


def load_api_key() -> str | None:
    key = os.environ.get("DEEPSEEK_API_KEY")
    if key:
        return key
    # Fall back to api/.env if present
    env_path = REPO_ROOT / "api" / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("DEEPSEEK_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def load_index() -> dict[str, Any]:
    with INDEX_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def read_artifact(relpath: str) -> str:
    """Read a tuned.md from the repo root, with Windows/POSIX path tolerance."""
    full = REPO_ROOT / relpath.replace("\\", "/")
    if not full.exists():
        raise FileNotFoundError(f"missing artifact: {full}")
    return full.read_text(encoding="utf-8")


PROMPT_TEMPLATE = """Eres un asistente que genera consultas de prueba para un sistema RAG (Retrieval-Augmented Generation) sobre Tello, Huila (Colombia).

Te doy un fragmento de texto extraído de un artefacto del corpus (puede ser una foto de Wikimedia, un retrato generado, una página OSM, etc.). Tu tarea es generar exactamente {n_queries} consultas que una persona real haría sobre Tello o el Huila, y para las cuales este fragmento sería una respuesta útil.

Reglas:
1. Mezcla español estándar con dialecto opita. Usa muletillas como: "asina es la cosa", "le digo yo", "ni muerto", "pues mijo", "lléguele", "qué más", "mami yo", "sumercé". Al menos 2 de las {n_queries} deben incluir una muletilla opita.
2. Las consultas deben ser plausibles — alguien que busca entender Tello (historia, geografía, personas, comida, fiestas, arquitectura, paisaje).
3. Varía la forma: preguntas (¿...), imperativas ("cuéntame de..."), declarativas con muletilla ("pues yo quiero saber de...").
4. NO inventes datos que no estén en el texto. Las consultas deben ser respondibles POR ESTE fragmento o por información cercanamente relacionada.
5. Devuelve SOLO un JSON array de strings. Sin explicaciones, sin markdown.

Texto del artefacto:
\"\"\"
{text}
\"\"\"

JSON array:"""


def build_prompt(text: str, n_queries: int) -> str:
    # Truncate text to ~4000 chars to stay within DeepSeek input limits.
    snippet = text if len(text) <= 4000 else text[:4000] + "..."
    return PROMPT_TEMPLATE.format(n_queries=n_queries, text=snippet)


def call_deepseek(prompt: str, api_key: str, retries: int = 3) -> list[str] | None:
    """Call DeepSeek and return parsed JSON array of query strings."""
    url = f"{DEEPSEEK_BASE_URL}/v1/chat/completions"
    payload = {
        "model": DEEPSEEK_MODEL,
        "messages": [
            {"role": "user", "content": prompt},
        ],
        "temperature": 1.0,
        "max_tokens": 1024,
        "response_format": {"type": "json_object"},
    }
    for attempt in range(retries):
        try:
            r = requests.post(
                url,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
                timeout=60,
            )
            if r.status_code != 200:
                print(f"  [api] HTTP {r.status_code}: {r.text[:200]}", file=sys.stderr)
                time.sleep(2 ** attempt)
                continue
            data = r.json()
            content = data["choices"][0]["message"]["content"]
            parsed = json.loads(content)
            # DeepSeek with response_format=json_object wraps in an object.
            # Look for the first list value.
            if isinstance(parsed, list):
                return [str(x) for x in parsed]
            if isinstance(parsed, dict):
                for v in parsed.values():
                    if isinstance(v, list):
                        return [str(x) for x in v]
            return None
        except (requests.RequestException, json.JSONDecodeError, KeyError) as e:
            print(f"  [api] attempt {attempt + 1}/{retries} failed: {e}", file=sys.stderr)
            time.sleep(2 ** attempt)
    return None


def pick_hard_negatives(target_doc: dict[str, Any], all_docs: list[dict[str, Any]], k: int, rng: random.Random) -> list[str]:
    """Pick k hard-negative docs from the corpus (not the target).

    Strategy: same group > same sub_group > different group. This mimics the
    retrieval scenario where the top-k candidates are semantically close.
    """
    target_id = target_doc["id"]
    target_group = target_doc["group"]
    target_sub = target_doc.get("sub_group", "")

    same_sub = [d for d in all_docs if d["id"] != target_id and d.get("sub_group") == target_sub]
    same_grp = [d for d in all_docs if d["id"] != target_id and d.get("sub_group") != target_sub and d["group"] == target_group]
    other = [d for d in all_docs if d["id"] != target_id and d["group"] != target_group]

    rng.shuffle(same_sub)
    rng.shuffle(same_grp)
    rng.shuffle(other)

    picks: list[str] = []
    for pool in (same_sub, same_grp, other):
        for d in pool:
            if d["id"] not in picks:
                picks.append(d["id"])
                if len(picks) == k:
                    return picks
    return picks[:k]


def synthesize(
    queries_per_doc: int = 12,
    negatives_per_query: int = 2,
    limit_docs: int | None = None,
    dry_run: bool = False,
    seed: int = 20260620,
) -> int:
    api_key = load_api_key()
    if not api_key:
        print("[synthesize-queries] DEEPSEEK_API_KEY not set — skipping.", file=sys.stderr)
        print("  Set $env:DEEPSEEK_API_KEY (Windows) or export DEEPSEEK_API_KEY (POSIX).", file=sys.stderr)
        print("  Falling back: operator runs this script on their machine.", file=sys.stderr)
        return 0

    index = load_index()
    artifacts = index["artifacts"]
    if limit_docs:
        artifacts = artifacts[:limit_docs]

    rng = random.Random(seed)

    # Pre-load artifact texts once to keep the inner loop fast.
    print(f"[synthesize-queries] loading {len(artifacts)} artifacts...", file=sys.stderr)
    docs: list[dict[str, Any]] = []
    for art in artifacts:
        relpath = art["tuned_relpath"]
        try:
            text = read_artifact(relpath)
        except FileNotFoundError as e:
            print(f"  [skip] {e}", file=sys.stderr)
            continue
        docs.append({
            "id": relpath,
            "group": art["group"],
            "sub_group": art.get("sub_group", ""),
            "text": text,
        })
    print(f"[synthesize-queries] loaded {len(docs)} docs", file=sys.stderr)

    if dry_run:
        print("[synthesize-queries] DRY RUN — showing prompt for first doc only:", file=sys.stderr)
        if docs:
            print(build_prompt(docs[0]["text"], queries_per_doc), file=sys.stderr)
        return 0

    triple_count = 0
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_PATH.open("w", encoding="utf-8") as out:
        start = time.time()
        for i, doc in enumerate(docs):
            prompt = build_prompt(doc["text"], queries_per_doc)
            queries = call_deepseek(prompt, api_key)
            if not queries:
                print(f"  [warn] doc {i} ({doc['id']}): no queries returned", file=sys.stderr)
                continue
            for q in queries[:queries_per_doc]:
                negatives = pick_hard_negatives(doc, docs, negatives_per_query, rng)
                triple = {
                    "query": q,
                    "positive_id": doc["id"],
                    "negative_ids": negatives,
                }
                out.write(json.dumps(triple, ensure_ascii=False) + "\n")
                triple_count += 1
            if (i + 1) % 5 == 0 or i == len(docs) - 1:
                elapsed = time.time() - start
                rate = triple_count / elapsed if elapsed > 0 else 0
                print(
                    f"  [synthesize] {i + 1}/{len(docs)} docs, "
                    f"{triple_count} triples, {elapsed:.1f}s ({rate:.1f} t/s)",
                    file=sys.stderr,
                )
    print(f"[synthesize-queries] DONE: wrote {triple_count} triples to {OUTPUT_PATH}", file=sys.stderr)
    return triple_count


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate synthetic RAG triples via DeepSeek")
    parser.add_argument("--queries", type=int, default=12, help="queries per doc (default 12)")
    parser.add_argument("--negatives", type=int, default=2, help="hard negatives per query (default 2)")
    parser.add_argument("--limit-docs", type=int, default=None, help="process only first N docs (debug)")
    parser.add_argument("--dry-run", action="store_true", help="show prompt, no API calls")
    parser.add_argument("--seed", type=int, default=20260620, help="RNG seed for negative sampling")
    args = parser.parse_args()
    n = synthesize(
        queries_per_doc=args.queries,
        negatives_per_query=args.negatives,
        limit_docs=args.limit_docs,
        dry_run=args.dry_run,
        seed=args.seed,
    )
    if n == 0:
        sys.exit(2)


if __name__ == "__main__":
    main()