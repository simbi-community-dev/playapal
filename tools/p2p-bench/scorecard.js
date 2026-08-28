#!/usr/bin/env node
/*
 * scorecard.js — turn one run's rows into a JSON record and a readable table.
 *
 * The JSON is the durable artifact: it carries every scenario, its tier, the
 * verdict, the counterfactual it was checked against, and the evidence lines
 * that produced the verdict. patch-matrix.js reads it, and so can any later
 * comparison between two nights.
 *
 * Device SERIALS never appear. Marketing model names do. The owner's phones
 * are personal hardware and this repo is headed for a public tree.
 */

'use strict';

const fs = require('fs');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--print') { a.print = argv[++i]; continue; }
    if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[++i];
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));

/* ---------------------------------------------------------------- print -- */
if (args.print) {
  const doc = JSON.parse(fs.readFileSync(args.print, 'utf8'));
  const mark = {
    PASS: '\x1b[32mPASS\x1b[0m',
    FAIL: '\x1b[31mFAIL\x1b[0m',
    SKIP: '\x1b[90mSKIP\x1b[0m',
    MANUAL: '\x1b[90mMANUAL\x1b[0m',
    ERROR: '\x1b[31mERROR\x1b[0m',
  };
  const w = Math.max(...doc.scenarios.map((s) => s.id.length), 8);
  let tier = null;
  for (const s of doc.scenarios) {
    if (s.tier !== tier) {
      tier = s.tier;
      process.stdout.write(`\n  TIER-${tier}\n`);
    }
    process.stdout.write(
      `    ${s.id.padEnd(w)}  ${(mark[s.verdict] || s.verdict).padEnd(14)}  ${s.title}\n`,
    );
  }
  const t = doc.totals;
  process.stdout.write(
    `\n  ${t.pass} pass · ${t.fail} fail · ${t.skip} skipped · ${t.manual} manual` +
    `   (${t.automated_share}% of the catalog is machine-decidable with the devices cabled tonight)\n`,
  );
  process.exit(0);
}

/* ------------------------------------------------------------------ build -- */
const rowsText = fs.readFileSync(args.rows, 'utf8');
const scenarios = [];
let cur = null;

for (const line of rowsText.split('\n')) {
  if (!line) continue;
  if (line.startsWith('\tEVIDENCE\t')) {
    if (cur) cur.evidence.push(line.split('\t')[2] || '');
    continue;
  }
  const [id, tier, requires, verdict, title, counterfactual] = line.split('\t');
  cur = { id, tier, requires, verdict, title, counterfactual, evidence: [] };
  scenarios.push(cur);
}

const count = (v) => scenarios.filter((s) => s.verdict === v).length;
const decidable = scenarios.filter((s) => s.verdict === 'PASS' || s.verdict === 'FAIL').length;

const doc = {
  stamp: args.stamp,
  tree: args.tree,
  devices: {
    // Models, never serials.
    a1: args.a1,
    a2: args.a2,
    iphone: args.iphone,
  },
  totals: {
    total: scenarios.length,
    pass: count('PASS'),
    fail: count('FAIL'),
    skip: count('SKIP'),
    manual: count('MANUAL'),
    error: count('ERROR'),
    decidable,
    automated_share: Math.round((decidable / scenarios.length) * 100),
  },
  scenarios,
};

fs.writeFileSync(args.out, `${JSON.stringify(doc, null, 2)}\n`);
