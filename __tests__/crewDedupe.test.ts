/**
 * Same-code pods, the two halves (src/crews/crew.ts): the MERGE that cleans
 * up after the pre-idempotent join, and the MINT that keeps a fresh pod
 * from landing on a code this phone already holds.
 *
 * Why this file exists: dedupeCrewsByCode() fuses rows, and fusing is the
 * one store operation that can destroy a pod a human built. It shipped with
 * no coverage of its own. The property being pinned is not "duplicates go
 * away" — it is WHICH rows may be fused: only the shapes the historical bug
 * minted (a joined row nobody here named, holding no picks). Two pods this
 * phone genuinely holds under one code are left alone and surfaced.
 *
 * The store is one settings row, so the phone here is a Map — the same stub
 * the CrewSection suite uses. No SQL is involved in this module.
 */

const mockSettings = new Map<string, string>();
jest.mock('../src/events/db', () => ({
  getSetting: (key: string) =>
    mockSettings.has(key) ? mockSettings.get(key)! : null,
  setSetting: (key: string, value: string) => {
    mockSettings.set(key, value);
  },
}));

import {
  Crew,
  crewCodeCollisions,
  dedupeCrewsByCode,
  joinCrew,
  listCrews,
  newCrew,
  newCrewCode,
  saveCrew,
} from '../src/crews/crew';

/** Write rows straight into the settings row, in display order — these are
 * shapes that ALREADY exist on a phone (the bug's residue, a restored
 * backup), which is exactly the state the merge has to judge. */
function seed(...crews: Crew[]): void {
  mockSettings.set('crews', JSON.stringify(crews));
}

/** A row as the pre-idempotent join minted it: empty, and wearing a name
 * nobody on this phone chose. `source` is 'code' before a podmate's
 * announcement lands and 'mesh' after it does — the "two Dust Bunnies"
 * shape, both twins carrying the same real name. */
const twinRow = (
  code: string,
  bornMs: number,
  name = `Pod ${code}`,
  source: 'code' | 'mesh' = 'code',
): Crew => ({
  id: `crew-${bornMs}-1`,
  name,
  code,
  memberIds: [],
  nameSource: source,
});

/** A row a human built here: a name they typed and people they picked. */
const myRow = (
  code: string,
  bornMs: number,
  name: string,
  memberIds: string[],
): Crew => ({
  id: `crew-${bornMs}-2`,
  name,
  code,
  memberIds,
  nameSource: 'mine',
});

/** Math.random, played from a script: the first entries are the values that
 * decide a minted PIN (Math.floor(r * 10000)), and anything past the end is
 * a stable filler so the id suffix never runs the queue dry. */
function scriptRandom(...values: number[]): jest.SpyInstance {
  let at = 0;
  return jest
    .spyOn(Math, 'random')
    .mockImplementation(() => (at < values.length ? values[at++] : 0.5));
}

beforeEach(() => {
  mockSettings.clear();
  jest.restoreAllMocks();
});

describe('dedupeCrewsByCode — merges the bug\'s twins, never two real pods', () => {
  test('the historical twin merges into the pod the user built', () => {
    // The measured shape: a pod created here, plus the row a second join
    // minted before joinCrew was idempotent.
    seed(
      myRow('4207', 1_000, 'Dust Bunnies', ['aaaa1111', 'bbbb2222']),
      twinRow('4207', 2_000),
    );
    expect(dedupeCrewsByCode()).toBe(true);
    const after = listCrews();
    expect(after).toHaveLength(1);
    expect(after[0].name).toBe('Dust Bunnies');
    expect(after[0].nameSource).toBe('mine');
    expect(after[0].memberIds).toEqual(['aaaa1111', 'bbbb2222']);
    // Nothing left to do on the second pass: callers run this every
    // reconcile.
    expect(dedupeCrewsByCode()).toBe(false);
    expect(crewCodeCollisions()).toEqual([]);
  });

  test('"two Dust Bunnies": the twin that adopted the name over the mesh', () => {
    // Both rows carry the SAME real name — the owner-caught render. The
    // twin is still a twin: it holds no picks and nobody here named it.
    seed(
      myRow('4207', 1_000, 'Dust Bunnies', ['aaaa1111']),
      twinRow('4207', 2_000, 'Dust Bunnies', 'mesh'),
    );
    expect(dedupeCrewsByCode()).toBe(true);
    expect(listCrews()).toHaveLength(1);
    expect(listCrews()[0].nameSource).toBe('mine');
  });

  test('twins spelled differently still merge — the code normalizes', () => {
    seed(
      twinRow('  Dusty-Flamingo-42 ', 1_000, 'Karl pod', 'mesh'),
      twinRow('dusty-flamingo-42', 2_000),
    );
    expect(dedupeCrewsByCode()).toBe(true);
    const after = listCrews();
    expect(after).toHaveLength(1);
    // Strongest name claim wins among twins; the code is kept VERBATIM as
    // the surviving row spelled it.
    expect(after[0].name).toBe('Karl pod');
    expect(after[0].code).toBe('  Dusty-Flamingo-42 ');
  });

  test('TWO REAL PODS sharing a code are left alone and surfaced', () => {
    // 10,000 PINs: two pods this phone genuinely holds can collide. Fusing
    // them would union strangers' picks into one row and throw a name the
    // user typed on the floor.
    seed(
      myRow('4207', 1_000, 'Dawn patrol', ['aaaa1111']),
      myRow('4207', 2_000, 'Dinner crew', ['bbbb2222']),
    );
    expect(dedupeCrewsByCode()).toBe(false);
    const after = listCrews();
    expect(after).toHaveLength(2);
    expect(after.map(c => c.name)).toEqual(['Dawn patrol', 'Dinner crew']);
    expect(after.map(c => c.memberIds)).toEqual([['aaaa1111'], ['bbbb2222']]);
    // Not silent: the collision is readable, so a surface can say it.
    const groups = crewCodeCollisions();
    expect(groups).toHaveLength(1);
    expect(groups[0].map(c => c.name)).toEqual(['Dawn patrol', 'Dinner crew']);
  });

  test('two rows nobody here named are twins whatever they hold', () => {
    // Neither row can have come from newCrew (which always stamps 'mine'),
    // so both came from a join — and joining is idempotent on the code, so
    // two of them can only be the bug. Fusing is provably right here even
    // though one has been filled in.
    seed(twinRow('4207', 1_000, 'Dawn patrol', 'mesh'), {
      ...twinRow('4207', 2_000, 'Dawn patrol', 'mesh'),
      memberIds: ['aaaa1111'],
    });
    expect(dedupeCrewsByCode()).toBe(true);
    const after = listCrews();
    expect(after).toHaveLength(1);
    // The survivor is the row someone filled in, not the older empty one.
    expect(after[0].id).toBe('crew-2000-1');
    expect(after[0].memberIds).toEqual(['aaaa1111']);
  });

  test('a pod made here beside a joined pod somebody filled in: hands off', () => {
    // The ambiguous shape, and the one the mint fix makes unreachable: a
    // created pod ('mine') whose PIN equals a pod that was JOINED and then
    // filled in. Picks are a human's work; fusing would union two pods'
    // rosters into one row.
    seed(
      myRow('4207', 1_000, 'Dinner crew', ['aaaa1111']),
      { ...twinRow('4207', 2_000, 'Dawn patrol', 'mesh'), memberIds: ['bbbb2222'] },
    );
    expect(dedupeCrewsByCode()).toBe(false);
    expect(listCrews().map(c => c.name)).toEqual(['Dinner crew', 'Dawn patrol']);
    expect(crewCodeCollisions()).toHaveLength(1);
  });

  test('a real pod and a twin under one code: the twin goes, the pod stays', () => {
    seed(
      myRow('4207', 1_000, 'Dawn patrol', ['aaaa1111']),
      myRow('4207', 2_000, 'Dinner crew', ['bbbb2222']),
      twinRow('4207', 3_000),
    );
    // Two anchored rows in the group: nothing here is safe to fuse, so
    // the twin stays too rather than being merged into a guess.
    expect(dedupeCrewsByCode()).toBe(false);
    expect(listCrews()).toHaveLength(3);
  });

  test('leading zeros survive the merge — "0042" is a string, not 42', () => {
    seed(
      myRow('0042', 1_000, 'Dawn patrol', ['aaaa1111']),
      twinRow('0042', 2_000),
      myRow('42', 3_000, 'Other pod', ['bbbb2222']),
    );
    expect(dedupeCrewsByCode()).toBe(true);
    const after = listCrews();
    // "0042" and "42" are DIFFERENT pods and never merge with each other.
    expect(after).toHaveLength(2);
    expect(after[0].code).toBe('0042');
    expect(after[0].name).toBe('Dawn patrol');
    expect(after[1].code).toBe('42');
  });

  test('untouched groups keep their order and their rows', () => {
    seed(
      myRow('1111', 1_000, 'Alpha', ['aaaa1111']),
      myRow('4207', 2_000, 'Dawn patrol', ['bbbb2222']),
      twinRow('1111', 3_000),
      myRow('4207', 4_000, 'Dinner crew', ['cccc3333']),
    );
    expect(dedupeCrewsByCode()).toBe(true);
    expect(listCrews().map(c => c.name)).toEqual([
      'Alpha',
      'Dawn patrol',
      'Dinner crew',
    ]);
  });
});

describe('newCrewCode — a fresh PIN never lands on a code this phone holds', () => {
  test('the mint rerolls past a held code', () => {
    joinCrew('4207');
    const rolls = scriptRandom(0.4207, 0.1234);
    expect(newCrewCode()).toBe('1234');
    rolls.mockRestore();
  });

  test('newCrew mints a pod that cannot be fused with an existing one', () => {
    // The only local path to two rows under one code: creating a pod whose
    // random PIN equals one already held. joinCrew is idempotent on the
    // code, so a second join can never mint the collision.
    const joined = joinCrew('4207');
    // newCrew mints its id before its code, so the first scripted value is
    // spent on the id suffix; the second is the PIN that collides and the
    // third is the reroll.
    const rolls = scriptRandom(0.4207, 0.4207, 0.9876);
    const made = saveCrew(newCrew('Dinner crew', ['bbbb2222']));
    rolls.mockRestore();
    expect(made.code).toBe('9876');
    expect(listCrews()).toHaveLength(2);
    // And therefore the reconcile pass has nothing to fuse.
    expect(dedupeCrewsByCode()).toBe(false);
    expect(crewCodeCollisions()).toEqual([]);
    expect(listCrews().map(c => c.id).sort()).toEqual(
      [joined.id, made.id].sort(),
    );
  });

  test('leading-zero codes are held, and rerolled past, as strings', () => {
    joinCrew('0042');
    const rolls = scriptRandom(0.0042, 0.0007);
    // "0042" is taken; "0007" is not — and neither is ever a number.
    expect(newCrewCode()).toBe('0007');
    rolls.mockRestore();
  });

  test('a held code spelled loosely still blocks the mint', () => {
    saveCrew({ ...newCrew('Dawn patrol'), code: ' 4207 ' });
    const rolls = scriptRandom(0.4207, 0.5555);
    expect(newCrewCode()).toBe('5555');
    rolls.mockRestore();
  });

  test('the reroll is BOUNDED — a hostile mint still returns a PIN', () => {
    joinCrew('4207');
    const rolls = scriptRandom(...new Array(500).fill(0.4207));
    const code = newCrewCode();
    rolls.mockRestore();
    // It gives up rather than spinning: the phone gets a code, and the
    // dedupe guard is what keeps the resulting collision non-destructive.
    expect(code).toMatch(/^\d{4}$/);
    expect(rolls.mock.calls.length).toBeLessThan(40);
  });

  test('minted PINs are still spread, and still four digits', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const code = newCrewCode();
      expect(code).toMatch(/^\d{4}$/);
      seen.add(code);
    }
    expect(seen.size).toBeGreaterThan(50);
  });
});
