#!/usr/bin/env node
/**
 * Build assets/packs/survival-guide/guide.md.json from the Playa Angel
 * corpus (a directory of topical .md files).
 *
 * The bundled pack ships as a { file, markdown } wrapper because Metro only
 * bundles JSON (see src/packs/builtins.ts); at install time the app chunks
 * the markdown through src/packs/chunker.ts (~500-token chunks with heading
 * breadcrumbs) — this script only concatenates and wraps, so the bundled
 * pack goes through EXACTLY the same install/chunking path as an imported
 * one. SOURCES.md is excluded: it is provenance (URLs), not guide content,
 * and would pollute retrieval.
 *
 * Usage: node tools/build_survival_pack.js <corpus-dir>
 *
 * The script fails loudly if the corpus is missing load-bearing facts or
 * still contains known placeholder-era falsehoods, so a bad regeneration
 * can't ship silently. survivalPack.test.ts re-asserts the same invariants
 * against the committed pack on every test run.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REQUIRED_FACTS = [
  ['water ration', /1\.5 gal/],
  ['BMIR frequency', /94\.5/],
  ['coffee discontinuation', /stopped selling coffee/],
  // v4: the Burn.Life technique layer can't silently drop out of a rebuild.
  ['lag-screw anchoring technique', /3\/8" hex-head lag screws/],
  ['Burn.Life credit lines', /Credit: \[Burn\.Life/],
  // v5 (2026-08-17 accuracy audit): the main medical station is 5:15 &
  // Esplanade (ESD + Rampart co-located) — a safety fact three official
  // pages agree on; and the three real questions the battery found the
  // corpus silent on: photo consent, dogs, playa foot.
  ['main medical station at 5:15 & Esplanade', /main station at 5:15 & Esplanade/],
  ['ask-before-photographing rule', /ASK PERMISSION before photographing/],
  ['no dogs rule', /Dogs and other animals .* are NOT permitted/],
  ['playa foot remedy', /4:1 water-to-vinegar/],
  // v6: the two questions the owner asked his phone and got inventions for.
  ['what the Temple is', /space for honoring, celebrating, grieving/],
  ['how it started (1986 Baker Beach)', /1986: Larry Harvey/],
  // v8: the exodus false-premise trap ("the Gate closes Saturday — do I have
  // to leave?") was every model's worst cell under every instrument; the
  // pieces lived in three sections and no single passage carried the answer.
  ['gate never closes for departures', /never "closes" for departures/],
];

// Placeholder-era text that CONTRADICTS the corpus — must never reappear.
const FORBIDDEN = [
  ['placeholder banner', /Invented placeholder/i],
  ['coffee-for-sale falsehood', /except ice and coffee at Center Camp/i],
  ['arctica proceeds guess', /Proceeds go to local Nevada community groups/i],
  // The pre-v5 medical error: 6:30 & Esplanade is Ranger HQ, not medical.
  ['medical-at-6:30 error', /main station on the Esplanade near 6:30/],
];

function main() {
  const corpusDir = process.argv[2];
  if (!corpusDir) {
    console.error('usage: node tools/build_survival_pack.js <corpus-dir>');
    process.exit(1);
  }
  const files = fs
    .readdirSync(corpusDir)
    .filter(f => f.endsWith('.md') && f !== 'SOURCES.md')
    .sort();
  if (files.length === 0) {
    console.error(`no .md files in ${corpusDir}`);
    process.exit(1);
  }
  const markdown = files
    .map(f => fs.readFileSync(path.join(corpusDir, f), 'utf8').trim())
    .join('\n\n');

  for (const [label, re] of REQUIRED_FACTS) {
    if (!re.test(markdown)) {
      console.error(`FAIL: corpus is missing the ${label} (${re})`);
      process.exit(1);
    }
  }
  for (const [label, re] of FORBIDDEN) {
    if (re.test(markdown)) {
      console.error(`FAIL: corpus contains the ${label} (${re})`);
      process.exit(1);
    }
  }

  const outPath = path.join(
    __dirname,
    '..',
    'assets',
    'packs',
    'survival-guide',
    'guide.md.json',
  );
  fs.writeFileSync(
    outPath,
    JSON.stringify({ file: 'guide.md', markdown }, null, 1) + '\n',
  );
  console.log(
    `wrote ${outPath}: ${files.length} corpus files, ${markdown.length} chars`,
  );
  console.log(
    'reminder: bump "version" in pack.json when content changes, or installed devices keep the old pack',
  );
}

main();
