#!/usr/bin/env node
/*
 * uinode.js — read one uiautomator dump and answer questions about it.
 *
 * WHY THIS EXISTS AND NOT A COORDINATE TABLE. Every hardcoded tap in this
 * project's bench notes ("Pods tab 366,2279 on P7 / 325,2036 on P9") is a
 * fact about ONE phone at ONE font size in ONE app state. The P7 and the
 * P9 disagree, the text-size dial moves everything, and the walkie stage
 * grows a peer row and pushes HOLD TO TALK down the screen. A suite built
 * on those numbers reports FAIL when the only thing that changed is the
 * layout — which is worse than no suite, because it trains the reader to
 * disbelieve red.
 *
 * So the bench never types a coordinate. It names the thing it wants by
 * the accessibility label the app already ships for screen-reader users
 * ("Hold to talk", "Walkie — live talk with this pod") and this script
 * turns that name into the centre of whatever rectangle currently carries
 * it. When the label is missing the answer is an honest failure, not a tap
 * into empty space.
 *
 * It also reads STATE, which is the half that makes assertions possible:
 * the walkie Switch carries checked="true|false", so "the walkie is on" is
 * a fact the dump can settle rather than something the bench infers from
 * having tapped.
 *
 * USAGE
 *   node uinode.js center  <dump.xml> <desc-substring>   -> "x y"
 *   node uinode.js attr    <dump.xml> <desc-substring> <attr> -> value
 *   node uinode.js exists  <dump.xml> <desc-substring>   -> exit 0/1
 *   node uinode.js texts   <dump.xml>                    -> all text= values
 *   node uinode.js list    <dump.xml>                    -> tsv debug dump
 *
 * Matching is case-insensitive substring against content-desc FIRST and
 * text SECOND. content-desc wins because the app's descs are written for
 * humans and stay stable while visible text picks up counts and badges
 * ("Pods" vs "Pods, 15 messages waiting").
 */

'use strict';

const fs = require('fs');

const NODE_RE = /<node\b[^>]*>/g;
const BOUNDS_RE = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/;

/** XML entity unescape, enough for the five uiautomator emits. */
function unesc(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attrOf(tag, name) {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
  return m ? unesc(m[1]) : '';
}

function parse(file) {
  let xml;
  try {
    xml = fs.readFileSync(file, 'utf8');
  } catch (e) {
    process.stderr.write(`uinode: cannot read ${file}: ${e.message}\n`);
    process.exit(2);
  }
  const out = [];
  let m;
  NODE_RE.lastIndex = 0;
  while ((m = NODE_RE.exec(xml)) !== null) {
    const tag = m[0];
    const b = tag.match(BOUNDS_RE);
    if (!b) continue;
    const x1 = +b[1];
    const y1 = +b[2];
    const x2 = +b[3];
    const y2 = +b[4];
    out.push({
      tag,
      desc: attrOf(tag, 'content-desc'),
      text: attrOf(tag, 'text'),
      cls: attrOf(tag, 'class'),
      x1, y1, x2, y2,
      cx: Math.round((x1 + x2) / 2),
      cy: Math.round((y1 + y2) / 2),
      area: Math.max(0, x2 - x1) * Math.max(0, y2 - y1),
    });
  }
  return out;
}

/**
 * Find the node a human would have tapped.
 *
 * Two rules, both learned from real dumps in this app:
 *  1. content-desc before text — a badge count mutates the text of the very
 *     row we are trying to address ("Pods" becomes "Pods, 15 messages
 *     waiting" only in the desc, and the desc is the stable half).
 *  2. SMALLEST matching rectangle wins. The dump nests a clickable
 *     ViewGroup around a TextView carrying the same words; both match, and
 *     the inner one is the control. Taking the largest would sometimes land
 *     on a full-width container whose centre is somewhere else entirely.
 */
function find(nodes, needle) {
  const n = needle.toLowerCase();
  const byDesc = nodes.filter((k) => k.desc && k.desc.toLowerCase().includes(n));
  const pool = byDesc.length
    ? byDesc
    : nodes.filter((k) => k.text && k.text.toLowerCase().includes(n));
  if (!pool.length) return null;
  pool.sort((a, b) => a.area - b.area);
  return pool[0];
}

const [, , cmd, file, ...rest] = process.argv;

if (!cmd || !file) {
  process.stderr.write('usage: uinode.js <center|attr|exists|texts|list> <dump.xml> [args]\n');
  process.exit(2);
}

const nodes = parse(file);

switch (cmd) {
  case 'center': {
    const hit = find(nodes, rest[0] || '');
    if (!hit) {
      process.stderr.write(`uinode: no node matching ${JSON.stringify(rest[0])}\n`);
      process.exit(1);
    }
    process.stdout.write(`${hit.cx} ${hit.cy}\n`);
    break;
  }
  case 'attr': {
    const hit = find(nodes, rest[0] || '');
    if (!hit) {
      process.stderr.write(`uinode: no node matching ${JSON.stringify(rest[0])}\n`);
      process.exit(1);
    }
    process.stdout.write(`${attrOf(hit.tag, rest[1] || 'checked')}\n`);
    break;
  }
  case 'exists': {
    process.exit(find(nodes, rest[0] || '') ? 0 : 1);
  }
  case 'texts': {
    for (const k of nodes) if (k.text) process.stdout.write(`${k.text}\n`);
    break;
  }
  case 'list': {
    for (const k of nodes) {
      if (!k.text && !k.desc) continue;
      const cls = k.cls.split('.').pop();
      process.stdout.write(
        `${k.cx},${k.cy}\t${cls}\tchecked=${attrOf(k.tag, 'checked') || '-'}\ttext=${JSON.stringify(k.text)}\tdesc=${JSON.stringify(k.desc)}\n`,
      );
    }
    break;
  }
  default:
    process.stderr.write(`uinode: unknown command ${cmd}\n`);
    process.exit(2);
}
