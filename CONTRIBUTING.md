# Contributing

Thanks for helping burners find ice. The short version:

- **Build**: see the README (Node 22.23+, `npm ci`, `npm test`). All three of
  lint, typecheck, and the jest suite must be green before a PR.
- **Adding a model to the catalog** is one object literal in
  `src/llm/modelCatalog.ts`; read the file header. Entries need an immutable
  URL, a SHA-256, a size, and a RAM floor. Unpinned entries are refused at
  download time by design.
- **Data packs**: the repo ships builders (`tools/`) and the attributed
  survival-guide pack (provenance in `NOTICE`). Do not commit fetched
  third-party corpus content (transcripts, crawls, archives): builders
  fetch locally, and content stays local.
- **Facts are load-bearing.** Anything the Angel can present as a fact needs
  a source in the pack it ships in. Corpus text should carry the asker's own
  vocabulary. Retrieval is FTS-based, so a section about "closures" is
  invisible to someone asking "when does it close"; write both.
- **Camp packs are the front door**: the most valuable contribution is often
  not code but a well-made data pack. [`PACK-FORMAT.md`](PACK-FORMAT.md)
  is the authoring spec; run `python3 tools/check_pack.py your-pack/` (the
  pack doctor, stdlib-only) before sharing, and
  `tools/build_pack_embeddings.py` to add optional semantic vectors.
- **Privacy floor**: never include real chat logs, camp beams, or personal
  data in issues, PRs, fixtures, or tests. Synthetic data only.
- By contributing you agree your contributions are licensed under the
  repository's Apache-2.0 license.
