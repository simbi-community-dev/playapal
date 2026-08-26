/**
 * DOES THE ANGEL WAKE UP WITH THE APP? (src/llm/angelRest.ts)
 *
 * Owner field report 2026-08-25, iPhone 13 mini (4 GB, iOS 26.6): three
 * jetsam kills across 0.7.4/0.8.0 with the model resident, then "still very
 * slow" on the 0.8.1 memory-fix build with a push-to-talk crash. The rule
 * under test is the one that answers it — small phone rests, big phone
 * unchanged, and what the camper said beats both.
 */
const mockTotalMemory = jest.fn<Promise<unknown>, []>(async () => 8 * 1024 ** 3);
jest.mock('react-native-device-info', () => ({
  __esModule: true,
  default: { getTotalMemory: () => mockTotalMemory() },
}));

// The settings table reduced to a Map (the themeGuard/tour pattern).
const mockSettings = new Map<string, string>();
let mockSettingsThrow: Error | null = null;
jest.mock('../src/events/db', () => ({
  getSetting: (key: string) => {
    if (mockSettingsThrow) {
      throw mockSettingsThrow;
    }
    return mockSettings.get(key) ?? null;
  },
  setSetting: (key: string, value: string) => {
    if (mockSettingsThrow) {
      throw mockSettingsThrow;
    }
    mockSettings.set(key, value);
  },
  // LlamaSession reaches these on import/turn paths; this suite never runs a
  // turn, and the module graph must still resolve.
  identityAffiliationTerms: () => [],
  getDb: () => ({
    execute: () => ({ rows: { _array: [], length: 0, item: () => null } }),
  }),
}));
jest.mock('llama.rn', () => ({ initLlama: jest.fn() }));
jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  exists: jest.fn(async () => false),
  hash: jest.fn(async () => 'sha'),
  mkdir: jest.fn(async () => {}),
  readDir: jest.fn(async () => []),
  stat: jest.fn(async () => ({ size: 1, mtime: new Date(), ctime: new Date() })),
  unlink: jest.fn(async () => {}),
}));
jest.mock('../src/log/chatLog', () => ({
  logChat: jest.fn(),
  logSystemNote: jest.fn(),
  rotateChatSession: jest.fn(),
}));
jest.mock('../src/llm/toolExecutor', () => ({ executeTool: jest.fn() }));
jest.mock('../src/facts/personIdentity', () => ({ lookupPersonIdentity: jest.fn() }));

import {
  ANGEL_ENABLED_KEY,
  angelPosture,
  readAngelChoice,
  readAngelPosture,
  writeAngelChoice,
} from '../src/llm/angelRest';

const GB = 1024 ** 3;

beforeEach(() => {
  mockSettings.clear();
  mockSettingsThrow = null;
  mockTotalMemory.mockReset().mockResolvedValue(8 * GB);
});

describe('the rule itself', () => {
  it('rests a never-asked constrained phone and wakes every other one', () => {
    expect(angelPosture(null, true)).toEqual({
      awake: false,
      constrained: true,
      chosen: false,
    });
    expect(angelPosture(null, false)).toEqual({
      awake: true,
      constrained: false,
      chosen: false,
    });
  });

  it('lets the camper overrule the phone in BOTH directions, forever', () => {
    // The small phone whose owner wants her anyway.
    expect(angelPosture('awake', true).awake).toBe(true);
    // The big phone whose owner would rather have the room.
    expect(angelPosture('resting', false).awake).toBe(false);
    expect(angelPosture('awake', true).chosen).toBe(true);
    expect(angelPosture('resting', false).chosen).toBe(true);
  });
});

describe('the stored choice', () => {
  it('round-trips through the settings table', () => {
    expect(readAngelChoice()).toBeNull();
    writeAngelChoice('resting');
    expect(mockSettings.get(ANGEL_ENABLED_KEY)).toBe('resting');
    expect(readAngelChoice()).toBe('resting');
    writeAngelChoice('awake');
    expect(readAngelChoice()).toBe('awake');
  });

  it('reads junk and a broken database as "never asked", never as a crash', () => {
    mockSettings.set(ANGEL_ENABLED_KEY, 'yes');
    expect(readAngelChoice()).toBeNull();
    mockSettingsThrow = new Error('database is not open yet');
    expect(readAngelChoice()).toBeNull();
    // A failed write costs the camper the same tap next launch — never the
    // wake they just asked for.
    expect(() => writeAngelChoice('awake')).not.toThrow();
  });
});

describe('the phone-size probe', () => {
  it('rests a measured 4 GB phone', async () => {
    mockTotalMemory.mockResolvedValue(4 * GB);
    await expect(readAngelPosture()).resolves.toEqual({
      awake: false,
      constrained: true,
      chosen: false,
    });
  });

  it('leaves an 8 GB phone exactly as it was', async () => {
    mockTotalMemory.mockResolvedValue(8 * GB);
    await expect(readAngelPosture()).resolves.toEqual({
      awake: true,
      constrained: false,
      chosen: false,
    });
  });

  it('treats the 6 GB boundary itself as roomy, like the smart tier does', async () => {
    mockTotalMemory.mockResolvedValue(6 * GB);
    await expect(readAngelPosture()).resolves.toMatchObject({ constrained: false });
    mockTotalMemory.mockResolvedValue(6 * GB - 1);
    await expect(readAngelPosture()).resolves.toMatchObject({ constrained: true });
  });

  it('never costs an unmeasurable phone its Angel', async () => {
    // A probe that throws, and the shapes platforms use for "I don't know".
    // The load PROFILE still takes the cautious road (LlamaSession); the
    // GATE must not, or one dead native module silently disables the Angel
    // on every phone in the camp.
    for (const answer of [0, -1, undefined, null, NaN]) {
      mockTotalMemory.mockResolvedValue(answer);
      await expect(readAngelPosture()).resolves.toMatchObject({
        awake: true,
        constrained: false,
      });
    }
    mockTotalMemory.mockRejectedValue(new Error('no native module'));
    await expect(readAngelPosture()).resolves.toMatchObject({
      awake: true,
      constrained: false,
    });
  });

  it('survives a probe that explodes rather than merely lying', async () => {
    // This runs on the boot path immediately before the load decision: a
    // throw here would not mis-answer, it would take the model load down
    // with it and strand a roomy phone with no Angel at all.
    mockTotalMemory.mockImplementation(() => {
      throw new Error('native module blew up');
    });
    await expect(readAngelPosture()).resolves.toMatchObject({ awake: true });
  });

  it('honours a stored choice on a phone of any size', async () => {
    mockTotalMemory.mockResolvedValue(4 * GB);
    mockSettings.set(ANGEL_ENABLED_KEY, 'awake');
    await expect(readAngelPosture()).resolves.toEqual({
      awake: true,
      constrained: true,
      chosen: true,
    });
    mockTotalMemory.mockResolvedValue(8 * GB);
    mockSettings.set(ANGEL_ENABLED_KEY, 'resting');
    await expect(readAngelPosture()).resolves.toEqual({
      awake: false,
      constrained: false,
      chosen: true,
    });
  });
});
