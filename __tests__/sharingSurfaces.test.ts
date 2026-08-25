/**
 * The sharing consolidation's invariants (docs/SHARING-SURFACES.md).
 *
 * The audit's finding was NOT "too many share buttons" — it was that a share
 * control belongs beside the thing it shares (so most of them are correctly
 * placed), while the two doors that depend on nothing above them were filed
 * where nobody looks. So the risk this suite guards is the opposite of the
 * usual one: not that the regrouping failed, but that a later tidy-up
 * "finishes the job" by dragging the object-bound buttons into the Share
 * section too, or by pasting a second copy of a flow instead of reusing it.
 *
 * Two kinds of test, deliberately separated:
 *   - a real unit test of the request bus that makes "Show my card" work
 *     from a second place without forking the consent ask;
 *   - source assertions that every affordance the audit inventoried is still
 *     reachable, each written to DIE on a specific mutation named beside it.
 */

import {
  requestMyCardQr,
  subscribeMyCardQr,
} from '../src/friends/friendCard';

// Named readFile, not `read` or `readSource`: these suites are SCRIPTS, not
// modules, so a top-level const is global — both of those names already
// belong to other suites and tsc rejects the redeclaration (TS2451) while
// jest happily runs them all.
const readFile = (p: string): string =>
  require('fs').readFileSync(p, 'utf8') as string;

// src/crews/ is DELIBERATELY not asserted on. The pod's own share controls
// (the "We're together — swap cards" row, the pod code, the position toggle)
// are inventoried in docs/SHARING-SURFACES.md §1.8, but that file belongs to
// the mesh lane and is under active change: a tripwire here would fire on
// their legitimate work, not on a regression in this one.
const CAMP = 'src/screens/CampScreen.tsx';
const FRIENDS = 'src/screens/FriendsSection.tsx';

describe('the "Show my card" request bus', () => {
  test('a request reaches every live subscriber', () => {
    const heard: string[] = [];
    const offA = subscribeMyCardQr(() => heard.push('a'));
    const offB = subscribeMyCardQr(() => heard.push('b'));
    requestMyCardQr();
    expect(heard.sort()).toEqual(['a', 'b']);
    offA();
    offB();
  });

  test('unsubscribing actually stops delivery', () => {
    // Mutation: return a no-op unsubscribe — an unmounted FriendsSection
    // keeps answering and opens a modal on a screen that is gone.
    let calls = 0;
    const off = subscribeMyCardQr(() => {
      calls += 1;
    });
    off();
    requestMyCardQr();
    expect(calls).toBe(0);
  });

  test('a request with nobody listening is a silent no-op, never a throw', () => {
    // The honest degradation the header promises: FriendsSection is always
    // mounted by CampScreen today, and if that ever stops being true a dead
    // tap beats a crash in front of a camper.
    expect(() => requestMyCardQr()).not.toThrow();
  });
});

describe('every affordance the audit inventoried is still reachable', () => {
  const camp = readFile(CAMP);
  const friends = readFile(FRIENDS);

  test('the ONE inbound door exists exactly once, in the Share section', () => {
    // Mutation: leave a second "Import a pack…" button behind in Camp &
    // private packs — two buttons for the one receive path is precisely the
    // scattering this pass removed. Counted on the BUTTON (its a11y label),
    // not on the words: other sections quote the label in prose to send
    // people here, and those pointers are the point.
    expect(camp.match(/accessibilityLabel="Import a pack"/g)?.length).toBe(1);
    expect(camp.match(/onPress=\{doImport\}/g)?.length).toBe(1);
  });

  test('the board keeps its own beam button, next to the board', () => {
    // Mutation: move "Beam the board" into the Share section. The audit's
    // §3.1 rule is that object-bound controls stay with their object; the
    // beam button sits under the board it beams and must not migrate.
    expect(camp).toMatch(/accessibilityLabel="Beam the board"/);
    expect(camp).toMatch(/accessibilityLabel="Beam as file instead"/);
    // and it must NOT gain a duplicate: one label, one button
    expect(camp.match(/accessibilityLabel="Beam the board"/g)?.length).toBe(1);
  });

  test('the friend card keeps all four of its own share controls', () => {
    // Mutation: hollow out the card's share row "because Share & receive
    // covers it" — these sit beside the scope chips that govern them.
    expect(friends).toMatch(/onPress=\{\(\) => openQr\('me'\)\}/);
    expect(friends).toMatch(/onPress=\{shareCard\}/);
    // Asserts the WIRING, not the punctuation: beamFriends became async when
    // the crew started travelling as a file instead of as pasted JSON, so the
    // handler is now the `() => void fn()` form CampScreen already uses for
    // its beam. Pinning the exact spelling would have failed on a change that
    // did not touch this control's behaviour at all.
    expect(friends).toMatch(/onPress=\{(?:beamFriends|\(\) => void beamFriends\(\))\}/);
    expect(friends).toMatch(/onPress=\{shareList\}/); // the printable list
  });
});

describe('a second door reuses the one flow, never a copy of it', () => {
  const camp = readFile(CAMP);
  const friends = readFile(FRIENDS);

  test('Camp asks for the card QR instead of building one', () => {
    // Mutation: render a QRCode in CampScreen with its own encode + consent
    // Alert. That forks the app's ONLY consent primitive ("just for them /
    // pass it on") into two implementations that will drift.
    expect(camp).toMatch(/requestMyCardQr/);
    expect(camp).not.toMatch(/encodeFriendLink/);
    expect(camp).not.toMatch(/exportMyCard/);
    expect(camp).not.toMatch(/react-native-qrcode-svg/);
  });

  test('FriendsSection answers the request with its EXISTING openQr flow', () => {
    // Mutation: answer with a bare setQrMode('me') — that skips
    // askScopeThen, so a card shared from the Share row would carry whatever
    // scope was last picked without ever asking.
    expect(friends).toMatch(/subscribeMyCardQr\(\(\) => openQr\('me'\)\)/);
    // and openQr('me') must still route through the consent ask
    const openQr = friends.slice(
      friends.indexOf('const openQr'),
      friends.indexOf('const openQr') + 900,
    );
    expect(openQr).toMatch(/askScopeThen\(go\)/);
  });
});

describe('the Share section says who each path is for', () => {
  const camp = readFile(CAMP);
  // Anchored on the section's own header and on the NEXT section's opening
  // comment — not on the words "Camp & private packs", which also appear in
  // a comment near the top of the file and would slice an empty window.
  const share = camp.slice(
    camp.indexOf('accessibilityLabel="Share and receive"'),
    camp.indexOf('Camp & private packs (moved from'),
  );

  test('the section exists and folds like the rest of the app', () => {
    expect(share.length).toBeGreaterThan(0);
    // the SettingsScreen collapsible-header pattern: role, label, expanded
    expect(camp).toMatch(/accessibilityLabel="Share and receive"/);
    expect(camp).toMatch(/accessibilityState=\{\{ expanded: shareOpen \}\}/);
  });

  test('it opens by default — a hidden inbound door is the bug being fixed', () => {
    // Mutation: useState(false). "Import a pack…" is the only way IN that a
    // human has to find; folding it away by default recreates the defect.
    expect(camp).toMatch(/const \[shareOpen, setShareOpen\] = useState\(true\)/);
  });

  test('the signal question is answered on the rows where it bites', () => {
    // Mutation: drop the honesty. The QR's web fallback is the one half of
    // the card path that needs internet, and a camper cannot discover that
    // by trying — they find out when it fails at the gate.
    expect(share).toMatch(/needs signal/);
    expect(share).toMatch(/No signal, ever/);
  });

  test('it points at the doors it deliberately did not absorb', () => {
    // Mutation: delete the closing line and the section becomes a half-map
    // that reads as the complete list of ways to hand something over.
    expect(share).toMatch(/Beam the board/);
    expect(share).toMatch(/Friends on playa/);
  });
});
