/**
 * ONE FACT, ONE STATEMENT. A constant defined in two files is a promise that
 * two people will remember to change both.
 *
 * This suite exists because that promise had already been broken six times
 * here: VECTOR_DIM, MAX_FRAGMENT_CHARS, NAME_MAX, KINDS, PIN_SLACK_PT and a
 * base64 alphabet, several of them with a comment at the copy site saying
 * "same as the other one" — which is the drift already written down and
 * shipped anyway.
 *
 * TWO ARMS, AND THE SECOND ONE IS THE DANGEROUS SHAPE.
 *
 *   DUPLICATE  — same name, same value, two files. Delete one, import it.
 *
 *   COLLISION  — same name, DIFFERENT values. This is worse than a duplicate,
 *   because it looks exactly like one. This tree had FIVE `B64` constants in
 *   four directories, and they were TWO different alphabets: url-safe for
 *   links and QR fragments, standard for wire payloads, each correct for its
 *   own job. A sweep reported them identical because it compared a truncated
 *   60-character preview of a 64-character string — and the two bytes that
 *   distinguish the alphabets are the last two. "Killing the duplicate" on
 *   that evidence would have silently corrupted every friend card and beam
 *   link, or every radio payload, with nothing thrown and no test named after
 *   the thing that broke.
 *
 * SO THIS SUITE COMPARES VALUES IN FULL, NEVER TRUNCATED, and it reads values
 * that span lines — the first version of the sweep used a newline-excluding
 * pattern and silently skipped every multi-line constant in the tree, which
 * is how MONTHS and REASONS stayed invisible through a pass that reported
 * itself complete.
 *
 * A collision is not always a bug. It is always a DECISION, and it belongs in
 * SIGNED_COLLISIONS with the reason, so the next person to run a dedupe knows
 * the values differ on purpose before they merge them.
 */
const fsd = require('fs');
const pathd = require('path');

function sourceFiles(dir: string): string[] {
  return fsd.readdirSync(dir, { withFileTypes: true }).flatMap((e: any) => {
    const full = pathd.join(dir, e.name);
    if (e.isDirectory()) {
      return e.name === 'node_modules' ? [] : sourceFiles(full);
    }
    return /\.(ts|tsx)$/.test(e.name) ? [full] : [];
  });
}

/** Comments stripped: prose quoting a constant is not a definition of it. */
function codeOf(file: string): string {
  return fsd
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** SCREAMING_CASE module-level consts. The value may span lines — that is not
 * an edge case, it is most array constants in this tree. */
const CONST_RE = /^(?:export )?const ([A-Z][A-Z0-9_]{2,})\s*(?::[^=]+)?=\s*([^;]+);/gm;

type Site = { file: string; value: string };

function definitions(): Map<string, Site[]> {
  const out = new Map<string, Site[]>();
  for (const file of [...sourceFiles('src'), 'App.tsx']) {
    for (const m of codeOf(file).matchAll(CONST_RE)) {
      const value = m[2].split(/\s+/).join(' ').trim(); // normalise whitespace, keep EVERY byte
      const list = out.get(m[1]) ?? [];
      list.push({ file, value });
      out.set(m[1], list);
    }
  }
  return out;
}

/**
 * Names deliberately reused for DIFFERENT facts. Each entry is a decision with
 * its reason; adding one should take an argument, removing one is a
 * celebration. These are the collisions a dedupe pass must NOT merge.
 */
const SIGNED_COLLISIONS: Record<string, string> = {
  KEY: 'per-module storage key: waypoints vs crews — different rows, generic name',
  TICK_MS: 'per-timer cadence: the call runtime ticks in ms, the share watcher in seconds',
  MONTHS: 'long month names for narration vs three-letter labels for a compact header',
  REASONS: 'per-capability reason unions: Wi-Fi Aware and the camp hotspot fail differently',
};

describe('a constant is stated once, or the reuse is signed', () => {
  test('the sweep works — POSITIVE AND NEGATIVE CONTROLS', () => {
    const defs = definitions();
    // A sweep that parses nothing passes every arm below.
    expect(defs.size).toBeGreaterThan(50);
    // It must read a MULTI-LINE value, which the first version could not.
    expect(CONST_RE.source).not.toContain('\\n');
    // Three characters minimum, matching the name pattern — a two-letter
    // SCREAMING constant would slip the floor, and the tree has none.
    const multi = 'const XYZ = [\n  1,\n  2,\n];';
    expect([...multi.matchAll(new RegExp(CONST_RE.source, 'gm'))].length).toBe(1);
    // It must NOT be fooled by a comment quoting a definition.
    const commented = "// const FAKE_CONST = 'x';\n";
    expect(
      [...commented.replace(/(^|[^:])\/\/.*$/gm, '$1').matchAll(new RegExp(CONST_RE.source, 'gm'))]
        .length,
    ).toBe(0);
    // Every signed collision must still BE a collision, or the pardon is rot
    // that hides the next real one taking that name.
    for (const name of Object.keys(SIGNED_COLLISIONS)) {
      const sites = defs.get(name) ?? [];
      expect(new Set(sites.map(s => s.file)).size).toBeGreaterThan(1);
    }
  });

  test('no constant is DUPLICATED — same name, same value, two files', () => {
    const found: string[] = [];
    for (const [name, sites] of definitions()) {
      const files = new Set(sites.map(s => s.file));
      const values = new Set(sites.map(s => s.value));
      if (files.size > 1 && values.size === 1) {
        found.push(`${name} = ${[...values][0]}  in ${[...files].join(', ')}`);
      }
    }
    expect(
      found.length === 0
        ? []
        : [
            'One fact, two statements. Export it from the module that OWNS the',
            'fact and import it everywhere else — a comment saying "same as the',
            'other one" is the drift already written down.',
            ...found,
          ],
    ).toEqual([]);
  });

  test('no UNSIGNED collision — same name, different values, two files', () => {
    const found: string[] = [];
    for (const [name, sites] of definitions()) {
      const files = new Set(sites.map(s => s.file));
      const values = new Set(sites.map(s => s.value));
      if (files.size > 1 && values.size > 1 && !(name in SIGNED_COLLISIONS)) {
        found.push(`${name}: ${sites.map(s => `${s.file} = ${s.value}`).join('  |  ')}`);
      }
    }
    expect(
      found.length === 0
        ? []
        : [
            'Same name, DIFFERENT values. This is the shape that gets merged by',
            'mistake — it looks like a duplicate until someone compares the',
            'values in full. Rename them apart, or record the reason in',
            'SIGNED_COLLISIONS so the next dedupe pass leaves them alone.',
            ...found,
          ],
    ).toEqual([]);
  });
});

export {};
