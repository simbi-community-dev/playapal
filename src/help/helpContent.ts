/**
 * IN-APP HELP — the words, in one place.
 *
 * WHY THIS FILE EXISTS (owner ask, 2026-08-25): "any final actual
 * limitations are fine, as long as they are clearly communicated in readme
 * and in-app help (need that built huh??)". There was no Help surface at
 * all. The camper this is written for is standing in dust with no signal,
 * no manual and no one to ask, and needs three answers: what works out
 * here, how the phones find each other, and what this app honestly cannot
 * do yet.
 *
 * ONE SOURCE OF TRUTH. HelpScreen.tsx only lays these strings out — every
 * sentence a camper reads in Help lives here, so the copy can be reviewed,
 * regression-tested and kept honest without reading a component. The
 * README's limitations list is held in step with HELP_LIMITATIONS by
 * shared key phrases (README_ANCHORS below, asserted in both directions by
 * __tests__/helpContent.test.ts).
 *
 * THE VOCABULARY LAW (docs/WALKIE-LADDER.md §5a, and podStatus.ts's
 * header) applies to every word here: a camper hears what a link ENABLES
 * and which ordinary radio carries it — "Bluetooth", "a shared camp
 * Wi-Fi", "the newer direct link" — never the engineering names for any of
 * it. The regression suite bans the protocol words. Bluetooth and Wi-Fi
 * are deliberately NOT banned in this file, unlike in podStatus: a status
 * row must not invite radio-management superstition, but Help is exactly
 * where a person is owed the plain physical reason their call button is
 * missing.
 *
 * EVERY CLAIM WAS CHECKED AGAINST THE CODE, not against yesterday's docs —
 * several of these moved on 2026-08-25 alone (mail delivery speed, the
 * keyed-mic mute, voice over Bluetooth, the Angel resting on a small
 * phone). Provenance is on each limitation.
 */

/** A plain section of the Help screen: a heading and its paragraphs. */
export interface HelpSection {
  /** Stable key — the render key, and what a test names when it fails. */
  id: string;
  title: string;
  /** One string per paragraph. Kept short: this is read in daylight, in
   * dust, by someone who is probably standing up. */
  body: string[];
}

/**
 * The named limitations. The union is the CONTRACT: adding a topic without
 * writing its copy fails typecheck (the record below is exhaustive), and
 * deleting one fails the regression suite, which carries its own
 * independent list of what a camper must be told.
 */
export type LimitationTopic =
  | 'iphone-background'
  | 'video-call-link'
  | 'big-pod-reach'
  | 'small-phone-angel'
  | 'playa-trust'
  | 'call-needs-app-open'
  | 'device-proof';

export interface HelpLimitation {
  topic: LimitationTopic;
  title: string;
  body: string;
}

/** Render order — worst-surprise-first, so the two that change what a
 * camper DOES (keep the app open; there is no call button) are read even
 * by someone who stops after the first card. */
const LIMITATION_ORDER: LimitationTopic[] = [
  'iphone-background',
  'video-call-link',
  'call-needs-app-open',
  'big-pod-reach',
  'small-phone-angel',
  'playa-trust',
  'device-proof',
];

/**
 * Exhaustive by type. Each entry names where its truth was read, because
 * the fastest way for this screen to start lying is for the code under it
 * to move and nobody to know which sentence went stale.
 */
const LIMITATION_COPY: Record<LimitationTopic, { title: string; body: string }> = {
  // Truth: ios/PlayaPal/CrewBeacon.swift (a backgrounded iPhone's beacon
  // moves to a place only other iPhones can see) + src/crews/radio.ts
  // startPocketSession, which is an Android-only service — so on iPhone
  // the mail loop itself stops when the app leaves the screen.
  'iphone-background': {
    title: 'On an iPhone, keep Playa Pal open',
    body:
      'On an iPhone, keep Playa Pal open to send and receive. Put the phone in ' +
      'your pocket and other iPhones can still spot you, but Android phones ' +
      'cannot, and nothing new lands until you open the app again. Android ' +
      'phones carry on pocketed — a plugged-in Android left sharing at camp ' +
      'makes a fine mailbox. Pocketed delivery on iPhone is the next piece ' +
      'being built.',
  },
  // Truth: android/.../WalkieModule.kt — the callable peer list skips any
  // podmate reached only over the Bluetooth pipe (host == null), and
  // WalkiePanel.tsx draws one button per callable peer. docs/VIDEO-CALLS.md
  // §7.10 is the device gate for the same behaviour.
  'video-call-link': {
    title: 'Video calls need a shared Wi-Fi',
    body:
      'The walkie carries voice with no network at all; a video call needs ' +
      'more room than that. Put both phones on any shared Wi-Fi and the ' +
      'call carries — an iPhone and an Android included, measured between ' +
      'the two, and a hotspot with no internet behind it counts. With no ' +
      'Wi-Fi anywhere, a call rings and then says it could not get through ' +
      '(field-measured) — so one Android in the pod can make the Wi-Fi ' +
      'itself: turn on Camp hotspot under your pod and the others join by ' +
      'pointing a camera at the code it shows. Nothing there touches the ' +
      'internet. A podmate you can ' +
      'only reach over Bluetooth shows no call button, on purpose: a button ' +
      'that could never ring anyone is worse than no button.',
  },
  // Truth: src/crews/walkieSession.ts — the session and its call runtime
  // are app-level as of 2026-08-25, so a ring reaches any tab, but nothing
  // there survives the app leaving the screen. docs/VIDEO-CALLS.md §4a
  // names the foreground service / PushToTalk work that would.
  'call-needs-app-open': {
    title: 'A call rings while the app is open',
    body:
      'Leave the walkie on and a call reaches you anywhere in the app — the ' +
      'camp board, the map, wherever you happen to be — with the caller’s ' +
      'name and a way to answer. A small bar along the bottom shows the ' +
      'walkie is on, who is on the channel, and turns it off in one tap. ' +
      'Away from the app, a call still buzzes your pocket like any message ' +
      'notification, and opening it answers — what it cannot yet do is take ' +
      'over a locked screen with a full ring. If you are expecting a call, ' +
      'keep Playa Pal on the screen; if you miss one, a voice note keeps ' +
      'until you are together.',
  },
  // Truth: src/crews/meshSync.ts (the sync worker is strictly one peer at a
  // time; the native side refuses concurrent syncs) + docs/WALKIE-LADDER.md
  // §6a, where the live-voice fan-out arithmetic is done: a pod of about
  // ten is comfortable, sixty is not.
  'big-pod-reach': {
    title: 'A very big pod outgrows Bluetooth',
    body:
      'Bluetooth reaches across a camp, not across a city, and phones trade ' +
      'mail one pair at a time, in turn. A pod of about ten is comfortable. ' +
      'Much past that and live voice starts to strain — messages still reach ' +
      'everyone, they just need more passing-by to do it. A big camp is ' +
      'happier as a few pods than as one enormous one.',
  },
  // Truth: src/llm/angelRest.ts — below LlamaSession's constrained boundary
  // (6 GB) she rests unless this camper has said otherwise, and a stored
  // choice always outranks the measurement. The switch is the rest card at
  // the top of Settings › Angel & voice.
  'small-phone-angel': {
    title: 'On a small phone the Angel rests',
    body:
      'The Angel needs room to think in, and on a phone with less memory than ' +
      'she likes the Angel rests when the app opens, so everything else stays ' +
      'quick and nothing gets closed out from under you. Every other part of ' +
      'the app — events, the map, your pod, the camp board — never needed her ' +
      'at all. Wake her whenever you like in Settings, under Angel & voice, at ' +
      'the top above the model list. Your answer sticks, on this phone, both ' +
      'ways.',
  },
  // Truth: README "Camp gifts and needs" (HMAC, not encryption) and
  // "Friends on playa" (cards carry no signature at all); the pod code is
  // owner-ruled at four digits, docs/WALKIE-LADDER.md §8.
  'playa-trust': {
    title: 'Playa trust, not bank trust',
    body:
      'The pod code is four digits, and camp boards and friend cards travel ' +
      'unsealed — stamped just well enough to tell one camp’s board from ' +
      'another and to notice a file that was meddled with. Anyone holding the ' +
      'file, or the camp phrase, can read it. This is playa trust, not bank ' +
      'trust: right for gifts, needs, plans and playa names, wrong for ' +
      'anything that would hurt if a phone were lost. Post what you would ' +
      'write on the camp whiteboard.',
  },
  // Truth: docs/WALKIE-LADDER.md §11 "What I could not measure", plus the
  // owner's own 2026-08-26 measurement — a Pixel and an iPhone carried a
  // real video call on his home Wi-Fi, which retires half of what this card
  // used to say. The direct link is measured both ways on two Android
  // phones with every network off. Voice over Bluetooth is the one left.
  'device-proof': {
    title: 'One of the newest pieces has not met two phones yet',
    body:
      'Live voice between two Android phones over their own direct link is ' +
      'measured and real — both directions, every network switched off. A ' +
      'video call has carried a real conversation between an iPhone and an ' +
      'Android on a shared Wi-Fi, so that path is proven too. The piece no ' +
      'two phones have tried in dust is voice over Bluetooth. If that is the ' +
      'one that misbehaves at camp, it is the new part; messages, positions ' +
      'and the walkie’s ordinary paths are not affected.',
  },
};

/** The limitations, in render order. */
export const HELP_LIMITATIONS: HelpLimitation[] = LIMITATION_ORDER.map(topic => ({
  topic,
  ...LIMITATION_COPY[topic],
}));

/**
 * THE README COUPLING, as cheap as it can honestly be. These exact phrases
 * appear in this file AND in README.md's limitations list; the regression
 * suite reads both and fails when they drift apart. It is not a proof that
 * two prose passages agree — it is a tripwire that fires the moment one
 * side is rewritten and the other is forgotten, which is the actual way
 * these two ever disagree.
 */
export const README_ANCHORS: string[] = [
  'keep Playa Pal open',
  'no call button',
  'one pair at a time',
  'the Angel rests',
  'playa trust, not bank trust',
];

/**
 * The prose sections, in reading order. The limitations are NOT duplicated
 * here — HelpScreen renders HELP_LIMITATIONS in their own place, so there
 * is exactly one copy of each honest sentence.
 */
export const HELP_SECTIONS: HelpSection[] = [
  {
    id: 'offline',
    title: 'It all works with no signal',
    body: [
      'Playa Pal runs on this phone and nowhere else. There is no account, no ' +
        'server behind it, and nothing to sign in to. Airplane mode is the ' +
        'habitat it was built for, not a degraded mode it tolerates.',
      'With no signal at all you still get: what is happening now and all week, ' +
        'the survival guide and any camp packs you brought, the compass and the ' +
        'whole city map, your friend cards, the camp board and notes, and your ' +
        'pod.',
      'Two things want the internet once, at home, before you drive in: the ' +
        'Angel’s download, and — if you want spoken replies — an offline ' +
        'voice from your phone’s own settings. Both are one-time. After ' +
        'that the app never reaches for a network again.',
    ],
  },
  {
    id: 'angel',
    title: 'The Angel, and what she is good for',
    body: [
      'The Angel is a small guide living on this phone. Every word she says is ' +
        'made here; nothing you ask ever leaves your hand. Open her with the ' +
        '🪽 button at the top of any tab.',
      'She is optional. Everything above worked before she was installed and ' +
        'works if you never install her.',
      'She converses well and remembers loosely. Event times, camps, locations ' +
        'and people come from the saved lists, and the cards underneath an ' +
        'answer are the part that is checked. If a card and a sentence ' +
        'disagree, believe the card — and check anything safety-shaped against ' +
        'the official word.',
    ],
  },
  {
    id: 'pod',
    title: 'How the phones find each other',
    body: [
      'A pod is your people. You join one by typing its four-digit code or by ' +
        'holding up its code for someone to scan. No signal is involved at any ' +
        'point.',
      'Phones look for each other over Bluetooth, which carries about as far as ' +
        'a camp — not across the city. That alone is enough for two things: ' +
        'knowing who is around, and carrying messages.',
      // THE MATRIX, IN FOUR SENTENCES (owner, 2026-08-26: "let's make sure
      // that's clear in help and tooltips"). He had called his iPhone from
      // his Pixel over his home Wi-Fi and wanted the app to say so. The
      // three rows below are what is MEASURED, and they are three different
      // answers — which is exactly why one blurred paragraph used to leave
      // people guessing which one they were living in.
      'Three questions, three answers. Messages and voice notes always get ' +
        'through, between any two phones, hopping phone to phone until they ' +
        'land. Live voice always works too, between any two phones near each ' +
        'other. A video call is the one that asks for a shared Wi-Fi.',
      'Live voice with no network at all comes through rougher, and the app ' +
        'marks it lo-fi so your ears are not surprised. Two Android phones ' +
        'are the exception: they make their own direct phone-to-phone link ' +
        'and sound clean with every network switched off.',
      'A shared camp Wi-Fi lifts every pair at once. Voice goes clean between ' +
        'any two phones — an iPhone and an Android included — and a video ' +
        'call becomes possible. Any Wi-Fi counts: a camp router, or one ' +
        'phone making a hotspot with nothing behind it. Two iPhones want ' +
        'that shared Wi-Fi as well, since iPhones do not yet make the direct ' +
        'link between themselves.',
      'You are never asked to choose. The app starts with what always works and ' +
        'moves up on its own the moment a better link proves itself, then drops ' +
        'back quietly when it goes away. Tap the connection line on your pod ' +
        'card to see, person by person, what each link is good for right now.',
      'A podmate out of reach is still a podmate. Nothing is lost, nobody is ' +
        'dropped, and notes keep until the phones next meet.',
    ],
  },
  {
    id: 'mail',
    title: 'Messages that wait for people',
    body: [
      'The pod carries typed notes and held-mic voice notes from phone to phone ' +
        'whenever podmates pass within reach. With both apps open and the ' +
        'phones near, that is seconds. Pocketed, or across camp, it is minutes. ' +
        'Across the city it is whenever you next walk past each other — and the ' +
        'app tells you which of those you are living in.',
      'Nothing is lost while you wait. A message sits on your phone until it ' +
        'has somewhere to go.',
      'A spare phone plugged in at camp with sharing left on is your camp ' +
        'mailbox — no special mode, it just never leaves.',
      '"Check for pod updates" on the pod card runs a real check and reports ' +
        'what actually moved, including "nobody in range", which is an answer ' +
        'and not a failure.',
    ],
  },
  {
    id: 'walkie',
    title: 'Talking live, and calling one person',
    body: [
      // ANDROID-SCOPED ON PURPOSE. The keyed-mic mute landed on
      // android/.../WalkieModule.kt on 2026-08-25 (the owner heard the
      // feedback howl from another room); ios/PlayaPal/Walkie.swift still
      // mutes playback only for a live call. Saying it of both phones
      // would be a lie on one of them, so the sentence names the one it
      // is true of and gives everyone the advice that works either way.
      'Hold the button, talk, let go to listen. On an Android phone the ' +
        'channel goes quiet while you are keying — that is what a walkie ' +
        'does, and it is what keeps two nearby phones from howling at each ' +
        'other. Either way, a few steps between phones is kinder than none.',
      'One talker at a time, like any radio. If two people key at once the app ' +
        'says so rather than letting you wonder why nobody answered.',
      'Incoming voice plays out of the loudspeaker on the volume rocker you ' +
        'already use, and the microphone is open only while the button is held.',
      'A call button appears beside each podmate a call can actually reach, and ' +
        'only while the walkie is on. It is one to one, and always something ' +
        'you tap on purpose.',
      'The walkie stays on when you leave its screen. Tuck it away and go look ' +
        'at the map — voice still comes through, and a bar along the bottom ' +
        'says the walkie is on and who is on the channel with you, so a radio ' +
        'is never quietly running where you cannot see it. That bar opens the ' +
        'walkie again, or turns it off.',
      'Because the walkie is on for the whole app, a call rings wherever you ' +
        'are in it — their name, and a way to answer or say not now. The ' +
        'hold-to-talk button stays on the walkie’s own screen, so the ' +
        'microphone is never something you lean on by accident.',
    ],
  },
  {
    id: 'privacy',
    title: 'What stays on this phone',
    body: [
      'All of it. Conversations, positions, notes, cards and board posts live in ' +
        'this app’s own storage. Nothing is reported anywhere — not usage, ' +
        'not questions, not even crashes.',
      'Conversations are kept for roughly three months and then the oldest are ' +
        'trimmed. You can export them from Settings to hand to someone; treat ' +
        'that file as private, because it holds everything that was said.',
      'Anything of yours that leaves this phone leaves because you sent it: a ' +
        'beam, a card, a code you held up, a message to your pod.',
      'One thing goes out by itself, and only to your pod: while the app is ' +
        'open, your phone says "someone in this pod is nearby, ask me for ' +
        'messages" over Bluetooth. That is how mail moves without anyone ' +
        'tapping anything. It carries no position — where you are goes out ' +
        'only while you have position sharing switched on for a pod.',
    ],
  },
  {
    id: 'stuck',
    title: 'If something looks wrong',
    body: [
      'Nobody in the pod can see you: sharing is a switch, and it does not ' +
        'survive the app closing — flip it back on. If Bluetooth went off, the ' +
        'pod card says so in plain words instead of pretending.',
      'Messages feel slow: open the app on both phones and stand nearer. Mail ' +
        'moves fastest when two people are looking at their phones in the same ' +
        'place.',
      'The app feels heavy or closes itself: let the Angel rest, in Settings ' +
        'under Angel & voice. Everything else keeps working exactly as it did.',
      'Spoken replies go silent once you lose signal: the voice you picked is a ' +
        'cloud voice. In Settings, pick one badged offline, then prove it in ' +
        'airplane mode with Hear a sample.',
      'A pack, a friend or an event is missing from answers: check it is still ' +
        'switched on, and look in Settings under Hidden for anything set aside ' +
        'with "Don’t use this".',
    ],
  },
];

/** The heading over the limitations block — kept here so the whole screen's
 * vocabulary is reviewable in one file. */
export const HELP_LIMITS_TITLE = 'What it cannot do yet';

/** The one calm sentence before the limitations. Not an apology: a camper
 * reading this is making a plan, and wants the shape of the edges. */
export const HELP_LIMITS_INTRO =
  'Named plainly, so nothing out here surprises you.';
