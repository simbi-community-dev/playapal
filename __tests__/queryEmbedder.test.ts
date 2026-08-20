/**
 * The device query embedder's contract: lazy (never at boot), fail-soft
 * (load/embed failure -> keyword-only degrade, never blocks chat), and the
 * dim guard (a wrong-dim GGUF is never wired). llama.rn and the fs layer are
 * mocked — this tests the WIRING contract, not native embedding (the
 * on-device certification battery owns that).
 */

import {
  ensureQueryEmbedder,
  __resetQueryEmbedderForTests,
  embedderPath,
} from '../src/llm/queryEmbedder';
import { semanticEnabled, __getQueryEmbedder, VECTOR_DIM } from '../src/docs/vectorSearch';

const mockExists = jest.fn();
const mockInitLlama = jest.fn();

jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/mock/files',
  exists: (p: string) => mockExists(p),
}));

jest.mock('llama.rn', () => ({
  initLlama: (params: any) => mockInitLlama(params),
}));

beforeEach(() => {
  __resetQueryEmbedderForTests();
  mockExists.mockReset();
  mockInitLlama.mockReset();
});

it('is inert before any load (never at boot)', () => {
  expect(semanticEnabled()).toBe(false);
  expect(mockInitLlama).not.toHaveBeenCalled();
});

it('no embedder file -> stays inert, no error thrown', async () => {
  mockExists.mockResolvedValue(false);
  await ensureQueryEmbedder();
  expect(semanticEnabled()).toBe(false);
  expect(mockInitLlama).not.toHaveBeenCalled();
});

it('wires the embedder on first semantic search when the file exists', async () => {
  mockExists.mockResolvedValue(true);
  mockInitLlama.mockResolvedValue({
    model: { nEmbd: VECTOR_DIM },
    embedding: async (_t: string) => ({ embedding: [0.1, 0.2] }),
  });
  await ensureQueryEmbedder();
  expect(semanticEnabled()).toBe(true);
  expect(mockInitLlama).toHaveBeenCalledWith(
    expect.objectContaining({ model: embedderPath(), embedding: true }),
  );
  const vec = await __getQueryEmbedder()!('a query');
  expect(vec).toEqual([0.1, 0.2]);
});

it('idempotent: a second ensure reuses the in-flight/settled load', async () => {
  mockExists.mockResolvedValue(true);
  mockInitLlama.mockResolvedValue({
    model: { nEmbd: VECTOR_DIM },
    embedding: async () => ({ embedding: [1] }),
  });
  await Promise.all([ensureQueryEmbedder(), ensureQueryEmbedder()]);
  expect(mockInitLlama).toHaveBeenCalledTimes(1);
});

it('DIM GUARD: a wrong-dim GGUF is never wired (inert, not wrong)', async () => {
  mockExists.mockResolvedValue(true);
  mockInitLlama.mockResolvedValue({
    model: { nEmbd: 768 }, // wrong model family
    embedding: async () => ({ embedding: [0] }),
  });
  await ensureQueryEmbedder();
  expect(semanticEnabled()).toBe(false);
});

it('load failure -> fail-soft (inert, no throw)', async () => {
  mockExists.mockResolvedValue(true);
  mockInitLlama.mockRejectedValue(new Error('native boom'));
  await expect(ensureQueryEmbedder()).resolves.toBeUndefined();
  expect(semanticEnabled()).toBe(false);
});

it('embed failure at query time -> null (that query degrades, arm stays)', async () => {
  mockExists.mockResolvedValue(true);
  mockInitLlama.mockResolvedValue({
    model: { nEmbd: VECTOR_DIM },
    embedding: async () => {
      throw new Error('embed boom');
    },
  });
  await ensureQueryEmbedder();
  expect(semanticEnabled()).toBe(true); // the arm itself is loaded
  const vec = await __getQueryEmbedder()!('a query');
  expect(vec).toBeNull(); // the query degrades to keyword-only
});

it('ESM-interop: named exports behind .default still resolve (cert round-2 lesson)', async () => {
  // Metro can put the package's named exports behind .default when reached
  // via require(); the path must still resolve to the real directory.
  jest.resetModules();
  jest.doMock('@dr.pogodin/react-native-fs', () => ({
    __esModule: true,
    default: {
      DocumentDirectoryPath: '/mock/files-default',
      exists: async () => false,
    },
  }));
  const fresh = require('../src/llm/queryEmbedder');
  expect(fresh.embedderPath()).toBe('/mock/files-default/embedder.gguf');
  jest.dontMock('@dr.pogodin/react-native-fs');
});
