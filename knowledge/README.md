# Mellis knowledge base (shippable RAG corpus)

This folder is the knowledge base that ships with Mellis. It replaces the private production corpus
`v7-split-advice-2026-10-22` (kept outside the repository because much of it is copyrighted text) with a
version that can be published in this AGPL repository:

- **SHIP_TEXT**: the original text, because its licence allows redistribution (Trio docs AGPL-3.0,
  OpenAPS docs MIT, AndroidAPS docs AGPL-3.0, articles under CC BY 4.0). Each file names the source,
  the licence and what was changed.
- **SUMMARY_ONLY**: our own summary, written in our own words, with the citation, the link to the
  original and the section or page each point comes from. Only short quotes. Used for everything whose
  licence does not allow redistribution or adaptation (publisher copyright, CC BY-NC, CC BY-NC-ND,
  manufacturer manuals, SmPCs, licence not verified).
- **LINK_ONLY**: title and link only, no text. Not indexed.

`SOURCES.md` lists every document with its mode, licence and the reason. `LICENSES.md` holds the
attribution texts the licences require. Nothing here is medical advice; see the disclaimer in
`LICENSES.md`.

## File format

One Markdown file per document, in the same folder layout as the production corpus (`trio/`, `openaps/`,
`ispad/`, `articles/`, `fat-protein/`, `bolus-reduction/`, `correction-up/`, `split-advice/`, `dexcom/`,
`ema/`, `ptd/`). Each file starts with a YAML front matter block between two `---` lines. Values are on one
line each; lists use the `[a, b]` form, so a very small parser is enough.

```yaml
---
id: ispad-2022-sick-day                 # unique, lowercase, [a-z0-9-]
title: "ISPAD 2022: Sick day management in children and adolescents with diabetes"
publisher: "ISPAD / Pediatric Diabetes (John Wiley & Sons)"
authors: "Phelan H, Hanas R, Hofer SE, et al."
year: 2022
url: https://doi.org/10.1111/pedi.13415  # where the reader can open the original
doi: 10.1111/pedi.13415                  # optional
licence: "© 2022 John Wiley & Sons A/S (all rights reserved)"
licence_url: https://onlinelibrary.wiley.com/doi/10.1111/pedi.13415
mode: SUMMARY_ONLY                       # SHIP_TEXT | SUMMARY_ONLY | LINK_ONLY
language: en                             # en | pl, language of the text below
retrieved: 2026-10-16                    # when the original was read
topics: [sick-day, ketones, children]
index: true                              # false: keep for reference, do not put into the search index
corpus_v7: ispad/ispad-2022-sick-day.txt # the file this replaces in the production corpus (if any)
attribution: "..."                       # SHIP_TEXT only: the attribution line the licence requires
changes: "..."                           # SHIP_TEXT only: what we changed (format, omitted parts)
---
```

The body follows the front matter. A SUMMARY_ONLY body starts with a line saying it is our summary, then
the summary with section or page references in brackets, e.g. `[Section 3.2]`, `[p. 1286]`. A SHIP_TEXT
body starts with the attribution line, then the original text.

### Topics

Free tags, but prefer these so search filters stay useful: `fat-protein`, `split-bolus`,
`hypoglycaemia`, `rescue-carbs`, `bolus-reduction`, `bolus-timing`, `correction`, `bolus-calculator`,
`trio`, `loop`, `oref`, `smb`, `uam`, `limits`, `aid`, `pump`, `cgm`, `cgm-accuracy`, `exercise`,
`sick-day`, `ketones`, `dka`, `insulin`, `targets`, `time-in-range`, `nutrition`, `children`,
`adolescents`, `education`, `settings`, `glucomind-rule`.

### Manifest

`sources.json` is generated from the front matter by `npx tsx scripts/knowledge/knowledge-manifest.ts`
(which also checks every file; `--check` only verifies that `sources.json` is up to date, and
`scripts/knowledge/knowledge-manifest.spec.ts` runs the same check in the test suite). It maps each file path to `{ "title", "skip" }`, the format the
existing ingest script (`scripts/evaluation/rag-corpus-ingest.ts`) already reads. `skip` is true for
LINK_ONLY files and `index: false` files.

## Loading

The index is built on each user's own server by `mellis-admin knowledge-build` (`infra/db/knowledge-build.ts`),
which `scripts/install-server.sh` runs after the setup and `mellis update` runs after every update (it rebuilds only
when this folder changed). The Docker image ships this folder as `/app/knowledge`.

- Only this folder's own documents: every file needs valid front matter (`knowledge-manifest.ts` checks); files with
  `mode: LINK_ONLY` or `index: false` (and those `sources.json` marks `skip`) are not indexed.
- The front matter is stripped before chunking; every chunk keeps `title`, `url`, `licence`, `mode` and `publisher`
  (`rag_chunks.url`, `licence`, `source_mode`, `publisher`, migration 095). Answers list the cited sources with the
  title, and the app opens `url` from it.
- Without an OpenAI key the chunks have no vectors and search is full text (BM25) only, with no AI cost. With a key the
  chunks are embedded (`text-embedding-3-small`) with the user's key through the cost guard and the server's AI ledger;
  a refused or failed embedding falls back to full text and is retried at the next update.
- Idempotent: the corpus hash (this folder + chunking + build version) is stored with the corpus version
  (`mellis-knowledge-<hash>`); nothing is rebuilt while it and the wanted mode are unchanged.
- A corpus loaded from a `rag-index.json` (production's own `v7-split-advice-2026-10-22`) is never replaced unless
  `--replace-foreign` is given.
- `scripts/evaluation/rag-corpus-ingest.ts --shipped-knowledge` makes the same chunks on the Mac for inspection; its
  `--corpus-dir` keeps refusing folders inside a Git working tree.
