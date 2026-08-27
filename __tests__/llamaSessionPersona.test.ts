import { initLlama } from 'llama.rn';
import { stat } from '@dr.pogodin/react-native-fs';
import { LlamaSession } from '../src/llm/LlamaSession';
import {
  DEFAULT_PERSONA_ID,
  getPersona,
  PERSONAS,
  type Persona,
} from '../src/llm/personas';
import {
  currentChatSessionId,
  logSystemNote,
  rotateChatSession,
} from '../src/log/chatLog';
import type { ModelStatus, PersonRef } from '../src/types';

jest.mock('llama.rn', () => ({ initLlama: jest.fn() }));

jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  exists: jest.fn(async () => false),
  hash: jest.fn(async (path: string) => `${path}:sha256`),
  mkdir: jest.fn(async () => {}),
  read: jest.fn(async (path: string, _length: number, position: number) => `${path}:${position}`),
  readDir: jest.fn(async () => []),
  unlink: jest.fn(async () => {}),
  stat: jest.fn(async (path: string) => ({
    path,
    originalFilepath: path,
    size: 1024,
    mtime: new Date('2026-08-24T00:00:00Z'),
    ctime: new Date('2026-08-24T00:00:01Z'),
  })),
}));

jest.mock('../src/events/db', () => ({
  identityAffiliationTerms: () => [],
}));

let mockSessionId = 'session-0';
jest.mock('../src/log/chatLog', () => ({
  currentChatSessionId: jest.fn(() => mockSessionId),
  logChat: jest.fn(),
  logSystemNote: jest.fn(),
  rotateChatSession: jest.fn(() => {
    mockSessionId = `session-${Number(mockSessionId.split('-')[1]) + 1}`;
    return mockSessionId;
  }),
}));

jest.mock('../src/llm/toolExecutor', () => ({ executeTool: jest.fn() }));
jest.mock('../src/facts/personIdentity', () => ({ lookupPersonIdentity: jest.fn() }));

type Context = ReturnType<typeof context>;
type Internals = {
  history: unknown[];
  pendingEventQuery: { query: string; rawUserText: string } | null;
  lastPersonEntity: PersonRef | null;
};

const targetPersona: Persona = {
  id: 'test-guide',
  name: 'Test Guide',
  label: 'Guide',
  systemPrompt: `${getPersona(DEFAULT_PERSONA_ID).systemPrompt}\nTest variant.`,
  ready: true,
};

function context() {
  return {
    completion: jest.fn<Promise<unknown>, [unknown]>(),
    saveSession: jest.fn(async () => {}),
    loadSession: jest.fn(async () => {}),
    clearCache: jest.fn(async () => {}),
    stopCompletion: jest.fn(async () => {}),
    release: jest.fn(async () => {}),
  };
}

function internals(session: LlamaSession): Internals {
  return session as unknown as Internals;
}

function seedConversation(session: LlamaSession) {
  const state = internals(session);
  state.history = [{
    user: { role: 'user', content: 'Who is Riv?' },
    assistant: { role: 'assistant', content: 'A campmate.' },
    noToolFailure: false,
    omitFromInference: false,
  }];
  state.pendingEventQuery = {
    query: 'sunrise events',
    rawUserText: 'sunrise events this week',
  };
  state.lastPersonEntity = { pack_id: 'camp', id: 'riv', name: 'Riv' };
  return {
    history: state.history,
    pendingEventQuery: state.pendingEventQuery,
    lastPersonEntity: state.lastPersonEntity,
  };
}

async function loadedSession(ctx: Context) {
  (initLlama as jest.Mock).mockResolvedValueOnce(ctx);
  const session = new LlamaSession(DEFAULT_PERSONA_ID);
  await session.load('/model.gguf', () => {});
  return session;
}

describe('LlamaSession atomic persona switching', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSessionId = 'session-0';
    (stat as jest.Mock).mockResolvedValue({
      path: '/model.gguf',
      originalFilepath: '/model.gguf',
      size: 1024,
      mtime: new Date('2026-08-24T00:00:00Z'),
      ctime: new Date('2026-08-24T00:00:01Z'),
    });
    PERSONAS.push(targetPersona);
  });

  afterEach(() => {
    expect(PERSONAS.pop()).toBe(targetPersona);
  });

  it('rolls back a failed target restore without publishing persona, conversation, session, or log changes', async () => {
    const ctx = context();
    ctx.completion
      .mockResolvedValueOnce({ content: '' })
      .mockRejectedValueOnce(new Error('target restore failed'))
      .mockResolvedValueOnce({ content: '' });
    const session = await loadedSession(ctx);
    const previous = seedConversation(session);
    const sessionId = currentChatSessionId();
    const logCalls = (logSystemNote as jest.Mock).mock.calls.slice();
    const statuses: ModelStatus[] = [];

    await expect(session.setPersona(targetPersona.id, s => statuses.push(s)))
      .rejects.toThrow('target restore failed');

    expect(session.personaId).toBe(DEFAULT_PERSONA_ID);
    expect(session.isReady).toBe(true);
    expect(internals(session)).toMatchObject(previous);
    expect(currentChatSessionId()).toBe(sessionId);
    expect(rotateChatSession).not.toHaveBeenCalled();
    expect((logSystemNote as jest.Mock).mock.calls).toEqual(logCalls);
    expect(statuses).toEqual([{
      state: 'ready',
      modelName: 'model.gguf',
      detail: 'Could not switch to Guide: target restore failed. Angel was restored.',
    }]);
    expect(ctx.clearCache).toHaveBeenCalledTimes(2);
    expect(ctx.completion.mock.calls[1][0]).toMatchObject({
      messages: [{ role: 'system', content: targetPersona.systemPrompt }],
    });
    expect(ctx.completion.mock.calls[2][0]).toMatchObject({
      messages: [{ role: 'system', content: getPersona(DEFAULT_PERSONA_ID).systemPrompt }],
    });
    expect(initLlama).toHaveBeenCalledTimes(1);
  });

  it('quarantines a failed rollback as non-ready and recovers on retry without mixed persona state', async () => {
    const ctx = context();
    ctx.completion
      .mockResolvedValueOnce({ content: '' })
      .mockRejectedValueOnce(new Error('target restore failed'))
      .mockRejectedValueOnce(new Error('rollback restore failed'))
      .mockResolvedValueOnce({ content: '' });
    const session = await loadedSession(ctx);
    const previous = seedConversation(session);
    const sessionId = currentChatSessionId();
    const logCalls = (logSystemNote as jest.Mock).mock.calls.slice();
    const statuses: ModelStatus[] = [];

    await expect(session.setPersona(targetPersona.id, s => statuses.push(s)))
      .rejects.toThrow(
        'Persona switch angel -> test-guide failed: target restore failed; ' +
        'restoring angel also failed: rollback restore failed',
      );

    expect(session.personaId).toBe(DEFAULT_PERSONA_ID);
    expect(session.isReady).toBe(false);
    expect(internals(session)).toMatchObject(previous);
    expect(currentChatSessionId()).toBe(sessionId);
    expect(rotateChatSession).not.toHaveBeenCalled();
    expect((logSystemNote as jest.Mock).mock.calls).toEqual(logCalls);
    expect(statuses.at(-1)).toMatchObject({
      state: 'error',
      detail: expect.stringContaining('resident model is not ready'),
    });
    expect(ctx.clearCache).toHaveBeenCalledTimes(3);

    await expect(session.setPersona(targetPersona.id, s => statuses.push(s)))
      .resolves.toBeUndefined();

    expect(session.personaId).toBe(targetPersona.id);
    expect(session.isReady).toBe(true);
    expect(internals(session)).toMatchObject({
      history: [],
      pendingEventQuery: null,
      lastPersonEntity: null,
    });
    expect(currentChatSessionId()).not.toBe(sessionId);
    expect(rotateChatSession).toHaveBeenCalledTimes(1);
    expect(logSystemNote).toHaveBeenCalledWith(
      targetPersona.id,
      `persona switch: ${DEFAULT_PERSONA_ID} -> ${targetPersona.id}`,
    );
    expect(statuses.at(-1)).toEqual({ state: 'ready', modelName: 'model.gguf' });
    expect(ctx.clearCache).toHaveBeenCalledTimes(4);
    expect(ctx.completion.mock.calls[3][0]).toMatchObject({
      messages: [{ role: 'system', content: targetPersona.systemPrompt }],
    });
    expect(initLlama).toHaveBeenCalledTimes(1);
  });

  it('keeps the current conversation published when a new-conversation preparation fails', async () => {
    const ctx = context();
    ctx.completion
      .mockResolvedValueOnce({ content: '' })
      .mockRejectedValueOnce(new Error('fresh prefix failed'))
      .mockResolvedValueOnce({ content: '' });
    const session = await loadedSession(ctx);
    const previous = seedConversation(session);
    const sessionId = currentChatSessionId();
    const logCalls = (logSystemNote as jest.Mock).mock.calls.slice();
    const statuses: ModelStatus[] = [];

    await expect(session.newConversation(s => statuses.push(s)))
      .rejects.toThrow('fresh prefix failed');

    expect(session.isReady).toBe(true);
    expect(internals(session)).toMatchObject(previous);
    expect(currentChatSessionId()).toBe(sessionId);
    expect(rotateChatSession).not.toHaveBeenCalled();
    expect((logSystemNote as jest.Mock).mock.calls).toEqual(logCalls);
    expect(statuses).toEqual([{
      state: 'ready',
      modelName: 'model.gguf',
      detail:
        'Could not start a new conversation: fresh prefix failed. ' +
        'The previous conversation was restored.',
    }]);
    expect(ctx.clearCache).toHaveBeenCalledTimes(2);
    expect(initLlama).toHaveBeenCalledTimes(1);
  });

  it('clears quarantine only after a new-conversation prefix is prepared successfully', async () => {
    const ctx = context();
    ctx.completion
      .mockResolvedValueOnce({ content: '' })
      .mockRejectedValueOnce(new Error('target restore failed'))
      .mockRejectedValueOnce(new Error('rollback restore failed'))
      .mockResolvedValueOnce({ content: '' });
    const session = await loadedSession(ctx);
    seedConversation(session);

    await expect(session.setPersona(targetPersona.id)).rejects.toThrow(
      'resident model is not ready',
    );
    expect(session.isReady).toBe(false);

    const statuses: ModelStatus[] = [];
    await expect(session.newConversation(s => statuses.push(s)))
      .resolves.toBeUndefined();

    expect(session.personaId).toBe(DEFAULT_PERSONA_ID);
    expect(session.isReady).toBe(true);
    expect(internals(session)).toMatchObject({
      history: [],
      pendingEventQuery: null,
      lastPersonEntity: null,
    });
    expect(rotateChatSession).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual([{ state: 'ready', modelName: 'model.gguf' }]);
    expect(initLlama).toHaveBeenCalledTimes(1);
  });
});
