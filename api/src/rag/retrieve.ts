/**
 * RAG retrieval — cosine similarity, top-k, and gzip corpus loader.
 *
 * REQ-2.1: top-k retrieval with cosine similarity in <50ms after corpus load.
 * REQ-2.2: dialect preservation is handled by BGE-M3's multilingual embedding
 *          space; similarity scores are computed over the pre-normalized vectors
 *          emitted by the embedder (normalize=true).
 * REQ-2.3: persona binding is enforced at the corpus build step (metadata.personas
 *          is populated from RAG-INDEX.json). Runtime cosine is unfiltered —
 *          persona filtering is done by the caller using metadata.
 *
 * Design notes:
 *   - cosine() expects L2-normalized vectors (norm=1), in which case the dot
 *     product equals cosine similarity. We still compute the full cosine to
 *     be safe if non-normalized vectors are passed.
 *   - topK() is generic over the shape but requires a numeric `score` field.
 *     Stable sort by score descending.
 *   - loadCorpus / loadCorpusFromBuffer parse a gzipped JSON array of CorpusDoc.
 *     The .gz artifact is produced by scripts/embed-corpus.ts.
 */
import { gunzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import type { CorpusDoc, RetrievalResult } from "./types";

export type { CorpusDoc, RetrievalResult } from "./types";
export { ARTIFACT_VERSION } from "./types";

/**
 * Cosine similarity between two equal-length Float32Array vectors.
 *
 * Returns a value in [-1, 1]. Returns 0 if either vector is zero-length.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosine: vector length mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Top-k selection by descending score.
 *
 * Generic over T so callers can pass {score, doc} or any object with a numeric
 * score field. Stable in the sense that ties preserve insertion order.
 */
export function topK<T extends { score: number }>(items: T[], k: number = 4): T[] {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  return sorted.slice(0, k);
}

/**
 * Load a corpus from a gzipped JSON buffer.
 *
 * @param gz         Gzipped bytes (Uint8Array).
 * @param pathHint   Optional path label used for error messages (e.g.,
 *                   the on-disk path that was read). Defaults to "<buffer>".
 */
export async function loadCorpusFromBuffer(
  gz: Uint8Array,
  pathHint?: string
): Promise<CorpusDoc[]> {
  const label = pathHint ?? "<buffer>";
  let json: string;
  try {
    json = gunzipSync(Buffer.from(gz)).toString("utf8");
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    throw new Error(`loadCorpus: gunzip failed for ${label}: ${cause}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    throw new Error(`loadCorpus: JSON.parse failed for ${label}: ${cause}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`loadCorpus: ${label} did not contain a JSON array`);
  }
  return parsed as CorpusDoc[];
}

/**
 * Load a corpus from a gzipped JSON file on disk.
 *
 * @param path  Absolute or relative path to the .json.gz artifact.
 */
export async function loadCorpus(path: string): Promise<CorpusDoc[]> {
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    throw new Error(`loadCorpus: cannot read ${path}: ${cause}`);
  }
  return loadCorpusFromBuffer(new Uint8Array(buf), path);
}

/**
 * Retrieve the top-k documents from `corpus` most similar to `queryEmbedding`.
 *
 * Default k=4 (REQ-2.1). Embeddings inside `corpus` are converted to
 * Float32Array on demand so we can keep them as plain number[] in the JSON
 * artifact (smaller on-disk and easier to inspect).
 */
export function retrieve(
  queryEmbedding: Float32Array,
  corpus: CorpusDoc[],
  k: number = 4
): RetrievalResult[] {
  const scored = corpus.map((doc) => ({
    doc,
    score: cosine(queryEmbedding, new Float32Array(doc.embedding)),
  }));
  return topK(scored, k);
}
