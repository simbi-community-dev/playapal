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

  test('the header holds BOTH a Map door and an Angel door', () => {
    const header = app.slice(headerStart, bodyStart);
    expect(header).toMatch(/accessibilityLabel="Open the map"/);
    expect(header).toMatch(/accessibilityLabel="Open the Angel conversation"/);
  });

  test('the doors open the surfaces that already exist, not new ones', () => {
    const header = app.slice(headerStart, bodyStart);
    expect(header).toMatch(/onOpenCompass\(null\)/); // the pins-picker path
    expect(header).toMatch(/setChatOpen\(true\)/); // the mounted ChatScreen
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
