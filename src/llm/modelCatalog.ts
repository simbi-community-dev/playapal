/**
 * Model catalog: on-device tiers selected by measured phone capacity.
 *
 * Adding a model means adding one entry with an immutable URL, SHA-256,
 * byte size, RAM floor, and camper-facing title and description. No registry
 * service, plugin API, or schema migration is required.
 *
 * The phone recommends the largest entry whose RAM floor it clears, while
 * Settings keeps every entry available for an explicit choice. Downloads
 * land at a .part path, show byte progress, verify the digest, and are only
 * then renamed and saved as model_path. Interrupted or unpinned downloads
 * therefore cannot be mistaken for loadable models.
 *
 * New weights require a new immutable catalog entry and app build. The two
 * shipping entries use the same code path as any future contribution.
 */
import {
  DocumentDirectoryPath,
  downloadFile,
  exists,
  getFSInfo,
  hash,
  moveFile,
  unlink,
} from '@dr.pogodin/react-native-fs';
import DeviceInfo from 'react-native-device-info';
import { getSetting, setSetting } from '../events/db';

/** A stable id for an entry -- the thing Settings remembers and a
 * contributor chooses. Lowercase, kebab-case, unique in the list. */
export type ModelId = string;

export interface CatalogEntry {
  id: ModelId;
  /** Shown to the user. Says what it is FOR. */
  title: string;
  /** One line under the title. */
  blurb: string;
  /** Exact file. HF "resolve" URLs are stable per commit; pin the commit. */
  url: string;
  /** Local filename under DocumentDirectoryPath. */
  file: string;
  /** SHA-256 of the exact file. EMPTY = not yet published = refused. */
  sha256: string;
  /** Approximate size, for the "1.7 GB — Wi-Fi recommended" line. */
  bytes: number;
  /** Phones with at least this much total RAM default to this tier. */
  minTotalRamBytes: number;
}

// The threshold: 6 GB total RAM. A 2.6B Q4_0 (~1.7 GB file) plus llama.rn
// context plus the OS is comfortable at 8 GB, tight at 6, and a 4 GB phone
// should not be asked to try. Measured on a Pixel 7 (8 GB): fine. Adjust
// with evidence, not vibes.
export const SMART_TIER_MIN_RAM = 6 * 1024 * 1024 * 1024;

/**
 * ADD A MODEL HERE. That is the whole contribution surface. Keep entries
 * ordered largest-first: the phone's default is the FIRST entry whose RAM
 * floor it clears, so order encodes preference.
 */
export const CATALOG: CatalogEntry[] = [
  {
    id: 'angel-smart',
    title: 'Playa Angel',
    blurb: 'Best answers, slower to reply. Needs a phone with 6 GB+ of memory.',
    // Q4_0 quantization of the LFM2.5-2.6B-derived Playa Angel weights.
    // This higher-precision tier is the default when the phone clears its
    // measured memory floor.
    url: 'https://huggingface.co/davidryalpug/playa-angel/resolve/de12531421cc0ab85d668479179130c4b93e24ac/angel-smart-q4_0.gguf',
    file: 'angel-smart.gguf',
    sha256: '653c7ee3e7e95468516574350b0cfacbadb4609bf56d8789e452f9b1297e0bb4',
    bytes: 1_593_894_208,
    minTotalRamBytes: SMART_TIER_MIN_RAM,
  },
  {
    id: 'angel-light',
    title: 'Playa Angel Light',
    blurb: 'Fastest replies, a little less precise. Made for lower-memory phones.',
    // The same Playa Angel weights at Q3_K_M: a smaller, faster download
    // that trades some precision for lower memory use.
    url: 'https://huggingface.co/davidryalpug/playa-angel/resolve/de12531421cc0ab85d668479179130c4b93e24ac/angel-light-q3_k_m.gguf',
    file: 'angel-light.gguf',
    sha256: 'f5fb59a0db7039f4c485f82f6d448e2126d3923b5bee1ac411b5aea67c85de31',
    bytes: 1_366_844_736,
    minTotalRamBytes: 0,
  },
];

export const localPath = (e: CatalogEntry) => `${DocumentDirectoryPath}/${e.file}`;
const partPath = (e: CatalogEntry) => `${localPath(e)}.part`;

/** What this phone actually has. Either field may be undefined when the
 * probe fails — callers must treat unknown as unknown, never as zero. */
export interface Circumstances {
  totalRamBytes?: number;
  freeBytes?: number;
}

/** Read the phone's real numbers. Each probe fails independently and
 * silently to undefined: a broken probe must degrade the recommendation,
 * never the app. */
export async function readCircumstances(): Promise<Circumstances> {
  const c: Circumstances = {};
  try {
    c.totalRamBytes = await DeviceInfo.getTotalMemory();
  } catch {}
  try {
    c.freeBytes = (await getFSInfo()).freeSpace;
  } catch {}
  return c;
}

/** Margin on top of the file itself: the .part download plus breathing room
 * so we never advise a pull that lands the phone at 0 bytes free. */
export const DOWNLOAD_HEADROOM = 256 * 1024 * 1024;

export type EntryFit =
  | { status: 'fits' }
  | { status: 'low-ram' }
  | { status: 'no-room'; shortBytes: number };

/** Can this phone run — and if needed, download — this entry?
 * Unknown circumstances count as fitting: a false "won't fit" turns a
 * working option invisible, while a false "fits" fails loudly at download
 * or load time with a real error the user can act on. */
export function fitEntry(
  e: CatalogEntry,
  c: Circumstances,
  alreadyDownloaded = false,
): EntryFit {
  if (c.totalRamBytes !== undefined && c.totalRamBytes < e.minTotalRamBytes) {
    return { status: 'low-ram' };
  }
  if (!alreadyDownloaded && c.freeBytes !== undefined) {
    const need = e.bytes + DOWNLOAD_HEADROOM;
    if (c.freeBytes < need) {
      return { status: 'no-room', shortBytes: need - c.freeBytes };
    }
  }
  return { status: 'fits' };
}

/** The entry this phone should default to: the FIRST catalog entry that
 * fits BOTH the RAM floor and the free space to get it (the list is
 * ordered largest-first, so order encodes preference). A phone with the
 * RAM but not the room falls through to something it can actually pull
 * today. Unknown RAM = the smallest entry, because a wrong guess UP
 * strands the user with a model that will not load, and a wrong guess DOWN
 * gives them a working app they can upgrade from Settings. */
export function recommendedEntry(
  c: Circumstances,
  downloadedIds?: Set<ModelId>,
): CatalogEntry {
  if (c.totalRamBytes === undefined) {
    return CATALOG[CATALOG.length - 1];
  }
  return (
    CATALOG.find(e => fitEntry(e, c, downloadedIds?.has(e.id)).status === 'fits') ??
    CATALOG[CATALOG.length - 1]
  );
}

export const entryFor = (id: ModelId): CatalogEntry | undefined =>
  CATALOG.find(e => e.id === id);

export interface DownloadProgress {
  bytesWritten: number;
  contentLength: number;
}

export type DownloadOutcome =
  | { ok: true; path: string }
  | { ok: false; reason: 'unpinned' | 'network' | 'digest' | 'cancelled'; detail: string };

/**
 * Pull one catalog entry to disk, verify it, and make it the active model.
 * Never leaves a torn file at the final path.
 */
export async function downloadModel(
  entry: CatalogEntry,
  onProgress?: (p: DownloadProgress) => void,
  onPhase?: (phase: 'verifying') => void,
): Promise<DownloadOutcome> {
  if (!entry.sha256) {
    return {
      ok: false,
      reason: 'unpinned',
      detail: `${entry.title} is not published yet (no digest pinned).`,
    };
  }
  const final = localPath(entry);
  const part = partPath(entry);

  // Already have it, and it verifies? Done. (A previous run may have crashed
  // between the rename and the setting write.)
  if (await exists(final)) {
    if ((await hash(final, 'sha256')).toLowerCase() === entry.sha256.toLowerCase()) {
      setSetting('model_path', final);
      return { ok: true, path: final };
    }
    await unlink(final); // wrong digest at the final path is never kept
  }

  // NO RESUME, ON PURPOSE. This fs library's downloadFile has no append
  // mode; its `resumable` option is an iOS background-session callback, not
  // a byte-range append. A Range request into toFile would OVERWRITE the
  // partial with the tail -- a torn file the digest check would catch, but
  // only after every retry wasted the same bandwidth. So a stale .part is
  // discarded and the pull starts clean; the digest gate keeps a torn file
  // from ever reaching the final path. If resume matters (it will, on playa
  // Wi-Fi), the primitive to add is a chunked GET with our own Range loop --
  // that is a separate, real piece of work and it says so here rather than
  // pretending this line does it.
  if (await exists(part)) {
    await unlink(part);
  }
  try {
    const job = downloadFile({
      fromUrl: entry.url,
      toFile: part,
      progressInterval: 500,
      progress: res =>
        onProgress?.({ bytesWritten: res.bytesWritten, contentLength: res.contentLength }),
    });
    const res = await job.promise;
    if (res.statusCode !== 200) {
      return { ok: false, reason: 'network', detail: `HTTP ${res.statusCode}` };
    }
  } catch (e: any) {
    return { ok: false, reason: 'network', detail: e?.message ?? String(e) };
  }

  // The owner watched the bar sit at "95%" for a minute on an iPhone: this
  // hash of a GB-scale file is that minute, and it deserves its own state
  // instead of a stuck progress bar (field report 2026-08-19).
  onPhase?.('verifying');
  const digest = (await hash(part, 'sha256')).toLowerCase();
  if (digest !== entry.sha256.toLowerCase()) {
    // A bad digest after a full download is corruption, not a partial: the
    // .part is worthless, remove it so the next attempt starts clean.
    await unlink(part);
    return {
      ok: false,
      reason: 'digest',
      detail: 'The downloaded file did not verify. It has been removed; try again.',
    };
  }
  await moveFile(part, final);
  setSetting('model_path', final);
  return { ok: true, path: final };
}

/** Which catalog entry, if any, is the currently active model. */
export async function installedEntry(): Promise<CatalogEntry | null> {
  const p = getSetting('model_path');
  if (!p) {
    return null;
  }
  for (const e of CATALOG) {
    if (p === localPath(e) && (await exists(p))) {
      return e;
    }
  }
  return null; // a hand-picked or adb-pushed model: not from the catalog
}
