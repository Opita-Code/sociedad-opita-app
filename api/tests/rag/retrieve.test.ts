import { describe, it, expect } from "vitest";
import {
  cosine,
  topK,
  loadCorpusFromBuffer,
  loadCorpus,
  retrieve,
  type CorpusDoc,
} from "../../src/rag/retrieve";

function makeDoc(id: string, embedding: number[]): CorpusDoc {
  return {
    id,
    text: `text of ${id}`,
    embedding,
    metadata: {
      topic: "test",
      personas: [],
      license: "CC-BY-4.0",
      tier: "free",
      language: "es",
    },
  };
}

describe("cosine()", () => {
  it("returns dot(a,b) / (|a| * |b|) for two Float32Arrays", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([4, 5, 6]);
    // dot = 4 + 10 + 18 = 32; |a| = sqrt(14); |b| = sqrt(77)
    const expected = 32 / (Math.sqrt(14) * Math.sqrt(77));
    expect(cosine(a, b)).toBeCloseTo(expected, 6);
  });

  it("returns 1.0 for identical vectors", () => {
    const v = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    expect(cosine(v, v)).toBeCloseTo(1.0, 6);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosine(a, b)).toBe(0);
  });

  it("returns -1 for opposite vectors", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([-1, -2, -3]);
    expect(cosine(a, b)).toBeCloseTo(-1.0, 6);
  });

  it("handles 1024-dim vectors (BGE-M3 shape)", () => {
    const a = new Float32Array(1024).fill(0.01);
    const b = new Float32Array(1024).fill(0.01);
    expect(cosine(a, b)).toBeCloseTo(1.0, 6);
  });

  it("is symmetric: cosine(a,b) === cosine(b,a)", () => {
    const a = new Float32Array([0.3, 0.7, 0.1, 0.9]);
    const b = new Float32Array([0.5, 0.2, 0.8, 0.4]);
    expect(cosine(a, b)).toBeCloseTo(cosine(b, a), 6);
  });
});

describe("topK()", () => {
  it("returns sorted descending by score", () => {
    const items = [
      { score: 0.3, label: "low" },
      { score: 0.9, label: "high" },
      { score: 0.5, label: "mid" },
      { score: 0.1, label: "lowest" },
    ];
    const result = topK(items, 4);
    expect(result.map((r) => r.score)).toEqual([0.9, 0.5, 0.3, 0.1]);
  });

  it("returns top-k items when k < length", () => {
    const items = [{ score: 0.1 }, { score: 0.8 }, { score: 0.4 }, { score: 0.6 }, { score: 0.2 }];
    const result = topK(items, 3);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.score)).toEqual([0.8, 0.6, 0.4]);
  });

  it("defaults to k=4 if not specified", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ score: i / 10 }));
    const result = topK(items);
    expect(result).toHaveLength(4);
    expect(result.map((r) => r.score)).toEqual([0.9, 0.8, 0.7, 0.6]);
  });

  it("preserves extra fields on items", () => {
    const items = [
      { score: 0.5, doc: makeDoc("a", [1, 0]) },
      { score: 0.9, doc: makeDoc("b", [0, 1]) },
    ];
    const result = topK(items, 2);
    expect(result[0]!.doc.id).toBe("b");
    expect(result[1]!.doc.id).toBe("a");
  });
});

describe("loadCorpusFromBuffer()", () => {
  it("parses gzipped JSON array of CorpusDoc", async () => {
    const docs: CorpusDoc[] = [makeDoc("a", [1, 0, 0]), makeDoc("b", [0, 1, 0])];
    const json = JSON.stringify(docs);
    const { gzipSync } = await import("node:zlib");
    const gz = gzipSync(Buffer.from(json, "utf8"));
    const loaded = await loadCorpusFromBuffer(new Uint8Array(gz));
    expect(loaded).toHaveLength(2);
    expect(loaded[0]!.id).toBe("a");
    expect(loaded[1]!.id).toBe("b");
    expect(loaded[0]!.embedding).toEqual([1, 0, 0]);
  });

  it("throws with file path context on malformed JSON", async () => {
    const { gzipSync } = await import("node:zlib");
    const gz = gzipSync(Buffer.from("not json", "utf8"));
    await expect(loadCorpusFromBuffer(new Uint8Array(gz), "fake.json.gz")).rejects.toThrow(
      /fake\.json\.gz/
    );
  });
});

describe("loadCorpus()", () => {
  it("reads file from disk and parses it", async () => {
    const docs: CorpusDoc[] = [makeDoc("disk-doc", [1, 2, 3])];
    const json = JSON.stringify(docs);
    const { gzipSync } = await import("node:zlib");
    const gz = gzipSync(Buffer.from(json, "utf8"));
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const os = await import("node:os");
    const tmpPath = path.join(
      os.tmpdir(),
      `corpus-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json.gz`
    );
    await fs.writeFile(tmpPath, gz);
    try {
      const loaded = await loadCorpus(tmpPath);
      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.id).toBe("disk-doc");
    } finally {
      await fs.unlink(tmpPath).catch(() => {});
    }
  });

  it("throws with path context when file missing", async () => {
    await expect(loadCorpus("/nonexistent/path/corpus.json.gz")).rejects.toThrow(/\/nonexistent/);
  });
});

describe("retrieve()", () => {
  it("returns top-k CorpusDocs scored by cosine similarity", () => {
    const q = new Float32Array([1, 0, 0]);
    const corpus = [makeDoc("a", [1, 0, 0]), makeDoc("b", [0, 1, 0]), makeDoc("c", [0.9, 0.1, 0])];
    const results = retrieve(q, corpus, 3);
    expect(results).toHaveLength(3);
    expect(results[0]!.doc.id).toBe("a");
    expect(results[0]!.score).toBeCloseTo(1.0, 6);
    expect(results[1]!.doc.id).toBe("c");
    expect(results[2]!.doc.id).toBe("b");
  });

  it("respects default k=4", () => {
    const q = new Float32Array([1, 0, 0]);
    const corpus = Array.from({ length: 10 }, (_, i) =>
      makeDoc(`d${i}`, [Math.cos(i), Math.sin(i), 0])
    );
    const results = retrieve(q, corpus);
    expect(results).toHaveLength(4);
  });

  it("returns empty array when corpus is empty", () => {
    const q = new Float32Array([1, 0, 0]);
    const results = retrieve(q, [], 4);
    expect(results).toEqual([]);
  });
});
