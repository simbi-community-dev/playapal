/**
 * P2-5: map a raw native/model load error to the camper-actionable fix.
 * The raw exception is a crash to a camper who can FIX it (free storage, a
 * truncated file, or a phone that can't hold the model). Ordered by
 * confidence — the specific native shapes first, the honest fallback last.
 * Kept in its own module so the mapping tests need no native imports.
 */
export function loadFailureMessage(raw: string): string {
  const s = raw.toLowerCase();
  if (
    s.includes('no space') ||
    s.includes('not enough space') ||
    s.includes('enospc') ||
    s.includes('storage') ||
    s.includes('disk full')
  ) {
    return 'Storage is full — free up some space, then try again.';
  }
  if (
    s.includes('not within file bounds') ||
    s.includes('file bounds') ||
    s.includes('truncated') ||
    s.includes('corrupt') ||
    s.includes('damaged') ||
    s.includes('invalid') ||
    s.includes('magic') ||
    s.includes('header')
  ) {
    return 'The model file is damaged — delete it and download it again.';
  }
  if (
    s.includes('mmap') ||
    s.includes('out of memory') ||
    s.includes('enomem') ||
    s.includes('insufficient memory') ||
    s.includes('cannot allocate') ||
    s.includes('alloc')
  ) {
    return 'Not enough memory for this model — close other apps, or use a smaller model.';
  }
  const short = raw.length > 80 ? raw.slice(0, 77) + '...' : raw;
  return `Could not load the model — ${short}`;
}
