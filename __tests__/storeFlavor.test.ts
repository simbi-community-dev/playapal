/**
 * THE STORE FLAVOR — what must be ABSENT from a binary, pinned.
 *
 * Two rows in this app are policy violations in a store build and load-bearing
 * features outside one:
 *
 *   "Update to latest"  — downloads the release APK and hands it to Android's
 *                         installer. Google Play's Device and Network Abuse
 *                         policy forbids exactly this.
 *   "Share Playa Pal"   — copies this app's own installed APK into a share
 *                         sheet. Alongside the updater, Play reads that as
 *                         unauthorised redistribution.
 *
 * Neither can simply be deleted: on the sideload road they are how the app
 * reaches a phone in the dust and how it ever hears about a newer build. So
 * they leave by FLAVOR — and a flavor split is precisely the kind of thing
 * that rots silently, because the build that would show the mistake is the one
 * nobody runs locally. Every assertion below therefore names the mutation it
 * dies on.
 *
 * THE LOCKS ARE INDEPENDENT AND BOTH ARE TESTED:
 *   1. the manifest overlay removes REQUEST_INSTALL_PACKAGES from the play
 *      binary, so the capability is absent rather than dormant;
 *   2. the JS channel flag hides both rows, so a Play reviewer never sees an
 *      affordance the binary cannot honour.
 */

import React from 'react';
import { Platform, Share } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

const fsx = require('fs');

const readSource = (p: string): string => fsx.readFileSync(p, 'utf8') as string;

const GRADLE = 'android/app/build.gradle';
const MAIN_MANIFEST = 'android/app/src/main/AndroidManifest.xml';
const PLAY_MANIFEST = 'android/app/src/play/AndroidManifest.xml';
const SETTINGS = 'src/screens/SettingsScreen.tsx';
const SHARE_ROW = 'src/screens/ShareAppRow.tsx';

// The channel every test in this file decides for itself. The module is
// mocked rather than driven through the real asset read because the real read
// crosses a native bridge that does not exist under jest — and because the
// PLANT this suite is built around is "the components ignore the channel",
// which a mock exposes and a real read cannot.
// `mock`-prefixed so jest's out-of-scope guard lets the factory close over it.
const mockChannel = { value: 'github' as 'github' | 'play' | 'ios-appstore' };
jest.mock('../src/config/distribution', () => ({
  distributionChannel: () => mockChannel.value,
  useDistributionChannel: () => mockChannel.value,
}));

const { UpdateRow } = require('../src/screens/UpdateRow');
const { ShareAppRow } = require('../src/screens/ShareAppRow');

function setPlatform(os: 'ios' | 'android'): void {
  (Platform as unknown as { OS: string }).OS = os;
}

function setDev(on: boolean): void {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = on;
}

/** Render, flush the mount effects, and hand back the rendered JSON. */
async function render(element: React.ReactElement): Promise<{
  json: unknown;
  tree: ReactTestRenderer;
}> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(element);
  });
  // The mount effects resolve native promises (describeInstalledApp, the
  // ShareApp stat); flushing them INSIDE act is what keeps their setState off
  // the console as an "not wrapped in act" warning on every green run.
  await act(async () => {});
  return { json: tree.toJSON(), tree };
}

/** Every string anywhere in a rendered tree, lowercased and joined. */
function renderedText(json: unknown): string {
  return JSON.stringify(json ?? null).toLowerCase();
}

const originalOS = Platform.OS;
const originalDev = (globalThis as unknown as { __DEV__: boolean }).__DEV__;

afterEach(() => {
  setPlatform(originalOS as 'ios' | 'android');
  setDev(originalDev);
  mockChannel.value = 'github';
  jest.restoreAllMocks();
});

describe('the play flavor carries neither forbidden row', () => {
  test('UpdateRow renders nothing at all on the play channel', async () => {
    // PLANT (run it to see this suite work): delete the `channel === 'play'`
    // early return in UpdateRow.tsx. The row renders "Check for update", this
    // assertion goes red, and the Store binary is offering a self-updater.
    mockChannel.value = 'play';
    setPlatform('android');
    const { json } = await render(React.createElement(UpdateRow, { version: '0.8.7' }));
    expect(json).toBeNull();
  });

  test('ShareAppRow renders nothing at all on the play channel', async () => {
    // PLANT: delete the `channel === 'play'` early return in ShareAppRow.tsx
    // — the row renders "Share Playa Pal", which is the APK-copy affordance.
    mockChannel.value = 'play';
    setPlatform('android');
    const { json } = await render(React.createElement(ShareAppRow));
    expect(json).toBeNull();
  });

  test('the update seam refuses to reach GitHub on a play build', () => {
    // The second lock, one layer down: even a row somebody re-adds by hand
    // cannot make this binary fetch an APK. Mutation: drop the guard in
    // checkLatestRelease and a Store build phones GitHub for a release.
    mockChannel.value = 'play';
    jest.isolateModules(() => {
      const seam = require('../src/update/appUpdate');
      const fetchSpy = jest
        .spyOn(globalThis as unknown as { fetch: unknown }, 'fetch' as never)
        .mockImplementation((() => {
          throw new Error('the play build must never reach the network here');
        }) as never);
      return Promise.all([
        seam.checkLatestRelease(),
        seam.downloadAndInstall(),
      ]).then(([check, download]: [any, any]) => {
        expect(check).toEqual({ ok: false, reason: 'store-build' });
        expect(download).toEqual({ ok: false, reason: 'store-build' });
        expect(fetchSpy).not.toHaveBeenCalled();
      });
    });
  });
});

describe('the github flavor keeps both rows, or the playa loses them', () => {
  test('UpdateRow renders its action on the github channel', async () => {
    // Guard the guard: if this went null too, the two play tests above would
    // pass for the wrong reason — a row that renders nothing anywhere.
    mockChannel.value = 'github';
    setPlatform('android');
    const { json } = await render(React.createElement(UpdateRow, { version: '0.8.7' }));
    expect(json).not.toBeNull();
    expect(renderedText(json)).toContain('check for update');
  });

  test('ShareAppRow renders the hand-over row on the github channel', async () => {
    mockChannel.value = 'github';
    setPlatform('android');
    const { json } = await render(React.createElement(ShareAppRow));
    expect(json).not.toBeNull();
    expect(renderedText(json)).toContain('share playa pal');
    // The field-bought install copy is what makes the row worth having.
    expect(renderedText(json)).toContain('play protect');
  });
});

describe('the App Store build never shows a TestFlight invite', () => {
  test('nothing in the released iOS row mentions TestFlight', async () => {
    // Apple rejects a shipping app that links to a beta of itself. Mutation:
    // render the TestFlight branch unconditionally on iOS and the App Store
    // build hands people an invite to the beta they already left.
    mockChannel.value = 'ios-appstore';
    setPlatform('ios');
    setDev(false);
    const { json } = await render(React.createElement(ShareAppRow));
    expect(json).not.toBeNull();
    expect(renderedText(json)).not.toContain('testflight');
    expect(renderedText(json)).toContain('playapal.lol');
  });

  test('the share sheet it opens carries the site, not the invite', async () => {
    // The rendered row is only half the surface: the URL that actually leaves
    // the phone is in the share message, which no render assertion sees.
    mockChannel.value = 'ios-appstore';
    setPlatform('ios');
    setDev(false);
    const shared = jest
      .spyOn(Share, 'share')
      .mockResolvedValue({ action: 'sharedAction' } as never);
    const { tree } = await render(React.createElement(ShareAppRow));
    const row = tree.root.findByProps({ accessibilityLabel: 'Share Playa Pal' });
    act(() => {
      row.props.onPress();
    });
    expect(shared).toHaveBeenCalledTimes(1);
    const message = String(shared.mock.calls[0][0].message).toLowerCase();
    expect(message).not.toContain('testflight');
    expect(message).toContain('playapal.lol');
  });

  test('a developer build still offers the invite', async () => {
    // Guard the guard: without this, deleting the TestFlight branch outright
    // would pass every assertion above while removing a real dev affordance.
    mockChannel.value = 'ios-appstore';
    setPlatform('ios');
    setDev(true);
    const { json } = await render(React.createElement(ShareAppRow));
    expect(renderedText(json)).toContain('testflight');
  });
});

describe('the build itself splits into the two channels', () => {
  const gradle = readSource(GRADLE);

  test('there are exactly two distribution flavors, named github and play', () => {
    // Mutation: rename either flavor and the generated flag stops matching
    // the word src/config/distribution.ts accepts, so every build reads as
    // 'play' — the sideload road silently loses its updater.
    expect(gradle).toMatch(/flavorDimensions "distribution"/);
    expect(gradle).toMatch(/productFlavors\s*\{/);
    expect(gradle).toMatch(/github\s*\{\s*\n\s*dimension "distribution"/);
    expect(gradle).toMatch(/play\s*\{\s*\n\s*dimension "distribution"/);
  });

  test('the flag is generated from the flavor name, never hand-written', () => {
    // THE SHARP ONE. A committed src/play/assets file reading "github" is a
    // policy violation no test could see. Mutation: replace the generator
    // with literal strings and the two can disagree forever.
    expect(gradle).toMatch(/tasks\.register\('writeDistributionFlag'\)/);
    expect(gradle).toMatch(/new File\(dir, fileName\)\.text = "\$\{flavor\}\\n"/);
    expect(gradle).toMatch(/DISTRIBUTION_FLAG_FILE = 'playapal-distribution\.txt'/);
    // Both flavor source sets read their own generated directory.
    expect(gradle).toMatch(/github \{ assets\.srcDir distributionFlagDir\("github"\) \}/);
    expect(gradle).toMatch(/play \{ assets\.srcDir distributionFlagDir\("play"\) \}/);
    // And the JS half reads the same file name.
    expect(readSource('src/config/distribution.ts')).toMatch(
      /FLAG_ASSET = 'playapal-distribution\.txt'/,
    );
  });

  test('both release-task matchers survive FLAVORED task names', () => {
    // THE ONE THAT WOULD HAVE SHIPPED THE DEBUG KEY. Both matchers were
    // written when the tasks were called `assembleRelease`; with flavors they
    // are `assembleGithubRelease` and `bundlePlayRelease`, and the original
    // `(assemble|bundle)Release` pattern matches NEITHER. The signing matcher
    // failing open means a release that should have been refused gets built
    // unsigned or debug-signed; the splits matcher failing shut means the
    // release APK carries every ABI again (+86 MB, measured on v0.6.1).
    const groovy = (line: string): RegExp => {
      const body = /[=]=~ \/\(\?i\)(.*)\/$/.exec(line.trim())?.[1];
      expect(body).toBeTruthy();
      return new RegExp(`^${body}$`, 'i');
    };
    const signing = groovy(
      gradle
        .split('\n')
        .find(l => l.includes('t.name ==~')) as string,
    );
    const splits = groovy(
      gradle
        .split('\n')
        .find(l => l.trim().startsWith('t ==~')) as string,
    );

    // Signing policy must fire on every release-producing task, flavored.
    for (const task of [
      'assembleRelease',
      'assembleGithubRelease',
      'assemblePlayRelease',
      'bundlePlayRelease',
      'bundleGithubRelease',
      'installGithubRelease',
      'packagePlayReleaseBundle',
    ]) {
      expect(signing.test(task)).toBe(true);
    }
    // ...and never on a debug build, which is what the 2026-08-17 fix bought.
    for (const task of ['assembleDebug', 'assembleGithubDebug', 'bundleGithubDebug']) {
      expect(signing.test(task)).toBe(false);
    }

    // The arm64 split is for APKs only: a bundle carries every ABI so Play
    // can serve per device, which is correct and must stay that way.
    expect(splits.test('assembleGithubRelease')).toBe(true);
    expect(splits.test('assembleRelease')).toBe(true);
    expect(splits.test('bundlePlayRelease')).toBe(false);
    expect(splits.test('assembleGithubDebug')).toBe(false);
  });
});

describe('the permission leaves the play binary, not just the screen', () => {
  test('the github road still declares REQUEST_INSTALL_PACKAGES', () => {
    // Guard the guard: if the main manifest lost it, the overlay test below
    // would pass while the sideload updater was dead on every phone.
    expect(readSource(MAIN_MANIFEST)).toContain(
      'android.permission.REQUEST_INSTALL_PACKAGES',
    );
  });

  test('the play overlay REMOVES it at manifest merge', () => {
    // Mutation: drop tools:node="remove" (or the whole overlay) and the
    // Store binary declares the one permission the policy is about, whatever
    // the UI does.
    const overlay = readSource(PLAY_MANIFEST);
    expect(overlay).toContain('xmlns:tools="http://schemas.android.com/tools"');
    expect(overlay).toMatch(
      /android:name="android\.permission\.REQUEST_INSTALL_PACKAGES"[\s\S]{0,80}tools:node="remove"/,
    );
    // And it removes nothing else: every other permission is shared by both
    // roads, and a stray tools:node here is a feature deleted in silence.
    // Comments stripped first — this file explains itself at length, and the
    // explanation naturally quotes the attribute it is about.
    const markup = overlay.replace(/<!--[\s\S]*?-->/g, '');
    expect(markup.match(/tools:node="remove"/g)?.length).toBe(1);
  });
});

describe('the About card tells the truth about itself', () => {
  const settings = readSource(SETTINGS);

  test('the privacy policy is one tap from Settings, at the exact URL', () => {
    // Both store listings carry this URL; a camper on playa cannot reach a
    // store page, so the app carries it too. Mutation: any other path (the
    // apex, a /policy typo) and the row opens a 404 with no signal to notice.
    expect(settings).toContain(
      "Linking.openURL('https://playapal.lol/privacy')",
    );
    expect(settings).toContain('<Text style={styles.aboutLink}>Privacy policy</Text>');
    expect(settings).toContain('accessibilityLabel="Read the privacy policy"');
    // Same row idiom as its neighbours — a link, not a button.
    expect(settings).toMatch(
      /accessibilityRole="link"[\s\S]{0,120}Read the privacy policy/,
    );
  });

  test('the app does not call the repository open source', () => {
    // CLAUDE.md, Legal: bundled data and third-party assets carry unresolved
    // redistribution terms, so "open source" is a claim about the whole
    // repository this project has not earned. The CODE licence is stated in
    // the fine print below the links, and stays.
    // JSX comments stripped: the comment beside the fix quotes the phrase it
    // removed, which is exactly the right thing for it to say and exactly the
    // wrong thing to count.
    const about = settings
      .slice(settings.indexOf('Playa Pal {APP_VERSION}'))
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    expect(about).not.toContain('open source');
    expect(about).toContain('source readable on GitHub');
    expect(about).toContain('Code: Apache-2.0');
  });
});

describe('the row file keeps its TestFlight constant honest', () => {
  const row = readSource(SHARE_ROW);

  test('the TestFlight link is reached only through the dev gate', () => {
    // A render assertion proves what one build did; this proves there is no
    // second path to the constant. Mutation: add another `${TESTFLIGHT_` use
    // outside the iosInvite branch and a release build can reach it again.
    expect(row).toContain("const iosInvite = Platform.OS === 'ios' && __DEV__;");
    const uses = row.match(/TESTFLIGHT_PUBLIC_LINK/g)?.length ?? 0;
    // One declaration, plus three uses — all of them downstream of the
    // `if (!iosInvite) return` above them: the emptiness check, the alert
    // branch, and the share message.
    expect(uses).toBe(4);
    expect(row).toContain('if (!iosInvite) {');
  });
});
