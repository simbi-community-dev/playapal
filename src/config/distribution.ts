/**
 * WHICH ROAD THIS COPY CAME DOWN — the one fact two Settings rows are not
 * allowed to guess.
 *
 * THE HOLE THIS FILLS. Playa Pal ships down two roads with the same
 * applicationId and the same JS bundle:
 *
 *   github — handed phone to phone in the dust, and updated by "Update to
 *            latest" (src/update/appUpdate.ts) because nothing else out
 *            there will ever tell a camper a newer build exists.
 *   play   — the Store, where BOTH of those are policy violations: Google
 *            Play's Device and Network Abuse policy forbids an app that
 *            downloads and installs its own APK, and reads "hand my whole
 *            APK to another phone" alongside it as unauthorised
 *            redistribution.
 *   ios-appstore — Apple installs only what Apple delivered; neither row
 *            was ever real there.
 *
 * The permission that makes the updater possible is struck from the play
 * binary at manifest merge (android/app/src/play/AndroidManifest.xml), so
 * this module is not the security boundary. It is the HONESTY boundary: a
 * row that cannot work must not be on the screen, and a Play reviewer who
 * finds "Update to latest" in a Store build files a rejection whether or not
 * tapping it does anything.
 *
 * WHY AN ASSET, AND NOT A BuildConfig FIELD. React Native builds ONE JS
 * bundle for every variant, so nothing inside the bundle can know its
 * flavor; the answer has to come across the native seam. BuildConfig is
 * Kotlin-only unless someone writes a native module to hand it over, and a
 * whole new bridge for one word is more moving parts than the job is worth.
 * The cheapest seam that ALREADY EXISTS on the JS side is the Android asset
 * directory: @dr.pogodin/react-native-fs is a dependency this app uses in
 * eight other places, `readFileAssets` reads straight out of the APK, and
 * AGP merges a flavor's assets into that flavor and no other. Gradle writes
 * the word from the flavor's own name (android/app/build.gradle,
 * `writeDistributionFlag`), so the file and the flavor cannot disagree.
 *
 * IT FAILS CLOSED. Until the read lands — and forever, if it never does —
 * an Android build answers 'play', the answer that HIDES things. The cost of
 * being wrong in that direction is a sideloader waiting a few milliseconds
 * for a Settings row; the cost of being wrong the other way is a Store
 * policy strike. The read is primed at module load, which on this app means
 * during startup, several tab-taps before either row can mount.
 */

import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

export type DistributionChannel = 'github' | 'play' | 'ios-appstore';

/** Written per flavor by the `writeDistributionFlag` gradle task. */
const FLAG_ASSET = 'playapal-distribution.txt';

let channel: DistributionChannel =
  Platform.OS === 'ios' ? 'ios-appstore' : 'play';

/** True once the answer is final; it settles exactly once per app launch. */
let settled = Platform.OS !== 'android';

/** Rows mounted before the read lands, waiting to be told. */
const waiting = new Set<(c: DistributionChannel) => void>();

function settle(next: DistributionChannel): void {
  channel = next;
  settled = true;
  const listeners = [...waiting];
  waiting.clear();
  for (const notify of listeners) {
    notify(next);
  }
}

/**
 * Read the flag once, at import. Required lazily and wrapped twice over:
 * under jest there is no native file system at all, and a module that throws
 * while being imported takes every screen that imports it down with it.
 */
function prime(): void {
  if (Platform.OS !== 'android') {
    settle('ios-appstore');
    return;
  }
  try {
    const fs = require('@dr.pogodin/react-native-fs');
    Promise.resolve(fs.readFileAssets(FLAG_ASSET, 'utf8'))
      .then((raw: unknown) => {
        const word = String(raw ?? '').trim();
        // Only the two words we write are accepted. Anything else is a build
        // this code does not understand, and an unknown build hides.
        settle(word === 'github' ? 'github' : 'play');
      })
      .catch(() => settle('play'));
  } catch {
    settle('play');
  }
}

prime();

/**
 * The channel, for code that is not a React component (the update seam's
 * own refusal). Synchronous on purpose: a refusal that has to await is a
 * refusal that arrives after the network call it was meant to prevent.
 */
export function distributionChannel(): DistributionChannel {
  return channel;
}

/**
 * The channel, for components. Identical to `distributionChannel()` once the
 * read has landed; before that it subscribes, so a row that mounted during
 * the first few milliseconds of app life still corrects itself instead of
 * staying hidden for the session.
 */
export function useDistributionChannel(): DistributionChannel {
  const [current, setCurrent] = useState<DistributionChannel>(channel);
  useEffect(() => {
    if (settled) {
      setCurrent(channel);
      return;
    }
    let alive = true;
    const notify = (next: DistributionChannel) => {
      if (alive) {
        setCurrent(next);
      }
    };
    waiting.add(notify);
    return () => {
      alive = false;
      waiting.delete(notify);
    };
  }, []);
  return current;
}
