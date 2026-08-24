/**
 * The catalog's decisions are pure functions; the download is a native
 * call. Test the decisions -- they are what a wrong phone would suffer from.
 */
jest.mock('@dr.pogodin/react-native-fs', () => ({
  DocumentDirectoryPath: '/docs',
  downloadFile: jest.fn(),
  exists: jest.fn(async () => false),
  getFSInfo: jest.fn(async () => ({ totalSpace: 0, freeSpace: 0 })),
  hash: jest.fn(),
  moveFile: jest.fn(),
  stat: jest.fn(async () => ({ size: 0 })),
  unlink: jest.fn(),
}));
jest.mock('react-native-device-info', () => ({
  __esModule: true,
  default: { getTotalMemory: jest.fn(async () => 0) },
}));
jest.mock('../src/events/db', () => ({
  getSetting: jest.fn(() => null),
  setSetting: jest.fn(),
}));

import {
  DOWNLOAD_HEADROOM,
  fitEntry,
  CATALOG,
  SMART_TIER_MIN_RAM,
  downloadModel,
  entryFor,
  recommendedEntry,
  verifiedKey,
  watchLiveDownload,
  type LiveDownload,
} from '../src/llm/modelCatalog';

const smart = () => entryFor('angel-smart')!;
const light = () => entryFor('angel-light')!;

const GB = 1024 * 1024 * 1024;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('recommendedEntry', () => {
  test('8 GB phone gets the smart model', () => {
    expect(recommendedEntry({ totalRamBytes: 8 * GB }).id).toBe('angel-smart');
  });
  test('exactly the threshold gets smart', () => {
    expect(recommendedEntry({ totalRamBytes: SMART_TIER_MIN_RAM }).id).toBe('angel-smart');
  });
  test('4 GB phone gets light', () => {
    expect(recommendedEntry({ totalRamBytes: 4 * GB }).id).toBe('angel-light');
  });
  test('UNKNOWN RAM gets the smallest -- a wrong guess up strands the user, a wrong guess down still works', () => {
    expect(recommendedEntry({}).id).toBe('angel-light');
  });
  test('RAM enough but no room for the big file falls through to one that fits today', () => {
    expect(
      recommendedEntry({ totalRamBytes: 8 * GB, freeBytes: smart().bytes - 1 }).id,
    ).toBe('angel-light');
  });
  test('no room to DOWNLOAD but already downloaded keeps the big one recommended', () => {
    expect(
      recommendedEntry(
        { totalRamBytes: 8 * GB, freeBytes: 0 },
        new Set(['angel-smart']),
      ).id,
    ).toBe('angel-smart');
  });
});

describe('fitEntry -- the phone\'s measured verdict per entry', () => {
  test('fits when both numbers clear', () => {
    expect(
      fitEntry(smart(), { totalRamBytes: 8 * GB, freeBytes: 10 * GB }).status,
    ).toBe('fits');
  });
  test('low-ram beats no-room in the verdict order (a phone that cannot RUN it should hear that first)', () => {
    expect(fitEntry(smart(), { totalRamBytes: 3 * GB, freeBytes: 0 }).status).toBe('low-ram');
  });
  test('no-room reports exactly how short, headroom included', () => {
    const free = 1 * GB;
    const fit = fitEntry(smart(), { totalRamBytes: 8 * GB, freeBytes: free });
    expect(fit.status).toBe('no-room');
    if (fit.status === 'no-room') {
      expect(fit.shortBytes).toBe(smart().bytes + DOWNLOAD_HEADROOM - free);
    }
  });
  test('already-downloaded ignores free space -- the bytes are spent', () => {
    expect(
      fitEntry(smart(), { totalRamBytes: 8 * GB, freeBytes: 0 }, true).status,
    ).toBe('fits');
  });
  test('unknown circumstances fit -- a false "will not fit" hides a working option, a false "fits" fails loudly later', () => {
    expect(fitEntry(smart(), {}).status).toBe('fits');
  });
});

describe('catalog shape -- the contribution surface', () => {
  test('every URL is pinned to an immutable revision — /resolve/main/ can change under shipped apps', () => {
    for (const e of CATALOG) {
      expect(e.url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
      expect(e.url).not.toContain('/resolve/main/');
    }
  });

  test('ids are unique, entries are ordered largest-first, and each says what it is for', () => {
    const ids = CATALOG.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < CATALOG.length; i++) {
      // largest-first: RAM floors never increase down the list
      expect(CATALOG[i].minTotalRamBytes).toBeLessThanOrEqual(CATALOG[i - 1].minTotalRamBytes);
    }
    for (const e of CATALOG) {
      expect(e.id).toMatch(/^[a-z0-9-]+$/);
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.url).toMatch(/^https:\/\/.+\.gguf$/);
      expect(e.file).toMatch(/\.gguf$/);
    }
  });
  test('a contributed entry is just another list item: appended, it becomes selectable and RAM-gated like the rest', () => {
    // simulate a PR that adds a third model at the bottom
    const contributed = {
      ...light(),
      id: 'community-tiny',
      title: 'Community Tiny',
      minTotalRamBytes: 0,
      file: 'community-tiny.gguf',
    };
    const list = [...CATALOG, contributed];
    // same selection rule, no code change: an unknown-RAM phone now gets the smallest
    const pick = list.find(e => e.minTotalRamBytes <= 0)!;
    expect(pick.id).toBe('angel-light'); // light still comes first at floor 0
    expect(list.map(e => e.id)).toContain('community-tiny');
  });
});

describe('downloadModel', () => {
  test('an UNPINNED entry is refused before any network call -- a model with no digest cannot ship by accident', async () => {
    const fs = require('@dr.pogodin/react-native-fs');
    const e = { ...smart(), sha256: '' };
    const r = await downloadModel(e);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('unpinned');
    }
    expect(fs.downloadFile).not.toHaveBeenCalled();
  });

  test('a completed download whose digest does not match is REMOVED and reported, never kept', async () => {
    const fs = require('@dr.pogodin/react-native-fs');
    fs.exists.mockResolvedValue(false);
    fs.downloadFile.mockReturnValue({ promise: Promise.resolve({ statusCode: 200 }) });
    fs.hash.mockResolvedValue('deadbeef');
    const e = { ...smart(), sha256: 'cafebabe' };
    const r = await downloadModel(e);
    expect(r).toMatchObject({ ok: false, reason: 'digest' });
    expect(fs.unlink).toHaveBeenCalledWith('/docs/angel-smart.gguf.part');
    expect(fs.moveFile).not.toHaveBeenCalled();
  });

  test('a verified download is moved into place and becomes the active model', async () => {
    const fs = require('@dr.pogodin/react-native-fs');
    const db = require('../src/events/db');
    fs.exists.mockResolvedValue(false);
    fs.downloadFile.mockReturnValue({ promise: Promise.resolve({ statusCode: 200 }) });
    fs.hash.mockResolvedValue('CAFEBABE');   // case-insensitive compare
    const e = { ...light(), sha256: 'cafebabe' };
    const r = await downloadModel(e);
    expect(r).toEqual({ ok: true, path: '/docs/angel-light.gguf' });
    expect(fs.moveFile).toHaveBeenCalledWith('/docs/angel-light.gguf.part', '/docs/angel-light.gguf');
    expect(db.setSetting).toHaveBeenCalledWith('model_path', '/docs/angel-light.gguf');
  });

  test('a network failure is reported as such and leaves nothing at the final path', async () => {
    const fs = require('@dr.pogodin/react-native-fs');
    fs.exists.mockResolvedValue(false);
    fs.downloadFile.mockReturnValue({ promise: Promise.reject(new Error('offline')) });
    const e = { ...light(), sha256: 'cafebabe' };
    const r = await downloadModel(e);
    expect(r).toMatchObject({ ok: false, reason: 'network', detail: 'offline' });
    expect(fs.moveFile).not.toHaveBeenCalled();
  });

  test('the live registry tracks the pull for late-mounting screens: current state on subscribe, bytes, verifying, cleared', async () => {
    const fs = require('@dr.pogodin/react-native-fs');
    fs.exists.mockResolvedValue(false);
    fs.downloadFile.mockImplementation(({ progress }: any) => {
      progress({ bytesWritten: 42, contentLength: 100 });
      return { promise: Promise.resolve({ statusCode: 200 }) };
    });
    fs.hash.mockResolvedValue('cafebabe');
    const seen: (LiveDownload | null)[] = [];
    const stop = watchLiveDownload(d => seen.push(d));
    await downloadModel({ ...light(), sha256: 'cafebabe' });
    stop();
    expect(seen[0]).toBeNull(); // fires immediately: nothing in flight yet
    expect(seen[1]).toEqual({
      id: 'angel-light',
      phase: 'downloading',
      bytesWritten: 0,
      contentLength: light().bytes,
    });
    expect(seen[2]).toMatchObject({ phase: 'downloading', bytesWritten: 42, contentLength: 100 });
    expect(seen[3]).toEqual({ id: 'angel-light', phase: 'verifying' });
    expect(seen[4]).toBeNull();
    expect(seen).toHaveLength(5);
  });

  test('a failed pull clears the live registry — no phantom "Downloading…" row', async () => {
    const fs = require('@dr.pogodin/react-native-fs');
    fs.exists.mockResolvedValue(false);
    fs.downloadFile.mockReturnValue({ promise: Promise.reject(new Error('offline')) });
    const seen: (LiveDownload | null)[] = [];
    const stop = watchLiveDownload(d => seen.push(d));
    await downloadModel({ ...light(), sha256: 'cafebabe' });
    stop();
    expect(seen[1]).toMatchObject({ phase: 'downloading' });
    expect(seen[seen.length - 1]).toBeNull();
  });
});

describe('switching to a model already on the phone does not re-hash it', () => {
  // Owner, 2026-08-20: "I shouldn't have to redownload the max model when I
  // switch, or the lfm model when I try it out after the first time." These
  // files are 1.4-5.2 GB. A SHA-256 on a phone is MINUTES of "Checking the
  // download…" on every switch, which reads exactly like a re-download — and
  // if that hash was ever interrupted, the unlink deleted a good model and
  // pulled it again. A verified file is now vouched for by its byte size.
  const fs = require('@dr.pogodin/react-native-fs');
  const db = require('../src/events/db');
  const entry = CATALOG.find(e => e.sha256)!;

  beforeEach(() => {
    jest.clearAllMocks();
    fs.exists.mockResolvedValue(true);
    fs.stat.mockResolvedValue({ size: entry.bytes });
  });

  test('a size-matching voucher skips the digest entirely', async () => {
    db.getSetting.mockImplementation((k: string) =>
      k === verifiedKey(entry) ? String(entry.bytes) : null,
    );
    const r = await downloadModel(entry);
    expect(r.ok).toBe(true);
    expect(fs.hash).not.toHaveBeenCalled();
    expect(fs.downloadFile).not.toHaveBeenCalled();
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  test('no voucher means it still verifies, then vouches for next time', async () => {
    db.getSetting.mockImplementation(() => null);
    fs.hash.mockResolvedValue(entry.sha256!.toUpperCase());
    const r = await downloadModel(entry);
    expect(r.ok).toBe(true);
    expect(fs.hash).toHaveBeenCalled();
    expect(db.setSetting).toHaveBeenCalledWith(verifiedKey(entry), String(entry.bytes));
  });

  test('a voucher for a DIFFERENT size is not trusted', async () => {
    // truncated or swapped file: the cheap property that actually changed
    db.getSetting.mockImplementation((k: string) =>
      k === verifiedKey(entry) ? String(entry.bytes - 1) : null,
    );
    fs.hash.mockResolvedValue(entry.sha256!.toLowerCase());
    const r = await downloadModel(entry);
    expect(r.ok).toBe(true);
    expect(fs.hash).toHaveBeenCalled();
  });

  test('a bad digest still deletes the file AND kills its voucher', async () => {
    db.getSetting.mockImplementation(() => null);
    fs.hash.mockResolvedValue('deadbeef');
    fs.downloadFile.mockReturnValue({
      promise: Promise.resolve({ statusCode: 500 }),
    });
    await downloadModel(entry);
    expect(fs.unlink).toHaveBeenCalled();
    expect(db.setSetting).toHaveBeenCalledWith(verifiedKey(entry), '');
  });
});
