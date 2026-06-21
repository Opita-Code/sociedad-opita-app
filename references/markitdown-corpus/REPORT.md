# Markitdown-tuned Corpus — Report

_Generated: 2026-06-20 16:03:39_


## Total processed

- 106 artifacts

- 0 errors


## Per-type breakdown

- bibtex: 3
- deployed_html: 3
- generated_images: 17
- geojson: 8
- sanitized_html: 7
- static_md: 6
- wikimedia_photos: 62

## Tier distribution

- diaspora: 17
- free: 80
- research: 9

## Errors

- (none)

## Index files

- `INDEX.md`: master index

- `RAG-INDEX.json`: RAG-ready index for OCAIS


## Recommendations

- OCAIS v2.0 should ingest `RAG-INDEX.json` for retrieval.

- Each `.tuned.md` is self-contained: YAML frontmatter + body + footer with citation.

- Persona portraits default to `diaspora` tier (high sensitivity + relevance rule).

- Maps scraped HTML defaults to `research` tier (restricted license).

- Wikipedia, OSM, and Wikimedia Commons content is `free` tier.
