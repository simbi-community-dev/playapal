/**
 * The art pack's two hard guarantees, checked against a REAL built pack.
 *
 * 1. THE EMBARGO. Burning Man's dataset terms forbid art locations reaching
 *    users before Gate opens. tools/load_art.py drops location fields at
 *    transform time rather than filtering later, so an embargoed field
 *    cannot survive into a built pack by accident — and this asserts it on
 *    the artifact, not on the intent.
 * 2. NO PERSONAL OR COMMERCIAL DATA. The source records carry
 *    contact_email (a named human's address) and donation_link (a
 *    solicitation, which the free-app terms forbid). Neither may ship.
 *
 * Also asserts the provenance flag, because whether a pack MAY BE PUBLISHED
 * depends on where its data came from: the API is publishable, the keyless
 * dataset archive is not ("You may not republish Event Data or other
 * Burning Man content not accessed through the API").
 */

const fs = require('fs');

/**
 * THE PACK THAT ACTUALLY SHIPS — not a build artifact.
 *
 * This suite pointed at `build/art-2025`, which is GITIGNORED (.gitignore:7).
 * So on every clean checkout `built()` was false, every describe below became
 * describe.skip, and eight assertions guarding a DATA-TERMS obligation ran
 * exactly never. MEASURED: `ls build/art-2025` -> no such directory, on this
 * tree, today.
 *
 * Meanwhile the pack the app installs is tracked at assets/packs/brc-art-2026
 * and was never read by this file at all. The guard and the shipped artifact
 * had drifted apart, and nothing could say so — the suite was green because
 * it was absent, which is the same shape as a suite that cannot load being
 * reported as silence.
 *
 * The wrappers are `.md.json` ({ file, markdown }), not `.md`, so a filter on
 * `.endsWith('.md')` would have yielded an EMPTY array even after repointing
 * — assertions over nothing, passing forever. campsPack.test.ts hit exactly
 * that drift once already and carries the fix; this file never got it.
 */
const PACK = 'assets/packs/brc-art-2026';

const built = (): boolean => fs.existsSync(`${PACK}/pack.json`);
const docs = (): string[] =>
  built()
    ? fs
        .readdirSync(PACK)
        .filter((f: string) => f.endsWith('.md.json'))
        .map(
          (f: string) =>
            (JSON.parse(fs.readFileSync(`${PACK}/${f}`, 'utf8')).markdown ??
              '') as string,
        )
    : [];

// With the shipped assets committed, absence means a BROKEN TREE — the same
// stance campsPack takes. Keeping describe.skip here is what let this suite
// disappear for a day, so absence is asserted against instead, below.
const maybe = built() ? describe : describe.skip;

describe('the art guard reads the pack that actually ships', () => {
  test('the shipped pack is present and parsed — POSITIVE CONTROL', () => {
    // Without this, every arm in this file passes over an empty array the
    // moment the path, the extension or the wrapper shape changes again.
    // That is not hypothetical here: it is what this suite has been doing.
    expect(built()).toBe(true);
    expect(docs().length).toBeGreaterThan(0);
    expect(docs().join('').length).toBeGreaterThan(500);
  });
});

maybe('a built art pack honors the location embargo', () => {
  test('no location field survives the transform', () => {
    for (const d of docs()) {
      expect(d).not.toMatch(/location_string/i);
      expect(d).not.toMatch(/"location"/i);
    }
  });

  test('no art location appears in the prose, in any of its real shapes', () => {
    // The FIRST version of this test asserted the CAMP address shape
    // ("7:30 & C") and was therefore vacuous: art locations never look
    // like that. The real shapes, read off the 2025 dataset:
    //   location_string -> "12:00 2500', Open Playa"  (clock + distance)
    //   location        -> gps_latitude 40.79..., gps_longitude -119.19...
    for (const d of docs()) {
      expect(d).not.toMatch(/\b\d{1,2}:\d{2}\s+\d{3,4}'/); // clock + distance
      expect(d).not.toMatch(/\b4[01]\.\d{4,}/); // BRC latitudes
      expect(d).not.toMatch(/-11[89]\.\d{4,}/); // BRC longitudes
      expect(d).not.toMatch(/gps_lat|gps_long/i);
    }
  });

  test('the reader is told locations are missing, and why', () => {
    for (const d of docs()) {
      expect(d).toMatch(/embargo/i);
    }
  });
});

maybe('a built art pack carries no personal or commercial data', () => {
  test('no contact emails', () => {
    for (const d of docs()) {
      expect(d).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    }
  });

  test('no donation links', () => {
    for (const d of docs()) {
      expect(d).not.toMatch(/donation_link/i);
    }
  });
});

maybe('the pack records which year and which surface it came from', () => {
  // Read lazily: jest evaluates a describe.skip callback too, so a top-level
  // readFileSync made the whole suite fail to RUN on any tree without the
  // built pack (every fresh fab worktree) instead of skipping.
  const readPack = () => JSON.parse(fs.readFileSync(`${PACK}/pack.json`, 'utf8'));

  test('provenance is recorded, because the reader needs to know the year', () => {
    const pack = readPack();
    expect(['api', 'archive']).toContain(pack.source);
    expect(typeof pack.year).toBe('number');
  });

  test('an archive pack says plainly that it describes a past year', () => {
    // ToS 5.3 permits content from "the API OR TOOLS THAT BURNING MAN MAY
    // PROVIDE", and the dataset archive is such a tool — so provenance is
    // NOT a publish gate. What the reader must not be misled about is the
    // YEAR: most pieces do not return.
    const pack = readPack();
    if (pack.source === 'archive') {
      expect(pack.description).toMatch(/not a guide to the current burn/i);
      for (const d of docs()) {
        expect(d).toMatch(/not a guide to what is out there now/i);
      }
    }
  });

  test('the required non-affiliation disclaimer is present', () => {
    expect(readPack().description).toMatch(/not affiliated/i);
    for (const d of docs()) {
      expect(d).toMatch(/not affiliated/i);
    }
  });
});
