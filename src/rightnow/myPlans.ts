/**
 * "My plans" — the user's OWN stuff (hearted events + saved map pins),
 * synthesized into one app-maintained document the Angel can retrieve.
 *
 * THE GAP THIS CLOSES (owner-approved 2026-08-24): the on-device Angel can
 * search events/camps/art/guides but was blind to the user's own hearts and
 * pins — "when's that thing I hearted?" got silence. The fix is a DOCUMENT,
 * deliberately NOT a fifth tool: the model's training contract pins exactly
 * four tools, and a new one risks routing regressions for zero gain when
 * FTS finds "my faves" / "my plans" / "my pins" trivially once those words
 * exist in doc_chunks.
 *
 * PRECEDENT: src/camp/campNotes.ts rematerializeNotes — the canonical store
 * stays canonical (event_favorites + the saved_waypoints setting), and the
 * pack row + doc_chunks rows written here are disposable PROJECTIONS,
 * rematerialized wholesale after every change; their generated chunk ids
 * are never identity. The pack id 'my-plans' is app-owned and collides with
 * nothing: board packs are 'camp-board-*', notes packs 'camp-notes-*', and
 * the builtins are 'brc-events-2026' / 'brc-art-2026' / 'brc-camps-2026' /
 * 'survival-guide'. The source_file deliberately does NOT start with
 * 'about-' — that prefix is the identity-rung namespace in searchDocs.
 *
 * PRIVACY: this document is synthesized on, and never leaves, THIS phone.
 * It never rides the camp beam (exports seal only camp-board-/camp-notes-
 * writer envelopes), and pod/crew messages deliberately stay OUT of the
 * Angel's retrieval corpus entirely — a private text is not search fodder.
 */

import { favoriteEvents } from './rightNow';
import { dayHeading } from './browse';
import { toISODate } from '../events/timeParser';
import { getDb, rebuildFtsIndexes } from '../events/db';
import { subscribeFavoritesChanged } from '../events/favorites';
import { listPins, subscribePinsChanged } from '../geo/waypoints';
import { getCityGeometry } from '../geo/cityGeometry';
import { latLonToBrc, type BrcGeometry } from '../geo/brcGeo';

export const MY_PLANS_PACK_ID = 'my-plans';

/** Honest empty states: a question about faves/pins must get a real answer
 * ("you have none yet"), never retrieval silence the model pads over. */
export const NO_FAVES_LINE = 'No faves yet.';
export const NO_PINS_LINE = 'No pins yet.';

// ---------------------------------------------------------------------------
// The pure synthesis (injected clock — no Date.now() in renderers)
// ---------------------------------------------------------------------------

interface MyPlansDoc {
  /** Chronological day groups, mirroring how the Faves list is read: one
   * heading per date, events in start order under it. */
  faveDays: { date: string; label: string; lines: string[] }[];
  pinLines: string[];
}

/**
 * One hearted event as a single citation-friendly line. Every field comes
 * from favoriteEvents() — the JOINED, walk-annotated Faves read that already
 * survives pack reinstalls via the natural key — never re-derived here.
 * The date rides IN the line (not only the group heading) so an excerpted
 * passage still answers "when": excerptForTerms may hand the model one line.
 * Walk minutes anchor at Center Camp (favoriteEvents' default): this runs as
 * a background synthesizer with no GPS fix to hand; the live screens own the
 * GPS-anchored numbers.
 */
function faveLine(
  item: ReturnType<typeof favoriteEvents>[number],
  todayISO: string,
): string {
  const ev = item.event;
  const when = `${dayHeading(ev.date)}${ev.time_start ? `, ${ev.time_start}` : ''}`;
  const bits = [
    when,
    ev.camp,
    ev.location,
    item.walkMinutes !== null ? `~${item.walkMinutes} min walk` : '',
    // ISO dates compare lexically; the marker keeps "when's that thing I
    // hearted?" honest after the fact instead of reading like a plan.
    ev.date < todayISO ? 'already happened' : '',
  ].filter(Boolean);
  return `**${ev.title}** — ${bits.join(' · ')}`;
}

/** One saved pin: BRC clock address when city geometry exists (the language
 * campers actually navigate by), bare coordinates otherwise — the same
 * geometry-free floor the compass keeps (src/geo/brcGeo.ts header). */
function pinLine(
  pin: { label: string; lat: number; lon: number },
  geo: BrcGeometry | null,
): string {
  const where = geo
    ? latLonToBrc(pin.lat, pin.lon, geo).address
    : `${pin.lat.toFixed(4)}, ${pin.lon.toFixed(4)}`;
  return `**${pin.label}** — ${where}`;
}

function buildMyPlans(now: Date, geo: BrcGeometry | null): MyPlansDoc {
  const todayISO = toISODate(now);
  const faveDays: MyPlansDoc['faveDays'] = [];
  // favoriteEvents() is date+time ordered, so insertion order IS the
  // chronological day order — same grouping the Faves list renders.
  for (const item of favoriteEvents()) {
    const date = item.event.date;
    const last = faveDays[faveDays.length - 1];
    const group =
      last && last.date === date
        ? last
        : (faveDays.push({ date, label: dayHeading(date), lines: [] }),
          faveDays[faveDays.length - 1]);
    group.lines.push(faveLine(item, todayISO));
  }
  return { faveDays, pinLines: listPins().map(p => pinLine(p, geo)) };
}

/**
 * The whole document as compact markdown — what a camper (or a test) reads
 * as one page. `now` is injected (iBurn's Date.present pattern, same as
 * rightNow()); geometry is injectable for the same reason and defaults to
 * the bundled city asset.
 */
export function renderMyPlansMarkdown(
  now: Date = new Date(),
  geo: BrcGeometry | null = getCityGeometry(),
): string {
  const doc = buildMyPlans(now, geo);
  const parts: string[] = ['# My plans', '', '## Faves', ''];
  if (doc.faveDays.length === 0) {
    parts.push(NO_FAVES_LINE, '');
  } else {
    for (const day of doc.faveDays) {
      parts.push(`### ${day.label}`, ...day.lines, '');
    }
  }
  parts.push('## My pins', '');
  parts.push(...(doc.pinLines.length > 0 ? doc.pinLines : [NO_PINS_LINE]));
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Materialization: the campNotes projection seam
// ---------------------------------------------------------------------------

/**
 * Replace the projected doc wholesale: derived pack row upserted, chunks
 * deleted-then-reinserted, FTS reindexed — rematerializeNotes' exact shape.
 * Chunking is one chunk per Faves day + one for pins (empty states included)
 * so a passage cites as "My plans > Faves — Saturday, Aug 29" and BM25 ranks
 * the right day instead of one giant blob.
 */
export function refreshMyPlansDoc(now: Date = new Date()): void {
  const conn = getDb();
  const doc = buildMyPlans(now, getCityGeometry());

  const chunks: { heading: string; content: string }[] =
    doc.faveDays.length > 0
      ? doc.faveDays.map(day => ({
          heading: `My plans > Faves — ${day.label}`,
          content: day.lines.join('\n'),
        }))
      : [{ heading: 'My plans > Faves', content: NO_FAVES_LINE }];
  chunks.push({
    heading: 'My plans > My pins',
    content:
      doc.pinLines.length > 0 ? doc.pinLines.join('\n') : NO_PINS_LINE,
  });

  conn.execute('DELETE FROM doc_chunks WHERE pack_id = ?', [MY_PLANS_PACK_ID]);
  // enabled only on INSERT: disabling "My plans" in Settings is a legitimate
  // opt-out of the Angel seeing your hearts, and a refresh must not undo it
  // (the campNotes keep-the-toggle lesson, audit 2026-08-20).
  conn.execute(
    `INSERT INTO packs (id, name, description, version, builtin, enabled)
     VALUES (?, ?, ?, ?, 0, 1)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, description = excluded.description,
       version = excluded.version`,
    [
      MY_PLANS_PACK_ID,
      'My plans',
      'Your hearted events and saved map pins, kept searchable so the Angel can answer "when\'s that thing I hearted?". Lives only on this phone — never beamed.',
      chunks.length,
    ],
  );
  for (const c of chunks) {
    conn.execute(
      'INSERT INTO doc_chunks (pack_id, source_file, heading, content) VALUES (?, ?, ?, ?)',
      [MY_PLANS_PACK_ID, 'my-plans', c.heading, c.content],
    );
  }
  // External-content FTS holds stale entries until rebuilt (db.ts owns the
  // why); refresh is debounced, so the wholesale rebuild stays cheap enough.
  rebuildFtsIndexes(conn);
}

// ---------------------------------------------------------------------------
// The sync loop: subscribe to both stores, debounce, rematerialize
// ---------------------------------------------------------------------------

/** One heart-tap burst must rebuild the doc once, not N times: a single
 * trailing-edge timer absorbs favorites and pins changes alike. 2 s is
 * imperceptible to retrieval (the Angel answers over the previous doc until
 * then) and long enough to swallow any tap flurry. */
export const MY_PLANS_DEBOUNCE_MS = 2000;

let pending: ReturnType<typeof setTimeout> | null = null;
let stops: Array<() => void> | null = null;

function schedule(): void {
  if (pending) {
    clearTimeout(pending);
  }
  pending = setTimeout(() => {
    pending = null;
    try {
      refreshMyPlansDoc();
    } catch (e) {
      // A failed projection must never crash the app from a timer; the
      // previous doc keeps answering and the next change retries.
      console.warn('[myPlans] refresh failed:', e);
    }
  }, MY_PLANS_DEBOUNCE_MS);
}

/** Idempotent (App's startup effect may re-run); the FIRST materialization
 * rides the same debounce, keeping doc synthesis off the launch critical
 * path while still guaranteeing the doc exists moments after boot. */
export function startMyPlansSync(): void {
  if (stops) {
    return;
  }
  stops = [subscribeFavoritesChanged(schedule), subscribePinsChanged(schedule)];
  schedule();
}

export function stopMyPlansSync(): void {
  if (!stops) {
    return;
  }
  for (const off of stops) {
    off();
  }
  stops = null;
  if (pending) {
    clearTimeout(pending);
    pending = null;
  }
}
