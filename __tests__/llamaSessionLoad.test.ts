import {
  LlamaSession,
  modelFileFingerprint,
  warmedSessionHash,
} from '../src/llm/LlamaSession';
import { DEFAULT_PERSONA_ID, getPersona } from '../src/llm/personas';
import { initLlama } from 'llama.rn';
import { exists, hash, readDir, stat, unlink } from '@dr.pogodin/react-native-fs';
import type { ModelStatus } from '../src/types';

jest.mock('llama.rn', () => ({ initLlama: jest.fn() }));

jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  exists: jest.fn(async () => false),
  hash: jest.fn(async (path: string) => `${path}:sha256`),
  mkdir: jest.fn(async () => {}),
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
  // The event-authority routing consults the exact-title catalog on every
  // turn; this suite is about load/ownership lifecycle, so the catalog
  // answers empty (and titleCatalog itself fails soft without this).
  getDb: () => ({
    execute: () => ({ rows: { _array: [], length: 0, item: () => null } }),
  }),
}));

jest.mock('../src/log/chatLog', () => ({
  logChat: jest.fn(),
  logSystemNote: jest.fn(),
  rotateChatSession: jest.fn(),
}));

jest.mock('../src/llm/toolExecutor', () => ({ executeTool: jest.fn() }));
jest.mock('../src/facts/personIdentity', () => ({ lookupPersonIdentity: jest.fn() }));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function context(warm: Promise<unknown> = Promise.resolve({ content: '' })) {
  return {
    completion: jest.fn(() => warm),
    saveSession: jest.fn(async () => {}),
    loadSession: jest.fn(async () => {}),
    clearCache: jest.fn(async () => {}),
    stopCompletion: jest.fn(async () => {}),
    release: jest.fn(async () => {}),
  };
}

function currentContext(session: LlamaSession): unknown {
  return (session as unknown as { context: unknown }).context;
}

function ownedContextCount(session: LlamaSession): number {
  return (session as unknown as { ownedContexts: Set<unknown> }).ownedContexts.size;
}

async function eventually(condition: () => boolean, message: string) {
  for (let i = 0; i < 100; i++) {
    if (condition()) {
      return;
    }
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error(message);
}

async function startedCompletions(...contexts: ReturnType<typeof context>[]) {
  await eventually(
    () => contexts.every(ctx => ctx.completion.mock.calls.length > 0),
    `load did not reach deterministic warm-up barrier: init=${
      (initLlama as jest.Mock).mock.calls.length
    }, completions=${contexts.map(ctx => ctx.completion.mock.calls.length).join(',')}`,
  );
}

describe('LlamaSession context replacement ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (readDir as jest.Mock).mockReset().mockResolvedValue([]);
    (unlink as jest.Mock).mockReset().mockResolvedValue(undefined);
    (stat as jest.Mock).mockReset().mockResolvedValue({
      path: '/model.gguf',
      originalFilepath: '/model.gguf',
      size: 1024,
      mtime: new Date('2026-08-24T00:00:00Z'),
      ctime: new Date('2026-08-24T00:00:01Z'),
    });
  });

  it('publishes only the newest of two overlapping successful loads', async () => {
    const aWarm = deferred<unknown>();
    const bWarm = deferred<unknown>();
    const a = context(aWarm.promise);
    const b = context(bWarm.promise);
    (initLlama as jest.Mock)
      .mockResolvedValueOnce(a)
      .mockResolvedValueOnce(b);
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    const aStatuses: ModelStatus[] = [];
    const bStatuses: ModelStatus[] = [];

    const aLoad = session.load('/a.gguf', s => aStatuses.push(s));
    await startedCompletions(a);
    const bLoad = session.load('/b.gguf', s => bStatuses.push(s));
    expect(a.stopCompletion).toHaveBeenCalledTimes(1);
    expect(initLlama).toHaveBeenCalledTimes(1);

    aWarm.resolve({ content: '' });
    await aLoad;
    await startedCompletions(b);
    bWarm.resolve({ content: '' });
    await bLoad;

    expect(currentContext(session)).toBe(b);
    expect(a.release).toHaveBeenCalledTimes(1);
    expect(b.release).not.toHaveBeenCalled();
    expect(aStatuses.some(s => s.state === 'ready' || s.state === 'error')).toBe(false);
    expect(bStatuses.at(-1)).toEqual({ state: 'ready', modelName: 'b.gguf' });
    expect(ownedContextCount(session)).toBe(1);
  });

  it('releases a candidate superseded during native init without warming it', async () => {
    const aInit = deferred<ReturnType<typeof context>>();
    const a = context();
    const b = context();
    (initLlama as jest.Mock)
      .mockImplementationOnce(() => aInit.promise)
      .mockResolvedValueOnce(b);
    const session = new LlamaSession(DEFAULT_PERSONA_ID);

    const aLoad = session.load('/slow-init.gguf', () => {});
    await eventually(
      () => (initLlama as jest.Mock).mock.calls.length === 1,
      'first load did not reach native init',
    );
    const bLoad = session.load('/new.gguf', () => {});
    expect(initLlama).toHaveBeenCalledTimes(1);
    aInit.resolve(a);
    await aLoad;
    await bLoad;

    expect(currentContext(session)).toBe(b);
    expect(a.completion).not.toHaveBeenCalled();
    expect(a.release).toHaveBeenCalledTimes(1);
  });

  it('ignores a slow stale failure after a newer load succeeds', async () => {
    const aWarm = deferred<unknown>();
    const bWarm = deferred<unknown>();
    const a = context(aWarm.promise);
    const b = context(bWarm.promise);
    (initLlama as jest.Mock)
      .mockResolvedValueOnce(a)
      .mockResolvedValueOnce(b);
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    const aStatuses: ModelStatus[] = [];
    const bStatuses: ModelStatus[] = [];

    const aLoad = session.load('/slow.gguf', s => aStatuses.push(s));
    await startedCompletions(a);
    const bLoad = session.load('/new.gguf', s => bStatuses.push(s));
    aWarm.reject(new Error('stale warm failed'));
    await expect(aLoad).resolves.toBe(false);
    await startedCompletions(b);
    bWarm.resolve({ content: '' });
    await bLoad;

    expect(currentContext(session)).toBe(b);
    expect(a.release).toHaveBeenCalledTimes(1);
    expect(b.release).not.toHaveBeenCalled();
    expect(aStatuses.some(s => s.state === 'error')).toBe(false);
    expect(bStatuses.at(-1)).toEqual({ state: 'ready', modelName: 'new.gguf' });
  });

  it('preserves the healthy old context when replacement stat or warm-up fails', async () => {
    const old = context();
    const badWarm = deferred<unknown>();
    const bad = context(badWarm.promise);
    (initLlama as jest.Mock)
      .mockResolvedValueOnce(old)
      .mockResolvedValueOnce(bad);
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    await session.load('/old.gguf', () => {});

    const statStatuses: ModelStatus[] = [];
    (stat as jest.Mock).mockRejectedValueOnce(new Error('stat failed'));
    await expect(
      session.load('/missing.gguf', s => statStatuses.push(s)),
    ).rejects.toThrow('stat failed');
    expect(currentContext(session)).toBe(old);
    expect(old.release).not.toHaveBeenCalled();
    expect(statStatuses.at(-1)).toEqual({
      state: 'ready',
      modelName: 'old.gguf',
      detail: 'Could not load missing.gguf; kept old.gguf ready: stat failed',
    });

    const warmStatuses: ModelStatus[] = [];
    const badLoad = session.load('/bad.gguf', s => warmStatuses.push(s));
    await startedCompletions(bad);
    badWarm.reject(new Error('warm failed'));
    await expect(badLoad).rejects.toThrow('warm failed');
    expect(currentContext(session)).toBe(old);
    expect(old.release).not.toHaveBeenCalled();
    expect(bad.release).toHaveBeenCalledTimes(1);
    expect(session.isReady).toBe(true);
    expect(warmStatuses.at(-1)).toEqual({
      state: 'ready',
      modelName: 'old.gguf',
      detail: 'Could not load bad.gguf; kept old.gguf ready: warm failed',
    });
  });

  it('retains a superseded candidate whose release fails and retries it explicitly', async () => {
    const aWarm = deferred<unknown>();
    const bWarm = deferred<unknown>();
    const a = context(aWarm.promise);
    a.release
      .mockRejectedValueOnce(new Error('superseded release refused'))
      .mockResolvedValueOnce(undefined);
    const b = context(bWarm.promise);
    (initLlama as jest.Mock)
      .mockResolvedValueOnce(a)
      .mockResolvedValueOnce(b);
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    const staleStatuses: ModelStatus[] = [];

    const aLoad = session.load('/a.gguf', s => staleStatuses.push(s));
    await startedCompletions(a);
    const bLoad = session.load('/b.gguf', () => {});
    aWarm.resolve({ content: '' });
    await aLoad;
    await startedCompletions(b);
    bWarm.resolve({ content: '' });
    await bLoad;

    expect(currentContext(session)).toBe(b);
    expect(a.release).toHaveBeenCalledTimes(2);
    expect(ownedContextCount(session)).toBe(1);
    expect(staleStatuses.some(s => s.state === 'error' || s.state === 'ready')).toBe(false);

    await session.release();
    expect(a.release).toHaveBeenCalledTimes(2);
    expect(b.release).toHaveBeenCalledTimes(1);
    expect(ownedContextCount(session)).toBe(0);
  });

  it('retains a failed old-context release, diagnoses it, and retries without double release', async () => {
    const old = context();
    old.release
      .mockRejectedValueOnce(new Error('native release refused'))
      .mockResolvedValueOnce(undefined);
    const next = context();
    (initLlama as jest.Mock)
      .mockResolvedValueOnce(old)
      .mockResolvedValueOnce(next);
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    await session.load('/old.gguf', () => {});
    const statuses: ModelStatus[] = [];

    await session.load('/next.gguf', s => statuses.push(s));

    expect(currentContext(session)).toBe(next);
    expect(session.isReady).toBe(true);
    expect(ownedContextCount(session)).toBe(2);
    expect(statuses.at(-1)).toEqual({ state: 'ready', modelName: 'next.gguf' });
    expect(old.release).toHaveBeenCalledTimes(1);

    await session.release();
    expect(old.release).toHaveBeenCalledTimes(2);
    expect(next.release).toHaveBeenCalledTimes(1);
    expect(ownedContextCount(session)).toBe(0);
    expect(session.isReady).toBe(false);
  });

  it('serializes concurrent chats on the single native context and transcript', async () => {
    const ctx = context();
    (initLlama as jest.Mock).mockResolvedValueOnce(ctx);
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    await session.load('/model.gguf', () => {});
    const firstGate = deferred<unknown>();
    ctx.completion
      .mockImplementationOnce(() => firstGate.promise)
      .mockResolvedValueOnce({ content: 'Second.' });

    const first = session.chat('hello');
    const second = session.chat('hello');
    await eventually(
      () => ctx.completion.mock.calls.length === 2,
      'first chat did not start',
    );
    expect(ctx.completion).toHaveBeenCalledTimes(2);

    firstGate.resolve({ content: 'First.' });
    await expect(first).resolves.toMatchObject({ text: 'First.' });
    await expect(second).resolves.toMatchObject({ text: 'Second.' });
    expect(ctx.completion).toHaveBeenCalledTimes(3);
  });

  it('keeps an in-flight chat context leased until the turn finishes', async () => {
    const old = context();
    const next = context();
    (initLlama as jest.Mock)
      .mockResolvedValueOnce(old)
      .mockResolvedValueOnce(next);
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    await session.load('/old.gguf', () => {});

    const chatGate = deferred<unknown>();
    old.completion.mockImplementationOnce(() => chatGate.promise);
    const chat = session.chat('hello');
    await eventually(
      () => old.completion.mock.calls.length === 2,
      'chat did not start on the resident context',
    );

    await session.load('/next.gguf', () => {});
    expect(currentContext(session)).toBe(next);
    expect(old.release).not.toHaveBeenCalled();

    chatGate.resolve({ content: 'Hello.' });
    await expect(chat).resolves.toMatchObject({ text: 'Hello.' });
    await eventually(
      () => old.release.mock.calls.length === 1,
      'retired context was not released after its active turn',
    );
  });

  it('waits for retired native memory before allocating another replacement', async () => {
    const releaseGate = deferred<void>();
    const old = context();
    old.release.mockImplementationOnce(() => releaseGate.promise);
    const next = context();
    const newest = context();
    (initLlama as jest.Mock)
      .mockResolvedValueOnce(old)
      .mockResolvedValueOnce(next)
      .mockResolvedValueOnce(newest);
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    await session.load('/old.gguf', () => {});

    const nextLoad = session.load('/next.gguf', () => {});
    await eventually(
      () => currentContext(session) === next && old.release.mock.calls.length === 1,
      'replacement did not publish before retiring the old context',
    );
    await expect(nextLoad).resolves.toBe(true);
    const newestLoad = session.load('/newest.gguf', () => {});
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(initLlama).toHaveBeenCalledTimes(2);
    expect(currentContext(session)).toBe(next);

    releaseGate.resolve(undefined);
    await Promise.all([nextLoad, newestLoad]);
    expect(currentContext(session)).toBe(newest);
  });

  it('refuses another native allocation while retired release keeps failing', async () => {
    const old = context();
    old.release.mockRejectedValue(new Error('native release refused forever'));
    const next = context();
    (initLlama as jest.Mock)
      .mockResolvedValueOnce(old)
      .mockResolvedValueOnce(next);
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    await session.load('/old.gguf', () => {});
    await session.load('/next.gguf', () => {});
    expect(currentContext(session)).toBe(next);
    expect(ownedContextCount(session)).toBe(2);

    await expect(session.load('/newest.gguf', () => {})).rejects.toThrow(
      'native release refused forever',
    );
    expect(initLlama).toHaveBeenCalledTimes(2);
    expect(currentContext(session)).toBe(next);
    expect(ownedContextCount(session)).toBe(2);
  });

  it('waits for an initializing context before teardown releases it', async () => {
    const warm = deferred<unknown>();
    const ctx = context(warm.promise);
    (initLlama as jest.Mock).mockResolvedValueOnce(ctx);
    const session = new LlamaSession(DEFAULT_PERSONA_ID);

    const load = session.load('/warming.gguf', () => {});
    await startedCompletions(ctx);
    const teardown = session.release();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(ctx.release).not.toHaveBeenCalled();

    warm.resolve({ content: '' });
    await Promise.all([load, teardown]);
    expect(ctx.release).toHaveBeenCalledTimes(1);
    expect(ownedContextCount(session)).toBe(0);
    expect(session.isReady).toBe(false);
  });

  it('stops an active chat and waits for it before releasing native ownership', async () => {
    const ctx = context();
    (initLlama as jest.Mock).mockResolvedValueOnce(ctx);
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    await session.load('/model.gguf', () => {});
    const chatGate = deferred<unknown>();
    ctx.completion.mockImplementationOnce(() => chatGate.promise);

    const chat = session.chat('hello');
    await eventually(
      () => ctx.completion.mock.calls.length === 2,
      'chat did not reach native completion',
    );
    const teardown = session.release();
    await eventually(
      () => ctx.stopCompletion.mock.calls.length > 0,
      'teardown did not stop the active completion',
    );
    expect(ctx.release).not.toHaveBeenCalled();
    const rejected = session.chat('hello');

    chatGate.resolve({ content: 'Stopped.' });
    await chat;
    await teardown;
    await expect(rejected).rejects.toThrow('LlamaSession has been released');
    expect(ctx.release).toHaveBeenCalledTimes(1);
    expect(session.isReady).toBe(false);
  });

  it('rejects new work after teardown starts', async () => {
    const ctx = context();
    (initLlama as jest.Mock).mockResolvedValueOnce(ctx);
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    await session.load('/model.gguf', () => {});

    await session.release();

    await expect(session.load('/later.gguf', () => {})).rejects.toThrow(
      'LlamaSession has been released',
    );
    await expect(session.chat('hello')).rejects.toThrow(
      'LlamaSession has been released',
    );
  });

  it('shares one in-flight native release and leaves failures retryable', async () => {
    const gate = deferred<void>();
    const ctx = context();
    ctx.release.mockImplementationOnce(() => gate.promise);
    (initLlama as jest.Mock).mockResolvedValueOnce(ctx);
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    await session.load('/model.gguf', () => {});

    const first = session.release();
    const second = session.release();
    await eventually(
      () => ctx.release.mock.calls.length === 1,
      'release did not reach native barrier',
    );
    expect(ctx.release).toHaveBeenCalledTimes(1);
    gate.resolve(undefined);
    await Promise.all([first, second]);
    expect(ctx.release).toHaveBeenCalledTimes(1);
  });

  it('prunes stale warmed sessions after the load set becomes quiescent', async () => {
    const ctx = context();
    (initLlama as jest.Mock).mockResolvedValueOnce(ctx);
    const fingerprint = await modelFileFingerprint('/model.gguf');
    const keep = `/docs/sessions/${warmedSessionHash(
      fingerprint,
      getPersona(DEFAULT_PERSONA_ID).systemPrompt,
    )}.llama-session`;
    (readDir as jest.Mock).mockResolvedValueOnce([
      { name: keep.split('/').at(-1), path: keep, mtime: new Date('2026-08-24T03:00:00Z'), isFile: () => true },
      { name: 'recent.llama-session', path: '/docs/sessions/recent.llama-session', mtime: new Date('2026-08-24T02:00:00Z'), isFile: () => true },
      { name: 'stale.llama-session', path: '/docs/sessions/stale.llama-session', mtime: new Date('2026-08-24T01:00:00Z'), isFile: () => true },
      { name: 'notes.txt', path: '/docs/sessions/notes.txt', isFile: () => true },
      { name: 'nested.llama-session', path: '/docs/sessions/nested.llama-session', isFile: () => false },
    ]);

    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    await session.load('/model.gguf', () => {});

    expect(unlink).toHaveBeenCalledTimes(2);
    expect(unlink).toHaveBeenCalledWith('/docs/sessions/recent.llama-session');
    expect(unlink).toHaveBeenCalledWith('/docs/sessions/stale.llama-session');
    expect(session.isReady).toBe(true);
  });

  it('retains the actual prior resident prefix rather than an unrelated newer file', async () => {
    const old = context();
    const next = context();
    (initLlama as jest.Mock)
      .mockResolvedValueOnce(old)
      .mockResolvedValueOnce(next);
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    await session.load('/old.gguf', () => {});
    const prompt = getPersona(DEFAULT_PERSONA_ID).systemPrompt;
    const oldFile = `/docs/sessions/${warmedSessionHash(
      await modelFileFingerprint('/old.gguf'),
      prompt,
    )}.llama-session`;
    const nextFile = `/docs/sessions/${warmedSessionHash(
      await modelFileFingerprint('/next.gguf'),
      prompt,
    )}.llama-session`;
    (readDir as jest.Mock).mockResolvedValueOnce([
      { name: oldFile.split('/').at(-1), path: oldFile, isFile: () => true },
      { name: nextFile.split('/').at(-1), path: nextFile, isFile: () => true },
      {
        name: 'newer-unrelated.llama-session',
        path: '/docs/sessions/newer-unrelated.llama-session',
        mtime: new Date('2026-08-25T00:00:00Z'),
        isFile: () => true,
      },
    ]);

    await session.load('/next.gguf', () => {});

    expect(unlink).toHaveBeenCalledTimes(1);
    expect(unlink).toHaveBeenCalledWith('/docs/sessions/newer-unrelated.llama-session');
  });

  it('clears partially restored native state before warming a stale session', async () => {
    const ctx = context();
    ctx.loadSession.mockRejectedValueOnce(new Error('late deserialize failure'));
    (exists as jest.Mock).mockResolvedValueOnce(true);
    (initLlama as jest.Mock).mockResolvedValueOnce(ctx);
    const session = new LlamaSession(DEFAULT_PERSONA_ID);

    await session.load('/model.gguf', () => {});

    expect(ctx.loadSession).toHaveBeenCalledTimes(1);
    expect(ctx.clearCache).toHaveBeenCalledTimes(1);
    expect(ctx.clearCache.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.completion.mock.invocationCallOrder[0],
    );
  });

  it('does not prune valid prefixes when the new warm session failed to persist', async () => {
    const ctx = context();
    ctx.saveSession.mockRejectedValueOnce(new Error('disk full'));
    (initLlama as jest.Mock).mockResolvedValueOnce(ctx);
    (readDir as jest.Mock).mockResolvedValueOnce([
      { name: 'valid.llama-session', path: '/docs/sessions/valid.llama-session', isFile: () => true },
    ]);

    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    await session.load('/model.gguf', () => {});

    expect(readDir).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
    expect(session.isReady).toBe(true);
  });

  it('keeps cleanup failures fail-soft and continues past one bad stale file', async () => {
    const ctx = context();
    (initLlama as jest.Mock).mockResolvedValueOnce(ctx);
    (readDir as jest.Mock).mockResolvedValueOnce([
      { name: 'kept.llama-session', path: '/docs/sessions/kept.llama-session', mtime: new Date('2026-08-24T03:00:00Z'), isFile: () => true },
      { name: 'bad.llama-session', path: '/docs/sessions/bad.llama-session', mtime: new Date('2026-08-24T02:00:00Z'), isFile: () => true },
      { name: 'good.llama-session', path: '/docs/sessions/good.llama-session', mtime: new Date('2026-08-24T01:00:00Z'), isFile: () => true },
    ]);
    (unlink as jest.Mock)
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValueOnce(undefined);

    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    await session.load('/model.gguf', () => {});

    expect(unlink).toHaveBeenCalledTimes(3);
    expect(session.isReady).toBe(true);
  });

  it('hashes full content to distinguish Android metadata-colliding replacements', async () => {
    const timestamp = new Date('2026-08-24T12:00:00Z');
    (stat as jest.Mock).mockResolvedValue({
      path: '/same.gguf',
      originalFilepath: '/same.gguf',
      size: 16_384,
      mtime: timestamp,
      ctime: timestamp,
    });
    (hash as jest.Mock)
      .mockResolvedValueOnce('old-content-sha256')
      .mockResolvedValueOnce('new-content-sha256');

    const first = await modelFileFingerprint('/same.gguf');
    const replacement = await modelFileFingerprint('/same.gguf');
    expect(replacement).not.toBe(first);
  });

  // LETTING THE ANGEL REST (llm/angelRest.ts). release() is a tombstone —
  // the app's teardown. unload() must free exactly as much native memory and
  // leave the session able to wake again, or "turn her off" would cost the
  // camper the app until they restarted it.
  it('frees native memory on unload and still loads again afterwards', async () => {
    const first = context();
    const second = context();
    (initLlama as jest.Mock)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    await session.load('/model.gguf', () => {});
    expect(session.isReady).toBe(true);

    await session.unload();

    expect(first.release).toHaveBeenCalledTimes(1);
    expect(ownedContextCount(session)).toBe(0);
    expect(currentContext(session)).toBeNull();
    expect(session.isReady).toBe(false);
    expect(session.loadedModelName).toBeNull();

    await session.load('/model.gguf', () => {});
    expect(session.isReady).toBe(true);
    expect(currentContext(session)).toBe(second);
  });

  it('stops an in-flight turn before unload frees the context', async () => {
    const ctx = context();
    (initLlama as jest.Mock).mockResolvedValueOnce(ctx);
    const session = new LlamaSession(DEFAULT_PERSONA_ID);
    await session.load('/model.gguf', () => {});
    const chatGate = deferred<unknown>();
    ctx.completion.mockImplementationOnce(() => chatGate.promise);

    const chat = session.chat('hello');
    await eventually(
      () => ctx.completion.mock.calls.length === 2,
      'chat did not reach native completion',
    );
    const resting = session.unload();
    await eventually(
      () => ctx.stopCompletion.mock.calls.length > 0,
      'unload did not stop the active completion',
    );
    // The lease holds the context until the turn is actually done — freeing
    // memory out from under a running generation is the crash this whole
    // feature exists to avoid.
    expect(ctx.release).not.toHaveBeenCalled();

    chatGate.resolve({ content: 'Stopped.' });
    await chat;
    await resting;
    expect(ctx.release).toHaveBeenCalledTimes(1);
    // The conversation survives resting — the camper can still READ what she
    // said, so a session that had forgotten it would be the ghost-history
    // pair inverted (the screen showing turns the session denies).
    expect(session.hasHistory()).toBe(true);
  });
});
