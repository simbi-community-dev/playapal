/**
 * Sealed BRC Art 2026 locations — the gate-day reveal (ToS 6.1: art
 * locations stay hidden from USERS until Gate opens, 2026-08-30 00:01
 * Pacific).
 *
 * The asset ships as a RAW Metro require: it is NOT in the art pack's file
 * list, so installPack never chunks it, doc_chunks and FTS never see it,
 * and the Angel cannot retrieve it — before OR after the gate. Retrieval
 * over this app is text-only by construction; the sealed map is reachable
 * only from PackReader, which renders a piece's location line when the
 * device clock passes the embargo instant.
 *
 * The device clock is the gate, by design: a camper who sets their clock
 * forward to see addresses early is lying to themselves, not cheating
 * anyone else — the same data is public on burningman.org the moment the
 * gate opens, and nothing here is a secret worth a crypto box.
 *
 * Keys are the piece headings exactly as load_art.py's section() emits
 * them (minus "## ") — built by tools/seal_art_locations.py, which IMPORTS
 * that logic rather than duplicating it, so a pack rebuild moves the keys
 * with the headings.
 */

// Raw bundled asset — deliberately never registered in builtins.ts files,
// so the installer cannot chunk it into retrieval.
const LOCATIONS: Record<string, string> = require('../../assets/packs/brc-art-2026/locations.json');

export const ART_PACK_ID = 'brc-art-2026';

/**
 * The embargo instant as a comparable string: local device wall time,
 * rendered as Pacific (UTC-7, PDT — BRC is on Pacific daylight time in
 * August, and the offset is hardcoded on purpose: no tz lib, no DST
 * guessing, the burn straddles no transition).
 */
export const GATE_ISO = '2026-08-30T00:01';

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** `now` → 'YYYY-MM-DDTHH:MM' in Pacific (UTC-7). */
export function pacificWall(now: Date): string {
  const p = new Date(now.getTime() - 7 * 60 * 60 * 1000);
  return `${p.getUTCFullYear()}-${pad(p.getUTCMonth() + 1)}-${pad(p.getUTCDate())}T${pad(p.getUTCHours())}:${pad(p.getUTCMinutes())}`;
}

/** Has Gate opened? String compare on zero-padded ISO — safe by form. */
export function gateOpen(now: Date): boolean {
  return pacificWall(now) >= GATE_ISO;
}

/**
 * The location for one rendered heading, or null when sealed (wrong pack,
 * unknown heading, or before the gate). Pure: `now` is injected so tests
 * never touch the wall clock.
 */
export function sealedLocationFor(
  packId: string,
  heading: string,
  now: Date,
): string | null {
  if (packId !== ART_PACK_ID || !gateOpen(now)) {
    return null;
  }
  return LOCATIONS[heading] ?? null;
}

/** How many sealed pieces this build carries (tests pin the join). */
export function sealedLocationCount(): number {
  return Object.keys(LOCATIONS).length;
}

/** Test-only handle: the raw map, so the FTS absence assertion can sweep
 * every string without the module knowing the DB exists. */
export function sealedLocationStrings(): string[] {
  return Object.values(LOCATIONS);
}
