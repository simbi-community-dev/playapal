import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { ModelStatus } from '../src/types';

const mockChatMounts = jest.fn();
const mockChatActive: boolean[] = [];
const mockStatuses: unknown[] = [];
const mockLoad = jest.fn<
  Promise<boolean>,
  [string, (status: ModelStatus) => void]
>(async () => true);
const mockRelease = jest.fn(async () => {});
let mockReady = false;
let mockModelName: string | null = null;

// IA adaptation: this branch's App mounts the Pods tab (kept-mounted) and
// the compass overlay, which reach geolocation and the crew radio; both
// are inert here — this suite is about the MODEL lifecycle.
jest.mock('react-native-sensors', () => {
  const subscribe = jest.fn();
  const unsubscribe = jest.fn();
  return {
    __esModule: true,
    magnetometer: {
      subscribe: (obs: unknown) => {
        subscribe(obs);
        return { unsubscribe };
      },
    },
    setUpdateIntervalForType: jest.fn(),
    SensorTypes: { magnetometer: 'magnetometer' },
    __mocks: { subscribe, unsubscribe },
  };
});

jest.mock('react-native-device-info', () => ({
  __esModule: true,
  default: { getTotalMemory: jest.fn(async () => 0) },
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
  return { RightNowScreen: () => ReactModule.createElement(Text, null, 'Right Now Screen') };
});
jest.mock('../src/screens/CampScreen', () => {
  const ReactModule = require('react');
  const { Text } = require('react-native');
  return { CampScreen: () => ReactModule.createElement(Text, null, 'Camp Screen') };
});
jest.mock('../src/screens/SettingsScreen', () => {
  const ReactModule = require('react');
  const { Text } = require('react-native');
  return { SettingsScreen: () => ReactModule.createElement(Text, null, 'Settings Screen') };
});
jest.mock('../src/screens/ChatScreen', () => {
  const ReactModule = require('react');
  const { Pressable, Text, View } = require('react-native');
  return {
    ChatScreen: ({
      active,
      status,
      onPickModel,
    }: {
      active: boolean;
      status: unknown;
      onPickModel: () => void;
    }) => {
      const [transcript, setTranscript] = ReactModule.useState('blank');
      mockStatuses.push(status);
      ReactModule.useEffect(() => {
        mockChatMounts();
      }, []);
      mockChatActive.push(active);
      return ReactModule.createElement(
        View,
        null,
        ReactModule.createElement(
          Pressable,
          { accessibilityLabel: 'mock-chat', onPress: () => setTranscript('remembered') },
          ReactModule.createElement(Text, null, transcript),
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

jest.mock('../src/llm/LlamaSession', () => ({
  // The phone-size probe App's startup gate reads (angelRest.ts). This suite
  // is the MODEL LIFECYCLE on an ordinary phone — the small-phone gate has
  // its own suite (appAngelRest.test.tsx) — so the answer is a plain "roomy",
  // which is exactly the behaviour every case below was written against.
  memoryConstrainedDevice: async () => false,
  LlamaSession: class {
    personaId = 'angel';
    get isReady() {
      return mockReady;
    }
    get loadedModelName() {
      return mockModelName;
    }
    load = mockLoad;
    release = mockRelease;
  },
}));
jest.mock('../src/llm/modelFile', () => ({
  discardUnpublishedModel: jest.fn(async () => {}),
  findModel: jest.fn(async () => null),
  pickModel: jest.fn(async () => null),
  rememberModel: jest.fn(),
}));
jest.mock('../src/speech/backend', () => ({ registerSpeechBackend: jest.fn() }));
jest.mock('../src/speech/kokoroBackend', () => ({ kokoroSpeechBackend: {} }));
jest.mock('../src/log/chatLog', () => ({ pruneChatLog: jest.fn() }));
jest.mock('../src/camp/campBoard', () => ({
  migrateLegacyOwnPack: jest.fn(),
  pruneCampPosts: jest.fn(),
  reconcileWriterIncarnation: jest.fn(() => ({ token: 'token' })),
}));
jest.mock('../src/events/db', () => ({
  // IA adaptation: this branch's App also reads onboarding/tour settings,
  // reconciles the camp incarnation, and mounts tabs whose stores read the
  // db — everything answers empty here; the suite is about MODEL lifecycle.
  getDb: jest.fn(() => ({
    execute: jest.fn(() => ({
      rows: { _array: [], length: 0, item: () => null },
    })),
  })),
  getSetting: jest.fn(() => null),
  setSetting: jest.fn(),
  listPacks: jest.fn(() => []),
  rebuildFtsIndexes: jest.fn(),
  rebuildFtsAfterCommit: jest.fn(() => null),
  identityAffiliationTerms: jest.fn(() => []),
}));
jest.mock('../src/camp/campBoard', () => {
  const actual = jest.requireActual('../src/camp/campBoard');
  return {
    ...actual,
    migrateLegacyOwnPack: jest.fn(),
    reconcileWriterIncarnation: jest.fn(() => ({ token: 't', rotated: false })),
    pruneCampPosts: jest.fn(),
  };
});
jest.mock('@dr.pogodin/react-native-fs', () => ({
  CachesDirectoryPath: '/cache',
  exists: jest.fn(async () => false),
  readFile: jest.fn(async () => ''),
  writeFile: jest.fn(async () => {}),
}));

import { Alert } from 'react-native';
import App from '../App';
import {
  discardUnpublishedModel,
  findModel,
  pickModel,
  rememberModel,
} from '../src/llm/modelFile';

function text(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(text).join('');
  if (value && typeof value === 'object' && 'children' in value) {
    return text((value as { children?: unknown }).children);
  }
  return '';
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => {
    resolve = yes;
  });
  return { promise, resolve };
}

// IA adaptation: on this branch Angel is an OVERLAY over a 4-tab shell
// (Now/Pods/Camp/Settings), opened from the header pill and closed with ✕,
// and "choose model" opens an Alert chooser whose LAST row is the file
// import. The lifecycle contracts under test are unchanged — only the
// doors moved.
function pressLabel(renderer: ReactTestRenderer, accessibilityLabel: string) {
  const node = renderer.root.findByProps({ accessibilityLabel });
  act(() => node.props.onPress());
}

const flush = async () =>
  new Promise<void>(resolve => setImmediate(resolve));

/** Drive the chooser to its "A file on this phone…" row: press the mock
 * chat's pick button (opens the Alert chooser), then press the import row
 * captured by the Alert spy. Resolves once queued microtasks flushed. */
async function chooseFileImport(renderer: ReactTestRenderer) {
  const pick = renderer.root.findByProps({ accessibilityLabel: 'mock-pick-model' });
  await act(async () => {
    pick.props.onPress();
    await flush();
  });
  const calls = (Alert.alert as jest.Mock).mock.calls;
  const buttons = calls[calls.length - 1][2] as {
    text: string;
    onPress?: () => void;
  }[];
  const fileRow = buttons.find(b => b.text.startsWith('A file on this phone'));
  if (!fileRow?.onPress) {
    throw new Error('chooser did not offer the file import row');
  }
  await act(async () => {
    fileRow.onPress!();
    await flush();
  });
}

describe('Angel tab lifecycle', () => {
  beforeEach(() => {
    mockReady = false;
    mockModelName = null;
    mockStatuses.length = 0;
    mockLoad.mockReset().mockResolvedValue(true);
    mockRelease.mockReset().mockResolvedValue(undefined);
    (findModel as jest.Mock).mockReset().mockResolvedValue(null);
    (pickModel as jest.Mock).mockReset().mockResolvedValue(null);
    (rememberModel as jest.Mock).mockReset();
    (discardUnpublishedModel as jest.Mock).mockReset().mockResolvedValue(undefined);
    jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });

  it('keeps the visible transcript mounted with the app-resident session across tabs', async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<App />);
    });

    pressLabel(renderer!, 'Open the Angel conversation');
    const chat = renderer!.root.findByProps({ accessibilityLabel: 'mock-chat' });
    act(() => chat.props.onPress());
    expect(text(renderer!.toJSON())).toContain('remembered');

    // Closing the overlay deactivates the chat (a hidden chat must not
    // speak) without unmounting it; reopening finds the transcript intact.
    pressLabel(renderer!, 'Close the conversation');
    expect(mockChatActive.at(-1)).toBe(false);
    pressLabel(renderer!, 'Open the Angel conversation');

    expect(text(renderer!.toJSON())).toContain('remembered');
    expect(mockChatMounts).toHaveBeenCalledTimes(1);
    expect(mockChatActive.at(-1)).toBe(true);
  });

  it('keeps the resident model ready when model picking is cancelled', async () => {
    (findModel as jest.Mock).mockResolvedValue('/old.gguf');
    mockLoad.mockImplementationOnce(async (_path, onStatus) => {
      mockReady = true;
      mockModelName = 'old.gguf';
      onStatus({ state: 'ready', modelName: 'old.gguf' });
      return true;
    });
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<App />);
    });
    expect(mockStatuses.at(-1)).toEqual({ state: 'ready', modelName: 'old.gguf' });

    await chooseFileImport(renderer!);

    expect(mockStatuses.at(-1)).toEqual({ state: 'ready', modelName: 'old.gguf' });
  });

  it('does not restore stale startup status when a picker cancellation races load completion', async () => {
    const loadGate = deferred<void>();
    const pickGate = deferred<string | null>();
    (findModel as jest.Mock).mockResolvedValue('/old.gguf');
    mockLoad.mockImplementationOnce(async (_path, onStatus) => {
      onStatus({ state: 'loading', detail: 'Loading model…' });
      await loadGate.promise;
      mockReady = true;
      mockModelName = 'old.gguf';
      onStatus({ state: 'ready', modelName: 'old.gguf' });
      return true;
    });
    (pickModel as jest.Mock).mockReturnValue(pickGate.promise);
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<App />);
    });
    await act(async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
    });

    await chooseFileImport(renderer!);
    await act(async () => {
      loadGate.resolve();
      await loadGate.promise;
      await flush();
    });
    await act(async () => {
      pickGate.resolve(null);
      await flush();
    });

    expect(mockStatuses.at(-1)).toEqual({ state: 'ready', modelName: 'old.gguf' });
  });

  it('does not let delayed startup discovery override an explicit model choice', async () => {
    const startupGate = deferred<string | null>();
    (findModel as jest.Mock).mockReturnValue(startupGate.promise);
    (pickModel as jest.Mock).mockResolvedValue('/chosen.gguf');
    let renderer: ReactTestRenderer;
    act(() => {
      renderer = create(<App />);
    });
    await chooseFileImport(renderer!);
    await act(async () => {
      startupGate.resolve('/startup.gguf');
      await startupGate.promise;
      await new Promise<void>(resolve => setImmediate(resolve));
    });

    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(mockLoad.mock.calls[0][0]).toBe('/chosen.gguf');
  });

  it('releases the resident native session when the app unmounts', async () => {
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<App />);
    });
    act(() => renderer!.unmount());
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('keeps retrying a rejected native release after unmount', async () => {
    mockRelease
      .mockRejectedValueOnce(new Error('native busy'))
      .mockResolvedValueOnce(undefined);
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<App />);
    });

    act(() => renderer!.unmount());
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockRelease).toHaveBeenCalledTimes(1);

    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 300));
    });
    expect(mockRelease).toHaveBeenCalledTimes(2);
  });

  it('keeps the resident model ready when a picked replacement rejects', async () => {
    mockReady = true;
    mockLoad.mockImplementationOnce(async (_path, onStatus) => {
      onStatus({
        state: 'ready',
        modelName: 'old.gguf',
        detail: 'Could not load bad.gguf; kept old.gguf ready: warm failed',
      });
      throw new Error('warm failed');
    });
    (pickModel as jest.Mock).mockResolvedValue('/bad.gguf');
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<App />);
    });

    await chooseFileImport(renderer!);

    expect(mockStatuses.at(-1)).toEqual({
      state: 'ready',
      modelName: 'old.gguf',
      detail: 'Could not load bad.gguf; kept old.gguf ready: warm failed',
    });
    expect(mockStatuses.at(-1)).not.toEqual({ state: 'error', detail: 'warm failed' });
    expect(rememberModel).not.toHaveBeenCalled();
    expect(discardUnpublishedModel).toHaveBeenCalledWith('/bad.gguf');
  });

  it('C10: a failed import with a resident model is SAID, not silently restored', async () => {
    // Binding review C10: every failure of the file import while a model
    // was resident restored ready silently — the camper re-attempted a
    // doomed import with zero feedback.
    mockReady = true;
    mockModelName = 'old.gguf';
    (pickModel as jest.Mock).mockResolvedValue('/bad.gguf');
    mockLoad.mockRejectedValueOnce(new Error('damaged'));
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<App />);
    });

    await chooseFileImport(renderer!);

    const alerts = (Alert.alert as jest.Mock).mock.calls;
    expect(
      alerts.some(call => String(call[0]).includes('Import failed')),
    ).toBe(true);
    expect(mockStatuses.at(-1)).toEqual({ state: 'ready', modelName: 'old.gguf' });
  });

  it('restores a healthy resident when import fails before native load', async () => {
    (findModel as jest.Mock).mockResolvedValue('/old.gguf');
    mockLoad.mockImplementationOnce(async (_path, onStatus) => {
      mockReady = true;
      mockModelName = 'old.gguf';
      onStatus({ state: 'ready', modelName: 'old.gguf' });
      return true;
    });
    (pickModel as jest.Mock).mockRejectedValue(new Error('copy failed'));
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<App />);
    });

    await chooseFileImport(renderer!);

    expect(mockStatuses.at(-1)).toEqual({ state: 'ready', modelName: 'old.gguf' });
    expect(mockLoad).toHaveBeenCalledTimes(1);
  });

  it('does not persist an explicit model whose superseded load never publishes', async () => {
    mockReady = true;
    (pickModel as jest.Mock).mockResolvedValue('/superseded.gguf');
    mockLoad.mockResolvedValueOnce(false);
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<App />);
    });

    await chooseFileImport(renderer!);

    expect(rememberModel).not.toHaveBeenCalled();
    expect(discardUnpublishedModel).toHaveBeenCalledWith('/superseded.gguf');
  });

  it('persists an explicit model only after its native load succeeds', async () => {
    (pickModel as jest.Mock).mockResolvedValue('/chosen.gguf');
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<App />);
    });

    await chooseFileImport(renderer!);

    expect(rememberModel).toHaveBeenCalledWith('/chosen.gguf');
  });

  it('reclaims the previously remembered imported copy after replacement publishes', async () => {
    (pickModel as jest.Mock).mockResolvedValue('/docs/chosen.gguf');
    (rememberModel as jest.Mock).mockReturnValue('/docs/old.gguf');
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<App />);
    });

    await chooseFileImport(renderer!);

    expect(discardUnpublishedModel).toHaveBeenCalledWith('/docs/old.gguf');
    expect(discardUnpublishedModel).not.toHaveBeenCalledWith('/docs/chosen.gguf');
  });

  it('keeps a published model ready while surfacing persistence failure', async () => {
    (pickModel as jest.Mock).mockResolvedValue('/chosen.gguf');
    mockLoad.mockImplementationOnce(async (_path, onStatus) => {
      mockReady = true;
      mockModelName = 'chosen.gguf';
      onStatus({ state: 'ready', modelName: 'chosen.gguf' });
      return true;
    });
    (rememberModel as jest.Mock).mockImplementation(() => {
      throw new Error('settings full');
    });
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<App />);
    });

    await chooseFileImport(renderer!);

    expect(mockStatuses.at(-1)).toEqual({
      state: 'ready',
      modelName: 'chosen.gguf',
      detail: "Running now, but the choice couldn't be saved — this phone may ask again next launch.",
    });
    expect(discardUnpublishedModel).not.toHaveBeenCalled();
  });
});
