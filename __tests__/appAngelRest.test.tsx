/**
 * THE ANGEL RESTS ON A SMALL PHONE — the startup decision, wired.
 *
 * Owner field report 2026-08-25 (iPhone 13 mini, 4 GB, iOS 26.6): three
 * jetsam kills across 0.7.4/0.8.0 with the model resident; on the 0.8.1
 * memory-fix build the app was "still very slow" and a push-to-talk attempt
 * died. ~1.4 GB of weights in a 4 GB phone, every time.
 *
 * The rule itself is unit-tested in angelRest.test.ts. THIS suite is about
 * the wiring — the one thing that actually spares the phone is whether
 * App.tsx calls session.load() at boot, and whether the switch does its work
 * NOW rather than next launch. It runs the real angelRest module over the
 * real memory boundary (only the phone's answer is mocked), so a change to
 * either shows up here.
 */
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ModelStatus } from '../src/types';
import type { AngelPosture } from '../src/llm/angelRest';

const GB = 1024 ** 3;
const mockTotalMemory = jest.fn<Promise<unknown>, []>(async () => 8 * GB);
const mockSettings = new Map<string, string>();
const mockLoad = jest.fn<Promise<boolean>, [string, (s: ModelStatus) => void]>(
  async () => true,
);
const mockUnload = jest.fn(async () => {});
const mockRelease = jest.fn(async () => {});
let mockReady = false;

jest.mock('react-native-device-info', () => ({
  __esModule: true,
  default: { getTotalMemory: () => mockTotalMemory() },
}));

jest.mock('react-native-sensors', () => ({
  __esModule: true,
  magnetometer: { subscribe: () => ({ unsubscribe: jest.fn() }) },
  setUpdateIntervalForType: jest.fn(),
  SensorTypes: { magnetometer: 'magnetometer' },
}));
jest.mock('@react-native-documents/picker', () => ({
  pick: jest.fn(),
  keepLocalCopy: jest.fn(),
  types: { allFiles: '*/*' },
}));
jest.mock('@react-native-community/geolocation', () => ({
  __esModule: true,
  default: {
    setRNConfiguration: jest.fn(),
    watchPosition: jest.fn(() => 7),
    clearWatch: jest.fn(),
    getCurrentPosition: jest.fn(),
    requestAuthorization: jest.fn(),
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }: { children: unknown }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
jest.mock('../src/hooks/useKeyboardInset', () => ({ useKeyboardInset: () => 0 }));
jest.mock('../src/screens/RightNowScreen', () => {
  const ReactModule = require('react');
  const { Text } = require('react-native');
  return {
    RightNowScreen: () => ReactModule.createElement(Text, null, 'Right Now Screen'),
  };
});
jest.mock('../src/screens/CampScreen', () => {
  const ReactModule = require('react');
  const { Text } = require('react-native');
  return { CampScreen: () => ReactModule.createElement(Text, null, 'Camp Screen') };
});
/** Settings is the durable home of the choice; capture what App hands it. */
const settingsProps: {
  current: { angel: AngelPosture | null; onAngelChange?: unknown };
} = { current: { angel: null } };
jest.mock('../src/screens/SettingsScreen', () => {
  const ReactModule = require('react');
  const { Text } = require('react-native');
  return {
    SettingsScreen: (received: {
      angel: AngelPosture | null;
      onAngelChange?: unknown;
    }) => {
      settingsProps.current = received;
      return ReactModule.createElement(Text, null, 'Settings');
    },
  };
});

/** The chat overlay, reduced to what this suite needs: the posture App
 * handed it, and a door onto the switch's own callback. */
const chatProps: { current: { angel: AngelPosture | null; busy: boolean } } = {
  current: { angel: null, busy: false },
};
jest.mock('../src/screens/ChatScreen', () => {
  const ReactModule = require('react');
  const { Pressable, Text } = require('react-native');
  return {
    ChatScreen: ({
      angel,
      angelBusy,
      onAngelChange,
      onPickModel,
    }: {
      angel: AngelPosture | null;
      angelBusy: boolean;
      onAngelChange: (awake: boolean) => void;
      onPickModel: () => void;
    }) => {
      chatProps.current = { angel, busy: angelBusy };
      return ReactModule.createElement(
        ReactModule.Fragment,
        null,
        ReactModule.createElement(
          Pressable,
          {
            accessibilityLabel: 'mock-angel-switch',
            onPress: (awake: boolean) => onAngelChange(awake),
          },
          ReactModule.createElement(Text, null, angel?.awake ? 'awake' : 'resting'),
        ),
        ReactModule.createElement(
          Pressable,
          { accessibilityLabel: 'mock-pick-model', onPress: onPickModel },
          ReactModule.createElement(Text, null, 'pick'),
        ),
      );
    },
  };
});

// The real session everywhere except the native half: memoryConstrainedDevice
// stays REAL so this suite runs over the actual 6 GB boundary.
jest.mock('../src/llm/LlamaSession', () => {
  const actual = jest.requireActual('../src/llm/LlamaSession');
  return {
    ...actual,
    LlamaSession: class {
      personaId = 'angel';
      get isReady() {
        return mockReady;
      }
      get loadedModelName() {
        return mockReady ? 'model.gguf' : null;
      }
      load = mockLoad;
      unload = mockUnload;
      release = mockRelease;
    },
  };
});

jest.mock('llama.rn', () => ({ initLlama: jest.fn() }));
jest.mock('../src/llm/toolExecutor', () => ({ executeTool: jest.fn() }));
jest.mock('../src/facts/personIdentity', () => ({ lookupPersonIdentity: jest.fn() }));
jest.mock('../src/llm/modelFile', () => ({
  discardUnpublishedModel: jest.fn(async () => {}),
  findModel: jest.fn(async () => '/docs/model.gguf'),
  pickModel: jest.fn(async () => null),
  rememberModel: jest.fn(),
}));
jest.mock('../src/speech/backend', () => ({ registerSpeechBackend: jest.fn() }));
jest.mock('../src/speech/kokoroBackend', () => ({ kokoroSpeechBackend: {} }));
jest.mock('../src/log/chatLog', () => ({
  logChat: jest.fn(),
  logSystemNote: jest.fn(),
  pruneChatLog: jest.fn(),
  rotateChatSession: jest.fn(),
}));
jest.mock('../src/camp/campBoard', () => ({
  migrateLegacyOwnPack: jest.fn(),
  pruneCampPosts: jest.fn(),
  reconcileWriterIncarnation: jest.fn(() => ({ token: 't', rotated: false })),
}));
jest.mock('../src/events/db', () => ({
  getDb: jest.fn(() => ({
    execute: jest.fn(() => ({ rows: { _array: [], length: 0, item: () => null } })),
  })),
  getSetting: (key: string) => mockSettings.get(key) ?? null,
  setSetting: (key: string, value: string) => {
    mockSettings.set(key, value);
  },
  listPacks: jest.fn(() => []),
  rebuildFtsIndexes: jest.fn(),
  rebuildFtsAfterCommit: jest.fn(() => null),
  identityAffiliationTerms: jest.fn(() => []),
}));
jest.mock('@dr.pogodin/react-native-fs', () => ({
  CachesDirectoryPath: '/cache',
  DocumentDirectoryPath: '/docs',
  exists: jest.fn(async () => false),
  hash: jest.fn(async () => 'sha'),
  mkdir: jest.fn(async () => {}),
  readDir: jest.fn(async () => []),
  readFile: jest.fn(async () => ''),
  stat: jest.fn(async () => ({ size: 1, mtime: new Date(), ctime: new Date() })),
  unlink: jest.fn(async () => {}),
  writeFile: jest.fn(async () => {}),
}));

import App from '../App';
import { ANGEL_ENABLED_KEY } from '../src/llm/angelRest';
import { findModel, pickModel } from '../src/llm/modelFile';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

async function boot(): Promise<ReactTestRenderer> {
  const result: { renderer?: ReactTestRenderer } = {};
  await act(async () => {
    result.renderer = create(<App />);
    await flush();
  });
  return result.renderer!;
}

/** The switch, as the camper flips it. */
async function flip(renderer: ReactTestRenderer, awake: boolean) {
  const node = renderer.root.findByProps({ accessibilityLabel: 'mock-angel-switch' });
  await act(async () => {
    node.props.onPress(awake);
    await flush();
  });
}

describe('the Angel rests on a small phone', () => {
  beforeEach(() => {
    mockReady = false;
    mockSettings.clear();
    mockLoad.mockReset().mockImplementation(async (_path, onStatus) => {
      mockReady = true;
      onStatus({ state: 'ready', modelName: 'model.gguf' });
      return true;
    });
    mockUnload.mockReset().mockResolvedValue(undefined);
    mockRelease.mockReset().mockResolvedValue(undefined);
    (findModel as jest.Mock).mockReset().mockResolvedValue('/docs/model.gguf');
    (pickModel as jest.Mock).mockReset().mockResolvedValue(null);
    mockTotalMemory.mockReset().mockResolvedValue(8 * GB);
  });

  it('does not load the model at startup on a 4 GB phone nobody has asked', async () => {
    mockTotalMemory.mockResolvedValue(4 * GB);

    await boot();

    expect(mockLoad).not.toHaveBeenCalled();
    expect(chatProps.current.angel).toEqual({
      awake: false,
      constrained: true,
      chosen: false,
    });
  });

  it('loads at startup exactly as before when that phone opted in', async () => {
    mockTotalMemory.mockResolvedValue(4 * GB);
    mockSettings.set(ANGEL_ENABLED_KEY, 'awake');

    await boot();

    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(mockLoad.mock.calls[0][0]).toBe('/docs/model.gguf');
    expect(chatProps.current.angel).toMatchObject({ awake: true, chosen: true });
  });

  it('leaves a roomy phone completely unchanged', async () => {
    mockTotalMemory.mockResolvedValue(8 * GB);

    await boot();

    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(mockLoad.mock.calls[0][0]).toBe('/docs/model.gguf');
    expect(chatProps.current.angel).toEqual({
      awake: true,
      constrained: false,
      chosen: false,
    });
  });

  it('honours a big phone that asked her to rest', async () => {
    mockTotalMemory.mockResolvedValue(8 * GB);
    mockSettings.set(ANGEL_ENABLED_KEY, 'resting');

    await boot();

    expect(mockLoad).not.toHaveBeenCalled();
  });

  it('wakes her the moment the switch is flipped, not next launch', async () => {
    mockTotalMemory.mockResolvedValue(4 * GB);
    const renderer = await boot();
    expect(mockLoad).not.toHaveBeenCalled();

    await flip(renderer, true);

    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(mockLoad.mock.calls[0][0]).toBe('/docs/model.gguf');
    // Persisted, so the next launch starts her without being asked again.
    expect(mockSettings.get(ANGEL_ENABLED_KEY)).toBe('awake');
    expect(chatProps.current.angel).toMatchObject({ awake: true, chosen: true });
    expect(chatProps.current.busy).toBe(false);
  });

  it('frees the model the moment she is sent to rest, not next launch', async () => {
    mockTotalMemory.mockResolvedValue(4 * GB);
    mockSettings.set(ANGEL_ENABLED_KEY, 'awake');
    const renderer = await boot();
    expect(mockLoad).toHaveBeenCalledTimes(1);

    await flip(renderer, false);

    expect(mockUnload).toHaveBeenCalledTimes(1);
    expect(mockSettings.get(ANGEL_ENABLED_KEY)).toBe('resting');
    expect(chatProps.current.angel).toMatchObject({ awake: false, chosen: true });
  });

  it('treats going and getting a model as the camper saying yes', async () => {
    // Otherwise a camper on a small phone waits out a multi-GB download and
    // the Angel goes back to resting on the next launch, having never been
    // asked anything.
    mockTotalMemory.mockResolvedValue(4 * GB);
    (pickModel as jest.Mock).mockResolvedValue('/docs/picked.gguf');
    const { Alert } = require('react-native');
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const renderer = await boot();
    expect(mockSettings.get(ANGEL_ENABLED_KEY)).toBeUndefined();

    const pick = renderer.root.findByProps({ accessibilityLabel: 'mock-pick-model' });
    await act(async () => {
      pick.props.onPress();
      await flush();
    });
    const buttons = alert.mock.calls[alert.mock.calls.length - 1][2] as {
      text: string;
      onPress?: () => void;
    }[];
    const fileRow = buttons.find(b => b.text.startsWith('A file on this phone'));
    await act(async () => {
      fileRow?.onPress?.();
      await flush();
    });

    expect(mockLoad).toHaveBeenCalledWith('/docs/picked.gguf', expect.anything());
    expect(mockSettings.get(ANGEL_ENABLED_KEY)).toBe('awake');
    expect(chatProps.current.angel).toMatchObject({ awake: true, chosen: true });
    alert.mockRestore();
  });

  it('carries the same switch into Settings, where the choice lives after', async () => {
    mockTotalMemory.mockResolvedValue(4 * GB);
    const renderer = await boot();

    const settingsTab = renderer.root.findByProps({ accessibilityLabel: 'Settings' });
    await act(async () => {
      settingsTab.props.onPress();
      await flush();
    });

    // Both halves: a posture with no handler renders nothing at all, which
    // is how a wired-looking control becomes a prop (exportsHaveCallers).
    expect(settingsProps.current.angel).toMatchObject({ awake: false });
    expect(typeof settingsProps.current.onAngelChange).toBe('function');
  });

  it('opens the chooser instead of pretending, when there is nothing to wake', async () => {
    mockTotalMemory.mockResolvedValue(4 * GB);
    (findModel as jest.Mock).mockResolvedValue(null);
    const { Alert } = require('react-native');
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const renderer = await boot();

    await flip(renderer, true);

    expect(mockLoad).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalled();
    expect(alert.mock.calls[0][0]).toBe('Choose a model');
    alert.mockRestore();
  });

  /**
   * The Settings half, asserted at the source (the radioTruthRendered
   * pattern): App handing the props down is proven above by render, but the
   * screen must actually MOUNT the control — a screen that takes a posture
   * and renders nothing with it is the prop-with-no-caller shape this repo
   * has shipped five times. Dies on: deleting the AngelRestCard mount, or
   * dropping either prop from the destructure.
   */
  it('really mounts the switch inside Settings, not just accepts it', () => {
    // Named for this suite: these files are SCRIPTS, so a top-level const is
    // global and a plain `read`/`source` collides with other suites (TS2451).
    const angelSource = require('fs').readFileSync(
      'src/screens/SettingsScreen.tsx',
      'utf8',
    ) as string;
    expect(angelSource).toContain('<AngelRestCard');
    expect(angelSource).toMatch(/angel && onAngelChange/);
  });
});
