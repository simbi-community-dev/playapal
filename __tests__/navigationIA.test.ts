/**
 * Navigation information architecture — the rules a cross-family meld
 * converged on 2026-08-20, after the owner reported: "the angel and map
 * surfaces are triggered in totally different ways by randomly placed
 * buttons... tufte would be embarrased."
 *
 * Two rules, both mechanical enough to assert:
 *
 * 1. THE TWO DOORS ARE PEERS. Angel already had a persistent header
 *    control rendered above the tab conditional, reachable from every tab.
 *    Map had none — it was reachable only through a giant Now-screen
 *    button, per-event chips, and friend chips, each a different shape.
 *    That asymmetry WAS the defect. Both doors now live in the same header.
 *
 * 2. ONE GLYPH, ONE MEANING. The compass glyph meant three unrelated
 *    things at once: an emergency action (Take me home), a navigate-link
 *    (friend/event chips), and a VIEW TOGGLE inside CompassScreen. A view
 *    choice is not a destination, so it no longer borrows the destination
 *    glyph.
 */

const readSrc = (p: string): string =>
  require('fs').readFileSync(p, 'utf8') as string;

const COMPASS = '\u{1F9ED}';

describe('both surfaces have a door in the global header', () => {
  const app = readSrc('App.tsx');
  const headerStart = app.indexOf('<View style={styles.header}>');
  const bodyStart = app.indexOf('<View style={styles.body}>');

  test('the header is rendered above the tab conditional, not inside it', () => {
    expect(headerStart).toBeGreaterThan(-1);
    expect(bodyStart).toBeGreaterThan(headerStart);
    // no tab check may sit between them, or a door would be tab-local
    expect(app.slice(headerStart, bodyStart)).not.toMatch(/tab === /);
  });

  test('the header holds the Map door and the Settings gear', () => {
    const header = app.slice(headerStart, bodyStart);
    // The Map door is the HomeArrow component since 0.7.3 (compass-as-home):
    // the same pill, upgraded to point home when it can. Its accessibility
    // label rides inside the component now, so assert the composition here
    // and the label at its new owner. Settings took the second seat on
    // Aug 27 (owner IA): a gear in the top right, where a decade of app
    // habit already looks for it.
    expect(header).toMatch(/<HomeArrow/);
    expect(readSrc('src/components/HomeArrow.tsx')).toMatch(/'Open the map'/);
    expect(header).toMatch(/accessibilityLabel="Open Settings"/);
    // The Angel's header door is GONE — its door moved to the bar below.
    // Both doors at once would be the two-doors-to-one-room defect. (The
    // pin names the door, not the word: comments may tell the history.)
    expect(header).not.toMatch(
      /accessibilityLabel="Open the Angel conversation"/,
    );
  });

  test('the doors open the surfaces that already exist, not new ones', () => {
    const header = app.slice(headerStart, bodyStart);
    expect(header).toMatch(/onOpenCompass\(null\)/); // the pins-picker path
    expect(header).toMatch(/openTab\('settings'\)/); // the existing screen
  });
});

describe("the Angel's door is the bar's fourth slot (owner IA, Aug 27)", () => {
  const app = readSrc('App.tsx');
  const barStart = app.indexOf('<View style={styles.tabBar}');
  const barEnd = app.indexOf('chatOpen', barStart) > -1
    ? app.indexOf('</View>', app.lastIndexOf('accessibilityLabel="Open the Angel conversation"'))
    : -1;
  const bar = app.slice(barStart, app.indexOf('\n      <View', barStart + 1));

  test('the bar holds the Angel door with its historic label and target', () => {
    // The label is the one AppChatLifecycle has always pressed, and the
    // target is the mounted ChatScreen overlay — the door moved, the room
    // did not. Mutation: route the slot through a new Tab key and the
    // ask-mode architecture (session singleton, mounted transcript) forks.
    expect(barStart).toBeGreaterThan(-1);
    expect(bar).toMatch(/accessibilityLabel="Open the Angel conversation"/);
    expect(bar).toMatch(/setChatOpen\(true\)/);
    expect(barEnd).not.toBe(0); // structural sanity for the slice above
  });

  test('Settings has no bar slot — the gear is its only door', () => {
    // Mutation: leave settings in TABS and the row grows to five, which is
    // exactly the crowding the owner's IA pass removed.
    expect(app).toMatch(/const TABS[\s\S]*?\];/);
    const tabsBlock = app.match(/const TABS[\s\S]*?\];/)![0];
    expect(tabsBlock).not.toMatch(/settings/);
    expect(tabsBlock).toMatch(/'now'/);
    expect(tabsBlock).toMatch(/'pod'/);
    expect(tabsBlock).toMatch(/'camp'/);
  });
});

describe('one glyph, one meaning', () => {
  const files = [
    'App.tsx',
    'src/screens/RightNowScreen.tsx',
    'src/screens/CompassScreen.tsx',
    'src/screens/FriendsSection.tsx',
  ];

  test('the compass glyph is never used for a view toggle', () => {
    const compass = readSrc('src/screens/CompassScreen.tsx');
    const toggleStart = compass.indexOf('styles.viewToggleText');
    expect(toggleStart).toBeGreaterThan(-1);
    // the toggle's own rendered label must carry no destination glyph
    const toggle = compass.slice(toggleStart, toggleStart + 200);
    expect(toggle).not.toContain(COMPASS);
  });

  test('every surviving compass glyph marks a destination', () => {
    // Each remaining use must sit on something that opens the compass at a
    // target: Take-me-home, or a friend/event location chip.
    const uses: string[] = [];
    for (const f of files) {
      for (const line of readSrc(f).split('\n')) {
        if (line.includes(COMPASS)) {
          uses.push(`${f}: ${line.trim()}`);
        }
      }
    }
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      expect(u).toMatch(/Take me home|\{where\}/);
    }
  });
});
