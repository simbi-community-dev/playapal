/**
 * A MODULE-LEVEL NAME BOUND TWICE IS A SILENT OVERWRITE, and it shipped.
 *
 * tools/check_pack.py defined CREDIT_LINE_RE twice: once as the credit
 * DETECTOR, carrying the capture group has_substantive_credit reads, and 200
 * lines later as the chunker's TRAILING attribution matcher, with no group.
 * Python takes the last binding, so the doctor ran the wrong pattern for every
 * credit check, and crashed outright — `IndexError: no such group` — on any
 * document containing a `*Credit: ...*` line.
 *
 * WHO IT BROKE. PACK-FORMAT.md is the contributor doorway; it tells pack
 * authors to run `python3 tools/check_pack.py <folder>` and require PACK PASS.
 * On the repo's OWN bundled survival-guide, with the flag the doc prescribes
 * for it, that command ended in a traceback. A validator that tracebacks tells
 * an author nothing about their pack — it tells them the project is broken.
 *
 * WHY A CHECK RATHER THAN A FIX. This is the SECOND instance of one class in a
 * single night: hours earlier a new .ts test with no import/export bound
 * `codeOnly` and `FILES` into the shared script scope and silently collided
 * with two other suites, taking `npm run typecheck` red. Same shape, different
 * language — one name, two bindings, the later one wins in silence. Two
 * instances is where you stop fixing instances.
 *
 * Python is not required to run this: the check reads the files as text, so it
 * works wherever jest does. That matters because nothing else in this suite
 * shells out to python, and a guard nobody can run is a guard nobody keeps.
 */
const fsc = require('fs');
const pathc = require('path');

const TOOLS_DIR = 'tools';

/** Top-level bindings only — column zero. An indented rebind inside a function
 * or a loop is ordinary Python and must not be flagged, which is the false
 * positive that would get this check deleted. */
const TOP_LEVEL_BIND = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=\n]+)?=(?!=)/;

function pythonTools(): string[] {
  return fsc
    .readdirSync(TOOLS_DIR)
    .filter((f: string) => f.endsWith('.py'))
    .map((f: string) => pathc.join(TOOLS_DIR, f));
}

/** Names bound more than once at module scope, per file. */
function shadowed(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const m = TOP_LEVEL_BIND.exec(line);
    if (m) {
      counts[m[1]] = (counts[m[1]] ?? 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 1));
}

const FILES = pythonTools();

describe('a shipped python tool never binds one module-level name twice', () => {
  test('the detector works — POSITIVE AND NEGATIVE CONTROLS', () => {
    // The bug this exists to catch, verbatim in shape. Without this arm a
    // green result only says the regex never fired.
    const bug = [
      'CREDIT_LINE_RE = re.compile(r"one")',
      'def trailing_credit(body):',
      '    last = "x"',
      'CREDIT_LINE_RE = re.compile(r"two")',
    ].join('\n');
    expect(shadowed(bug)).toEqual({ CREDIT_LINE_RE: 2 });

    // Legitimate python that must NOT be flagged: an indented rebind, an
    // augmented assignment, and a comparison.
    const fine = [
      'TOTAL = 0',
      'def go(rows):',
      '    total = 0',
      '    for r in rows:',
      '        total = total + 1',
      '    if total == TOTAL:',
      '        return total',
    ].join('\n');
    expect(shadowed(fine)).toEqual({});

    // And the corpus must be real, or the arm below reads every file it has
    // — which is none — and passes.
    expect(FILES.length).toBeGreaterThan(5);
  });

  test('no shipped tool has a shadowed module-level constant', () => {
    const found: string[] = [];
    for (const file of FILES) {
      const dupes = shadowed(fsc.readFileSync(file, 'utf8'));
      for (const [name, n] of Object.entries(dupes)) {
        found.push(`${file}: ${name} bound ${n} times at module scope`);
      }
    }
    expect(
      found.length === 0
        ? []
        : [
            'A module-level name bound twice is a silent overwrite: the later',
            'binding wins and every earlier reader gets it instead. Rename one,',
            'or move the second inside the function that wants it.',
            ...found,
          ],
    ).toEqual([]);
  });
});

export {};
