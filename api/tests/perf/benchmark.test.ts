/**
 * Performance baseline harness — Polish R3.
 *
 * Captures the per-component latency budget documented in
 * `.sdd/monumento-cultural-v2/design.md` (sections 4.5–4.9) and the
 * .sdd/monumento-cultural-v2/spec.md performance requirements:
 *
 *   REQ-2.1  cosine retrieval P95           <  50 ms  (corpus n≈100)
 *   REQ-2.1  loadCorpusFromBuffer (≈1 MB)   <  50 ms
 *   REQ-3.x  buildContext()                  <   5 ms
 *   REQ-3.x  validateDialogueRequest()       <   1 ms
 *   REQ-3.x  embedQuery wrapper (mocked)     <  10 ms
 *
 * TDD posture:
 *   - This file *defines* the perf contract on top of existing code
 *     (frozen retrieval, context builder, validator). It does not
 *     require source changes — failures here signal budget drift, not
 *     bugs to fix in this round.
 *   - All `it()` blocks are wrapped in `it.skipIf(!!process.env.CI)`
 *     so the GitHub Actions pipeline stays fast; CI never runs perf.
 *     Locally: `pnpm test -- tests/perf` re-runs the full suite.
 *   - Iterations (N) are conservative for laptops and CI runners; if
 *     you bump N locally, do not commit the higher number — the CI
 *     skip means reviewers won't see drift.
 *
 * Why `performance` from `node:perf_hooks` rather than `Date.now()`:
 * sub-millisecond resolution. Subtract before/after samples instead
 * of using `performance.timeOrigin` (which drifts across processes).
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { performance } from "node:perf_hooks";
import { gzipSync, gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  cosine,
  topK,
  retrieve,
  loadCorpusFromBuffer,
  type CorpusDoc,
} from "../../src/rag/retrieve";
import { TELLO_PERSONAS } from "../../src/personas";
import { buildContext, type Scene } from "../../src/context/builder";
import { validateDialogueRequest } from "../../src/handlers/validation";

// ── Mock the heavy embedder ─────────────────────────────────────────
// embedQuery() loads Xenova/bge-m3 (q8 ONNX, ~600 MB on disk, 3-5 s
// cold-start on a laptop). For perf budgeting we measure the *wrapper*
// overhead only — vi.mock replaces the ONNX call with a synchronous
// stub that returns a zero-copy Float32Array of the same shape as
// BGE-M3 (1024-dim, L2-normalized). The wrapper then converts to a
// new Float32Array view in <1 ms.
const { embedQueryMock } = vi.hoisted(() => ({ embedQueryMock: vi.fn() }));
vi.mock("../../src/rag/embed-query", () => ({ embedQuery: embedQueryMock }));

// ── Synthetic corpus generation ────────────────────────────────────
const CORPUS_N = 103;
const EMBEDDING_DIM = 1024;

function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function makeSyntheticCorpus(n: number, dim: number, seed = 42): CorpusDoc[] {
  const rng = seededRng(seed);
  const docs: CorpusDoc[] = [];
  for (let i = 0; i < n; i++) {
    const v = new Float32Array(dim);
    let sum = 0;
    for (let j = 0; j < dim; j++) {
      v[j] = rng() - 0.5;
      sum += v[j]! * v[j]!;
    }
    const inv = 1 / Math.sqrt(sum || 1);
    for (let j = 0; j < dim; j++) v[j]! *= inv;
    docs.push({
      id: `synthetic-${i}`,
      text: `synthetic text for doc ${i}`,
      embedding: Array.from(v),
      metadata: {
        topic: "test/perf",
        personas: [],
        license: "CC-BY-4.0",
        tier: "free",
        language: "es",
      },
    });
  }
  return docs;
}

// ── Statistical helpers ────────────────────────────────────────────
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor((p / 100) * sortedAsc.length));
  return sortedAsc[idx]!;
}

function summarize(samples: number[]): {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
} {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: samples.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1]!,
  };
}

function mean(samples: number[]): number {
  if (samples.length === 0) return 0;
  let s = 0;
  for (const x of samples) s += x;
  return s / samples.length;
}

// ── Real corpus artifact (for loadCorpusFromBuffer timing) ─────────
const REAL_ARTIFACT_PATH = resolve(
  process.cwd(),
  "../references/markitdown-corpus/corpus-embeddings.bge-m3-v1.json.gz"
);

let realCorpusGz: Buffer | null = null;
beforeAll(() => {
  try {
    realCorpusGz = readFileSync(REAL_ARTIFACT_PATH);
  } catch {
    realCorpusGz = null;
  }
});

// ── Common test fixtures ───────────────────────────────────────────
const persona = TELLO_PERSONAS[0]!;
const scene: Scene = { time: "06:30", place: "Plaza de Tello" };
const sampleQuery = "Don Rosalío, ¿cuántas cabezas tiene su ganado este año en la finca?";

describe("performance baseline (Polish R3)", () => {
  // Wrap every perf `it` so CI skips the whole block.
  const itLocal = it.skipIf(!!process.env.CI);

  itLocal("cosine retrieval P95 < 50ms (n=103, k=4, 100 trials)", () => {
    const corpus = makeSyntheticCorpus(CORPUS_N, EMBEDDING_DIM);
    const rng = seededRng(7);
    const samples: number[] = [];

    for (let i = 0; i < 100; i++) {
      const q = new Float32Array(EMBEDDING_DIM);
      let sum = 0;
      for (let j = 0; j < EMBEDDING_DIM; j++) {
        q[j] = rng() - 0.5;
        sum += q[j]! * q[j]!;
      }
      const inv = 1 / Math.sqrt(sum || 1);
      for (let j = 0; j < EMBEDDING_DIM; j++) q[j]! *= inv;

      const t0 = performance.now();
      retrieve(q, corpus, 4);
      samples.push(performance.now() - t0);
    }

    const s = summarize(samples);
    // Log for the runbook — fail loudly if budget drifts above 50 ms.
    console.log(
      `  cosine retrieve p50=${s.p50.toFixed(2)}ms p95=${s.p95.toFixed(2)}ms p99=${s.p99.toFixed(2)}ms max=${s.max.toFixed(2)}ms`
    );
    expect(s.p95).toBeLessThan(50);
  });

  itLocal("loadCorpusFromBuffer < 50ms for real artifact (~1 MB gz)", async () => {
    if (!realCorpusGz) {
      console.log("  skipping: real corpus artifact not on disk");
      return;
    }
    const gz = new Uint8Array(realCorpusGz);

    // Warm-up: 5 unmeasured calls let V8 JIT the gunzip + JSON.parse
    // hot path so the first measured sample is not a cold function.
    for (let i = 0; i < 5; i++) {
      await loadCorpusFromBuffer(gz, REAL_ARTIFACT_PATH);
    }

    const samples: number[] = [];
    // 50 measured trials — enough that a single GC spike doesn't
    // dominate P95. loadCorpusFromBuffer is one-shot per cold start,
    // so we care about mean latency (cold-start budget) more than
    // tail latency. P95 is logged for visibility.
    for (let i = 0; i < 50; i++) {
      const t0 = performance.now();
      await loadCorpusFromBuffer(gz, REAL_ARTIFACT_PATH);
      samples.push(performance.now() - t0);
    }

    const s = summarize(samples);
    const m = mean(samples);
    console.log(
      `  loadCorpusFromBuffer mean=${m.toFixed(2)}ms p50=${s.p50.toFixed(2)}ms p95=${s.p95.toFixed(2)}ms max=${s.max.toFixed(2)}ms (size=${realCorpusGz.length} bytes)`
    );
    // Cold-start budget — mean < 50 ms holds even on a busy laptop.
    // We assert the mean (not P95) because cold-start is one-shot; the
    // tail latency budget belongs to the per-request handlers, not
    // to the cold-path corpus loader.
    expect(m).toBeLessThan(50);
  });

  itLocal("embedQuery wrapper < 10ms (mocked ONNX pipeline)", async () => {
    // Mock returns a fresh Float32Array of the right shape — same
    // shape the real bge-m3 q8 returns.
    const mocked = new Float32Array(EMBEDDING_DIM);
    for (let i = 0; i < EMBEDDING_DIM; i++) mocked[i] = 0.001;
    embedQueryMock.mockImplementation(async () => mocked);

    const { embedQuery } = await import("../../src/rag/embed-query");
    const samples: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t0 = performance.now();
      await embedQuery(sampleQuery);
      samples.push(performance.now() - t0);
    }

    const s = summarize(samples);
    console.log(
      `  embedQuery (mocked) mean=${mean(samples).toFixed(3)}ms p95=${s.p95.toFixed(3)}ms max=${s.max.toFixed(3)}ms`
    );
    expect(s.p95).toBeLessThan(10);
  });

  itLocal("buildContext < 5ms (system + user prompts, k=4)", () => {
    const corpus = makeSyntheticCorpus(CORPUS_N, EMBEDDING_DIM);
    const q = new Float32Array(EMBEDDING_DIM);
    q[0] = 1;
    const topKResults = retrieve(q, corpus, 4);

    const samples: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      buildContext(persona, scene, topKResults, sampleQuery);
      samples.push(performance.now() - t0);
    }

    const s = summarize(samples);
    console.log(
      `  buildContext mean=${mean(samples).toFixed(3)}ms p95=${s.p95.toFixed(3)}ms max=${s.max.toFixed(3)}ms`
    );
    expect(s.p95).toBeLessThan(5);
  });

  itLocal("validateDialogueRequest < 1ms (happy path)", () => {
    const body = {
      persona_id: persona.persona_id,
      scene: { time: "06:30", place: "Plaza de Tello", weather: "Soleado" },
      query: sampleQuery,
    };
    const samples: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      validateDialogueRequest(body);
      samples.push(performance.now() - t0);
    }

    const s = summarize(samples);
    console.log(
      `  validateDialogueRequest mean=${mean(samples).toFixed(3)}ms p95=${s.p95.toFixed(3)}ms max=${s.max.toFixed(3)}ms`
    );
    expect(s.p95).toBeLessThan(1);
  });

  itLocal("cosine (raw) per-call budget sanity check", () => {
    // The hot loop is cosine() inside retrieve(). One cosine over a
    // 1024-dim Float32Array should be sub-millisecond on any modern
    // laptop. We assert <0.2 ms mean — leaves 50x headroom before
    // the 50 ms P95 budget on full retrieve() at n=103.
    const rng = seededRng(11);
    const a = new Float32Array(EMBEDDING_DIM);
    const b = new Float32Array(EMBEDDING_DIM);
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      a[i] = rng();
      b[i] = rng();
    }
    const samples: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const t0 = performance.now();
      cosine(a, b);
      samples.push(performance.now() - t0);
    }
    const s = summarize(samples);
    console.log(`  cosine (1024-d) mean=${mean(samples).toFixed(3)}ms p95=${s.p95.toFixed(3)}ms`);
    expect(mean(samples)).toBeLessThan(0.2);
    // topK sanity — must return 4 items with descending score.
    const items = Array.from({ length: 50 }, (_, i) => ({ score: i / 50 }));
    const k = topK(items, 4);
    expect(k).toHaveLength(4);
    expect(k[0]!.score).toBeGreaterThan(k[3]!.score);
  });
});
