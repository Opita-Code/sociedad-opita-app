/**
 * embed-corpus.ts — Offline BGE-M3 corpus embedder.
 *
 * Reads the 106 markitdown-tuned artefacts tracked in
 * `references/markitdown-corpus/RAG-INDEX.json`, embeds each with
 * BAAI/bge-m3 (1024d, MIT, 100+ languages) using transformers.js, and
 * writes a deterministic gzipped JSON artifact at:
 *
 *   references/markitdown-corpus/corpus-embeddings.bge-m3-v1.json.gz       (base)
 *   references/markitdown-corpus/corpus-embeddings.bge-m3-lora-v1.json.gz  (fine-tuned)
 *
 * Determinism guarantees (REQ-1.1):
 *   - Documents are processed in the order they appear in RAG-INDEX.json,
 *     which is sorted by topic group then by path (lexicographic).
 *   - No timestamps, random IDs, or environment-dependent values are baked
 *     into the JSON output.
 *   - The same input + same model version always produces byte-identical output
 *     (verified by sha256 in api/tests/rag/embed-corpus.test.ts).
 *
 * Runtime: never loaded by Lambda. The artifact is read by api/src/rag/retrieve.ts
 * via loadCorpus() at warm boot (~50ms for ~430KB gz).
 *
 * Usage:
 *   pnpm tsx scripts/embed-corpus.ts                              # base, default output
 *   pnpm tsx scripts/embed-corpus.ts --model Xenova/bge-m3-lora   # fine-tuned model
 *   pnpm tsx scripts/embed-corpus.ts --output <path>              # custom output path
 *
 * First-run downloads the BGE-M3 quantized (q8) model to ~/.cache/huggingface/
 * (~600MB on disk). Subsequent runs use the cached model.
 */
import { pipeline, env } from "@huggingface/transformers";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

const CORPUS_DIR = resolve(REPO_ROOT, "references/markitdown-corpus");
const INDEX_PATH = resolve(CORPUS_DIR, "RAG-INDEX.json");
const DEFAULT_MODEL = "Xenova/bge-m3";
const DEFAULT_OUTPUT = resolve(CORPUS_DIR, "corpus-embeddings.bge-m3-v1.json.gz");
const EMBEDDING_DIMS = 1024;
const DTYPE = "q8";
// BGE-M3 supports up to 8192 tokens. We cap at 2048 tokens to stay within ONNX
// Runtime memory budgets on developer laptops (~4 GB free for activations and
// KV cache on a typical 8 GB machine). 2048 tokens is plenty for retrieval on
// our short docs (median ~600 tok).
const MAX_SEQUENCE_LENGTH = 2048;
// We additionally pre-truncate the raw character stream before tokenization,
// because a single .tuned.md (notably references/osm/tello-raw.tuned.md, ~54 KB)
// would otherwise overflow the tokenizer's max length and produce padded tensors
// at the model's static 8192 length — which OOMs ONNX Runtime on small laptops.
// 8000 chars ≈ 1800-2200 tokens for Spanish prose, well within MAX_SEQUENCE_LENGTH.
const MAX_CHAR_LENGTH = 8000;

// Allow operators to point transformers.js at a different cache location via env.
// Default: ~/.cache/huggingface (transformers.js default).
if (process.env.HF_HOME) {
  env.cacheDir = process.env.HF_HOME;
} else if (!env.cacheDir) {
  env.cacheDir = resolve(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".cache/huggingface");
}

interface CliArgs {
  model: string;
  output: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { model: DEFAULT_MODEL, output: DEFAULT_OUTPUT };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") {
      args.model = argv[++i] ?? DEFAULT_MODEL;
    } else if (a === "--output") {
      args.output = resolve(argv[++i] ?? DEFAULT_OUTPUT);
    } else if (a === "--help" || a === "-h") {
      console.log("Usage: embed-corpus.ts [--model <hf-id>] [--output <path>]");
      process.exit(0);
    } else {
      console.warn(`[embed-corpus] unknown arg: ${a}`);
    }
  }
  return args;
}

interface IndexArtifact {
  tuned_relpath: string;
  group: string;
  sub_group: string;
  title: string;
  tags: string[];
  tello_relevance: string;
  license: string;
  attribution: string;
  access_tier: string;
  persona_key: string | null;
}

interface RAGIndex {
  schema_version: string;
  engagement_id: string;
  total_artifacts: number;
  artifacts: IndexArtifact[];
  indices: {
    by_persona: Record<string, string[]>;
  };
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

function loadIndex(): RAGIndex {
  const raw = readFileSync(INDEX_PATH, "utf8");
  return JSON.parse(raw) as RAGIndex;
}

function readArtifactText(relpath: string): string {
  const fullPath = resolve(REPO_ROOT, normalizePath(relpath));
  return readFileSync(fullPath, "utf8");
}

/**
 * Best-effort read with graceful skip. Returns null if the artifact file is
 * missing (some RAG-INDEX entries reference files that haven't been generated
 * yet, e.g. web/dist/*.tuned.md which require a fresh web build).
 */
function tryReadArtifactText(relpath: string): string | null {
  const fullPath = resolve(REPO_ROOT, normalizePath(relpath));
  try {
    return readFileSync(fullPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/**
 * Derive metadata for a corpus doc from its RAG-INDEX.json entry.
 * IDs are slug-normalized: lowercase, dashes for underscores/slashes.
 */
function buildMetadata(art: IndexArtifact): {
  topic: string;
  personas: string[];
  license: string;
  tier: string;
  language: string;
} {
  const topic = art.sub_group ? `${art.group}/${art.sub_group}` : art.group;
  const personas: string[] = [];
  if (art.persona_key) personas.push(art.persona_key);
  return {
    topic,
    personas,
    license: art.license ?? "unknown",
    tier: art.access_tier ?? "unknown",
    language: "es",
  };
}

/**
 * Derive a stable id from the relpath.
 *   "references/maria-outputs/candidates/01-dona-rosa-best.tuned.md"
 *     -> "maria-outputs__candidates__01-dona-rosa-best"
 */
function deriveId(relpath: string): string {
  return normalizePath(relpath)
    .replace(/\.tuned\.md$/, "")
    .replace(/^references\//, "")
    .replace(/^web\//, "web__")
    .replace(/^docs\//, "docs__")
    .replace(/\//g, "__");
}

/**
 * Look up additional persona bindings from by_persona index — a single
 * artifact can be referenced by multiple personas if it appears under
 * multiple keys. We scan the index once and cache the reverse map.
 */
function buildPersonaReverseLookup(index: RAGIndex): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [persona, paths] of Object.entries(index.indices.by_persona)) {
    for (const p of paths) {
      const norm = normalizePath(p);
      if (!map.has(norm)) map.set(norm, []);
      map.get(norm)!.push(persona);
    }
  }
  return map;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  console.log(`[embed-corpus] loading index: ${INDEX_PATH}`);
  const index = loadIndex();
  if (index.artifacts.length === 0) {
    throw new Error(`RAG-INDEX.json has 0 artifacts; nothing to embed`);
  }
  console.log(`[embed-corpus] index reports ${index.artifacts.length} artifacts`);

  const personaLookup = buildPersonaReverseLookup(index);

  console.log(`[embed-corpus] loading model: ${args.model} (dtype=${DTYPE})`);
  console.log(`[embed-corpus] cache: ${env.cacheDir}`);
  mkdirSync(env.cacheDir, { recursive: true });

  const extractor = await pipeline("feature-extraction", args.model, { dtype: DTYPE });
  console.log(`[embed-corpus] model loaded (max_length=${MAX_SEQUENCE_LENGTH})`);

  // Process in sorted (deterministic) order. RAG-INDEX.json's by_topic already
  // groups by topic; we additionally sort by tuned_relpath to make byte-level
  // output stable across re-indexing.
  const sortedArtifacts = [...index.artifacts].sort((a, b) =>
    a.tuned_relpath.localeCompare(b.tuned_relpath),
  );

  const start = Date.now();
  const docs = [];
  let skipped = 0;
  for (let i = 0; i < sortedArtifacts.length; i++) {
    const art = sortedArtifacts[i]!;
    const relpath = art.tuned_relpath;
    const fullText = tryReadArtifactText(relpath);
    if (fullText === null) {
      console.warn(`[embed-corpus] SKIP (missing): ${relpath}`);
      skipped++;
      continue;
    }
    // Pre-truncate to stay well within the model's max length (BGE-M3: 8192).
    // OSM scraped HTML files can be 50+ KB; without truncation ONNX Runtime
    // tries to allocate ~4 GB of attention buffers at the static 8192 length
    // and OOMs on 8 GB laptops.
    const text =
      fullText.length > MAX_CHAR_LENGTH ? fullText.slice(0, MAX_CHAR_LENGTH) : fullText;
    const out = await extractor(text, {
      pooling: "mean",
      normalize: true,
      truncation: true,
      max_length: MAX_SEQUENCE_LENGTH,
    });
    const data = out.data as Float32Array;

    const truncated = fullText.length > MAX_CHAR_LENGTH;

    if (data.length !== EMBEDDING_DIMS) {
      throw new Error(
        `[embed-corpus] ${relpath}: expected ${EMBEDDING_DIMS}-dim embedding, got ${data.length}`,
      );
    }

    const meta = buildMetadata(art);
    const personas = personaLookup.get(normalizePath(relpath)) ?? meta.personas;
    const doc = {
      id: deriveId(relpath),
      text,
      embedding: Array.from(data),
      metadata: { ...meta, personas },
    };
    if (truncated) doc.full_text = fullText;
    docs.push(doc);

    if ((i + 1) % 10 === 0 || i === sortedArtifacts.length - 1) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(
        `[embed-corpus] embedded ${i + 1}/${sortedArtifacts.length} (${elapsed}s)`,
      );
    }
  }

  console.log(`[embed-corpus] serializing JSON (${docs.length} docs, ${skipped} skipped)`);
  const json = JSON.stringify(docs);

  console.log(`[embed-corpus] gzipping`);
  const gz = gzipSync(Buffer.from(json, "utf8"), { level: 9 });

  console.log(`[embed-corpus] writing artifact: ${args.output}`);
  mkdirSync(dirname(args.output), { recursive: true });
  writeFileSync(args.output, gz);

  const sizeKb = (gz.length / 1024).toFixed(1);
  console.log(
    `[embed-corpus] DONE: wrote ${docs.length} docs, ${sizeKb} KB (raw JSON ${(json.length / 1024).toFixed(1)} KB)`,
  );
  console.log(`[embed-corpus] total elapsed: ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error(`[embed-corpus] FATAL:`, err);
  process.exit(1);
});