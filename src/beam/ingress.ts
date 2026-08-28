/**
 * Beam ingress, JS half (docs/BEAM-INGRESS-CONTRACT.md §2, §4).
 *
 * Native copied a received .playapal file into the app cache and queued
 * {ingressId, localPath, displayName, mime, bytes, source}. This module
 * drains that queue once on mount and again on every 'PlayaPalBeamIngress'
 * wake-up, reads each local copy, and pushes it through the SAME seam the
 * picker uses — installIncomingPayload — so there is exactly one sniff
 * order, one size gate, one transaction and one receipt shape.
 *
 * Delivery discipline:
 *   - dedupe on ingressId (a cold start + warm event for the same item, or
 *     a double drain, must produce ONE receipt);
 *   - one Alert per delivery — success with counts, or the honest failure;
 *   - the cache copy is deleted once it has been judged, success OR refusal
 *     (the app cache is invisible to the file picker, so a kept copy is a
 *     leak, not a second chance — the camper still has the original);
 *   - the FILE is the source of truth, not native's RAM queue: its name stem
 *     is the ingressId, and startBeamIngress sweeps the ingress directory
 *     on mount, so a beam stranded by a process death between native copy
 *     and JS drain is imported on the next launch instead of vanishing
 *     (xrev pug-opus on ea1ba6e).
 *
 * Pure-JS core (`processIngressItems`) takes its I/O as parameters so the
 * dedupe, the receipt wording and the cleanup rule are testable under node.
 */

import { Alert, NativeEventEmitter, NativeModules } from 'react-native';
import {
  CachesDirectoryPath,
  readDir,
  readFile,
  unlink,
} from '@dr.pogodin/react-native-fs';
import { MAX_BEAM_BYTES } from '../camp/campBoard';
import {
  describeInstall,
  installIncomingPayload,
  IngressSource,
} from '../packs/importPack';
import type { InstallResult } from '../packs/installPack';

export type BeamIngressItem = {
  ingressId: string;
  localPath?: string;
  displayName: string;
  mime: string;
  bytes: number;
  source: Exclude<IngressSource, 'picker' | 'link'>;
  /** set INSTEAD of localPath when the native copy failed */
  error?: string;
  /** ACTION_SEND_MULTIPLE: how many files were offered (we take the first) */
  extraCount?: number;
};

export const BEAM_INGRESS_EVENT = 'PlayaPalBeamIngress';
/** Must match BeamIngressModule.DIR / EXT on the native side. */
export const BEAM_INGRESS_DIR = 'beam-ingress';
export const BEAM_INGRESS_EXT = 'playapal';

/**
 * Files on disk that native finished copying but nobody drained — the
 * process died in between. Their stem is the ingressId native minted, so
 * dedupe against the live queue still holds. A `.part` is a copy in flight
 * and is never an item.
 */
export function orphanItems(
  entries: { name: string; path: string; size: number }[],
): BeamIngressItem[] {
  const suffix = `.${BEAM_INGRESS_EXT}`;
  return entries
    .filter(e => e.name.endsWith(suffix))
    .map(e => ({
      ingressId: e.name.slice(0, -suffix.length),
      localPath: e.path,
      displayName: 'a beam received before Playa Pal restarted',
      mime: '',
      bytes: e.size,
      source: 'android-view' as const,
    }));
}

type Io = {
  read: (path: string) => Promise<string>;
  remove: (path: string) => Promise<void>;
  install: (p: { name: string; content: string; source: IngressSource }) => InstallResult;
  notify: (title: string, body: string) => void;
};

export type IngressOutcome = {
  ingressId: string;
  status: 'installed' | 'refused' | 'duplicate';
  title: string;
  body: string;
};

/** Every ingressId this JS instance has already handled. */
const consumed = new Set<string>();

/**
 * The pure core. Returns one outcome per NEW item (duplicates are reported as
 * such and produce no notification).
 */
export async function processIngressItems(
  items: BeamIngressItem[],
  io: Io,
  seen: Set<string> = consumed,
): Promise<IngressOutcome[]> {
  const out: IngressOutcome[] = [];
  for (const item of items) {
    if (seen.has(item.ingressId)) {
      out.push({ ingressId: item.ingressId, status: 'duplicate', title: '', body: '' });
      continue;
    }
    seen.add(item.ingressId);
    const name = item.displayName || 'beam';
    const many =
      item.extraCount && item.extraCount > 1
        ? ` (${item.extraCount} files were shared — Playa Pal takes one beam at a time, this was the first)`
        : '';

    if (item.error || !item.localPath) {
      const why =
        item.error === 'too large'
          ? `${name} is bigger than a beam can be (${Math.round(MAX_BEAM_BYTES / 1024 / 1024)} MB limit).`
          : `${name} could not be read${item.error ? `: ${item.error}` : ''}.`;
      const o: IngressOutcome = {
        ingressId: item.ingressId,
        status: 'refused',
        title: "Couldn't read that beam",
        body: why + many,
      };
      io.notify(o.title, o.body);
      out.push(o);
      continue;
    }

    let content: string;
    try {
      content = await io.read(item.localPath);
    } catch (e: any) {
      const o: IngressOutcome = {
        ingressId: item.ingressId,
        status: 'refused',
        title: "Couldn't read that beam",
        body: `${name}: ${e?.message ?? String(e)}${many}`,
      };
      io.notify(o.title, o.body);
      out.push(o);
      continue;
    }

    try {
      const result = io.install({ name, content, source: item.source });
      const o: IngressOutcome = {
        ingressId: item.ingressId,
        status: 'installed',
        title: result.packId === 'friends' ? 'Friends on playa' : 'Beam received',
        body: `${describeInstall(result)}${many}`,
      };
      io.notify(o.title, o.body);
      out.push(o);
      try {
        await io.remove(item.localPath);
      } catch {
        // a leftover cache copy is harmless; the OS reclaims cache
      }
    } catch (e: any) {
      // Refused by the seam (not a beam, wrong passphrase, stale, corrupt…).
      // The copy goes too: the cache is invisible to the picker, so keeping
      // it would only leak, and re-refusing it on every launch would nag.
      const o: IngressOutcome = {
        ingressId: item.ingressId,
        status: 'refused',
        title: "Couldn't import that beam",
        body: `${name}: ${e?.message ?? String(e)}${many}`,
      };
      io.notify(o.title, o.body);
      out.push(o);
      try {
        await io.remove(item.localPath);
      } catch {
        // nothing more to do with it
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* App wiring                                                          */
/* ------------------------------------------------------------------ */

const installedWatchers = new Set<() => void>();

/** Screens that render beamed content subscribe to re-read after an install. */
export function subscribeBeamInstalled(cb: () => void): () => void {
  installedWatchers.add(cb);
  return () => {
    installedWatchers.delete(cb);
  };
}

/** Fire the subscribers — used by the link path in App.tsx too. */
export function notifyBeamInstalled(): void {
  for (const w of installedWatchers) {
    w();
  }
}

const realIo: Io = {
  read: p => readFile(p, 'utf8'),
  remove: p => unlink(p),
  install: installIncomingPayload,
  notify: (t, b) => Alert.alert(t, b),
};

async function drainNow(sweep = false): Promise<void> {
  const mod = NativeModules.BeamIngress;
  if (!mod?.drain) {
    return; // iOS until its module lands; the picker remains the door
  }
  let items: BeamIngressItem[] = [];
  try {
    items = (await mod.drain()) ?? [];
  } catch (e) {
    console.warn('[beam] drain failed:', e);
    return;
  }
  if (sweep) {
    try {
      const entries = await readDir(`${CachesDirectoryPath}/${BEAM_INGRESS_DIR}`);
      const queued = new Set(items.map(i => i.ingressId));
      items = items.concat(orphanItems(entries).filter(o => !queued.has(o.ingressId)));
    } catch {
      // no directory yet — nothing was ever received
    }
  }
  if (items.length === 0) {
    return;
  }
  const outcomes = await processIngressItems(items, realIo);
  if (outcomes.some(o => o.status === 'installed')) {
    notifyBeamInstalled();
  }
}

/**
 * Mount once at the app root: drains anything queued before JS existed
 * (cold start), then listens for warm deliveries. Returns the unsubscribe.
 */
export function startBeamIngress(): () => void {
  const mod = NativeModules.BeamIngress;
  if (!mod) {
    return () => {};
  }
  const emitter = new NativeEventEmitter(mod);
  const sub = emitter.addListener(BEAM_INGRESS_EVENT, () => {
    void drainNow();
  });
  void drainNow(true); // mount: queue + the orphan sweep
  return () => sub.remove();
}
