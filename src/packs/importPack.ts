/**
 * Data-pack import via the system document picker.
 *
 * v0 flow: the user multi-selects a pack's files together (pack.json + its
 * content files); we copy them into app storage, read them as UTF-8, and hand
 * the payloads to the shared installer. Importing a whole .zip pack is the
 * planned next step, and is still open: it needs an unzip dependency, which
 * the app does not currently carry.
 */

import { pick, keepLocalCopy, types } from '@react-native-documents/picker';
import { readFile } from '@dr.pogodin/react-native-fs';
import { getDb, rebuildFtsIndexes } from '../events/db';
import { installPackFromFiles, InstallResult, PackFilePayload } from './installPack';
import {
  MAX_BEAM_BYTES,
  installCampBundle,
  parseCampBundle,
} from '../camp/campBoard';
import { installFriendBundle, parseFriendBundle } from '../friends/friendCard';
import { logSystemNote } from '../log/chatLog';
import { refreshFactGraphSafe } from '../facts/factGraph';

/**
 * Ask the user for a pack's files, then install. Resolves null when the user
 * cancels the picker. Throws with a user-showable message on invalid packs.
 */
let pickInFlightSince = 0;

export async function importPackViaPicker(): Promise<InstallResult | null> {
  // An abandoned picker (user wandered off mid-pick) can leave the native
  // promise unsettled forever, and every later Import tap died silently
  // until an app restart (Marisol finding #8). A stale in-flight marker is
  // ignored rather than honored: the new tap always reaches pick(), and a
  // concurrent-pick refusal surfaces as words instead of nothing.
  const now = Date.now();
  if (pickInFlightSince && now - pickInFlightSince < 45_000) {
    throw new Error(
      'The file chooser is still open (or stuck) — finish or dismiss it first.',
    );
  }
  pickInFlightSince = now;
  let picked;
  try {
    picked = await pick({
      mode: 'import',
      allowMultiSelection: true,
      type: [types.allFiles],
    });
  } catch (e: any) {
    // Picker rejects on user cancellation; treat that as a no-op.
    if (e?.code === 'OPERATION_CANCELED') {
      return null;
    }
    throw e;
  } finally {
    pickInFlightSince = 0;
  }
  if (!picked || picked.length === 0) {
    return null;
  }

  // content:// URIs (Android) are not directly readable — copy into app
  // storage first. Harmless on iOS too.
  const copies = await keepLocalCopy({
    files: picked.map(p => ({
      uri: p.uri,
      fileName: p.name ?? 'unnamed',
    })) as [{ uri: string; fileName: string }],
    destination: 'cachesDirectory',
  });

  const payloads: PackFilePayload[] = [];
  for (let i = 0; i < copies.length; i++) {
    const copy = copies[i];
    if (copy.status !== 'success') {
      throw new Error(`Could not read "${picked[i]?.name}": ${copy.copyError}`);
    }
    const path = copy.localUri.replace(/^file:\/\//, '');
    payloads.push({
      name: picked[i]?.name ?? path.split('/').pop() ?? 'unnamed',
      content: await readFile(path, 'utf8'),
    });
  }

  // Friend card? (Friends on playa, 2026-08-19.) A card or gossip bundle is
  // one small JSON document (kind: playapal-friend-card) — sniffed before
  // camp beams, imported through the same button.
  // Single-file selections only: a multi-file PACK may legitimately contain
  // a .txt whose content happens to parse as a friend bundle (review
  // 2026-08-19) — pack.json declares the container there.
  if (payloads.length === 1 && parseFriendBundle(payloads[0].content) !== null) {
    const conn = getDb();
    const r = installFriendBundle(conn, payloads[0].content);
    const bits: string[] = [];
    if (r.added.length > 0) {
      bits.push(`added ${r.added.join(', ')}`);
    }
    if (r.updated.length > 0) {
      bits.push(`updated ${r.updated.join(', ')}`);
    }
    if (r.stale > 0) {
      bits.push(`${r.stale} older cop${r.stale === 1 ? 'y' : 'ies'} skipped`);
    }
    if (bits.length === 0) {
      bits.push('nothing new');
    }
    logSystemNote(
      'system',
      `friend cards: +${r.added.length} ~${r.updated.length} =${r.unchanged} stale ${r.stale}`,
    );
    return {
      packId: 'friends',
      name: 'Friends on playa',
      events: 0,
      chunks: 0,
      nodes: 0,
      edges: 0,
      friends: r.added.length + r.updated.length,
      detail: bits.join('; '),
      warnings: [],
    };
  }

  // Camp beam? A beamed camp-board file is one self-contained JSON document
  // (kind: playapal-camp-board) carrying one sealed envelope per known
  // writer — verified + high-water-guarded by installCampBundle, through the
  // same Import button (doc 30 pilot: import via the EXISTING picker path).
  // Size gate BEFORE any JSON.parse (audit 2026-08-20): .length counts
  // UTF-16 units, a floor on bytes — an over-bound file never reaches the
  // parser. installCampBundle re-checks behind this gate.
  const campBundles = payloads.filter(
    p => p.content.length <= MAX_BEAM_BYTES && parseCampBundle(p.content) !== null,
  );
  if (campBundles.length > 0) {
    if (payloads.length > 1) {
      throw new Error('Import a camp beam by itself — one file at a time.');
    }
    const conn = getDb();
    const camp = installCampBundle(conn, campBundles[0].content);
    const warnings: string[] = [];
    // Canonical state is committed; the FTS index is derived and its
    // refresh must not turn a successful import into a reported failure
    // (implementation-review finding 7). The per-open rebuild recovers it.
    try {
      rebuildFtsIndexes(conn);
    } catch (e) {
      warnings.push(
        'Imported, but it may not appear in search yet. Restart Playa Pal.',
      );
      console.warn('[import] post-commit FTS rebuild failed:', e);
    }
    if (camp.forks.length > 0) {
      warnings.push(
        `Conflicted copy from ${camp.forks.join(', ')} — both versions now show in Camp; remove the stale one under Boards once resolved.`,
      );
    }
    if (camp.stale > 0) {
      warnings.push(
        `${camp.stale} board${camp.stale === 1 ? '' : 's'} in the beam ${
          camp.stale === 1 ? 'was' : 'were'
        } older than what you already have - skipped.`,
      );
    }
    const name =
      camp.installed.length > 0
        ? `Camp beam — ${camp.installed.join(', ')}${
            camp.notes > 0
              ? ` (${camp.notes} camp note${camp.notes === 1 ? '' : 's'})`
              : ''
          }`
        : 'Camp beam (nothing new)';
    logSystemNote(
      'system',
      `camp beam: installed [${camp.installed.join(', ')}], ` +
        `${camp.posts} open posts, ${camp.notes} notes, ${camp.unchanged} unchanged, ${camp.stale} stale, ` +
        `forks [${camp.forks.join(', ')}]`,
    );
    // posts and notes land on different surfaces — never report one as the other
    const detail =
      camp.posts > 0
        ? `${camp.posts} open board post${camp.posts === 1 ? '' : 's'} — see the board above`
        : camp.notes > 0
        ? 'read them under "Camp & private packs"'
        : 'nothing new';
    return {
      packId: camp.installed.length > 0 ? camp.campId : 'camp-board',
      name,
      events: 0,
      chunks: 0,
      nodes: 0,
      edges: 0,
      items: camp.posts + camp.notes,
      detail,
      warnings,
    };
  }

  const conn = getDb();
  const result = installPackFromFiles(conn, payloads, { builtin: false });
  if (refreshFactGraphSafe(conn) === null) {
    result.warnings.push(
      'Imported, but camp-history details may not appear yet. Restart Playa Pal.',
    );
  }
  try {
    rebuildFtsIndexes(conn);
  } catch (e) {
    result.warnings.push(
      'Imported, but it may not appear in search yet. Restart Playa Pal.',
    );
    console.warn('[import] post-commit FTS rebuild failed:', e);
  }
  // Field log: a pack install changes what every later answer can retrieve —
  // the analysis needs to know when the ground truth shifted.
  logSystemNote(
    'system',
    `pack installed: ${result.name} (${result.packId}) — ${result.events} events, ${result.chunks} doc chunks, ${result.nodes} nodes, ${result.edges} edges`,
  );
  return result;
}
