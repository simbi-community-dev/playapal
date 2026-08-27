/**
 * A CAPABILITY WITH NO CALLER IS A FEATURE THAT DOES NOT EXIST — and this
 * repo shipped five of them in one night before anyone noticed the shape.
 *
 *   1. `decodePodLink` — a whole invite codec, round-trip tested, with zero
 *      call sites. The QR component told the camper "Playa Pal opens and they
 *      are in the pod." It opened and returned silently.
 *   2. `radioInterrupted` — a correct interruption state machine with three
 *      named reasons and its own suite, read by nothing. With Bluetooth off
 *      the pod card still promised "your pod sees which way and how far".
 *   3. `encodeBeamSchemeLink` / `encodeFriendSchemeLink` — minted, documented
 *      as "the link the QR encodes", and never called. The QRs encoded the
 *      https carrier instead, which cannot open offline.
 *   4. `factGraphRefreshError` — its own docstring says "the Packs screen
 *      surfaces this so a bad pack is visible instead of silent". No screen
 *      reads it.
 *
 * Every one passed review. Every one had tests. The tests asked "does this
 * work", and the question that separates a feature from a prop is "who calls
 * it".
 *
 * At the second instance of a bug class you stop fixing instances and go
 * after the mechanism. This is the mechanism: an export whose only references
 * are its own module and its own test.
 *
 * HOW TO READ A FAILURE HERE. It is not "delete this". It is one of:
 *   - wire it up (it was meant to be used, and is the bug), or
 *   - delete it (it is genuinely dead), or
 *   - add it to KNOWN_UNCALLED with the reason (it is a documented test
 *     handle, a deliberate not-yet-wired seam, or reached dynamically).
 * The third is a decision someone signs, which is the entire point — today
 * these were nobody's decision at all.
 */
const fsx = require('fs');
const pathx = require('path');

/** Every production source file. Tests are deliberately NOT included: a
 * reference from a test is exactly what makes a dead export look alive. */
function productionFiles(dir: string): string[] {
  return fsx.readdirSync(dir, { withFileTypes: true }).flatMap((e: any) => {
    const full = pathx.join(dir, e.name);
    if (e.isDirectory()) {
      return productionFiles(full);
    }
    return /\.(ts|tsx)$/.test(e.name) && !/\.d\.ts$/.test(e.name) ? [full] : [];
  });
}

const FILES: string[] = [...productionFiles('src'), 'App.tsx'];
const SRC = new Map<string, string>(FILES.map(f => [f, fsx.readFileSync(f, 'utf8')]));

/** Identifier occurrences per file, counted once. */
const TOKENS = new Map<string, Map<string, number>>();
for (const [file, text] of SRC) {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  }
  TOKENS.set(file, counts);
}

/** Exported VALUE names (types are erased and cannot have "callers"). */
function exportsOf(text: string): { kind: string; name: string }[] {
  return [
    ...text.matchAll(
      /^export\s+(?:async\s+)?(function|const|let|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm,
    ),
  ].map(m => ({ kind: m[1], name: m[2] }));
}

/**
 * THE PREDICATE, and it was narrowed by MEASUREMENT rather than by taste.
 *
 * The obvious rule — "no reference outside its own file" — flags 231 exports
 * here, because a helper used inside its module and exported only so a test
 * can reach it looks identical to a dead one. A 231-entry allowlist is not a
 * set of decisions, it is a rubber stamp, which is the very thing this guard
 * exists to prevent.
 *
 * Narrowing to FUNCTIONS whose own file names them ONLY at the definition
 * gives 34 — and that list independently reproduces almost exactly what a
 * separate manual audit found, which is the cross-check that made me trust
 * it. It also correctly EXCLUDES the two capabilities that were dead earlier
 * tonight and are now wired, which is the guard doing its job in the
 * direction that matters.
 */
function isOrphan(kind: string, name: string, home: string): boolean {
  if (kind !== 'function') {
    return false; // constants are routinely internal-plus-test by design
  }
  if (referencesOutside(name, home) > 0) {
    return false;
  }
  return (TOKENS.get(home)?.get(name) ?? 0) <= 1; // named only where defined
}

/** References to `name` anywhere in production OTHER than `home`. */
function referencesOutside(name: string, home: string): number {
  let n = 0;
  for (const [file, counts] of TOKENS) {
    if (file === home) {
      continue;
    }
    n += counts.get(name) ?? 0;
  }
  return n;
}

/**
 * TODAY'S BASELINE. Every entry is a DECISION, not a pardon — the reason is
 * required so the next reader can tell a deliberate seam from an oversight.
 * Removing a name from this list should be a celebration; adding one should
 * take an argument.
 */
const KNOWN_UNCALLED: Record<string, string> = {
  // --- documented test handles: named so this is obvious from the call site
  resetRungCacheForTests: 'explicit test handle',
  __resetQueryEmbedderForTests: 'explicit test handle',
  resetBoardMeshGuard: 'test handle for the board relay guard',
  resetAnnounceGuard: 'test handle for the announce spin guard',
  __resetWalkieSessionForTests:
    'explicit test handle; the walkie session is an app-lifetime store',
  sealedLocationCount: 'documented test handle for the art embargo',
  sealedLocationStrings: 'documented test handle for the art embargo',
  crewAdvertisingHeld:
    'test seam: walkieAirtime observes the hold bit; production reads it inside crewRadio().advertise',

  // --- deliberately unwired, and the module says so out loud
  whereAmIJson: 'unregistered tool; docs/GPS-LANE.md records how to wire it',
  wifiAwarePresent: 'ladder rung 4 seam, inert until the data path lands',
  fitsOnePodQr: 'pod budget helper; PodQr uses fitPodInvite',
  // --- thin wrappers over code production DOES run, so tests through them
  //     still exercise the real path
  exportCampBundle: 'one line over exportCampBeam, which ships',
  isFavorite: 'wrapper; the shipped path reads the favorites table directly',
  brcToLatLon: 'geometry helper; addressToLatLon is the shipped entry',
  formatBrc: 'geometry helper; latLonToBrc is the shipped entry',
  bearingBetween: 'geometry helper; toWaypoint is the shipped entry',
  getMeHome: 'geometry helper; toWaypoint is the shipped entry',
  renderMyPlansMarkdown: 'shares buildMyPlans with the shipping refresher',
  fuseOutcomes: 'wrapper over the vector search path that ships',
  installedEntry: 'catalog wrapper; entryFor is the shipped entry',
  isFactNodeExcluded: 'exclusion is enforced at WRITE time; this reader is redundant',
  embedderPath: 'internal path helper, exercised through the embedder',
  policyFor: 'KIND_POLICY accessor; the shipped code indexes the table',
  factNeighborNodes: 'graph reader used through the fact lookup path',
  resolvePersonSlot: 'used through the identity intent path',
  meshSyncRunning: 'liveness accessor for tests and future UI',
  crewRadioSupported: 'capability accessor; radio.ts gates internally',
  // walkieOn CLOSED 2026-08-25 (lane ring-anywhere): the walkie session is
  // owned above the panel now, and walkieSession.walkieOnFor reads this flag
  // as the radio half of every "voice with this pod" claim. The pardon's own
  // reason — "the panel tracks its own open state" — was exactly the design
  // this lane removed.
  subscribeWalkieCallEvents:
    'the ring seam the pocket-notifications lane consumes; deliberately published ahead of its consumer so the two lanes do not race one file',
  pinsRevision: 'getSnapshot half of a subscribe pair no UI consumes yet',
  stopMyPlansSync: 'app-lifetime subscription; nothing tears it down',
  listCampNotes: 'SELECT * reader; production uses an explicit-column read',

  // --- KNOWN DEFECTS, ledgered rather than pardoned. These are on the
  //     after-train list and each has a room row; they are here so the guard
  //     goes green on the CURRENT tree without pretending they are fine.
  // encodeFriendSchemeLink CLOSED 2026-08-25: the pod's swap-cards QR
  // (src/friends/CardQr.tsx via cardShare.ts) renders the scheme carrier,
  // which is what makes it open on a build whose https app-links are not
  // verified. FriendsSection's own QR deliberately keeps the https carrier —
  // it may be scanned by a phone with no app, and site/f.html is its real
  // fallback — so the two carriers are now a decision rather than a defect.
  encodeBeamLink:
    'DEFECT-ADJACENT: orphaned by switching BeamQr to the offline scheme carrier. Either the share-sheet https path returns or this goes.',
  factGraphRefreshError:
    'DEFECT: its own docstring says the Packs screen surfaces it so a bad pack is visible instead of silent. No screen reads it.',
  shouldForceIdentityTool:
    'DEFECT: production inlines a DIFFERENT predicate in LlamaSession, so four routing tests assert about a function that does not ship.',
  shouldForceHistoryTool:
    'DEFECT: production inlines the identical expression; harmless today, unguarded against drift.',
};

describe('every exported capability has a caller, or a signed reason', () => {
  test('the scan itself works — POSITIVE AND NEGATIVE CONTROLS', () => {
    // Reading this scan cannot tell you it is sound, and a broken one looks
    // careful and passes. So: a name we KNOW is consumed across files must
    // show references, and a name that cannot exist must show none. These
    // catch opposite failures and neither substitutes for the other.
    expect(referencesOutside('decodeBeamLink', 'src/beam/beamLink.ts')).toBeGreaterThan(0);
    expect(referencesOutside('zzzNoSuchExportAnywhere', 'App.tsx')).toBe(0);
    // And the corpus must be real, or every arm below passes over nothing.
    expect(FILES.length).toBeGreaterThan(50);
  });

  test('no NEW export lands with zero production callers', () => {
    const orphans: string[] = [];
    for (const [file, text] of SRC) {
      for (const { kind, name } of exportsOf(text)) {
        if (KNOWN_UNCALLED[name]) {
          continue;
        }
        if (isOrphan(kind, name, file)) {
          orphans.push(`${file}: ${name}`);
        }
      }
    }
    // The message is the fix instructions, because this failing at 2am to
    // someone who did not write the export is the normal case.
    expect(
      orphans.length === 0
        ? []
        : [
            'These exports have no production caller. Each is a feature that',
            'does not exist yet, or dead code. Wire it, delete it, or add it',
            'to KNOWN_UNCALLED with the reason — the third is a decision, and',
            'that is the point.',
            ...orphans,
          ],
    ).toEqual([]);
  });

  test('the baseline does not rot — every pardon still names a real export', () => {
    // A pardon for a name that no longer exists is a comment pretending to be
    // a guard, and it hides the next orphan that happens to share the name.
    const all = new Set<string>();
    for (const text of SRC.values()) {
      for (const e of exportsOf(text)) {
        all.add(e.name);
      }
    }
    const stale = Object.keys(KNOWN_UNCALLED).filter(n => !all.has(n));
    expect(stale).toEqual([]);
  });
});
