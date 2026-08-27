/**
 * The pod connection list, held to its two laws (src/crews/podStatus.ts):
 * proof before claim (docs/WALKIE-LADDER.md §5) and capability words, never
 * mechanism (§5a). Each assertion names the mutation it dies on — the
 * walkieCap.test.ts idiom.
 */
import {
  checkOutcomePhrase,
  lastSyncPhrase,
  linkGlyph,
  linkSummary,
  memberLinkTier,
  myLinkStatus,
  rungsByName,
  tierPhrase,
  type LinkTier,
} from '../src/crews/podStatus';
import { nameKey } from '../src/crews/rosterFold';
import {
  formatChannelNames,
  stopWalkie,
  subscribeWalkieChannel,
  walkieChannelRevision,
} from '../src/crews/walkie';

const TIERS: LinkTier[] = ['voice', 'voice-lofi', 'near', 'recent', 'quiet'];

describe('the tier is evidence, degraded downward silently (§5)', () => {
  test('a proven walkie row outranks presence — voice needs no beacon', () => {
    // Mutation: require presence for the voice tiers — a LAN podmate whose
    // Bluetooth beacon never reached this phone (different radio!) would
    // read "quiet" while their voice is literally playing.
    expect(memberLinkTier({ walkieRung: 'lan', presence: null })).toBe('voice');
    expect(memberLinkTier({ walkieRung: 'aware', presence: null })).toBe(
      'voice',
    );
  });

  test('a BLE walkie row is lo-fi voice, not full voice and not less', () => {
    // Mutation 1: fold ble into 'voice' — the row promises a quality the
    // camper can hear is missing, and the panel's (lo-fi) badge beside it
    // contradicts this list on the same screen.
    // Mutation 2: fold ble below 'near' — a proven live channel renders as
    // mere proximity, §2a's degraded-live failure inverted.
    expect(
      memberLinkTier({
        walkieRung: 'ble',
        presence: { atMs: 0, live: true },
      }),
    ).toBe('voice-lofi');
  });

  test('presence alone claims messages, never voice', () => {
    // Mutation: promote a live beacon to a voice tier — a beacon proves
    // "their radio reaches mine", not a voice channel; §5 forbids the
    // claim without the proven link.
    expect(
      memberLinkTier({ walkieRung: null, presence: { atMs: 5, live: true } }),
    ).toBe('near');
    expect(
      memberLinkTier({ walkieRung: null, presence: { atMs: 5, live: false } }),
    ).toBe('recent');
  });

  test('no evidence at all is the calm floor, not an error', () => {
    expect(memberLinkTier({ walkieRung: null, presence: null })).toBe('quiet');
  });
});

describe('capability words, never mechanism (§5a + the owner ask)', () => {
  // The ban list: every protocol/radio word the design forbids the user
  // from ever reading. \b keeps 'lan' from matching inside ordinary words.
  const BANNED =
    /\b(ble|gatt|aware|lan|nan|datapath|rung|ladder|wi-?fi|bluetooth|udp|mdns|subnet|protocol)\b/i;

  test('no member phrase speaks a protocol word', () => {
    // Mutation: word a phrase as "BLE voice" or "no datapath" — the exact
    // vocabulary the design bans, and the door to rung superstition.
    for (const t of TIERS) {
      expect(tierPhrase(t)).not.toMatch(BANNED);
    }
  });

  test('no self phrase speaks a protocol word either', () => {
    // Every reachable combination, including the two the mailbox lane
    // added: carrying mail with the position private, and carrying nothing
    // at all.
    const states = [
      { sharingOn: true, radioDown: true, walkieOn: false, mailboxOn: true, waitingForFix: false },
      { sharingOn: true, radioDown: false, walkieOn: true, mailboxOn: true, waitingForFix: false },
      { sharingOn: true, radioDown: false, walkieOn: false, mailboxOn: true, waitingForFix: false },
      { sharingOn: false, radioDown: false, walkieOn: true, mailboxOn: true, waitingForFix: false },
      { sharingOn: false, radioDown: false, walkieOn: false, mailboxOn: true, waitingForFix: false },
      { sharingOn: false, radioDown: true, walkieOn: false, mailboxOn: true, waitingForFix: false },
      { sharingOn: false, radioDown: false, walkieOn: false, mailboxOn: false, waitingForFix: false },
    ];
    for (const s of states) {
      expect(myLinkStatus(s).phrase).not.toMatch(BANNED);
    }
  });

  test('the lo-fi word is the SAME word the channel list wears — one lane, one bar', () => {
    // Mutation: rename the tier's word ("rough voice", "low quality") —
    // two vocabularies for one audible fact, on one screen.
    expect(tierPhrase('voice-lofi')).toMatch(/lo-fi/);
    expect(formatChannelNames([{ name: 'Marisol', rung: 'ble' }])).toContain(
      '(lo-fi)',
    );
  });

  test('an absent member reads calmly, as a member', () => {
    // Mutation: word 'quiet' as loss ("unreachable", "offline", "lost") —
    // §1: absence of link is a state to show calmly, never an error.
    expect(tierPhrase('quiet')).not.toMatch(
      /\b(error|offline|unreachable|lost|failed|dead)\b/i,
    );
    expect(tierPhrase('quiet')).toMatch(/messages keep/);
  });
});

describe('the manual check reports honestly, in capability words', () => {
  const BANNED =
    /\b(ble|gatt|aware|lan|nan|datapath|rung|ladder|wi-?fi|bluetooth|udp|mdns|subnet|protocol)\b/i;

  test('zero in range says nobody, calmly, in the summary\'s own promise', () => {
    // Mutation: word the empty result as failure (or as a shrugging "done")
    // — the check becomes the fake spinner it exists to replace.
    const p = checkOutcomePhrase({ inRange: 0, moved: 0 });
    expect(p).toMatch(/Nobody in range/);
    expect(p).toMatch(/notes keep/);
  });

  test('movement is counted, not vibed', () => {
    // Mutation: report "caught up" without the count — the user cannot tell
    // a real delivery from a no-op and stops trusting the button.
    expect(checkOutcomePhrase({ inRange: 2, moved: 3 })).toMatch(
      /3 new messages/,
    );
    expect(checkOutcomePhrase({ inRange: 1, moved: 1 })).toMatch(
      /1 new message\b/,
    );
  });

  test('in range with nothing new is caught up, never an error', () => {
    expect(checkOutcomePhrase({ inRange: 1, moved: 0 })).toMatch(/caught up/i);
  });

  test('no check or recency phrase speaks a protocol word', () => {
    const phrases = [
      checkOutcomePhrase({ inRange: 0, moved: 0 }),
      checkOutcomePhrase({ inRange: 1, moved: 0 }),
      checkOutcomePhrase({ inRange: 2, moved: 5 }),
      lastSyncPhrase(null),
      lastSyncPhrase('2m ago'),
    ];
    for (const p of phrases) {
      expect(p).not.toMatch(BANNED);
    }
  });

  test('recency is stated or honestly absent', () => {
    // Mutation: default the null case to a cheerful "just now" — staleness
    // dressed as freshness, the exact lie this surface exists to end.
    expect(lastSyncPhrase(null)).toMatch(/Not caught up/);
    expect(lastSyncPhrase('2m ago')).toBe('Last caught up 2m ago');
  });
});

describe('the glyph ranks by ink, and never alone', () => {
  test('more link is more ink: voice > lo-fi > near, all from one family', () => {
    // Mutation: equalize the step glyphs — the eye can no longer rank rows
    // without reading, which was the glyph's whole job.
    const steps = ['voice', 'voice-lofi', 'near'] as const;
    const lens = steps.map(t => [...linkGlyph(t)].length);
    expect(lens[0]).toBeGreaterThan(lens[1]);
    expect(lens[1]).toBeGreaterThan(lens[2]);
  });

  test('the non-live shapes are a different KIND, not a smaller amount (§2a)', () => {
    // Mutation: render 'recent'/'quiet' as zero-or-one bar steps — an
    // async podmate drawn as a weak live one is the exact collapse §2a
    // forbids.
    for (const t of ['recent', 'quiet'] as const) {
      expect(linkGlyph(t)).not.toMatch(/[▂▄▆]/);
    }
    // Every tier's glyph is distinct — five states, five shapes.
    expect(new Set(TIERS.map(linkGlyph)).size).toBe(TIERS.length);
  });
});

describe('walkie rows match roster rows by the ONE name fold', () => {
  test('the key is rosterFold\'s own fold — spacing and case never split a person', () => {
    // Mutation: key the map on the raw name — " Dusty" on the channel and
    // "dusty" on the roster become two people and the badge lands nowhere.
    const m = rungsByName([{ name: '  Dusty  Rhodes ', rung: 'aware' }]);
    expect(m.get(nameKey('dusty rhodes'))).toBe('aware');
  });

  test('a name collision keeps the better rung, whichever order it arrives', () => {
    // Mutation: last-write-wins — the tier flaps with event order, and the
    // camper watches a row wobble between lo-fi and voice for no reason.
    const better = rungsByName([
      { name: 'Pug', rung: 'ble' },
      { name: 'Pug', rung: 'lan' },
    ]);
    expect(better.get(nameKey('Pug'))).toBe('lan');
    const reversed = rungsByName([
      { name: 'Pug', rung: 'lan' },
      { name: 'Pug', rung: 'ble' },
    ]);
    expect(reversed.get(nameKey('Pug'))).toBe('lan');
  });
});

describe('the summary counts reach honestly', () => {
  test('zero members, zero reach and mixed lists each get their own sentence', () => {
    expect(linkSummary([])).toBe('No podmates in the list yet');
    // Mutation: count 'recent' as in-reach — "1 of 1 in reach" about a
    // podmate who left an hour ago is a promise the mesh cannot keep.
    expect(linkSummary(['recent', 'quiet'])).toMatch(/Nobody in reach/);
    expect(linkSummary(['voice', 'near', 'quiet'])).toBe(
      '2 of 3 in reach · voice with 1',
    );
    expect(linkSummary(['near', 'quiet'])).toBe('1 of 2 in reach');
  });
});

describe('my own state: radio truth orders the arms', () => {
  test('a dead radio beats every on-switch (§5: intent is not carriage)', () => {
    // Mutation: check walkieOn first — the header claims "on the air"
    // while the pod provably cannot hear this phone.
    const s = myLinkStatus({
      sharingOn: true,
      radioDown: true,
      walkieOn: true,
      mailboxOn: true,
      waitingForFix: false,
    });
    expect(s.phrase).toMatch(/paused/i);
    expect(s.glyph).toBe('—');
  });

  test('the glyph grows with what is actually on', () => {
    const both = myLinkStatus({
      sharingOn: true,
      radioDown: false,
      walkieOn: true,
      mailboxOn: true,
      waitingForFix: false,
    });
    const share = myLinkStatus({
      sharingOn: true,
      radioDown: false,
      walkieOn: false,
      mailboxOn: true,
      waitingForFix: false,
    });
    const off = myLinkStatus({
      sharingOn: false,
      radioDown: false,
      walkieOn: false,
      mailboxOn: false,
      waitingForFix: false,
    });
    expect([...both.glyph].length).toBeGreaterThan([...share.glyph].length);
    expect(off.glyph).toBe('—');
    expect(off.phrase).toMatch(/quiet/i);
  });
});

/**
 * QUIET GOT A SMALLER MEANING (mailbox decoupling, 2026-08-25). Until this
 * lane, a phone with sharing off did nothing at all — no advert, no scan,
 * no delivery — so "podmates can't see this phone" was the whole truth. Now
 * the app carries pod mail whenever it is open, and the same sentence would
 * tell a camper their message is going nowhere while it is in fact on its
 * way. These pin the two halves apart.
 */
describe('quiet means unplaced, not undeliverable', () => {
  const BANNED =
    /\b(ble|gatt|aware|lan|nan|datapath|rung|ladder|wi-?fi|bluetooth|udp|mdns|subnet|protocol)\b/i;

  test('carrying mail with the position private says BOTH things', () => {
    // Mutation: keep the old single sentence for this state — the camper
    // reads "podmates can't see this phone" and concludes, wrongly, that
    // their note will not arrive.
    const s = myLinkStatus({
      sharingOn: false,
      radioDown: false,
      walkieOn: false,
      mailboxOn: true,
      waitingForFix: false,
    });
    expect(s.phrase).toMatch(/messages/i); // mail moves
    expect(s.phrase).toMatch(/where you are|position|see you/i); // place does not
    expect(s.phrase).not.toMatch(BANNED);
    // Still a calm state, never an error — §1's rule for absent links.
    expect(s.phrase).not.toMatch(/\b(error|offline|unreachable|failed|dead)\b/i);
  });

  test('nothing on the air at all is a DIFFERENT sentence', () => {
    // Mutation: give both states one phrase — one of the two is then a lie,
    // and which one depends on the day.
    const carrying = myLinkStatus({
      sharingOn: false,
      radioDown: false,
      walkieOn: false,
      mailboxOn: true,
      waitingForFix: false,
    });
    const nothing = myLinkStatus({
      sharingOn: false,
      radioDown: false,
      walkieOn: false,
      mailboxOn: false,
      waitingForFix: false,
    });
    expect(nothing.phrase).not.toBe(carrying.phrase);
    expect(nothing.phrase).toMatch(/quiet/i);
    expect(nothing.glyph).toBe('—');
  });

  test('a mailbox whose radio died never claims mail is moving', () => {
    // Mutation: order the mailbox arm above the radio-truth arm — §5's
    // "intent is not carriage" broken for the mail half exactly the way it
    // once was for the sharing half.
    const s = myLinkStatus({
      sharingOn: false,
      radioDown: true,
      walkieOn: false,
      mailboxOn: true,
      waitingForFix: false,
    });
    expect(s.glyph).toBe('—');
    expect(s.phrase).toMatch(/off the air|wait/i);
    expect(s.phrase).not.toMatch(BANNED);
  });

  test('waiting for a fix is not a dead radio, and says so', () => {
    // The regression this lane could have shipped: 'no-fix' used to be a
    // radio interruption like any other, and the header said "the pod can't
    // hear this phone right now". Since the fixless phone now falls back to
    // the mailbox frame, that sentence would be false in the one direction
    // that matters to a camper waiting on a message.
    // Mutation: fold waitingForFix back into radioDown — the phrase claims
    // nothing is moving while the mail is moving.
    const s = myLinkStatus({
      sharingOn: true,
      radioDown: false,
      walkieOn: false,
      mailboxOn: true,
      waitingForFix: true,
    });
    expect(s.phrase).toMatch(/messages are moving/i);
    expect(s.phrase).toMatch(/position|fix/i);
    expect(s.phrase).not.toMatch(/can't hear|cannot hear/i);
    expect(s.phrase).not.toMatch(BANNED);
    // A REAL fault still wins over it: an adapter that died while we were
    // waiting for a fix is a dead radio, not a patient one.
    expect(
      myLinkStatus({
        sharingOn: true,
        radioDown: true,
        walkieOn: false,
        mailboxOn: true,
        waitingForFix: true,
      }).phrase,
    ).toMatch(/paused/);
  });

  test('sharing ON is untouched by any of it', () => {
    // Mutation: let the mailbox arm swallow the sharing arms — the whole
    // point of the lane is that sharing behaves exactly as it did.
    expect(
      myLinkStatus({
        sharingOn: true,
        radioDown: false,
        walkieOn: false,
        mailboxOn: true,
        waitingForFix: false,
      }).phrase,
    ).toBe("You're on the air — podmates in range can find you");
    expect(
      myLinkStatus({
        sharingOn: true,
        radioDown: true,
        walkieOn: false,
        mailboxOn: true,
        waitingForFix: false,
      }).phrase,
    ).toMatch(/paused/);
  });
});

describe('the walkie channel is a subscribable store', () => {
  test('closing the walkie bumps the revision so claims can drop with it', async () => {
    // Mutation: drop notifyWalkieChannel from stopWalkie — the link list
    // never re-renders on close and the last peer list keeps reading
    // "voice now" about a channel that no longer exists (staleness, the
    // enemy).
    let fired = 0;
    const off = subscribeWalkieChannel(() => {
      fired += 1;
    });
    const before = walkieChannelRevision();
    await stopWalkie();
    expect(walkieChannelRevision()).toBeGreaterThan(before);
    expect(fired).toBeGreaterThan(0);
    off();
  });
});

// The walkieLadder.test.ts source-reading idiom (typed require, no
// @types/node in this tree).
const readSource = (p: string): string =>
  require('fs').readFileSync(p, 'utf8') as string;

describe('wiring: one store, actually mounted', () => {
  const podLinks = readSource('src/crews/PodLinks.tsx');
  const crewSection = readSource('src/crews/CrewSection.tsx');

  test('CrewSection mounts the list — a feature nobody can reach is not shipped', () => {
    // Mutation: delete the <PodLinks mount — every pure function above
    // stays green while the owner's ask silently vanishes from the app.
    expect(crewSection).toMatch(/<PodLinks\b/);
  });

  test('PodLinks reads the walkie\'s own stores, never a second peer model', () => {
    // Mutation: give the list its own NativeEventEmitter or its own peer
    // bookkeeping — two models of "who is on the channel" drift, and the
    // panel and the list disagree on one screen. The single store is now
    // the SESSION (walkieSession.ts), which subscribes to WalkiePeers once
    // for the whole app; the list reads its state.
    expect(podLinks).toMatch(/from '\.\/walkieSession'/);
    expect(podLinks).not.toMatch(/NativeEventEmitter|NativeModules/);
    expect(podLinks).not.toMatch(/onWalkiePeers/);
    // ...and presence comes from the sighting store, not a private map.
    expect(podLinks).toMatch(/presenceFor/);
  });

  test('every live-voice claim is gated on the channel being open FOR THIS POD', () => {
    // Mutation A: drop the render gate — between a close and the next
    // render, stale peers claim live voice. Mutation B: gate on a bare
    // walkieOn() — since the session outlives this card (lane
    // ring-anywhere), the walkie can be open on the BIG camp pod while the
    // card shows the two-person pod, and the rows would paint voice tiers
    // onto people this radio is not on a channel with.
    // The ASSIGNMENT, not the import: a pin that only saw the name stayed
    // green when the derivation was swapped for a session-exists check and
    // the import rode along unused (caught by mutation, 2026-08-25).
    expect(podLinks).toMatch(/const voiceHere = walkieOnFor\(crewId\);/);
    expect(podLinks).toMatch(/voiceHere\s*\?\s*rungsByName/);
    expect(podLinks).toMatch(/walkieOn:\s*voiceHere/);
  });
});
