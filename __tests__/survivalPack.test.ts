/**
 * Content assertions for the BUNDLED survival-guide pack. The pack must be
 * the real Playa Angel corpus (built by tools/build_survival_pack.js), never
 * the scaffold-era placeholder — the placeholder actively contradicted the
 * corpus (it claimed coffee IS sold at Center Camp), and EVAL-v11-TOOLS made
 * the swap a prerequisite for any of its results reaching the phone.
 */

import { chunkDocument, DEFAULT_MAX_CHARS } from '../src/packs/chunker';
import { GUIDE_CHUNK_MAX_CHARS } from '../src/packs/builtins';

const guide = require('../assets/packs/survival-guide/guide.md.json') as {
  file: string;
  markdown: string;
};
const manifest = require('../assets/packs/survival-guide/pack.json') as {
  id: string;
  version: number;
};

describe('bundled survival-guide pack content', () => {
  test('is the real corpus: load-bearing facts are present verbatim', () => {
    expect(guide.markdown).toContain('1.5 gallons of water per person per day');
    expect(guide.markdown).toContain('94.5'); // BMIR frequency
    expect(guide.markdown).toContain('stopped selling coffee'); // Center Camp, post-2022
    expect(guide.markdown).toContain('451.9000'); // BRC 911 radio
    expect(guide.markdown).toContain('moonless'); // burn-night moon conditions
    // v5 (2026-08-17 accuracy audit): the safety fact the corpus had WRONG,
    // and the three real questions it was silent on.
    expect(guide.markdown).toContain('main station at 5:15 & Esplanade');
    expect(guide.markdown).toContain('ASK PERMISSION before photographing');
    expect(guide.markdown).toMatch(/Dogs and other animals .* are NOT permitted/);
    expect(guide.markdown).toContain('4:1 water-to-vinegar');
    // v6: the owner's own phone questions ("What is the temple", "history of
    // burning Man") were answered from weights, wrongly, because the corpus
    // had no Temple or history section at all.
    expect(guide.markdown).toContain('space for honoring, celebrating, grieving');
    expect(guide.markdown).toContain('1986: Larry Harvey');
    expect(guide.markdown).toMatch(/first Temple was built in 2000/);
    // v8: the exodus false-premise answer lives in ONE passage.
    expect(guide.markdown).toMatch(/never "closes" for departures/);
  });

  test('the pre-v5 medical error is gone: 6:30 & Esplanade is Ranger HQ, not medical', () => {
    // Three official 2026 Survival Guide pages (On-Playa Resources, Health,
    // Consent) put ESD + Rampart at 5:15 & Esplanade; the one page that
    // said "near 6:30" was reciting Ranger HQ's address. A burner at 9:00
    // sent to 6:30 for an emergency is the wrong-fact-kills-trust case.
    expect(guide.markdown).not.toMatch(/main station on the Esplanade near 6:30/);
    expect(guide.markdown).not.toMatch(/Esplanade-near-6:30 facility/);
    expect(guide.markdown).toMatch(/Ranger HQ: Esplanade & 6:30/);
  });

  test('contains no placeholder-era falsehoods', () => {
    expect(guide.markdown).not.toMatch(/invented placeholder/i);
    // The placeholder claimed coffee is still sold at Center Camp.
    expect(guide.markdown).not.toMatch(/except ice and coffee at Center Camp/i);
    expect(guide.markdown).not.toMatch(/Proceeds go to local Nevada community groups/i);
  });

  test('pack version was bumped for the corpus swap (devices reinstall on mismatch)', () => {
    expect(manifest.id).toBe('survival-guide');
    // v4 = the Burn.Life veteran-technique layer (credited); v5 = the
    // medical-station correction + photo/dogs/playa-foot sections. Each
    // forces a reseed on installed phones.
    expect(manifest.version).toBeGreaterThanOrEqual(9);
  });

  test('chunks through the real importer path: budget kept, every chunk carries a heading breadcrumb', () => {
    const chunks = chunkDocument(guide.markdown);
    // Growth-only invariant: v3 (per-principle headings) was 52 chunks; v4 adds
    // the 20-chunk Burn.Life layer for 73. A rebuild that DROPS below the v3
    // count means corpus files went missing — never ship that.
    expect(chunks.length).toBeGreaterThanOrEqual(70);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(DEFAULT_MAX_CHARS);
      expect(c.heading.length).toBeGreaterThan(0);
    }
  });

  test('installed at the excerpt budget: no guide chunk is ever cut by the tool payload (v7, 2026-08-17)', () => {
    // The phone installs the built-in guide with chunkMaxChars =
    // GUIDE_CHUNK_MAX_CHARS (700 = the lookup_facts excerpt budget), so every
    // retrieved passage is whole. Before: 42 of 79 chunks were over 700 and
    // the model saw a query-chosen window of most sections. Bullet lists
    // pack whole lines (no mid-bullet cuts), and every piece keeps its
    // breadcrumb.
    const chunks = chunkDocument(guide.markdown, { maxChars: GUIDE_CHUNK_MAX_CHARS });
    expect(chunks.length).toBeGreaterThan(120);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(GUIDE_CHUNK_MAX_CHARS);
      expect(c.heading.length).toBeGreaterThan(0);
      // a bullet-list piece never starts mid-bullet
      if (/^\s*- /.test(c.content) || c.content.includes('\n- ')) {
        expect(c.content.split('\n').every(l => l.trim() === '' || /^\s*(?:- |\d+[.)] |[^-\s])/.test(l))).toBe(true);
      }
    }
    // The Temple's burn sentence and its "what it is" sentence are each in a
    // whole passage of their own section (the case that fell out of the
    // 700-char window on the phone).
    const temple = chunks.filter(c => /The Temple \[/.test(c.heading));
    expect(temple.length).toBeGreaterThanOrEqual(2);
    expect(temple.some(c => /burns Sunday night/.test(c.content))).toBe(true);
    expect(temple.some(c => /space for honoring/.test(c.content))).toBe(true);
  });

  test('key facts land in retrievable chunks under the right headings', () => {
    const chunks = chunkDocument(guide.markdown);
    const water = chunks.find(c => /water and hydration/i.test(c.heading));
    expect(water).toBeDefined();
    expect(water!.content).toContain('1.5 gallons');

    const coffee = chunks.find(c => /center camp coffee/i.test(c.heading));
    expect(coffee).toBeDefined();
    expect(coffee!.content).toContain('stopped selling coffee');

    // The 10 Principles are per-principle chunks under "## Principle N: Name"
    // headings (v1.6 freeze quad — EVAL-v16: the headings corpus is the
    // primary fix for the principle-2 item; the old single tail chunk lost
    // ordinal questions to BM25 junk).
    const gifting = chunks.find(c => /principle 2: gifting/i.test(c.heading));
    expect(gifting).toBeDefined();
    expect(gifting!.content).toContain('devoted to acts of gift giving');
    expect(gifting!.heading).toMatch(/10 principles/i);
    const lnt = chunks.find(c => /principle 8: leaving no trace/i.test(c.heading));
    expect(lnt).toBeDefined();

    // Task-27 corpus gap: the Greeters role is answerable (r8/r10 addition).
    const greeters = chunks.find(c => /greeters/i.test(c.heading));
    expect(greeters).toBeDefined();
    expect(greeters!.content).toMatch(/welcome home/i);
    expect(greeters!.content).toContain('WhatWhereWhen');

    // v5 additions land under their own headings (retrievable by topic).
    const cameras = chunks.find(c => /cameras, photography, photos, and consent/i.test(c.heading));
    expect(cameras).toBeDefined();
    expect(cameras!.content).toContain('ASK PERMISSION');
    const dogs = chunks.find(c => /dogs and other animals/i.test(c.heading));
    expect(dogs).toBeDefined();
    expect(dogs!.content).toMatch(/NOT permitted/);
    const medical = chunks.find(c => /medical stations/i.test(c.heading));
    expect(medical).toBeDefined();
    expect(medical!.content).toContain('5:15 & Esplanade');
    expect(medical!.content).toContain('Playa foot');
  });
});

/**
 * v4: the Burn.Life veteran-technique layer (homelab docs/31). Licensing model:
 * the site has NO license (all rights reserved by default), so the layer is
 * summarize-in-our-own-words with a per-chunk credit line + exact article URL +
 * retrieval date. These tests machine-check that contract.
 */
describe('burn.life technique layer (v4)', () => {
  const chunks = chunkDocument(guide.markdown);
  const burnlife = chunks.filter(c => c.heading.startsWith('Veteran Techniques'));

  test('the layer is present at its designed size and mirrors the build-tool gates', () => {
    // 1 preamble + 18 technique sections + 1 index-only section.
    expect(burnlife.length).toBe(20);
    // Mirrors REQUIRED_FACTS in tools/build_survival_pack.js.
    expect(guide.markdown).toContain('3/8" hex-head lag screws');
    expect(guide.markdown).toContain('Credit: [Burn.Life');
  });

  test('EVERY burn.life chunk carries the credit line: source name, exact URL, retrieval date', () => {
    // The app renders chunk text, so the credit riding INSIDE each chunk is what
    // makes the attribution visible to the Angel and the user.
    const creditRe =
      /\*Credit: \[Burn\.Life(?: — [^\]]+)?\]\(https:\/\/www\.burn\.life\/[a-z0-9-]*(?:\.html)?\)[^*]*Retrieved \d{4}-\d{2}-\d{2}\.\*/;
    for (const c of burnlife) {
      expect(c.content).toMatch(creditRe);
    }
  });

  test('conflict rule holds: the official 1.5 gal/day ration is never displaced', () => {
    // Burn.Life's food page frames 1 gal/day as DRINKING water; the official
    // TOTAL ration (1.5) must remain the only ration number in the pack.
    const blText = burnlife.map(c => c.content).join('\n');
    expect(blText).toContain('1.5 gallons per person per day');
    expect(blText).not.toMatch(/\b1 gallon per (?:person per )?day\b/i);
  });

  test('lag-screw chunk carries the PAGE spec with the credit chain (ApesInSpace/FIGJAM)', () => {
    const lag = burnlife.find(c => /lag screws instead of rebar/i.test(c.heading));
    expect(lag).toBeDefined();
    expect(lag!.content).toContain('3/8" hex-head lag screws');
    expect(lag!.content).toMatch(/10", 12", 14"/); // page sizes, not the remembered 5/8"x16" variant
    expect(lag!.content).not.toMatch(/5\/8/);
    expect(lag!.content).toMatch(/ApesInSpace/);
    expect(lag!.content).toMatch(/FIGJAM/);
  });

  // Summarize-not-copy gate: no sentence of ours longer than ~15 words may
  // appear verbatim in the archived raw pages. Runs only where the raw-page
  // archive exists (dev box); the credit/format tests above run everywhere.
  const fs = require('fs');
  // Read from the environment rather than hardcoding one machine's home: the
  // hardcoded path made this suite silently skip on every checkout that was
  // not that box, which reads as "passing" in exactly the same way as running.
  const home = (globalThis as any).process?.env?.HOME || '';
  const ARCHIVE =
    (globalThis as any).process?.env?.BURN_LIFE_EVAL_DIR ||
    `${home}/corpus-archive/2026-08-14-burn-life-eval`;
  const archived = fs.existsSync(ARCHIVE);
  (archived ? test : test.skip)(
    'no >15-word sentence is copied verbatim from the raw pages',
    () => {
      const normalize = (s: string) =>
        s
          .toLowerCase()
          .replace(/<[^>]+>/g, ' ')
          .replace(/&[a-z#0-9]+;/g, ' ')
          .replace(/[^a-z0-9 ]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      const sourceNorm = fs
        .readdirSync(ARCHIVE)
        .filter((f: string) => f.endsWith('.html'))
        .map((f: string) => normalize(fs.readFileSync(`${ARCHIVE}/${f}`, 'utf8')))
        .join('\n');
      let longSentences = 0;
      for (const c of burnlife) {
        for (const sentence of c.content.split(/[.!?](?:\s|$)/)) {
          const norm = normalize(sentence);
          if (norm.split(' ').length <= 15) continue;
          longSentences += 1;
          expect(sourceNorm.includes(norm)).toBe(false);
        }
      }
      expect(longSentences).toBeGreaterThan(0); // the gate actually checked something
    },
  );
});
