/**
 * First-run onboarding — logic seam (0.7.3).
 *
 * WIRING CONTRACT (main seat; this module touches no existing file):
 *
 *   Mount — in App.tsx, before the tab UI: when onboardingDone() is false,
 *   render <OnboardingFlow onDone={...}/> full-screen instead of (or above)
 *   the tabs. The flow persists its own choices and marks its own done flag;
 *   onDone only needs to flip local state so the app re-renders into the
 *   normal tabs. Note getSetting/getDb open the database, so mount AFTER the
 *   app's usual getDb() startup work, not before it.
 *
 *   Consume — all three keys are plain settings, all nullable (every step is
 *   skippable):
 *     getSetting('display_name')        → the greeting, and anywhere the app
 *                                         addresses this phone's human.
 *     getSetting('home_camp_name')      → seed the Home pin ("Take me home")
 *     getSetting('home_camp_location')    and the camp greeting. Location is
 *                                         a BRC address string when the camp
 *                                         came from the directory, '' when
 *                                         the user typed a camp freehand.
 *
 *   Replay — a Settings row can re-run the flow by rendering <OnboardingFlow/>
 *   directly (do NOT clear the done flag first; a crash mid-replay would
 *   otherwise re-gate the app). A finished replay overwrites only the answers
 *   the user gave: skipped steps never erase earlier answers.
 */

import { getDb, getSetting, setSetting } from '../events/db';
import { getCityGeometry } from '../geo/cityGeometry';
import { addressToLatLon } from '../geo/brcGeo';
import { HOME_LABEL, savePin } from '../geo/waypoints';
import { getMyCard, saveMyCard } from '../friends/friendCard';
import { campIndex } from './campIndex';

export const ONBOARDING_DONE_KEY = 'onboarding_done';
export const DISPLAY_NAME_KEY = 'display_name';
export const HOME_CAMP_NAME_KEY = 'home_camp_name';
export const HOME_CAMP_LOCATION_KEY = 'home_camp_location';

/** True once the flow has been completed OR skipped — either way, never
 * show it again on launch. */
export function onboardingDone(): boolean {
  return getSetting(ONBOARDING_DONE_KEY) === '1';
}

export function markOnboardingDone(): void {
  setSetting(ONBOARDING_DONE_KEY, '1');
}

export interface CampEntry {
  camp: string;
  location: string;
}

/**
 * The picker's source: the FULL official roster (camps-index.json, every
 * placed camp — 0.7.4, after a placed camp hosting no events was invisible),
 * unioned with every distinct camp across ENABLED event packs (which can
 * carry an event host the official register lacks). Deduped by camp name
 * (case-insensitively; the first spelling wins) keeping the first non-empty
 * location, because the events table repeats a camp once per event and
 * placement strings drift. The index leads: its names and placements are the
 * official dataset's own.
 */
export function campDirectory(): CampEntry[] {
  const byName = new Map<string, CampEntry>();
  const add = (camp: string, location: string) => {
    const key = camp.toLocaleLowerCase();
    const seen = byName.get(key);
    if (!seen) {
      byName.set(key, { camp, location });
    } else if (seen.location === '' && location !== '') {
      seen.location = location;
    }
  };
  for (const r of campIndex()) {
    add(r.camp, r.location);
  }
  const res = getDb().execute(
    "SELECT DISTINCT camp, location FROM events e JOIN packs p ON p.id = e.pack_id AND p.enabled = 1 WHERE camp != '' ORDER BY camp COLLATE NOCASE",
  );
  for (const row of res.rows?._array ?? []) {
    add(String(row.camp), String(row.location ?? ''));
  }
  return [...byName.values()].sort((a, b) =>
    a.camp.toLocaleLowerCase().localeCompare(b.camp.toLocaleLowerCase()),
  );
}

export interface OnboardingChoices {
  name?: string;
  camp?: string;
  location?: string;
}

/**
 * Persist whatever the flow collected. Empty/skipped fields write NOTHING
 * (a skip must never erase an earlier answer on replay). Location rides
 * with camp: without a camp it means nothing, so it is only stored — '' is
 * stored deliberately for a freehand camp — when a camp is stored.
 */
export function saveOnboardingChoices(choices: OnboardingChoices): void {
  const name = choices.name?.trim();
  if (name) {
    setSetting(DISPLAY_NAME_KEY, name);
  }
  const camp = choices.camp?.trim();
  const location = choices.location?.trim() ?? '';
  if (camp) {
    setSetting(HOME_CAMP_NAME_KEY, camp);
    setSetting(HOME_CAMP_LOCATION_KEY, location);
    // Seed the Home pin AT THE MOMENT OF CHOICE, never at flow completion:
    // a later replay that skips the camp step must not re-derive Home from
    // the stored setting and overwrite a GPS pin dropped at the actual tent
    // (CompassScreen's own rule: standing at your tent beats math). savePin
    // replaces by label, so re-picking a camp MOVES Home — also on purpose.
    if (location) {
      const geo = getCityGeometry();
      const at = geo ? addressToLatLon(location, geo) : null;
      if (at) {
        savePin(HOME_LABEL, at.lat, at.lon);
      }
    }
  }
  // Composition, not duplication: the my-card (Friends on playa) asks for
  // exactly these fields. A card never written gets seeded from the answers
  // — the camp-address Home fallback and the first card share both work
  // without typing anything twice. A card the user has already written is
  // never touched: it is their surface; onboarding only fills silence.
  try {
    const conn = getDb();
    if (name && getMyCard(conn).name === '') {
      saveMyCard(conn, { name, camp: camp ?? '', address: location, note: '' });
    }
  } catch {
    // The card is a bonus seam — a failure here must not lose the settings.
  }
}
