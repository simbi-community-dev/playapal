/**
 * Beam ingress, the JS half (docs/BEAM-INGRESS-CONTRACT.md §2, §4).
 *
 * Native hands JS a queue of {ingressId, localPath, ...}. These tests pin
 * the delivery discipline that native cannot enforce: one receipt per
 * delivery even when the same item arrives twice (cold-start drain + warm
 * event), the cache copy deleted ONLY after a successful install, and the
 * refusal wording a camper reads at 3am.
 */
jest.mock('@dr.pogodin/react-native-fs', () => ({
  CachesDirectoryPath: '/cache',
  readDir: jest.fn(),
  readFile: jest.fn(),
  unlink: jest.fn(),
}));
jest.mock('../src/packs/importPack', () => ({
  installIncomingPayload: jest.fn(),
  describeInstall: (r: any) => `${r.name}: ${r.detail}.`,
}));

import { processIngressItems, orphanItems, BeamIngressItem } from '../src/beam/ingress';

const ok = {
  packId: 'camp-x',
  name: 'Camp beam — marisol',
  events: 0,
  chunks: 0,
  nodes: 0,
  edges: 0,
  items: 3,
  detail: '3 open board posts — see the board above',
  warnings: [],
};

function io(overrides: Partial<Record<'read' | 'remove' | 'install' | 'notify', any>> = {}) {
  const files: Record<string, string> = { '/cache/a.playapal': '{"kind":"playapal-camp-board"}' };
  return {
    read: jest.fn(async (p: string) => {
      if (!(p in files)) {
        throw new Error('ENOENT');
      }
      return files[p];
    }),
    remove: jest.fn(async () => {}),
    install: jest.fn(() => ok),
    notify: jest.fn(),
    ...overrides,
  };
}

const item = (over: Partial<BeamIngressItem> = {}): BeamIngressItem => ({
  ingressId: 'id-1',
  localPath: '/cache/a.playapal',
  displayName: 'camp-beam-2026-08-25.playapal',
  mime: 'application/octet-stream',
  bytes: 3069,
  source: 'android-view',
  ...over,
});

describe('processIngressItems', () => {
  test('installs through the seam with the native source and one receipt', async () => {
    const f = io();
    const out = await processIngressItems([item()], f as any, new Set());
    expect(f.install).toHaveBeenCalledWith({
      name: 'camp-beam-2026-08-25.playapal',
      content: '{"kind":"playapal-camp-board"}',
      source: 'android-view',
    });
    expect(out).toEqual([
      expect.objectContaining({ status: 'installed', title: 'Beam received' }),
    ]);
    expect(f.notify).toHaveBeenCalledTimes(1);
    expect(f.notify.mock.calls[0][1]).toContain('3 open board posts');
  });

  test('the cache copy is deleted after a successful install', async () => {
    const f = io();
    await processIngressItems([item()], f as any, new Set());
    expect(f.remove).toHaveBeenCalledWith('/cache/a.playapal');
  });

  test('the same ingressId delivered twice produces ONE receipt (cold drain + warm event)', async () => {
    const f = io();
    const seen = new Set<string>();
    const a = await processIngressItems([item()], f as any, seen);
    const b = await processIngressItems([item()], f as any, seen);
    expect(a[0].status).toBe('installed');
    expect(b[0].status).toBe('duplicate');
    expect(f.install).toHaveBeenCalledTimes(1);
    expect(f.notify).toHaveBeenCalledTimes(1);
  });

  test('a refusal by the seam says why and also removes the copy (no leak, no re-nag next launch)', async () => {
    const f = io({
      install: jest.fn(() => {
        throw new Error('That beam was sealed with a different camp passphrase.');
      }),
    });
    const out = await processIngressItems([item()], f as any, new Set());
    expect(out[0].status).toBe('refused');
    expect(f.remove).toHaveBeenCalledWith('/cache/a.playapal');
    expect(f.notify.mock.calls[0][1]).toContain('different camp passphrase');
  });

  test('a native copy error never reaches the seam and names the file', async () => {
    const f = io();
    const out = await processIngressItems(
      [item({ localPath: undefined, error: 'too large', bytes: 9_000_000 })],
      f as any,
      new Set(),
    );
    expect(out[0].status).toBe('refused');
    expect(f.install).not.toHaveBeenCalled();
    expect(f.notify.mock.calls[0][1]).toMatch(/bigger than a beam can be \(4 MB limit\)/);
    expect(f.notify.mock.calls[0][1]).toContain('camp-beam-2026-08-25.playapal');
  });

  test('an unreadable copy is a refusal, not a crash', async () => {
    const f = io();
    const out = await processIngressItems([item({ localPath: '/cache/missing' })], f as any, new Set());
    expect(out[0].status).toBe('refused');
    expect(f.install).not.toHaveBeenCalled();
  });

  test('SEND_MULTIPLE: the receipt says one of N was taken', async () => {
    const f = io();
    await processIngressItems([item({ extraCount: 3, source: 'android-send' })], f as any, new Set());
    expect(f.notify.mock.calls[0][1]).toContain('3 files were shared');
  });

  test('a friend card through the file door gets the friend receipt title', async () => {
    const f = io({ install: jest.fn(() => ({ ...ok, packId: 'friends', name: 'Friends on playa', detail: 'added Lux' })) });
    const out = await processIngressItems([item()], f as any, new Set());
    expect(out[0].title).toBe('Friends on playa');
  });
});

describe('orphanItems — the file is the source of truth, not the RAM queue', () => {
  test('a finished copy stranded by a process death becomes an item keyed on its stem', () => {
    const items = orphanItems([
      { name: '6f1d-aaaa.playapal', path: '/cache/beam-ingress/6f1d-aaaa.playapal', size: 3069 },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].ingressId).toBe('6f1d-aaaa');
    expect(items[0].localPath).toBe('/cache/beam-ingress/6f1d-aaaa.playapal');
    expect(items[0].bytes).toBe(3069);
  });

  test('a .part (copy still in flight) is never an item', () => {
    expect(
      orphanItems([{ name: 'x.playapal.part', path: '/cache/beam-ingress/x.playapal.part', size: 10 }]),
    ).toEqual([]);
  });

  test('an orphan with the same stem as a queued item is deduped by the shared seen-set', async () => {
    const f = io();
    const seen = new Set<string>();
    await processIngressItems([item({ ingressId: '6f1d-aaaa' })], f as any, seen);
    const again = orphanItems([
      { name: '6f1d-aaaa.playapal', path: '/cache/a.playapal', size: 1 },
    ]);
    const out = await processIngressItems(again, f as any, seen);
    expect(out[0].status).toBe('duplicate');
    expect(f.install).toHaveBeenCalledTimes(1);
  });
});
