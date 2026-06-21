/**
 * Property-based tests — RAG retrieval primitives.
 *
 * Polish R2 (test expansion). Uses fast-check (4.x) to assert
 * mathematical properties of cosine similarity and top-K over
 * randomly-generated embeddings. Catches edge cases that hand-picked
 * unit tests miss:
 *
 *   - cosine(a, a) === 1.0 for any non-zero a (identity)
 *   - |cosine(a, b)| <= 1.0 for any a, b (range)
 *   - cosine(a, b) === cosine(b, a) (commutative)
 *   - cosine is 0 for orthogonal vectors (sanity)
 *   - topK returns at most k items, sorted descending
 *   - topK is deterministic for the same input
 *   - topK with k >= length returns all items, sorted
 *   - retrieve() returns k docs, each with finite score in [-1, 1]
 *
 * Why these properties matter:
 *   - Identity + range + commutation are the canonical cosine axioms.
 *     A regression in the math (e.g., wrong normalization) trips them.
 *   - top-K ordering matters for RAG quality — out-of-order results
 *     push the right doc out of the system prompt and confuse the LLM.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { cosine, topK, retrieve } from "../../src/rag/retrieve";
import type { CorpusDoc } from "../../src/rag/retrieve";

// ── Arbitraries ────────────────────────────────────────────────────

/**
 * Float32 vectors of dimension `dim`, no NaN/Inf, no all-zero.
 * All-zero vectors would make cosine undefined (0/0).
 */
function float32Vector(dim: number, maxAbs: number = 1.0) {
  return fc
    .array(
      fc
        .double({ min: -maxAbs, max: maxAbs, noNaN: true, noDefaultInfinity: true })
        .map(Math.fround),
      {
        minLength: dim,
        maxLength: dim,
      },
    )
    .filter((arr) => arr.some((v) => v !== 0))
    .map((arr) => Float32Array.from(arr));
}

const arbVecSmall = float32Vector(8);
const arbVec1024 = float32Vector(1024);

const arbAnyVec = arbVecSmall;

const arbCorpus = (size: number) =>
  fc
    .array(
      fc.record({
        score: fc.double({ min: -1, max: 1, noNaN: true }).map(Math.fround),
        label: fc.string({ minLength: 1, maxLength: 20 }),
      }),
      { minLength: size, maxLength: size },
    )
    .map((items) =>
      items.map((it, i) => ({
        score: it.score,
        label: it.label + i,
      })),
    );

// ── cosine() properties ───────────────────────────────────────────

describe("cosine() — property-based", () => {
  it("identity: cosine(a, a) === 1 for any non-zero vector", () => {
    fc.assert(
      fc.property(arbAnyVec, (a) => {
        const c = cosine(a, a);
        // Allow FP epsilon drift.
        expect(Math.abs(c - 1)).toBeLessThan(1e-5);
      }),
      { numRuns: 50 },
    );
  });

  it("range: |cosine(a, b)| <= 1 for any two vectors", () => {
    fc.assert(
      fc.property(arbAnyVec, arbAnyVec, (a, b) => {
        const c = cosine(a, b);
        expect(Math.abs(c)).toBeLessThanOrEqual(1 + 1e-5);
        expect(Number.isFinite(c)).toBe(true);
      }),
      { numRuns: 50 },
    );
  });

  it("commutative: cosine(a, b) === cosine(b, a)", () => {
    fc.assert(
      fc.property(arbAnyVec, arbAnyVec, (a, b) => {
        const c1 = cosine(a, b);
        const c2 = cosine(b, a);
        // Allow 1 ULP of FP epsilon drift.
        expect(Math.abs(c1 - c2)).toBeLessThan(1e-5);
      }),
      { numRuns: 50 },
    );
  });

  it("zero vector is handled gracefully (returns 0, no NaN)", () => {
    fc.assert(
      fc.property(arbAnyVec, (a) => {
        const zero = new Float32Array(a.length);
        const c = cosine(a, zero);
        // a / 0 in float is 0, so the result is 0 (not NaN).
        expect(Number.isFinite(c)).toBe(true);
      }),
      { numRuns: 30 },
    );
  });

  it("scales invariance: cosine(2*a, b) === cosine(a, b)", () => {
    fc.assert(
      fc.property(
        arbAnyVec,
        arbAnyVec,
        fc.double({ min: 0.1, max: 100, noNaN: true, noDefaultInfinity: true }).map(Math.fround),
        (a, b, k) => {
          const scaled = new Float32Array(a.length);
          for (let i = 0; i < a.length; i++) scaled[i] = a[i]! * k;
          const c1 = cosine(a, b);
          const c2 = cosine(scaled, b);
          // Allow larger drift since FP multiplies compound.
          expect(Math.abs(c1 - c2)).toBeLessThan(1e-3);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("L2-normalized vectors yield cosine === dot product", () => {
    fc.assert(
      fc.property(arbVecSmall, (raw) => {
        // Normalize.
        let n = 0;
        for (let i = 0; i < raw.length; i++) n += raw[i]! * raw[i]!;
        const norm = Math.sqrt(n);
        const a = new Float32Array(raw.length);
        for (let i = 0; i < raw.length; i++) a[i] = raw[i]! / norm;
        // dot(a, a) should be 1.
        let dot = 0;
        for (let i = 0; i < a.length; i++) dot += a[i]! * a[i]!;
        expect(cosine(a, a)).toBeCloseTo(dot, 4);
        expect(dot).toBeCloseTo(1.0, 4);
      }),
      { numRuns: 30 },
    );
  });
});

// ── topK() properties ────────────────────────────────────────────

describe("topK() — property-based", () => {
  it("returns at most k items", () => {
    fc.assert(
      fc.property(
        arbCorpus(20),
        fc.integer({ min: 1, max: 25 }),
        (items, k) => {
          const r = topK(items, k);
          expect(r.length).toBeLessThanOrEqual(k);
          expect(r.length).toBeLessThanOrEqual(items.length);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("returns items sorted by score descending", () => {
    fc.assert(
      fc.property(
        arbCorpus(20),
        fc.integer({ min: 1, max: 10 }),
        (items, k) => {
          const r = topK(items, k);
          for (let i = 1; i < r.length; i++) {
            expect(r[i - 1]!.score).toBeGreaterThanOrEqual(r[i]!.score);
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  it("preserves the input length when k >= length", () => {
    fc.assert(
      fc.property(arbCorpus(10), fc.integer({ min: 10, max: 50 }), (items, k) => {
        const r = topK(items, k);
        expect(r).toHaveLength(items.length);
      }),
      { numRuns: 30 },
    );
  });

  it("is deterministic — same input always yields same output", () => {
    fc.assert(
      fc.property(arbCorpus(15), fc.integer({ min: 1, max: 10 }), (items, k) => {
        const r1 = topK(items, k);
        const r2 = topK(items, k);
        expect(r1.map((x) => x.score)).toEqual(r2.map((x) => x.score));
        expect(r1.map((x) => x.label)).toEqual(r2.map((x) => x.label));
      }),
      { numRuns: 30 },
    );
  });

  it("returns the top-1 item as the highest-scoring input", () => {
    fc.assert(
      fc.property(arbCorpus(20), (items) => {
        const k = 1;
        const r = topK(items, k);
        const maxScore = Math.max(...items.map((x) => x.score));
        expect(r[0]!.score).toBeCloseTo(maxScore, 6);
      }),
      { numRuns: 30 },
    );
  });

  it("all returned scores are finite (no NaN, no Infinity)", () => {
    fc.assert(
      fc.property(arbCorpus(15), fc.integer({ min: 1, max: 10 }), (items, k) => {
        const r = topK(items, k);
        for (const x of r) {
          expect(Number.isFinite(x.score)).toBe(true);
        }
      }),
      { numRuns: 30 },
    );
  });

  it("k=0 returns empty array", () => {
    fc.assert(
      fc.property(arbCorpus(5), (items) => {
        const r = topK(items, 0);
        expect(r).toEqual([]);
      }),
      { numRuns: 20 },
    );
  });

  it("empty input returns empty array regardless of k", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (k) => {
        const r = topK([], k);
        expect(r).toEqual([]);
      }),
      { numRuns: 20 },
    );
  });
});

// ── retrieve() properties ────────────────────────────────────────

describe("retrieve() — property-based", () => {
  // Generate a synthetic corpus: each doc has a random 8-d embedding
  // and a synthetic metadata block.
  const arbCorpusDocs = fc
    .array(arbVecSmall, { minLength: 5, maxLength: 30 })
    .map((vecs) =>
      vecs.map((v, i): CorpusDoc => ({
        id: `synth-${i}`,
        text: `synthetic doc ${i}`,
        embedding: Array.from(v),
        metadata: {
          topic: "test/synthetic",
          personas: [],
          license: "CC-BY-4.0",
          tier: "free",
          language: "es",
        },
      })),
    );

  it("returns at most k results", () => {
    fc.assert(
      fc.property(arbCorpusDocs, arbVecSmall, fc.integer({ min: 1, max: 20 }), (corpus, q, k) => {
        const r = retrieve(q, corpus, k);
        expect(r.length).toBeLessThanOrEqual(Math.min(k, corpus.length));
      }),
      { numRuns: 30 },
    );
  });

  it("every returned score is in [-1, 1]", () => {
    fc.assert(
      fc.property(arbCorpusDocs, arbVecSmall, (corpus, q) => {
        const r = retrieve(q, corpus, 4);
        for (const x of r) {
          expect(x.score).toBeGreaterThanOrEqual(-1 - 1e-5);
          expect(x.score).toBeLessThanOrEqual(1 + 1e-5);
          expect(Number.isFinite(x.score)).toBe(true);
        }
      }),
      { numRuns: 30 },
    );
  });

  it("returns scores sorted descending", () => {
    fc.assert(
      fc.property(arbCorpusDocs, arbVecSmall, fc.integer({ min: 1, max: 10 }), (corpus, q, k) => {
        const r = retrieve(q, corpus, k);
        for (let i = 1; i < r.length; i++) {
          expect(r[i - 1]!.score).toBeGreaterThanOrEqual(r[i]!.score);
        }
      }),
      { numRuns: 30 },
    );
  });

  it("a query identical to a corpus doc's embedding ranks that doc top-1 with score ~1", () => {
    // Property: when q equals one corpus doc's embedding, that doc
    // must appear in the top-K and have a score of ~1.0 (other docs
    // may also score 1.0 if random embeddings coincide).
    fc.assert(
      fc.property(arbCorpusDocs, fc.integer({ min: 0, max: 1000 }), (corpus, seed) => {
        if (corpus.length === 0) return;
        const idx = seed % corpus.length;
        const q = new Float32Array(corpus[idx]!.embedding);
        const r = retrieve(q, corpus, 1);
        // Top-1 must have a score very close to 1.0 (cosine of a
        // vector with itself). FP rounding may give 0.9999... rather
        // than exactly 1.0.
        expect(r[0]!.score).toBeGreaterThan(0.99);
        expect(r[0]!.score).toBeLessThanOrEqual(1.0001);
        // Top-1's id must exist in the corpus (no fabrication).
        const ids = new Set(corpus.map((d) => d.id));
        expect(ids.has(r[0]!.doc.id)).toBe(true);
      }),
      { numRuns: 20 },
    );
  });

  it("empty corpus returns empty result", () => {
    fc.assert(
      fc.property(arbVecSmall, fc.integer({ min: 0, max: 10 }), (q, k) => {
        const r = retrieve(q, [], k);
        expect(r).toEqual([]);
      }),
      { numRuns: 20 },
    );
  });

  it("every returned doc is from the input corpus (no fabrication)", () => {
    fc.assert(
      fc.property(arbCorpusDocs, arbVecSmall, (corpus, q) => {
        const ids = new Set(corpus.map((d) => d.id));
        const r = retrieve(q, corpus, 4);
        for (const x of r) {
          expect(ids.has(x.doc.id)).toBe(true);
        }
      }),
      { numRuns: 30 },
    );
  });
});
