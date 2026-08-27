/**
 * ONE BEHAVIOUR, ONE IMPLEMENTATION — the function-level sibling of
 * noDuplicatedConstants.
 *
 * Seventeen functions were defined in more than one file here. Only a handful
 * had identical bodies; the rest merely shared a NAME. That ratio is the whole
 * lesson: a dedupe pass driven by names would have merged twelve pairs that do
 * different things, including two UTF-8 encoders and a hideItem/listHidden
 * family where one side is a thin delegate over the other.
 *
 * SO BODIES ARE COMPARED IN FULL, NEVER BY NAME AND NEVER TRUNCATED. The
 * constant-level sweep that preceded this one reported five base64 alphabets
 * as identical because it compared a 60-character preview of a 64-character
 * string, and the two bytes that distinguished them were the last two.
 * Merging on that evidence would have corrupted a wire format silently.
 *
 * TWO ARMS AND TWO LEDGERS:
 *   DUPLICATE — same name, same body. Extract it. If it cannot be extracted
 *     yet, it goes in PENDING_MERGE with the reason and the blocker, so it
 *     reads as owed rather than as fine.
 *   COLLISION — same name, different body. Usually correct; always a DECISION.
 *     It goes in SIGNED_COLLISIONS so the next dedupe pass leaves it alone.
 *
 * Neither ledger is a pardon list. Both rot-check: an entry naming something
 * that is no longer duplicated fails, because a stale pardon hides the next
 * real one that takes that name.
 */
const fsq = require('fs');
const pathq = require('path');

function sourceFiles(dir: string): string[] {
  return fsq.readdirSync(dir, { withFileTypes: true }).flatMap((e: any) => {
    const full = pathq.join(dir, e.name);
    if (e.isDirectory()) {
      return e.name === 'node_modules' ? [] : sourceFiles(full);
    }
    return /\.(ts|tsx)$/.test(e.name) ? [full] : [];
  });
}

const stripComments = (t: string): string =>
  t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Top-level definitions: `function f(` and `const f = (…) =>`. */
const HEADS = [
  /^(?:export )?(?:async )?function ([a-z][A-Za-z0-9_]*)\s*[(<]/gm,
  /^(?:export )?const ([a-z][A-Za-z0-9_]*)\s*(?::[^=]+)?=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=]+)?=>/gm,
];


/**
 * End of a definition, handling BOTH body shapes — and the second one is why
 * this is a named function with its own control.
 *
 * The first version only balanced braces. A CONCISE ARROW has no braces at
 * all (`const clean = (raw) => raw.replace(...).trim();`), so the scan ran
 * straight past the end of the function and kept going until it found some
 * LATER block. Every concise arrow was therefore compared as itself PLUS
 * whatever happened to follow it in that file — which differs per file by
 * definition. The result was silent and specific: `clean`, identical in three
 * files, was reported as three DIFFERENT bodies and got signed as a legitimate
 * collision. A guard that mis-reads a duplicate as a decision is worse than no
 * guard, because someone signs it.
 */
function endOfDefinition(text: string, start: number): number {
  const arrow = text.indexOf('=>', start);
  const brace = text.indexOf('{', start);
  const conciseArrow = arrow !== -1 && (brace === -1 || arrow < brace);
  if (conciseArrow) {
    // Look at what follows `=>`: a `{` means a block body, anything else is an
    // expression that ends at the first top-level `;`.
    let k = arrow + 2;
    while (k < text.length && /\s/.test(text[k])) {
      k++;
    }
    if (text[k] !== '{') {
      let depth = 0;
      for (let i = k; i < text.length; i++) {
        const c = text[i];
        if ('([{'.includes(c)) {
          depth++;
        } else if (')]}'.includes(c)) {
          depth--;
        } else if (c === ';' && depth <= 0) {
          return i;
        }
      }
      return text.length - 1;
    }
  }
  let depth = 0;
  let started = false;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') {
      depth++;
      started = true;
    } else if (text[i] === '}') {
      depth--;
      if (started && depth === 0) {
        return i;
      }
    }
  }
  return text.length - 1;
}

type Site = { file: string; body: string };

/** Balanced-brace body, whitespace-normalised, with the NAME erased so two
 * implementations are compared on what they DO, not what they are called. */
function definitions(): Map<string, Site[]> {
  const out = new Map<string, Site[]>();
  for (const file of sourceFiles('src')) {
    const text = stripComments(fsq.readFileSync(file, 'utf8'));
    for (const head of HEADS) {
      for (const m of text.matchAll(head)) {
        const j = endOfDefinition(text, m.index as number);
        const body = text
          .slice(m.index as number, j + 1)
          .split(/\s+/)
          .join(' ')
          .replace(/^(?:export )?(?:async )?function \w+/, 'F')
          .replace(/^(?:export )?const \w+ = /, 'F');
        const list = out.get(m[1]) ?? [];
        list.push({ file, body });
        out.set(m[1], list);
      }
    }
  }
  return out;
}

/** Identical bodies that are NOT yet extracted, each with its blocker. */
const PENDING_MERGE: Record<string, string> = {
  // announce WAS here — WalkiePanel took util/a11y once the native fence
  // settled (2026-08-26); the rot check removed the entry with the merge.
  getEmitter:
    'crews/walkie.ts is inside the same fence; radio.ts and walkie.ts share this verbatim',
};

/** Different bodies sharing a name — deliberate, and not to be merged. */
const SIGNED_COLLISIONS: Record<string, string> = {
  aliases: 'history lookup vs identity resolution build different alias sets',
  clampName: 'pod invite clamps by code point for QR budget; podMembers clamps for display',
  hideItem: 'db.ts is the app-connection entry; hiddenItems.ts is the conn-taking implementation',
  listHidden: 'same delegate/implementation split',
  listHiddenPeople: 'same delegate/implementation split',
  unhideItem: 'same delegate/implementation split',
  setFactNodeExcluded: 'same delegate/implementation split',
  isReason: 'Wi-Fi Aware and the camp hotspot validate against different reason unions',
  parseAttrs: 'graph attrs vs person-card attrs have different shapes',
  // utf8Encode WAS here. It is gone because friendLink and callSignal now
  // share src/util/utf8.ts — the merge this ledger flagged as possible, done
  // in 4f0 with its own differential. The rot check is what removed the entry:
  // it failed the moment the name stopped being duplicated.
  utf8Bytes: 'hmac feeds a signature; meshSync feeds a frame — merging changes signed bytes across versions',
};

describe('a function is implemented once, or the reuse is signed', () => {
  test('the sweep works — POSITIVE AND NEGATIVE CONTROLS', () => {
    const defs = definitions();
    expect(defs.size).toBeGreaterThan(100);
    // It must read a body that spans lines, or it sees almost nothing here.
    expect(definitions().get('announce')?.[0].body).toContain('{');
    // AND it must stop at the end of a CONCISE ARROW rather than running on
    // into the next block — the bug that made three identical `clean`
    // functions look like three different ones.
    const concise = 'const f = (x: string): string => x.trim();\nexport const g = () => {\n  return 1;\n};';
    expect(endOfDefinition(concise, 0)).toBe(concise.indexOf(';'));
    // ...and a block-bodied arrow must still end at its closing brace.
    const block = 'const h = (x: number) => {\n  return x;\n};\nconst after = 1;';
    expect(endOfDefinition(block, 0)).toBe(block.indexOf('}'));
    // Both ledgers must still describe reality — a stale entry hides the next
    // real duplicate that takes that name.
    for (const name of [...Object.keys(PENDING_MERGE), ...Object.keys(SIGNED_COLLISIONS)]) {
      const files = new Set((defs.get(name) ?? []).map(s => s.file));
      expect(`${name}:${files.size > 1}`).toBe(`${name}:true`);
    }
  });

  test('no UNRECORDED duplicate — same name, same body, two files', () => {
    const found: string[] = [];
    for (const [name, sites] of definitions()) {
      const files = new Set(sites.map(s => s.file));
      const bodies = new Set(sites.map(s => s.body));
      if (files.size > 1 && bodies.size === 1 && !(name in PENDING_MERGE)) {
        found.push(`${name}: identical in ${[...files].join(', ')}`);
      }
    }
    expect(
      found.length === 0
        ? []
        : [
            'One behaviour, two implementations that are byte-identical. Extract',
            'it to a module both can import, or record it in PENDING_MERGE with',
            'the reason it cannot be extracted yet.',
            ...found,
          ],
    ).toEqual([]);
  });

  test('no UNSIGNED collision — same name, different bodies', () => {
    const found: string[] = [];
    for (const [name, sites] of definitions()) {
      const files = new Set(sites.map(s => s.file));
      const bodies = new Set(sites.map(s => s.body));
      if (
        files.size > 1 &&
        bodies.size > 1 &&
        !(name in SIGNED_COLLISIONS) &&
        !(name in PENDING_MERGE)
      ) {
        found.push(`${name}: differing in ${[...files].join(', ')}`);
      }
    }
    expect(
      found.length === 0
        ? []
        : [
            'Same name, DIFFERENT behaviour. This is what a name-driven dedupe',
            'merges by mistake. Rename them apart, or record the reason in',
            'SIGNED_COLLISIONS so the next pass leaves them alone.',
            ...found,
          ],
    ).toEqual([]);
  });
});

export {};
