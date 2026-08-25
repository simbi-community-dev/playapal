/**
 * Unit tests for the playa address parser + walk-time approximation
 * (ported-in-concept from iBurn's playaWalkMinutes).
 */

import { parsePlayaAddress, playaWalkMinutes } from '../src/rightnow/playaWalk';

describe('parsePlayaAddress', () => {
  test('standard "time & ring" and reversed forms', () => {
    expect(parsePlayaAddress('7:30 & G')).toEqual({ radiusFt: 4400, angleDeg: 225 });
    expect(parsePlayaAddress('G & 7:30')).toEqual({ radiusFt: 4400, angleDeg: 225 });
  });

  test('esplanade addresses', () => {
    expect(parsePlayaAddress('6:00 & Esplanade')).toEqual({ radiusFt: 2500, angleDeg: 180 });
    expect(parsePlayaAddress('Esplanade at 6:00')).toEqual({ radiusFt: 2500, angleDeg: 180 });
  });

  test('landmarks', () => {
    expect(parsePlayaAddress('Center Camp')?.angleDeg).toBe(180);
    expect(parsePlayaAddress('Temple plaza')?.angleDeg).toBe(0);
    expect(parsePlayaAddress('The Man')?.radiusFt).toBe(0);
  });

  test('deep playa', () => {
    expect(parsePlayaAddress('12:00 deep playa')).toEqual({ radiusFt: 4200, angleDeg: 0 });
    expect(parsePlayaAddress('Trash fence, 12:00 deep playa')?.radiusFt).toBe(4200);
  });

  test('unparseable addresses return null', () => {
    expect(parsePlayaAddress('')).toBeNull();
    expect(parsePlayaAddress('somewhere dusty')).toBeNull();
    expect(parsePlayaAddress('13:00 & Z')).toBeNull();
  });
});

describe('playaWalkMinutes', () => {
  test('same address is a zero-minute walk', () => {
    expect(playaWalkMinutes('7:30 & G', '7:30 & G')).toBe(0);
  });

  test('is symmetric', () => {
    const ab = playaWalkMinutes('3:00 & C', 'Center Camp');
    const ba = playaWalkMinutes('Center Camp', '3:00 & C');
    expect(ab).toBe(ba);
    expect(ab).toBeGreaterThan(0);
  });

  test('crossing the whole city takes most of an hour', () => {
    // 3:00 & C to 9:00 & C is a diameter walk: 2 x 3400ft x 1.25 / 264 ~ 32min.
    expect(playaWalkMinutes('3:00 & C', '9:00 & C')).toBe(50);
  });

  test('short hop between adjacent rings is a few minutes', () => {
    const mins = playaWalkMinutes('7:30 & G', '7:30 & F');
    expect(mins).toBeGreaterThanOrEqual(1);
    expect(mins).toBeLessThanOrEqual(3);
  });

  test('null when either end is unparseable', () => {
    expect(playaWalkMinutes('nowhere', '7:30 & G')).toBeNull();
    expect(playaWalkMinutes('7:30 & G', '')).toBeNull();
  });
});
