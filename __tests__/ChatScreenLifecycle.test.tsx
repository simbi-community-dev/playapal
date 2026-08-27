import React from 'react';
import { Keyboard, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { PackRow } from '../src/types';
import type {
  ChatTurnResult,
  TurnCallbacks,
} from '../src/llm/LlamaSession';
import { ChatScreen } from '../src/screens/ChatScreen';
import type { AngelPosture } from '../src/llm/angelRest';
import type { LlamaSession } from '../src/llm/LlamaSession';

const mockInputBlur = jest.fn();
const mockSpeak = jest.fn();
const mockSpeakQueued = jest.fn();
const mockStop = jest.fn();
const mockSpeaker = {
  speakingId: null,
  speak: mockSpeak,
  speakQueued: mockSpeakQueued,
  stop: mockStop,
};
const mockListPacks = jest.fn<PackRow[], []>();
/** The transcript's scroll seam. One stable spy (not a fresh jest.fn per
 * render) and the live props, so a test can ask whether the list FOLLOWED a
 * growing answer — see "staying with the newest answer". */
const mockScrollToEnd = jest.fn();
const listProps: { current: Record<string, any> } = { current: {} };

jest.mock(
  'react-native/Libraries/Components/TextInput/TextInput',
  () => {
    const ReactModule = require('react');
    const Input = ReactModule.forwardRef(
      (inputProps: Record<string, unknown>, ref: React.Ref<unknown>) => {
        ReactModule.useImperativeHandle(ref, () => ({ blur: mockInputBlur }));
        return ReactModule.createElement('TextInput', inputProps);
      },
    );
    return { __esModule: true, default: Input };
  },
);

jest.mock('react-native/Libraries/Lists/FlatList', () => {
  const ReactModule = require('react');
  const List = ReactModule.forwardRef(
    (
      props: {
        data: unknown[];
        renderItem: (info: { item: unknown; index: number }) => React.ReactNode;
        ListEmptyComponent?: React.ReactNode;
      },
      ref: React.Ref<unknown>,
    ) => {
      const { data, renderItem, ListEmptyComponent } = props;
      // Hand the live props out: the scroll handlers ARE the behaviour under
      // test in "staying with the newest answer", and a mock that swallows
      // them would make that case unwritable.
      listProps.current = props;
      ReactModule.useImperativeHandle(ref, () => ({
        scrollToEnd: mockScrollToEnd,
      }));
      const children = data.length
        ? data.map((item, index) =>
            ReactModule.createElement(
              ReactModule.Fragment,
              { key: index },
              renderItem({ item, index }),
            ),
          )
        : ListEmptyComponent;
      return ReactModule.createElement('FlatList', null, children);
    },
  );
  return { __esModule: true, default: List };
});

jest.mock('../src/speech', () => ({
  loadSpeechSettings: () => ({ enabled: true }),
  SentenceFeed: jest.requireActual('../src/speech/sentenceFeed').SentenceFeed,
  speechForAssistantMessage: (message: string) => message.trim(),
  toMarkdownlessSpeech: (message: string) => message.trim(),
  useSpeaker: () => mockSpeaker,
}));

jest.mock('../src/events/db', () => ({
  listPacks: () => mockListPacks(),
}));

jest.mock('../src/components/MessageBubble', () => {
  const ReactModule = require('react');
  const { Text: NativeText } = require('react-native');
  return {
    MessageBubble: ({ message }: { message: { text: string } }) =>
      ReactModule.createElement(NativeText, null, message.text),
  };
});

// A marker rather than null: "which strip is showing" is itself a contract
// now — a resting Angel's card REPLACES this bar, whose idle wording would
// otherwise contradict it (angel-rest, 2026-08-25).
jest.mock('../src/components/ModelStatusBar', () => {
  const ReactModule = require('react');
  const { Text: NativeText } = require('react-native');
  return {
    ModelStatusBar: () => ReactModule.createElement(NativeText, null, '[status bar]'),
  };
});

jest.mock('../src/components/PulsingLabel', () => {
  const ReactModule = require('react');
  const { Text: NativeText } = require('react-native');
  return {
    PulsingLabel: ({ label }: { label: string }) =>
      ReactModule.createElement(NativeText, null, label),
  };
});

const pack = (id: string, name: string): PackRow => ({
  id,
  name,
  description: name,
  version: 1,
  enabled: true,
  builtin: false,
  eventCount: 1,
  chunkCount: 0,
  postCount: 0,
  nodeCount: 0,
  edgeCount: 0,
});

function screenText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(screenText).join('');
  }
  if (value && typeof value === 'object' && 'children' in value) {
    return screenText((value as { children?: unknown }).children);
  }
  return '';
}

function sessionWith(
  chat: (text: string, callbacks: TurnCallbacks) => Promise<ChatTurnResult>,
): LlamaSession {
  return {
    personaId: 'angel',
    isReady: true,
    chat: jest.fn(chat),
    setPersona: jest.fn(async () => {}),
    newConversation: jest.fn(async () => {}),
    // IA adaptation: this branch's ChatScreen heals an orphaned session
    // pair at mount by asking whether the session carries prior turns.
    hasHistory: jest.fn(() => false),
  } as unknown as LlamaSession;
}

const ready = { state: 'ready' as const, modelName: 'model.gguf' };
const props = (session: LlamaSession, active: boolean) => ({
  session,
  active,
  status: ready,
  onPickModel: jest.fn(),
  onStatus: jest.fn(),
});

function render(
  session: LlamaSession,
  active = true,
): ReactTestRenderer {
  const result: { renderer?: ReactTestRenderer } = {};
  act(() => {
    result.renderer = create(<ChatScreen {...props(session, active)} />);
  });
  return result.renderer!;
}

describe('ChatScreen retained lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListPacks.mockReturnValue([]);
  });

  it('never lets a hidden turn speak again after late token/tool callbacks or reactivation', async () => {
    const turn: {
      callbacks?: TurnCallbacks;
      resolve?: (result: ChatTurnResult) => void;
    } = {};
    const session = sessionWith(
      (_text, callbacks) =>
        new Promise(resolve => {
          turn.callbacks = callbacks;
          turn.resolve = resolve;
        }),
    );
    const renderer = render(session);
    const input = renderer.root.findByType(TextInput);

    act(() => input.props.onChangeText('Where should I go?'));
    act(() => {
      input.props.onSubmitEditing();
    });
    expect(turn.callbacks).toBeDefined();

    act(() => turn.callbacks?.onToken?.('First sentence. '));
    expect(mockSpeakQueued).toHaveBeenCalledTimes(1);

    act(() => renderer.update(<ChatScreen {...props(session, false)} />));
    expect(mockStop).toHaveBeenCalledTimes(2);

    act(() => turn.callbacks?.onToken?.('Late hidden sentence. '));
    act(() => renderer.update(<ChatScreen {...props(session, true)} />));
    act(() =>
      turn.callbacks?.onToolDone?.(
        'lookup_facts',
        [{ kind: 'person' } as never],
        [],
      ),
    );
    await act(async () => {
      turn.resolve?.({
        text: 'Stale final answer.',
        cards: [{ kind: 'person' } as never],
        sources: [],
        answeredFrom: 'packs' as const,
        toolRounds: 1,
      });
      await Promise.resolve();
    });

    expect(mockStop).toHaveBeenCalledTimes(2);
    expect(mockSpeakQueued).toHaveBeenCalledTimes(1);
    expect(mockSpeak).not.toHaveBeenCalled();
  });

  it('stops queued partial speech before replacing a failed stream', async () => {
    const session = sessionWith(async (_text, callbacks) => {
      callbacks.onToken?.('A partial sentence. ');
      throw new Error('decode failed');
    });
    const renderer = render(session);
    const input = renderer.root.findByType(TextInput);

    act(() => input.props.onChangeText('Tell me something'));
    await act(async () => {
      input.props.onSubmitEditing();
      await Promise.resolve();
    });

    expect(mockSpeakQueued).toHaveBeenCalledWith(
      expect.any(String),
      'A partial sentence.',
    );
    expect(mockStop).toHaveBeenCalledTimes(2);
    // IA adaptation: raw error detail is diagnostics, not conversation
    // (public-QA P2) — the bubble keeps its voice and the console carries
    // the reason. The lifecycle behavior under test is unchanged.
    expect(screenText(renderer.toJSON())).toContain(
      'Something broke in the dust — ask me again.',
    );
    expect(screenText(renderer.toJSON())).not.toContain('A partial sentence.');
  });

  it('refreshes pack chips and the empty state from the live DB on each return', () => {
    const session = sessionWith(async () => ({
      text: '',
      cards: [],
      sources: [],
      answeredFrom: 'packs' as const,
      toolRounds: 0,
    }));
    mockListPacks.mockReturnValue([pack('old', 'Old Guide')]);
    const renderer = render(session);
    expect(screenText(renderer.toJSON())).toContain('Old Guide');

    act(() => renderer.update(<ChatScreen {...props(session, false)} />));
    mockListPacks.mockReturnValue([]);
    act(() => renderer.update(<ChatScreen {...props(session, true)} />));
    expect(screenText(renderer.toJSON())).not.toContain('Old Guide');
    expect(screenText(renderer.toJSON())).toContain(
      'No offline knowledge is enabled yet.',
    );

    act(() => renderer.update(<ChatScreen {...props(session, false)} />));
    mockListPacks.mockReturnValue([pack('new', 'Imported Guide')]);
    act(() => renderer.update(<ChatScreen {...props(session, true)} />));
    expect(screenText(renderer.toJSON())).toContain('Imported Guide');
    expect(screenText(renderer.toJSON())).not.toContain(
      'No offline knowledge is enabled yet.',
    );
  });

  it('blurs the retained input and dismisses the IME when hidden', () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
    const session = sessionWith(async () => ({
      text: '',
      cards: [],
      sources: [],
      answeredFrom: 'packs' as const,
      toolRounds: 0,
    }));
    const renderer = render(session);

    expect(mockInputBlur).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
    act(() => renderer.update(<ChatScreen {...props(session, false)} />));

    expect(mockInputBlur).toHaveBeenCalledTimes(1);
    expect(dismiss).toHaveBeenCalledTimes(1);
    dismiss.mockRestore();
  });
});

/**
 * STAYING WITH THE NEWEST ANSWER — the transcript follows a growing reply
 * while the reader is at the bottom, and leaves them alone when they are not.
 *
 * The old handler scrolled to the end on EVERY content-size change, and an
 * answer streams token by token, so scrolling up to re-read something earlier
 * was undone within a frame — a whole turn long, once every few hundred
 * milliseconds. Same rule as the pod's answering machine
 * (src/crews/PodMessages.tsx): follow the pinned reader, never yank the one
 * who went looking.
 */
describe('staying with the newest answer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListPacks.mockReturnValue([]);
  });

  /** The reader is N points from the bottom of the transcript. */
  function scrollTo(fromBottom: number) {
    act(() =>
      listProps.current.onScroll({
        nativeEvent: {
          contentOffset: { x: 0, y: 1000 - fromBottom },
          contentSize: { width: 300, height: 1200 },
          layoutMeasurement: { width: 300, height: 200 },
        },
      }),
    );
  }

  /** A token landed and the transcript got taller. */
  function grew() {
    act(() => listProps.current.onContentSizeChange(300, 1400));
  }

  it('follows the answer while the reader is at the bottom', () => {
    render(sessionWith(async () => ({ text: 'ok' }) as never));
    grew();
    expect(mockScrollToEnd).toHaveBeenCalled();
  });

  it('does NOT yank a reader who scrolled up to re-read', () => {
    render(sessionWith(async () => ({ text: 'ok' }) as never));
    scrollTo(600); // up in the answer, reading something earlier
    mockScrollToEnd.mockClear();
    grew();
    expect(mockScrollToEnd).not.toHaveBeenCalled();
    // Scrolling back down by hand resumes following — the pin is theirs to
    // take back, and it must not stay stuck off.
    scrollTo(0);
    grew();
    expect(mockScrollToEnd).toHaveBeenCalled();
  });

  /**
   * A RESTING ANGEL SAYS SO, IN HER OWN VOICE (owner ask 2026-08-25: "maybe
   * on a 4gb phone the angel should be disabled by default?"). The surface
   * someone opened expecting her owes them the reason and the way back —
   * and it must not simultaneously claim there is no model on the phone.
   */
  describe('a resting Angel', () => {
    const resting = { awake: false, constrained: true, chosen: false };
    function renderWith(angel: AngelPosture, onAngelChange = jest.fn()) {
      const session = sessionWith(async () => ({ text: 'ok' }) as never);
      const result: { renderer?: ReactTestRenderer } = {};
      act(() => {
        result.renderer = create(
          <ChatScreen
            {...props(session, true)}
            status={{ state: 'idle' }}
            angel={angel}
            onAngelChange={onAngelChange}
          />,
        );
      });
      return { renderer: result.renderer!, onAngelChange };
    }

    it('explains herself warmly instead of showing the model status bar', () => {
      const { renderer } = renderWith(resting);
      const shown = screenText(renderer.toJSON());
      expect(shown).toContain('The Angel is resting');
      expect(shown).toContain('This phone is on the small side');
      expect(shown).toContain('Wake her anyway?');
      // Not one word of machinery, and no "no model yet" contradiction.
      expect(shown).not.toContain('[status bar]');
      expect(shown).not.toMatch(/memory|RAM|crash/i);
    });

    it('offers the switch right there, and says so to a screen reader', () => {
      const { renderer, onAngelChange } = renderWith(resting);
      const control = renderer.root.findByProps({
        accessibilityLabel: 'Wake the Angel',
      });
      expect(control.props.value).toBe(false);
      act(() => control.props.onValueChange(true));
      expect(onAngelChange).toHaveBeenCalledWith(true);
    });

    it('tells the typist she is resting, not that a model is missing', () => {
      const { renderer } = renderWith(resting);
      const input = renderer.root.findByType(TextInput);
      expect(input.props.placeholder).toContain('is resting — wake her above');
      expect(input.props.editable).toBe(false);
    });

    it('gives the status bar back the moment she is awake', () => {
      const { renderer } = renderWith({ ...resting, awake: true, chosen: true });
      const shown = screenText(renderer.toJSON());
      expect(shown).toContain('[status bar]');
      expect(shown).not.toContain('The Angel is resting');
    });
  });

  it('asking a new question takes the pin back', async () => {
    const session = sessionWith(async () => ({ text: 'ok' }) as never);
    const renderer = render(session);
    scrollTo(600);
    mockScrollToEnd.mockClear();
    const input = renderer.root.findByType(TextInput);
    await act(async () => {
      input.props.onChangeText('Where should I go?');
    });
    await act(async () => {
      input.props.onSubmitEditing();
    });
    grew();
    // Nobody asks a question and then wants to keep reading the old answer.
    expect(mockScrollToEnd).toHaveBeenCalled();
  });
});
