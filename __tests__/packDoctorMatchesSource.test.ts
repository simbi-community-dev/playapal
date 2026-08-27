/**
 * THE PACK DOCTOR IS A PARITY PORT, AND A PARITY PORT IS A PILE OF HARDCODES.
 *
 * tools/check_pack.py says so in its own docstring — "PARITY PORT of
 * src/packs/chunker.ts" — and it restates ten values the app defines
 * elsewhere: the embedder's vector dimension and model id, the chunk budgets,
 * the pack-id/date/time/graph regexes, and the camp-board bundle kind. Python
 * cannot import TypeScript, so those copies cannot be deleted. What they can
 * be is JOINED: this suite fails the moment the two sides disagree.
 *
 * This is not hypothetical. The doctor already drifted twice in one night —
 * once carrying a stale copy of what src/packs/builtins.ts bundles (it
 * reported the repo's own pack as carrying an unbundled file, citing as its
 * authority the file that bundles it), and once binding one regex name twice
 * at module scope so its credit check ran the wrong pattern everywhere and
 * crashed on the repo's own bundled pack. Both were invisible because nothing
 * compared the doctor to the thing it validates.
 *
 * WHY THE REGEX ARM NORMALISES. The two sides spell the same pattern
 * differently — JavaScript writes `\d`, the Python copies write `[0-9]` —
 * so a raw string compare would cry wolf on ten correct lines. A guard that
 * cries wolf gets switched off, so the difference in DIALECT is normalised
 * away and the difference in MEANING is what fails.
 *
 * See also packDoctorMatchesBuiltins (the bundled file sets) and
 * noDuplicatedConstants (the same class inside TypeScript, where the fix is
 * deletion rather than a guard).
 */
const fss = require('fs');

const DOCTOR = 'tools/check_pack.py';

/** A python module-level constant, as a raw source string. */
function py(name: string): string | null {
  const m = new RegExp(`^${name}\\s*=\\s*(.+)$`, 'm').exec(fss.readFileSync(DOCTOR, 'utf8'));
  return m ? m[1].trim() : null;
}

/** A TypeScript module-level constant, as a raw source string. */
function ts(file: string, name: string): string | null {
  const m = new RegExp(`(?:export )?const ${name}\\s*(?::[^=]+)?=\\s*([^;]+);`).exec(
    fss.readFileSync(file, 'utf8'),
  );
  return m ? m[1].trim() : null;
}

/** Strip the dialect, keep the meaning. */
const normRe = (s: string): string =>
  s
    .replace(/^re\.compile\(\s*r?["'](.*)["']\s*\)$/s, '$1') // python wrapper
    .replace(/^\/(.*)\/[a-z]*$/s, '$1') // js literal
    .replace(/\\d/g, '[0-9]')
    .replace(/\s+/g, '');

const normVal = (s: string): string => s.replace(/^["'](.*)["']$/s, '$1').trim();

/** Every value the doctor restates, and where the app really defines it. */
const PAIRS: { py: string; file: string; ts: string; kind: 'value' | 'regex' }[] = [
  { py: 'VECTOR_DIM', file: 'src/docs/vectorSearch.ts', ts: 'VECTOR_DIM', kind: 'value' },
  { py: 'SEMANTIC_MODEL', file: 'src/docs/vectorSearch.ts', ts: 'EMBEDDER_MODEL_ID', kind: 'value' },
  { py: 'DEFAULT_MAX_CHARS', file: 'src/packs/chunker.ts', ts: 'DEFAULT_MAX_CHARS', kind: 'value' },
  { py: 'BUILTIN_GUIDE_MAX_CHARS', file: 'src/packs/builtins.ts', ts: 'GUIDE_CHUNK_MAX_CHARS', kind: 'value' },
  { py: 'CAMP_BUNDLE_KIND', file: 'src/camp/campBoard.ts', ts: 'CAMP_BUNDLE_KIND', kind: 'value' },
  { py: 'PACK_ID_RE', file: 'src/packs/installPack.ts', ts: 'PACK_ID_RE', kind: 'regex' },
  { py: 'DATE_RE', file: 'src/packs/installPack.ts', ts: 'DATE_RE', kind: 'regex' },
  { py: 'TIME_RE', file: 'src/packs/installPack.ts', ts: 'TIME_RE', kind: 'regex' },
  { py: 'GRAPH_ID_RE', file: 'src/packs/installPack.ts', ts: 'GRAPH_ID_RE', kind: 'regex' },
  { py: 'GRAPH_TYPE_RE', file: 'src/packs/installPack.ts', ts: 'GRAPH_TYPE_RE', kind: 'regex' },
];

describe('the pack doctor restates the app’s values without drifting from them', () => {
  test('both readers work — POSITIVE AND NEGATIVE CONTROLS', () => {
    // A reader that returns null for everything makes the arm below vacuous:
    // "no mismatches" over nothing read.
    expect(py('VECTOR_DIM')).toBe('384');
    expect(ts('src/docs/vectorSearch.ts', 'VECTOR_DIM')).toBe('384');
    // A name that does not exist must read as absent, not as empty-equals-empty.
    expect(py('NO_SUCH_CONSTANT_HERE')).toBeNull();
    expect(ts('src/packs/chunker.ts', 'NO_SUCH_CONSTANT_HERE')).toBeNull();
    // The normaliser must erase DIALECT...
    expect(normRe(String.raw`re.compile(r"^[0-9]{4}$")`)).toBe(normRe(String.raw`/^\d{4}$/`));
    // ...and must NOT erase MEANING.
    expect(normRe(String.raw`/^\d{4}$/`)).not.toBe(normRe(String.raw`/^\d{2}$/`));
  });

  test('every restated value still equals the source of truth', () => {
    const drift: string[] = [];
    for (const p of PAIRS) {
      const a = py(p.py);
      const b = ts(p.file, p.ts);
      if (a === null || b === null) {
        drift.push(`${p.py}: could not read ${a === null ? DOCTOR : p.file} — a renamed constant is drift too`);
        continue;
      }
      const [x, y] = p.kind === 'regex' ? [normRe(a), normRe(b)] : [normVal(a), normVal(b)];
      if (x !== y) {
        drift.push(`${p.py}: ${DOCTOR} has ${a}, ${p.file} has ${b}`);
      }
    }
    expect(
      drift.length === 0
        ? []
        : [
            'tools/check_pack.py restates values the app defines elsewhere, and',
            'python cannot import TypeScript — so these copies are joined by this',
            'test instead. The app is the source of truth; update the doctor.',
            ...drift,
          ],
    ).toEqual([]);
  });
});

export {};
