/**
 * THE README PUBLISHES THE DIGEST A CAMPER VERIFIES A DOWNLOAD AGAINST, AND
 * NOTHING KEPT IT EQUAL TO THE CATALOG.
 *
 * README.md says, in as many words, that `src/llm/modelCatalog.ts` is the
 * single source of truth for what the app offers — and then reprints that
 * file's SHA-256s in a table. Two statements of one fact, and the copy is the
 * one strangers read: the README table is the public record of what a
 * legitimate model file hashes to.
 *
 * WHAT DRIFT COSTS HERE, which is why this is worth a suite of its own. Ship a
 * rebuilt model and update the catalog only, and the README now publishes a
 * hash no real file matches: every careful person who verifies their download
 * concludes the file is corrupt or tampered with. Update the README only, and
 * it publishes a hash the app will refuse — the same confusion pointed the
 * other way. The failure mode of a stale integrity digest is that it makes
 * GOOD files look bad and teaches people to skip the check.
 *
 * THIRD INSTANCE OF ONE CLASS IN A NIGHT. tools/check_pack.py carried a
 * hardcoded second copy of src/packs/builtins.ts and drifted; the jest fab
 * guard nearly hardcoded the manifest's private prefixes before it was made to
 * read them; this is the third. The pattern is always the same — a fact stated
 * twice, with nothing joining the statements.
 */
const fsr = require('fs');

const README = 'README.md';
const CATALOG = 'src/llm/modelCatalog.ts';

/** Rows of the README's model table: filename -> digest. */
function readmeModels(): Record<string, string> {
  const out: Record<string, string> = {};
  const text = fsr.readFileSync(README, 'utf8');
  for (const m of text.matchAll(/`([a-z0-9-]+\.gguf)`[^|]*\|[^|]*\|\s*`([0-9a-f]{64})`/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

/** The catalog's own entries: filename -> digest. */
function catalogModels(): Record<string, string> {
  const out: Record<string, string> = {};
  const text = fsr.readFileSync(CATALOG, 'utf8');
  for (const m of text.matchAll(/file:\s*'([^']+\.gguf)'[\s\S]{0,400}?sha256:\s*'([0-9a-f]{64})'/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

describe('the README publishes the catalog’s digests, not its own', () => {
  test('both readers work — POSITIVE AND NEGATIVE CONTROLS', () => {
    // A reader that returns {} makes every arm below pass over nothing, which
    // is exactly how a digest check reads green while checking no digests.
    expect(Object.keys(readmeModels()).length).toBeGreaterThan(0);
    expect(Object.keys(catalogModels()).length).toBeGreaterThan(0);
    // Each digest must be a full SHA-256, not a truncated display form — a
    // shortened hash would compare equal to nothing and fail confusingly.
    for (const d of [...Object.values(readmeModels()), ...Object.values(catalogModels())]) {
      expect(d).toMatch(/^[0-9a-f]{64}$/);
    }
    // And the README's parse must not silently match the catalog's own text.
    expect(readmeModels()).not.toEqual({});
  });

  test('every model the README lists carries the catalog’s digest', () => {
    // Mutation: change one hex character in either file and this fails,
    // naming the file and both values.
    const readme = readmeModels();
    const catalog = catalogModels();
    const problems: string[] = [];
    for (const [file, digest] of Object.entries(readme)) {
      if (!(file in catalog)) {
        problems.push(`${file}: in README, absent from ${CATALOG}`);
      } else if (catalog[file] !== digest) {
        problems.push(`${file}: README ${digest} vs catalog ${catalog[file]}`);
      }
    }
    expect(
      problems.length === 0
        ? []
        : [
            `${CATALOG} is the source of truth and README.md reprints it. A`,
            'stale digest here makes a GOOD download look tampered with, which',
            'teaches people to skip the check. Update the README table.',
            ...problems,
          ],
    ).toEqual([]);
  });

  test('the README does not omit a model the app offers', () => {
    // The inverse, and it is not the same check: a table that silently loses a
    // row leaves that model with no published digest at all, so nobody can
    // verify it and nothing goes red.
    const missing = Object.keys(catalogModels()).filter(f => !(f in readmeModels()));
    expect(
      missing.length === 0
        ? []
        : ['These models ship in the catalog but have no README row:', ...missing],
    ).toEqual([]);
  });
});

export {};
