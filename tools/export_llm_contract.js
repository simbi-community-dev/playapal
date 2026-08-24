#!/usr/bin/env node
/**
 * Export the app's LLM contract — the DEFAULT persona's exact system prompt
 * and the exact tool schemas the phone offers — as plain files, so datagen,
 * the trainer, and the eval can import ONE source instead of each carrying
 * their own copy (HARNESS-SEAM-MAP.md S1/S2: four prompt generations and a
 * training set that never saw two of the four tools).
 *
 *   node tools/export_llm_contract.js <out-dir>
 *     -> <out-dir>/angel-system-app.txt   (system prompt, exact bytes)
 *     -> <out-dir>/angel-tools-app.json   (ALL_TOOLS, OpenAI function shape)
 *     -> <out-dir>/angel-contract.json    ({sha256 of each, exported_from sha})
 *
 * The trainer rewrites every row's system turn to the .txt and every row's
 * `tools` to the .json before rendering, and prints the sha256 it used; the
 * eval asserts the same sha; a drift is a loud mismatch, not a silent one.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// TypeScript in, via Node's built-in type stripping (Node >= 22.6 with
// --experimental-strip-types; unflagged in Node 23+). personas.ts and
// tools.ts use only erasable syntax and import nothing native.
const personasMod = require('../src/llm/personas.ts');
const toolsMod = require('../src/llm/tools.ts');
const { getPersona, DEFAULT_PERSONA_ID } = personasMod;
const { ALL_TOOLS } = toolsMod;

const out = process.argv[2];
if (!out) {
  console.error('usage: node tools/export_llm_contract.js <out-dir>');
  process.exit(1);
}
fs.mkdirSync(out, { recursive: true });
const prompt = getPersona(DEFAULT_PERSONA_ID).systemPrompt;
const tools = JSON.stringify(ALL_TOOLS, null, 1) + '\n';
fs.writeFileSync(path.join(out, 'angel-system-app.txt'), prompt);
fs.writeFileSync(path.join(out, 'angel-tools-app.json'), tools);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
let head = 'unknown';
try { head = require('child_process').execSync('git rev-parse --short HEAD').toString().trim(); } catch (e) {}
fs.writeFileSync(path.join(out, 'angel-contract.json'), JSON.stringify({
  exported_from: head,
  system_prompt_sha256: sha(prompt), system_prompt_chars: prompt.length,
  tools_sha256: sha(tools), tools: ALL_TOOLS.map(t => t.function.name),
}, null, 1) + '\n');
console.log(`wrote ${out}: prompt ${prompt.length} chars sha ${sha(prompt).slice(0, 12)}, tools ${ALL_TOOLS.map(t => t.function.name).join(',')} sha ${sha(tools).slice(0, 12)} @ ${head}`);
