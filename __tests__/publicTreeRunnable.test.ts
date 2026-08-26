/**
 * THE PUBLIC CLONE MUST BE ABLE TO RUN ITS OWN TEST SUITE.
 *
 * CONTRIBUTING.md tells an outside contributor that lint, typecheck and the
 * jest suite must all be green before a PR. That is only a fair bar if a
 * fresh public clone can actually reach it. It could not: __tests__/
 * walkieLadder.test.ts opened docs/WALKIE-LADDER.md, and `-docs` is a
 * manifest exclusion, so the file is absent from every public checkout.
 *
 * WHY IT WAS INVISIBLE FOR SO LONG. The read sat at DESCRIBE scope, so the
 * failure was "Test suite failed to run" -- which jest reports in the SUITES
 * line, not the tests line. On the private tree, where the doc exists, every
 * run was green. Nothing in the repo ever executed the suite in the shape a
 * contributor gets, so the only way to see it was to build the public tree
 * and run it, which is what finally happened.
 *
 * TWO OTHER FILES ALREADY HAD THE CONVENTION -- walkieLiveness and videoWire
 * both guard on existsSync and say why in a comment. So this was not an
 * unknown hazard, it was a known one that one file missed. That is precisely
 * when a convention should stop being a comment and become a check: three
 * instances, two of them handled correctly, and the third took down the
 * contributor's gate.
 *
 * THE PRIVATE PREFIXES ARE READ FROM THE MANIFEST rather than hardcoded, so
 * a directory that becomes private tomorrow is covered by this guard the same
 * day, without anyone remembering to come back here.
 */
const fsp = require('fs');
const pathp = require('path');

/** Comments stripped: an assertion about code that trips on PROSE quoting
 * that code punishes the good comment. That mistake was made three times in
 * one night on this repo before the helper existed. */
const codeOnly = (p: string): string =>
  fsp
    .readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Every path prefix the manifest marks private, i.e. absent from a public
 * checkout. Comments are stripped the same way the real check_public_safe
 * parser strips them. */
/**
 * THIS GUARD CAUGHT ITSELF on its first run, which is the best evidence it
 * works: it reads the manifest, and `-tools/PUBLIC-TREE.manifest` is itself a
 * private entry, so on a public clone this very suite would have hit the
 * ENOENT it exists to prevent. It now demonstrates the convention it enforces
 * — literal path in the existsSync AND in the read, so the scan can see that
 * it is guarded rather than being blind to it by accident.
 *
 * Skipping on a public clone is correct, not a gap: there are no private
 * paths there to find. The guard's job is done from the private tree, before
 * the public one is ever cut.
 */
const HAS_MANIFEST = fsp.existsSync('tools/PUBLIC-TREE.manifest');

function privatePrefixes(): string[] {
  if (!HAS_MANIFEST) {
    return [];
  }
  return fsp
    .readFileSync('tools/PUBLIC-TREE.manifest', 'utf8')
    .split('\n')
    .map((l: string) => l.replace(/#.*/, '').trim())
    .filter((l: string) => l.startsWith('-') && l.length > 1)
    .map((l: string) => l.slice(1).trim());
}

function sourceFiles(dir: string): string[] {
  return fsp.readdirSync(dir, { withFileTypes: true }).flatMap((e: any) => {
    const full = pathp.join(dir, e.name);
    if (e.isDirectory()) {
      return sourceFiles(full);
    }
    return /\.(ts|tsx)$/.test(e.name) ? [full] : [];
  });
}

const FILES: string[] = [...sourceFiles('__tests__'), ...sourceFiles('src'), 'App.tsx'];
const PRIVATE = privatePrefixes();

const isPrivate = (p: string): boolean =>
  PRIVATE.some(pref => p === pref || p.startsWith(pref + '/'));

/** Reads of a literal path: the call name is deliberately open (`read`,
 * `readSource`, `readFileSync`, project-local helpers all appear here) —
 * what makes it a finding is the ARGUMENT being a private path. */
const READ_CALL = /\b(?:\w*[Rr]ead\w*)\s*\(\s*'([^']+)'/g;
const EXISTS_CALL = /existsSync\s*\(\s*'([^']+)'/g;
/** A read through a NAMED constant — `const LADDER = 'docs/…'; read(LADDER)`
 * — is the shape that slipped past the literal-only scan and failed the
 * public clone at flip-verify (awarePairing, 2026-08-26). Resolve simple
 * single-quoted const declarations per file and hunt reads by identifier
 * too; a guard counts if the resolved path OR the identifier appears in an
 * existsSync. */
const CONST_DECL = /\bconst\s+(\w+)\s*=\s*'([^']+)'/g;
const READ_IDENT = /\b(?:\w*[Rr]ead\w*)\s*\(\s*([A-Z_][A-Z0-9_]*)\s*\)/g;
const EXISTS_IDENT = /existsSync\s*\(\s*([A-Z_][A-Z0-9_]*)\s*\)/g;

function findings(): string[] {
  const out: string[] = [];
  for (const file of FILES) {
    const code = codeOnly(file);
    const consts = new Map<string, string>();
    for (const m of code.matchAll(CONST_DECL)) {
      consts.set(m[1], m[2]);
    }
    const guarded = new Set<string>();
    for (const m of code.matchAll(EXISTS_CALL)) {
      guarded.add(m[1]);
    }
    for (const m of code.matchAll(EXISTS_IDENT)) {
      const p = consts.get(m[1]);
      if (p) {
        guarded.add(p);
      }
    }
    for (const m of code.matchAll(READ_CALL)) {
      const target = m[1];
      if (!isPrivate(target) || guarded.has(target)) {
        continue;
      }
      out.push(`${file}: reads ${target}, which no public checkout has`);
    }
    for (const m of code.matchAll(READ_IDENT)) {
      const target = consts.get(m[1]);
      if (!target || !isPrivate(target) || guarded.has(target)) {
        continue;
      }
      out.push(
        `${file}: reads ${target} via const ${m[1]}, which no public checkout has`,
      );
    }
  }
  return out;
}

(HAS_MANIFEST ? describe : describe.skip)('a public clone can run the suite it is told to keep green [needs tools/PUBLIC-TREE.manifest, private tree only]', () => {
  test('the scan works — POSITIVE AND NEGATIVE CONTROLS', () => {
    // Reading this scan cannot tell you it is sound. So: the manifest must
    // actually yield private prefixes, docs must be one of them, and a path
    // that is plainly public must NOT be classified private.
    expect(PRIVATE.length).toBeGreaterThan(3);
    expect(isPrivate('docs/WALKIE-LADDER.md')).toBe(true);
    expect(isPrivate('src/crews/walkie.ts')).toBe(false);
    // ...and the corpus must be real, or every arm below passes over nothing.
    expect(FILES.length).toBeGreaterThan(100);
    // ...and the read-detector must actually match the shape it hunts, or a
    // green result only means the regex never fired.
    expect([...`readSource('docs/X.md')`.matchAll(READ_CALL)].length).toBe(1);
    expect([...`existsSync('docs/X.md')`.matchAll(EXISTS_CALL)].length).toBe(1);
    // ...and it must NOT fire on a comment quoting the same call, which is
    // the false positive this repo shipped three times in one night.
    const commented = '// readSource(\'docs/X.md\') is how it used to work\n';
    expect(
      [...commented.replace(/(^|[^:])\/\/.*$/gm, '$1').matchAll(READ_CALL)].length,
    ).toBe(0);
    // ...and the const-indirection arms (the shape that slipped through and
    // failed the public clone): the decl resolves, the identifier read
    // fires, and an identifier existsSync counts as the guard.
    const indirect = "const LADDER = 'docs/X.md';\nconst x = readSource(LADDER);";
    expect([...indirect.matchAll(CONST_DECL)].length).toBe(1);
    expect([...indirect.matchAll(READ_IDENT)].length).toBe(1);
    expect([...`existsSync(LADDER)`.matchAll(EXISTS_IDENT)].length).toBe(1);
  });

  test('no shipped file reads a private path without guarding on its presence', () => {
    expect(
      findings().length === 0
        ? []
        : [
            'These files read a path that is PRIVATE per tools/PUBLIC-TREE.manifest,',
            'so a public clone hits ENOENT. If the read sits at describe scope the',
            'whole suite fails to RUN, which jest reports in the Suites line.',
            'Either guard it — (existsSync(P) ? describe : describe.skip) — or',
            'make the path public in the manifest.',
            ...findings(),
          ],
    ).toEqual([]);
  });
});

/**
 * MODULE SCOPE, DELIBERATELY. A .ts test with no import/export is a SCRIPT,
 * so its top-level `const`s share one global scope with every other script
 * test in the project — and `codeOnly` and `FILES` are exactly the names a
 * second guard reaches for. Adding this file without it broke `npm run
 * typecheck` with four TS2451 redeclarations, which is the middle stage of
 * the documented contributor gate: lint passed, typecheck died, and the test
 * suite this file exists to protect never ran at all.
 */
export {};
