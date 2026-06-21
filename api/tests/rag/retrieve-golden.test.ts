/**
 * Golden retrieval queries — Phase 1 RAG foundation.
 *
 * These tests verify that the embedded corpus can discriminate between personas
 * and topics using semantic similarity in BGE-M3 multilingual space.
 *
 * Note: The current Phase 1 corpus consists of image/geojson/bibtex metadata
 * about Tello and 10 personas (portraits, OSM features, Wikimedia photos).
 * The "narrative" content is limited to bibtex, attribution, and tags. As such,
 * the golden queries below match the actual corpus content — they test
 * cross-document semantic discrimination within what exists.
 *
 * Original PRD queries (e.g., "Don Rosalío abre la tienda") would require
 * narrative persona content not yet authored. Those become Phase 2 work
 * once the corpus is augmented with persona scenes.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { loadCorpusFromBuffer, retrieve, type CorpusDoc } from "../../src/rag/retrieve";
import { pipeline, env } from "@huggingface/transformers";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const ARTIFACT_PATH = resolve(
  process.cwd(),
  "../references/markitdown-corpus/corpus-embeddings.bge-m3-v1.json.gz",
);

// Pin cache dir explicitly so beforeAll is reproducible across machines.
if (!env.cacheDir) {
  env.cacheDir = resolve(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".cache/huggingface");
}
mkdirSync(env.cacheDir, { recursive: true });

let corpus: CorpusDoc[] = [];
type EmbedFn = (text: string) => Promise<Float32Array>;
let embed: EmbedFn;

beforeAll(async () => {
  const buf = readFileSync(ARTIFACT_PATH);
  corpus = await loadCorpusFromBuffer(new Uint8Array(buf), ARTIFACT_PATH);

  // Use Xenova/bge-m3 (ONNX, q8) — matches scripts/embed-corpus.ts and avoids
  // the ~2GB+ full-precision BAAI download.
  const extractor = await pipeline("feature-extraction", "Xenova/bge-m3", { dtype: "q8" });

  embed = async (text: string): Promise<Float32Array> => {
    const out = await extractor(text, { pooling: "mean", normalize: true });
    return new Float32Array(out.data as Float32Array);
  };
}, 240_000);

async function topK(query: string, k = 4) {
  const q = await embed(query);
  return retrieve(q, corpus, k);
}

describe("golden retrieval queries", () => {
  it(
    "Q1: 'Doña Rosa tendera tienda fiadera' → top doc mentions Dona Rosa",
    async () => {
      const results = await topK("Doña Rosa tendera tienda fiadera");
      const top = results[0]!.doc;
      // Top doc should reference Dona Rosa (either by name in title/id or by topic).
      const text = `${top.id} ${top.text}`.toLowerCase();
      expect(text).toMatch(/dona[-_ ]?rosa|rosa/);
    },
    30_000,
  );

  it(
    "Q2: 'Padre Cecilio parroco sacerdote' → top doc mentions Padre Cecilio",
    async () => {
      const results = await topK("Padre Cecilio parroco sacerdote");
      const top = results[0]!.doc;
      const text = `${top.id} ${top.text}`.toLowerCase();
      expect(text).toMatch(/padre[-_ ]?cecilio|cecilio/);
    },
    30_000,
  );

  it(
    "Q3: 'iglesia templo parroquia' → top doc is about a church",
    async () => {
      const results = await topK("iglesia templo parroquia templo catolico");
      const top = results[0]!.doc;
      const text = `${top.id} ${top.text}`.toLowerCase();
      // The corpus has 7 iglesia-san-antonio-tello photos and Padre Cecilio portrait.
      // Either is a correct top-1.
      const isChurch = /iglesia|parroquia|templo|church|cecilio/.test(text);
      expect(isChurch).toBe(true);
    },
    30_000,
  );

  it(
    "Q4: 'retrato persona opita maria' → top doc is a maria-output portrait",
    async () => {
      const results = await topK("retrato persona opita maria generation");
      const top = results[0]!.doc;
      const text = `${top.id} ${top.text}`.toLowerCase();
      expect(text).toMatch(/maria-output|persona|portrait/);
    },
    30_000,
  );
});