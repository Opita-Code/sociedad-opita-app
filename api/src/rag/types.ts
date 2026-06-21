/**
 * Types for the RAG foundation.
 *
 * Phase 1 scope:
 *   - Precomputed BGE-M3 embeddings baked into a JSON.gz artifact.
 *   - In-memory cosine retrieval at warm boot.
 *   - 1024-dim vectors (BAAI/bge-m3 default).
 *
 * Schema versioning (REQ-1.3): when BGE-M3 v2 ships, regenerate as
 * `corpus-embeddings.bge-m3-v2.json.gz` and bump ARTIFACT_VERSION here.
 */

export interface CorpusDocMetadata {
  /** Primary topic tag (e.g., "wikimedia_photos/iglesia-san-antonio-tello", "geojson/streets"). */
  topic: string;
  /** Persona IDs this document is relevant to (from RAG-INDEX.json by_persona). */
  personas: string[];
  /** License: CC-BY-4.0, CC-BY-SA-4.0, ODbL-1.0, restricted. */
  license: string;
  /** Access tier: free, research, diaspora. */
  tier: string;
  /** ISO 639-1 language code; mostly "es" for the Tello corpus. */
  language: string;
}

export interface CorpusDoc {
  /** Stable document id, derived from the source path. */
  id: string;
  /** Text that was embedded (truncated to fit BGE-M3 max length on long docs). */
  text: string;
  /** 1024-dim BGE-M3 embedding (L2-normalized). */
  embedding: number[];
  /** Extracted structured metadata for filtering. */
  metadata: CorpusDocMetadata;
  /**
   * Full document text (frontmatter + body). Only present when the embedded
   * `text` was truncated to fit BGE-M3's 8192-token limit. Callers can use
   * `full_text` for downstream citation/quoting without re-reading the source.
   */
  full_text?: string;
}

export interface RetrievalResult {
  doc: CorpusDoc;
  score: number;
}

/**
 * Current artifact version. Bump when BGE-M3 major version changes.
 * Format: "bge-m3-vN".
 */
export const ARTIFACT_VERSION = "bge-m3-v1" as const;
