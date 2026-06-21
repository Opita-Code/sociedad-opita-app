/**
 * embedQuery — server-side BGE-M3 query embedding.
 *
 * Loads Xenova/bge-m3 (q8 quantized, MIT) once via @huggingface/transformers
 * and produces a 1024-dim L2-normalized Float32Array for the visitor's query.
 *
 * Phase 1 (local + sst dev):
 *   - Model cached in `process.env.HF_CACHE` or `~/.cache/huggingface/`.
 *   - Cold start ~3-5s on developer laptop while the q8 ONNX graph loads.
 *   - Per-query inference ~50-150ms.
 *
 * Phase 2 (Lambda, deferred to v3):
 *   - Model should be packaged as a Lambda Layer (~600MB) and symlinked to
 *     /opt or env.cacheDir to avoid the per-invocation cold-start tax.
 *   - Memory must be 2048 MB to fit the q8 graph + activations safely.
 *   - This file's signature stays the same; only the cache path changes.
 *
 * Why BGE-M3 and not multilingual-e5-small?
 *   The corpus was embedded with BGE-M3 (1024d) — using a different model
 *   for queries would put the cosine computation in incompatible embedding
 *   spaces. We must use the same model family on both sides.
 *
 * Fail-safe behaviour: if the model fails to load, we throw a descriptive
 * Error so the dialogue handler can return 500 with `internal_error`. The
 * handler also catches this and degrades gracefully (see dialogue.ts).
 */
import { pipeline, env } from "@huggingface/transformers";

type FeatureExtractor = (
  text: string,
  options: { pooling: "mean"; normalize: true },
) => Promise<{ data: Float32Array }>;

let extractorPromise: Promise<FeatureExtractor> | null = null;

async function getExtractor(): Promise<FeatureExtractor> {
  if (!extractorPromise) {
    const cacheDir =
      process.env.HF_CACHE ??
      process.env.HF_HOME ??
      (env.cacheDir as string | undefined) ??
      `${process.env.USERPROFILE ?? process.env.HOME ?? "."}/.cache/huggingface`;
    env.cacheDir = cacheDir;
    extractorPromise = pipeline("feature-extraction", "Xenova/bge-m3", {
      dtype: "q8",
    }) as Promise<FeatureExtractor>;
  }
  return extractorPromise;
}

/**
 * Embed a single Spanish query into a 1024-dim BGE-M3 vector.
 *
 * Returns L2-normalized Float32Array so the dot product equals cosine
 * similarity against the precomputed corpus vectors.
 *
 * @throws Error when the model fails to load or inference throws.
 */
export async function embedQuery(query: string): Promise<Float32Array> {
  const extractor = await getExtractor();
  const out = await extractor(query, { pooling: "mean", normalize: true });
  return new Float32Array(out.data);
}
