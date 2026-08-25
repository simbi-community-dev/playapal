/**
 * Registry of the data packs bundled with the app. All go through the
 * exact same installer as user-imported packs — they exist partly to prove
 * the pack abstraction.
 *
 * Note: built-in FREEFORM content is embedded in a .md.json wrapper
 * ({ file, markdown }) because Metro only bundles JSON, not .md. Imported
 * packs use real .md/.txt files read from disk at import time.
 */

import type { PackManifest } from '../types';
import type { PackFilePayload } from './installPack';

const eventsManifest = require('../../assets/packs/brc-events-2026/pack.json') as PackManifest;
const eventsContent = require('../../assets/packs/brc-events-2026/events.json');
const artManifest = require('../../assets/packs/brc-art-2026/pack.json') as PackManifest;
const artFiles = [
  require('../../assets/packs/brc-art-2026/art-cafe-art.md.json'),
  require('../../assets/packs/brc-art-2026/art-open-playa.md.json'),
  require('../../assets/packs/brc-art-2026/art-other.md.json'),
] as { file: string; markdown: string }[];
const campsManifest = require('../../assets/packs/camps-2026/pack.json') as PackManifest;
const campsFiles = [
  require('../../assets/packs/camps-2026/camps-2.md.json'),
  require('../../assets/packs/camps-2026/camps-3.md.json'),
  require('../../assets/packs/camps-2026/camps-4.md.json'),
  require('../../assets/packs/camps-2026/camps-5.md.json'),
  require('../../assets/packs/camps-2026/camps-6.md.json'),
  require('../../assets/packs/camps-2026/camps-7.md.json'),
  require('../../assets/packs/camps-2026/camps-8.md.json'),
  require('../../assets/packs/camps-2026/camps-9.md.json'),
  require('../../assets/packs/camps-2026/camps-10.md.json'),
  require('../../assets/packs/camps-2026/camps-unplaced.md.json'),
] as { file: string; markdown: string }[];
const guideManifest = require('../../assets/packs/survival-guide/pack.json') as PackManifest;
const guideContent = require('../../assets/packs/survival-guide/guide.md.json') as {
  file: string;
  markdown: string;
};

/**
 * PRECOMPUTED VECTORS for the semantic arm (0.7.5). Until now only imported
 * camp packs carried embeddings.json, so semantic recall worked for camp
 * lore and NOT for the guide, the art register, or the camps directory —
 * the arm was installed but half-dark. tools/build_pack_embeddings.py now
 * reads the .md.json shapes these packs actually ship (it silently wrote
 * ZERO vectors before), and each file is bundled here so the installer's
 * vector path sees it.
 *
 * KEYS ARE CHUNK-EXACT: "<source_file>:<ordinal>" at the SAME chunk size
 * the installer uses — the guide is embedded at GUIDE_CHUNK_MAX_CHARS (700),
 * everything else at the 2,000 default. Re-chunk one side without the other
 * and installPack refuses the pack as a stale vector build, by design.
 */
const guideVectors = require('../../assets/packs/survival-guide/embeddings.json');
const artVectors = require('../../assets/packs/brc-art-2026/embeddings.json');
const campsVectors = require('../../assets/packs/camps-2026/embeddings.json');

export interface BuiltinPack {
  manifest: PackManifest;
  files: PackFilePayload[];
  /** Chunk size for this pack's docs at install (see GUIDE_CHUNK_MAX_CHARS). */
  chunkMaxChars?: number;
}

/**
 * CHUNK = EXCERPT UNIT for the built-in guide. lookup_facts hands the model a
 * 700-char query-focused excerpt of each passage (docs/excerpt.ts); a chunk
 * longer than that is only ever partly visible, and which part depends on
 * where the query words fall. Measured 2026-08-17: 42 of the guide's 79
 * chunks exceeded 700 chars, and the Temple burn sentence sat outside the
 * window the query 'temple' chose — the model answered the burn from memory
 * ("8 pm before the fireworks"). Chunking the guide AT the budget makes every
 * retrieved passage whole. Imported packs keep the 2,000-char default: their
 * precomputed vectors are keyed to their chunks (embeddings.json), and a
 * re-chunk would orphan them until the pack is rebuilt.
 */
export const GUIDE_CHUNK_MAX_CHARS = 700;

export const BUILTIN_PACKS: BuiltinPack[] = [
  {
    manifest: eventsManifest,
    files: [
      { name: 'pack.json', content: JSON.stringify(eventsManifest) },
      { name: 'events.json', content: JSON.stringify(eventsContent) },
    ],
  },
  {
    manifest: guideManifest,
    files: [
      { name: 'pack.json', content: JSON.stringify(guideManifest) },
      { name: guideContent.file, content: guideContent.markdown },
      { name: 'embeddings.json', content: JSON.stringify(guideVectors) },
    ],
    chunkMaxChars: GUIDE_CHUNK_MAX_CHARS,
  },
  {
    // BRC Art 2026, official text from the API (locations stripped at the
    // TOOL — tools/load_art.py — so an embargoed field cannot exist here;
    // the sealed-locations feature carries them separately, gate-gated).
    manifest: artManifest,
    files: [
      { name: 'pack.json', content: JSON.stringify(artManifest) },
      ...artFiles.map(f => ({ name: f.file, content: f.markdown })),
      { name: 'embeddings.json', content: JSON.stringify(artVectors) },
    ],
  },
  {
    // BRC Camps 2026 with REAL placements ("where is camp X" is THE playa
    // question). Camp locations are showable to users from Aug 23 12:01am;
    // this build reaches users with the Aug 27 release. Not embargoed like
    // art — the inverse test (campsPack.test.ts) asserts Where is PRESENT.
    manifest: campsManifest,
    files: [
      { name: 'pack.json', content: JSON.stringify(campsManifest) },
      ...campsFiles.map(f => ({ name: f.file, content: f.markdown })),
      { name: 'embeddings.json', content: JSON.stringify(campsVectors) },
    ],
  },
];

/** Pack id the lookup_facts tool is specialized over. */
export const SURVIVAL_GUIDE_PACK_ID = guideManifest.id;
