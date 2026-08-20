/**
 * Release identity: every surface that names a version must name the SAME one.
 *
 * A release is not one version string, it is seven, spread across four files
 * and two app stores. v0.6.1 was staged with package.json, build.gradle and
 * the docs at 0.6.1 while package-lock.json and BOTH iOS build configs still
 * said 0.6.0 — so the iOS build would have shipped to TestFlight labelled
 * 0.6.0, landing under "previous versions" exactly like the confusion this
 * project already hit once with builds 5 and 6. Nothing failed; the app
 * compiled, the tests passed, and only a reviewer reading the diff caught it
 * (cross-family ship council, 2026-08-20, gpt).
 *
 * The build number is checked the same way: Android versionCode and iOS
 * CURRENT_PROJECT_VERSION are the same counter for two stores and must not
 * drift apart.
 */

const read = (p: string): string =>
  require('fs').readFileSync(p, 'utf8') as string;
const uniq = (xs: string[]): string[] => [...new Set(xs)];

const all = (src: string, re: RegExp): string[] => {
  const out: string[] = [];
  for (const m of src.matchAll(re)) {
    out.push(m[1]);
  }
  return out;
};

describe('every version surface names the same version', () => {
  const pkg = JSON.parse(read('package.json')) as { version: string };
  const lock = JSON.parse(read('package-lock.json')) as {
    version: string;
    packages: Record<string, { version?: string }>;
  };
  const gradle = read('android/app/build.gradle');
  const pbx = read('ios/PlayaPal.xcodeproj/project.pbxproj');

  const marketing = uniq(all(pbx, /MARKETING_VERSION = ([\d.]+);/g));
  const projectVer = uniq(all(pbx, /CURRENT_PROJECT_VERSION = (\d+);/g));
  const versionName = /versionName "([^"]+)"/.exec(gradle)?.[1];
  const versionCode = /versionCode (\d+)/.exec(gradle)?.[1];

  test('package.json and package-lock.json agree', () => {
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages['']?.version).toBe(pkg.version);
  });

  test('android versionName matches package.json', () => {
    expect(versionName).toBe(pkg.version);
  });

  test('every iOS build config names one marketing version, matching package.json', () => {
    // both Debug and Release configs — a half-bumped project ships the old
    // number from whichever config the release scheme happens to use.
    // Count the RAW occurrences too, not just the unique set: uniq() proves
    // the configs AGREE but would also pass if a key were deleted outright,
    // and a missing MARKETING_VERSION falls back to whatever Xcode infers
    // (gpt, ship council 2026-08-20).
    const rawMarketing = all(pbx, /MARKETING_VERSION = ([\d.]+);/g);
    const rawProject = all(pbx, /CURRENT_PROJECT_VERSION = (\d+);/g);
    expect(rawMarketing.length).toBeGreaterThanOrEqual(2);
    expect(rawProject.length).toBeGreaterThanOrEqual(2);
    expect(marketing.length).toBe(1);
    expect(marketing[0]).toBe(pkg.version);
  });

  test('the build number is one counter across both stores', () => {
    expect(projectVer.length).toBe(1);
    expect(projectVer[0]).toBe(versionCode);
  });

  test('the changelog documents the version being shipped', () => {
    const changelog = read('CHANGELOG.md');
    expect(changelog).toMatch(new RegExp(`^## ${pkg.version.replace(/\./g, '\\.')}: `, 'm'));
  });
});
