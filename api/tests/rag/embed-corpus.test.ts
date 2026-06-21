import { describe, it, expect } from "vitest";
import { loadCorpusFromBuffer, type CorpusDoc } from "../../src/rag/retrieve";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ARTIFACT_PATH = resolve(
  process.cwd(),
  "../references/markitdown-corpus/corpus-embeddings.bge-m3-v1.json.gz"
);

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

describe("corpus-embeddings.bge-m3-v1.json.gz (artifact)", () => {
  it("exists on disk", () => {
    const buf = readFileSync(ARTIFACT_PATH);
    expect(buf.length).toBeGreaterThan(1000);
  });

  it("is a valid gzip file that parses as JSON", async () => {
    const buf = readFileSync(ARTIFACT_PATH);
    const json = gunzipSync(buf).toString("utf8");
    const docs = JSON.parse(json) as CorpusDoc[];
    expect(Array.isArray(docs)).toBe(true);
    expect(docs.length).toBeGreaterThan(0);
  });

  it("contains the expected number of documents (>= 90 — corpus may have grown)", () => {
    const buf = readFileSync(ARTIFACT_PATH);
    const json = gunzipSync(buf).toString("utf8");
    const docs = JSON.parse(json) as CorpusDoc[];
    expect(docs.length).toBeGreaterThanOrEqual(90);
  });

  it("every doc has the expected schema (id, text, embedding[1024], metadata)", () => {
    const buf = readFileSync(ARTIFACT_PATH);
    const json = gunzipSync(buf).toString("utf8");
    const docs = JSON.parse(json) as CorpusDoc[];
    for (const doc of docs.slice(0, 5)) {
      expect(typeof doc.id).toBe("string");
      expect(doc.id.length).toBeGreaterThan(0);
      expect(typeof doc.text).toBe("string");
      expect(Array.isArray(doc.embedding)).toBe(true);
      expect(doc.embedding).toHaveLength(1024);
      expect(typeof doc.metadata.topic).toBe("string");
      expect(Array.isArray(doc.metadata.personas)).toBe(true);
      expect(typeof doc.metadata.license).toBe("string");
      expect(typeof doc.metadata.tier).toBe("string");
      expect(typeof doc.metadata.language).toBe("string");
    }
  });

  it("all embeddings are 1024-dim and normalized (unit length)", () => {
    const buf = readFileSync(ARTIFACT_PATH);
    const json = gunzipSync(buf).toString("utf8");
    const docs = JSON.parse(json) as CorpusDoc[];
    for (const doc of docs.slice(0, 5)) {
      let sum = 0;
      for (const v of doc.embedding) sum += v * v;
      const norm = Math.sqrt(sum);
      expect(norm).toBeCloseTo(1.0, 3);
    }
  });

  it("every embedding is exactly 1024-dim (cosine math validity)", () => {
    const buf = readFileSync(ARTIFACT_PATH);
    const json = gunzipSync(buf).toString("utf8");
    const docs = JSON.parse(json) as Array<{ embedding: number[] }>;
    const dims = new Set(docs.map((d) => d.embedding.length));
    expect(dims.size).toBe(1);
    expect(dims.has(1024)).toBe(true);
  });

  it("round-trips through loadCorpusFromBuffer", async () => {
    const buf = readFileSync(ARTIFACT_PATH);
    const docs = await loadCorpusFromBuffer(new Uint8Array(buf), ARTIFACT_PATH);
    expect(docs.length).toBeGreaterThanOrEqual(90);
    expect(docs[0]!.embedding).toHaveLength(1024);
  });
});
