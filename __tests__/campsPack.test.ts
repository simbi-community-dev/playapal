/**
 * The camps pack's hard guarantees, checked against a REAL built pack —
 * the camp-specific mirror of artPack.test.ts.
 *
 * THE ONE DIFFERENCE THAT MATTERS. Art LOCATIONS are embargoed and stripped
 * (load_art.py). Camp locations are NOT embargoed — the dataset terms make
 * them showable from Aug 23 12:01am, and the release ships Aug 27. So this
 * suite asserts the OPPOSITE of the art suite on the location axis: a camp
 * pack that LOST its "**Where:**" line is just as broken as an art pack that
 * leaked a coordinate, and for the same reason — the transform dropped (or
 * kept) exactly the wrong field.
 *
 * Guarded the same two ways:
 *  1. NO PERSONAL/COMMERCIAL DATA — contact_email (a named human) and images
 *     (remote thumbnail URLs) must never ship.
 *  2. LOCATION KEPT — every camp on the 2:00-10:00 clock face carries a
 *     "**Where:**" line, keyed to the right sector file.
 *  3. SECTOR KEYING — a camp in camps-N.md must have a placement whose first
 *     clock hour is N (the same first-token convention the app's own
 *     parsePlayaAddressParts reads).
 *  4. PROVENANCE — pack.json records id/source/year and the Aug 23 showable
 *     note plus the non-affiliation disclaimer.
 */


export {}; // module scope: the artPack template's top-level consts must not collide

const fs = require('fs');
// The SHIPPED pack is committed at assets/packs/camps-2026 as Metro
// .md.json wrappers, so this guard ALWAYS runs — the first draft read only
// build/camps-2026 (a local build artifact) and the whole suite silently
// SKIPPED on every fresh fab worktree, which is a guard that guards
// nothing in CI (caught by the 0.7.1 batch: "7 skipped"). A local
// build/ dir, when present, is read IN ADDITION so tool iterations are
// covered before they are wrapped.
const BUILD = 'build/camps-2026';
const ASSETS = 'assets/packs/camps-2026';

const built = (): boolean =>
  fs.existsSync(`${BUILD}/pack.json`) || fs.existsSync(`${ASSETS}/pack.json`);
const readWrap = (path: string): string =>
  (JSON.parse(fs.readFileSync(path, 'utf8')) as { markdown: string }).markdown;
const docs = (): string[] => {
  if (fs.existsSync(`${BUILD}/pack.json`)) {
    return fs
      .readdirSync(BUILD)
      .filter((f: string) => f.endsWith('.md'))
      .map((f: string) => fs.readFileSync(`${BUILD}/${f}`, 'utf8') as string);
  }
  return fs
    .readdirSync(ASSETS)
    .filter((f: string) => f.endsWith('.md.json'))
    .map((f: string) => readWrap(`${ASSETS}/${f}`));
};
const docFor = (name: string): string | null => {
  if (fs.existsSync(`${BUILD}/${name}`)) {
    return fs.readFileSync(`${BUILD}/${name}`, 'utf8') as string;
  }
  if (fs.existsSync(`${ASSETS}/${name}.json`)) {
    return readWrap(`${ASSETS}/${name}.json`);
  }
  return null;
};

// With the shipped assets committed, absence means a BROKEN TREE — but keep
// the skip for the transitional case of a checkout predating the bundle.
const maybe = built() ? describe : describe.skip;

/** First clock token's hour, the exact convention load_camps.py keys on. */
const firstClockHour = (s: string): number | null => {
  const m = s.match(/\b(\d{1,2}):\d{2}\b/);
  return m ? parseInt(m[1], 10) : null;
};

/** Split a doc into its H2 camp sections (drops the leading header block). */
const sections = (doc: string): string[] => doc.split(/\n## /).slice(1);

maybe('a built camps pack drops the personal/commercial fields', () => {
  test('no contact email, image URL, or email address survives the transform', () => {
    for (const d of docs()) {
      expect(d).not.toMatch(/contact_email/i);
      expect(d).not.toMatch(/thumbnail_url/i);
      expect(d).not.toMatch(/widen\.net/i);
      expect(d).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    }
  });
});

maybe('a built camps pack KEEPS camp locations (the camp/art inverse)', () => {
  test('every camp on the clock face carries a Where line', () => {
    for (const name of ['camps-2.md', 'camps-4.md', 'camps-7.md', 'camps-10.md']) {
      const d = docFor(name);
      expect(d).not.toBeNull();
      for (const sec of sections(d as string)) {
        expect(sec).toMatch(/\*\*Where:\*\*/);
      }
    }
  });

  test('the off-face file still names the placed off-face camps', () => {
    const d = docFor('camps-unplaced.md');
    expect(d).not.toBeNull();
    // Airport Road and Center Camp Plaza are placed but off the clock face.
    expect(d).toMatch(/\*\*Where:\*\* Airport Road/);
    expect(d).toMatch(/\*\*Where:\*\* Center Camp Plaza/);
  });
});

maybe('a built camps pack keys each camp to the right clock sector', () => {
  test('camps-N.md holds only camps whose placement clock hour is N', () => {
    for (let hour = 2; hour <= 10; hour++) {
      const name = `camps-${hour}.md`;
      const d = docFor(name);
      if (d === null) {
        continue; // a sector with no camps may simply not be written
      }
      for (const sec of sections(d)) {
        const where = sec.match(/\*\*Where:\*\*\s*([^\n·]*)/)?.[1] ?? '';
        expect(firstClockHour(where)).toBe(hour);
      }
    }
  });
});

maybe('the pack records provenance and the showable date', () => {
  const readPack = () =>
    JSON.parse(
      fs.readFileSync(
        fs.existsSync(`${BUILD}/pack.json`) ? `${BUILD}/pack.json` : `${ASSETS}/pack.json`,
        'utf8',
      ),
    );

  test('id/source/year and the non-affiliation disclaimer', () => {
    const pack = readPack();
    expect(pack.id).toMatch(/^brc-camps-/);
    expect(pack.source).toBe('api');
    expect(typeof pack.year).toBe('number');
    expect(pack.description).toMatch(/not affiliated/i);
  });

  test('the Aug 23 showable date is stated in the pack and its headers', () => {
    expect(readPack().description).toMatch(/Aug 23/);
    for (const d of docs()) {
      expect(d).toMatch(/Aug 23/);
    }
  });
});

maybe('the --metro wrappers match their markdown byte for byte', () => {
  test('every .md has a {file, markdown} .md.json and the markdown matches', () => {
    if (!fs.existsSync(`${BUILD}/pack.json`)) {
      return; // assets carry ONLY wrappers; this cross-check needs a build/ pair
    }
    for (const f of fs.readdirSync(BUILD).filter((x: string) => x.endsWith('.md'))) {
      const wrapper = `${BUILD}/${f}.json`;
      if (!fs.existsSync(wrapper)) {
        continue; // built without --metro: wrappers optional
      }
      const obj = JSON.parse(fs.readFileSync(wrapper, 'utf8'));
      expect(obj.file).toBe(f);
      expect(obj.markdown).toBe(fs.readFileSync(`${BUILD}/${f}`, 'utf8'));
    }
  });
});
