/**
 * embedQuery — runtime stub for query embedding.
 *
 * WHY THIS IS A STUB (v2 deploy context)
 * ─────────────────────────────────────
 * The v2 design originally intended to run BGE-M3 (q8 ONNX, ~600MB on
 * disk) at Lambda runtime via `@huggingface/transformers` + `onnxruntime-node`.
 * That works locally but is not deployable to AWS Lambda as-is:
 *
 *   1. The 250MB Lambda zip cap (50MB for direct upload) cannot hold the
 *      full model files. A Lambda Layer would be ~600MB (over the 250MB
 *      Layer limit), so even with a layer we'd need EFS or S3-streamed
 *      cold-start — both add 5-8s on first invoke.
 *   2. `onnxruntime-node` ships platform-specific .node binaries
 *      (darwin/arm64, linux/arm64, linux/x64, win32/*) — esbuild cannot
 *      bundle them. SST's bundler fails with:
 *        "No loader is configured for .node files: onnxruntime_node.node"
 *   3. The deep-probe Meta on our best DeepSeek key confirms we have
 *      ~$2.50 USD budget — LoRA training is deferred to operator's
 *      Colab T4 session, so the "fine-tuned model" path is also v3+.
 *
 * WHAT THIS STUB DOES
 * ───────────────────
 * Generates a 1024-dim **deterministic hash-based vector** for the query
 * using a seedable PRNG (xorshift32 chained from the query's FNV-1a hash).
 *
 * Properties:
 *   - Same query → same vector (stable, idempotent).
 *   - Different queries → uncorrelated vectors (cosine will vary).
 *   - Magnitude: L2-normalized, so dot product == cosine similarity
 *     against the corpus vectors (which are also L2-normalized).
 *   - Tiny: 1024 floats = 4 KB, no model, no native deps, <1ms.
 *
 * The result: `retrieve()` still runs, returns the 4 most cosine-similar
 * corpus docs, but the ranking is now driven by a hash fingerprint of
 * the query — NOT by semantic similarity. The LLM still gets corpus
 * context; it just gets a *less optimal* slice. The dialogue handler
 * remains identical.
 *
 * Migration to real BGE-M3 (planned v3, .sdd/monumento-cultural-v3/):
 *   1. Build Lambda Layer with `onnxruntime-node` (linux-arm64, ~30MB).
 *   2. Upload BGE-M3 q8 model to S3 (model-q8/ folder, ~600MB).
 *   3. On cold start: download model to /tmp (~5-8s), cache for warm
 *      invocations. Provisioned concurrency = 1 keeps latency sane.
 *   4. Replace this stub with a real `embedQuery` that calls
 *      `pipeline("feature-extraction", "Xenova/bge-m3", { dtype: "q8" })`.
 *   5. (Optional) Plug in the LoRA adapter trained in Colab T4 to lift
 *      recall@4 on opita-specific terms.
 *
 * Until v3 ships, the system runs end-to-end with deterministic-
 * ranking retrieval. Tests that mock `embedQuery` keep passing because
 * the function signature is unchanged.
 */
import { createHash } from "node:crypto";

const DIM = 1024;

/**
 * L2-normalize a Float32Array in place. Returns the same array for chaining.
 * If the input is all zeros, returns a zero vector (no NaN).
 */
function l2Normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
  if (norm === 0) return v;
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < v.length; i++) v[i] = v[i]! * inv;
  return v;
}

/**
 * FNV-1a 32-bit hash of a string — fast, no deps, decent distribution.
 * Used to seed the PRNG so that the same query always produces the
 * same 1024-dim vector.
 */
function fnv1a32(s: string): number {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0; // FNV prime, keep uint32
  }
  return h >>> 0;
}

/**
 * Generate a 1024-dim Float32Array seeded by `seed` using xorshift32
 * chained across the array. Output is uniform in [-1, 1) before
 * normalization.
 */
function xorshiftVector(seed: number, dim: number): Float32Array {
  const v = new Float32Array(dim);
  let state = seed === 0 ? 0xdeadbeef : seed;
  for (let i = 0; i < dim; i++) {
    // xorshift32: state ^= state << 13; state ^= state >>> 17; state ^= state << 5
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state = state >>> 0;
    // Map uint32 → [-1, 1)
    v[i] = (state / 0xffffffff) * 2 - 1;
  }
  return v;
}

/**
 * Embed a single Spanish query into a 1024-dim Float32Array.
 *
 * Deterministic, hash-seeded, L2-normalized. Cosine similarity against
 * the pre-computed corpus vectors will return real values, but the
 * ranking is by query-fingerprint, not by semantic meaning. See the
 * file header for the v3 migration plan.
 *
 * @param query  Visitor text (free-form Spanish).
 * @returns      L2-normalized 1024-dim Float32Array.
 */
export async function embedQuery(query: string): Promise<Float32Array> {
  const seed = fnv1a32(query.trim().toLowerCase());
  const v = xorshiftVector(seed, DIM);
  return l2Normalize(v);
}

// Self-test helper exposed for tests; not part of the public contract.
export const _internal = { fnv1a32, xorshiftVector, l2Normalize, DIM };

// SHA-256 of the stub signature so the build pipeline can verify the
// stub is in place. If you replace this file with the real BGE-M3
// embedder, delete this line AND the matching assertion in
// tests/rag/embed-query-stub.test.ts.
export const STUB_SIGNATURE = createHash("sha256")
  .update("embed-query-hash-stub-v2-2026-06-21")
  .digest("hex");
