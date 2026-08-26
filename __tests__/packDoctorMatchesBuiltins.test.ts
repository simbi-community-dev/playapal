/**
 * THE PACK DOCTOR CARRIES A SECOND COPY OF WHAT THE APP BUNDLES, AND IT
 * DRIFTED.
 *
 * tools/check_pack.py hardcodes BUILTIN_IDS and BUILTIN_FILES to assert that a
 * bundled pack's folder matches what src/packs/builtins.ts ships. Those are two
 * sources of truth for one fact, so they drifted: builtins.ts bundles
 * embeddings.json for survival-guide, the doctor's copy did not, and the doctor
 * reported the repo's own pack as carrying a file "not bundled by
 * src/packs/builtins.ts" — naming, as its authority, the very file that
 * bundles it.
 *
 * A validator that is wrong about the thing it validates is worse than no
 * validator, because it is believed. And this one is the contributor doorway:
 * PACK-FORMAT.md tells pack authors to run it and require PACK PASS.
 *
 * THE SIGNAL IS THE REQUIRE PATHS. builtins.ts pulls every bundled file by a
 * literal `assets/packs/<id>/<file>` path, so what it actually ships is
 * readable without executing it or parsing TypeScript.
 */
const fsb = require('fs');

const DOCTOR = 'tools/check_pack.py';
const BUILTINS = 'src/packs/builtins.ts';

/** {id: files} as the DOCTOR believes it. */
function doctorExpectation(): Record<string, string[]> {
  const src = fsb.readFileSync(DOCTOR, 'utf8');
  const block = /BUILTIN_FILES\s*=\s*\{([\s\S]*?)\n\}/.exec(src);
  if (!block) {
    return {};
  }
  const out: Record<string, string[]> = {};
  for (const m of block[1].matchAll(/"([a-z0-9-]+)":\s*\{([^}]*)\}/g)) {
    out[m[1]] = [...m[2].matchAll(/"([^"]+)"/g)].map(f => f[1]).sort();
  }
  return out;
}

/** {id: files} as the APP actually bundles it. */
function appBundles(): Record<string, string[]> {
  const src = fsb.readFileSync(BUILTINS, 'utf8');
  const out: Record<string, Set<string>> = {};
  for (const m of src.matchAll(/assets\/packs\/([a-z0-9-]+)\/([A-Za-z0-9._-]+)/g)) {
    (out[m[1]] ??= new Set()).add(m[2]);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()]));
}

/**
 * PACKS THE DOCTOR DOES NOT COVER, recorded rather than ignored. Each is a
 * DECISION with a reason, so the next reader can tell a deliberate gap from an
 * oversight — and so removing one is a celebration rather than a surprise.
 *
 * These three bundle their documents as `*.md.json` Metro wrappers, and the
 * doctor recognizes that wrapper for survival-guide ONLY (wrapper_document()
 * hardcodes the id and the filename). Listing them in BUILTIN_IDS without
 * generalizing that recognition would swap one wrong answer for another: the
 * doctor would accept the id and then fail every document as "expected a
 * top-level JSON array of event objects". Generalizing it is a real change to
 * the tool's semantics and belongs to whoever owns the pack format, not to a
 * drift guard.
 */
const KNOWN_UNCOVERED: Record<string, string> = {
  'brc-art-2026': 'Metro-wrapped *.md.json docs; wrapper_document() is survival-guide-only',
  'camps-2026': 'same wrapper shape',
  'playa-lore': 'same wrapper shape',
};

describe('the pack doctor agrees with what the app actually bundles', () => {
  test('both parsers work — POSITIVE AND NEGATIVE CONTROLS', () => {
    // A parser that returns {} makes every arm below pass over nothing.
    expect(Object.keys(doctorExpectation()).length).toBeGreaterThan(0);
    expect(Object.keys(appBundles()).length).toBeGreaterThan(3);
    // The app side must find real files, not just ids.
    expect(appBundles()['survival-guide']).toContain('embeddings.json');
    // And a pack the doctor covers must be one the app really ships.
    for (const id of Object.keys(doctorExpectation())) {
      expect(Object.keys(appBundles())).toContain(id);
    }
  });

  test('every pack the doctor claims to check has the right file set', () => {
    // THE DRIFT ARM. Mutation: drop embeddings.json from the doctor's
    // survival-guide set — which is the bug as it shipped — and this fails.
    const app = appBundles();
    const mismatches: string[] = [];
    for (const [id, expected] of Object.entries(doctorExpectation())) {
      const actual = app[id] ?? [];
      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        mismatches.push(`${id}: doctor says [${expected}], builtins.ts ships [${actual}]`);
      }
    }
    expect(
      mismatches.length === 0
        ? []
        : [
            'tools/check_pack.py and src/packs/builtins.ts disagree about what',
            'is bundled. builtins.ts is the app, so it is right; update the',
            "doctor's BUILTIN_FILES.",
            ...mismatches,
          ],
    ).toEqual([]);
  });

  test('a bundled pack the doctor ignores is a SIGNED gap, not a silent one', () => {
    const uncovered = Object.keys(appBundles()).filter(
      id => !(id in doctorExpectation()),
    );
    const unsigned = uncovered.filter(id => !(id in KNOWN_UNCOVERED));
    expect(
      unsigned.length === 0
        ? []
        : [
            'These packs ship in the app but the doctor does not check them.',
            'Cover them in BUILTIN_IDS/BUILTIN_FILES, or record the reason in',
            'KNOWN_UNCOVERED — the second is a decision, which is the point.',
            ...unsigned,
          ],
    ).toEqual([]);
    // And the gap list must not rot: a pardon for a pack that is no longer
    // bundled hides the next one that takes its name.
    expect(Object.keys(KNOWN_UNCOVERED).filter(id => !uncovered.includes(id))).toEqual([]);
  });
});

export {};
