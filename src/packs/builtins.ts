/**
 * Registry of the two data packs bundled with the app. Both go through the
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
const guideManifest = require('../../assets/packs/survival-guide/pack.json') as PackManifest;
const guideContent = require('../../assets/packs/survival-guide/guide.md.json') as {
  file: string;
  markdown: string;
};

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
    ],
    chunkMaxChars: GUIDE_CHUNK_MAX_CHARS,
  },
];

/** Pack id the lookup_facts tool is specialized over. */
export const SURVIVAL_GUIDE_PACK_ID = guideManifest.id;
