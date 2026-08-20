/**
 * The camper-actionable load-failure map (P2-5): raw native/model errors
 * map to the fix a camper can act on, never a crash-shaped exception in the
 * status line. Ordered by confidence; unknown errors stay honest with a
 * short detail, never dressed up.
 */
import { loadFailureMessage } from '../src/llm/loadFailure';

describe('loadFailureMessage (P2-5)', () => {
  it('storage-full shapes -> free-up-space fix', () => {
    for (const raw of [
      'failed to write: No space left on device',
      'ENOSPC: not enough space',
      'insufficient storage available',
    ]) {
      expect(loadFailureMessage(raw)).toContain('Storage is full');
    }
  });

  it('file-damaged shapes -> redownload fix', () => {
    for (const raw of [
      'gguf tensor data offset is not within file bounds',
      'model file is truncated',
      'invalid gguf magic',
      'corrupt model header',
    ]) {
      expect(loadFailureMessage(raw)).toContain('damaged');
      expect(loadFailureMessage(raw)).toContain('download it again');
    }
  });

  it('memory shapes -> close-apps-or-smaller-model fix', () => {
    for (const raw of [
      'failed to mmap model: Out of memory',
      'ENOMEM: cannot allocate memory',
      'insufficient memory to load model',
    ]) {
      expect(loadFailureMessage(raw)).toContain('Not enough memory');
    }
  });

  it('unknown errors stay honest with a short detail, never dressed up', () => {
    const out = loadFailureMessage('some exotic native failure nobody mapped');
    expect(out).toContain('Could not load the model');
    expect(out).toContain('some exotic native failure');
    expect(out.length).toBeLessThan(120);
  });

  it('a long unknown error is truncated, not dumped whole', () => {
    const out = loadFailureMessage('x'.repeat(200));
    // 'Could not load the model — ' prefix + 77 chars + '...' = 107 max.
    expect(out.length).toBeLessThan(110);
    expect(out).toContain('...');
    expect(out.length).toBeLessThan(200); // the point: not the whole 200
  });
});
