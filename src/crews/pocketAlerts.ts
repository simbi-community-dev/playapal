/**
 * Pocket alerts — the phone buzzes like a normal app when the pod wants
 * you (owner ask, 2026-08-25: "most people will not have phones out most
 * of the time … enable notifications like any other normal app").
 *
 * EVERYTHING IS LOCAL. There is no push server and no internet at BRC —
 * every buzz here is minted on this phone, from an event this phone
 * already produced: a record ACCEPTED off a peer over the Bluetooth mesh
 * (messages.ts acceptIncoming → subscribeRecordsAccepted), or a call
 * invite arriving over the walkie's own wire (callRuntime.ts dispatch).
 * The native halves (PocketAlertsModule.kt / PocketAlerts.swift) only
 * know how to post and cancel a notification; every DECISION — whose
 * mail, which posture, how many buzzes a burst earns — lives here, in
 * testable TypeScript.
 *
 * THE FOUR LAWS, each with a suite line that dies if it breaks:
 *
 *  1. ACCEPT, NEVER COMPOSE. Only records that arrived FROM A PODMATE
 *     buzz. The seam subscribed is subscribeRecordsAccepted — fired
 *     exclusively by the accept gate — never subscribeMessagesChanged
 *     (which fires on your own compose too) and never
 *     subscribeLocalCompose. Your own message buzzing your own pocket is
 *     the bug this wiring makes unrepresentable.
 *  2. CARRY ≠ SHOW, again. A phone relays mail addressed to OTHER
 *     people (messages.ts's whole relay design), and an accepted record
 *     is not necessarily YOUR record. The filter here is the inbox's
 *     exact predicate: pod kinds, not from me, to_hash null-or-mine.
 *     A relayed stranger-to-stranger record must never vibrate anyone.
 *  3. FOREGROUND OWNS ITSELF. When the app is visible the in-app
 *     surfaces (unread badge, pod card, ringing panel) already announce
 *     everything; a system notification on top would be the app
 *     interrupting itself. Suppressed whenever AppState says 'active'.
 *  4. ONE DRAIN, ONE BUZZ. A sync batch that lands N records fires the
 *     accepted hook once with N rows and earns ONE summary notification
 *     — attention is the scarcest resource at a burn, and each category
 *     re-uses a fixed notification slot so bursts REPLACE rather than
 *     stack.
 *  5. A MENTION OUTRANKS THE BATCH. "@Kupo" is one human choosing one
 *     other human, so a batch carrying a mention of ME earns the LOUD
 *     surface instead of the summary — the sender's name, their words,
 *     its own high-importance channel. Everything else in that batch is
 *     still on the phone and still on the badge; what it does not get is
 *     a second buzz (law 4 holds).
 *
 * THE MESH TRUTH, STATED ONCE SO NO COPY DRIFTS OFF IT (owner ask,
 * 2026-08-26). A mention buzz is minted by the RECIPIENT'S phone when the
 * message ARRIVES over the mesh — seconds when the two phones are linked,
 * at the next radio meeting when they are not. There is no push server and
 * there is no internet out there. Nothing this app says about @-mentions
 * may imply otherwise; see src/crews/mentions.ts, which owns the matching
 * and says the same thing at the composing end.
 *
 * PERMISSION IS ASKED IN CONTEXT, ONCE, AND THE ANSWER IS KEPT. The ask
 * happens the first time a pod feature arms (sharing toggle — share.ts —
 * or walkie open), never at launch. A decline is stored and permanently
 * respected: every later arm is silent, and the only way back is the
 * deliberate Settings row (reAskPocketAlerts). On Android the grant is
 * the same POST_NOTIFICATIONS the Phase C foreground service consent
 * rides (radio.ts ensureNotificationPermission — reused, not forked);
 * on iOS it is UNUserNotificationCenter authorization via the native
 * module.
 *
 * LAZY REQUIRES, ON PURPOSE: callRuntime imports this file, and suites
 * that exercise the call machinery must not drag the whole storage
 * engine into their module graph just to type-check a buzz they mocked
 * away. The share.ts geolocation() precedent.
 */
import { AppState, NativeModules, Platform } from 'react-native';
import type { CrewRecord } from './messages';
import type { CallPhase } from './videoCall';
import { hash32 } from './beacon';

// Optional-chained ON PURPOSE (the DeviceInfo lesson, same class): a
// module-scope native read must not detonate under a test environment
// whose react-native mock carries no NativeModules — every suite that
// merely imports a file that imports this one would die at load.
const native = NativeModules?.PocketAlerts;

/** The four native channels/categories — must match PocketAlertsModule.kt
 * and PocketAlerts.swift, which key channel ids and notification slots on
 * exactly these strings. 'mention' is the loud one: its own Android
 * channel at IMPORTANCE_HIGH with a vibration pattern, its own iOS
 * category and interruption level. Because they are CHANNELS, the camper's
 * own system settings screen can silence pod chatter overnight and keep
 * mentions loud without this app growing a single switch. */
export type PocketAlertCategory = 'message' | 'voice' | 'call' | 'mention';

export interface PocketAlert {
  category: PocketAlertCategory;
  title: string;
  body: string;
}

/**
 * Who this phone can NAME in one pod, which is exactly what a mention
 * needs: my own name to match against, and the hash→name table to put a
 * sender's name on the buzz.
 *
 * Resolved per accept batch rather than held, because both halves change
 * under the app: a card swap renames a podmate instantly, a member
 * announcement arrives over the same radio window that delivers the mail.
 */
export interface PodIdentity {
  /** My pod display name — what a podmate types after '@'. */
  myName: string;
  /** from_hash → display name for everyone this phone can name in this
   * pod. Its VALUES are the pod's '@' vocabulary. */
  names: Map<number, string>;
}

/** Is the native notifier in this build at all? False = every verb here is
 * a silent no-op — an older native must degrade, never red-box. */
export function pocketAlertsPresent(): boolean {
  return native != null;
}

// ---------------------------------------------------------------- choice
//
// '' (never asked) | 'granted' | 'denied' — the app's OWN record of the
// in-context ask, which is what makes a decline durable: the OS forgets
// nothing, but re-invoking its dialog (or getting its silent auto-deny)
// on every share toggle is still the app nagging. Stored in settings so
// it survives process death with the rest of the phone's choices.

export const POCKET_ALERTS_CHOICE_KEY = 'pocket_alerts_choice';

type Choice = '' | 'granted' | 'denied';

function db() {
  return require('../events/db') as typeof import('../events/db');
}

function readChoice(): Choice {
  try {
    const v = db().getSetting(POCKET_ALERTS_CHOICE_KEY);
    return v === 'granted' || v === 'denied' ? v : '';
  } catch {
    // DB not open yet (early boot, bare harness): "never asked" is the
    // honest fallback — it can only delay an ask, never fake a grant.
    return '';
  }
}

function writeChoice(c: Choice): void {
  try {
    db().setSetting(POCKET_ALERTS_CHOICE_KEY, c);
  } catch {
    // Unstorable choice = re-asked next arm. Annoying, not wrong.
  }
}

/** The stored answer, for the Settings row's copy. */
export function pocketAlertsChoice(): '' | 'granted' | 'denied' {
  return readChoice();
}

async function askPlatform(): Promise<boolean> {
  if (Platform?.OS === 'android') {
    // The SAME grant the Phase C foreground service consent notification
    // needs — one permission, one asker, reused from the radio seam
    // rather than duplicated here.
    const radio = require('./radio') as typeof import('./radio');
    return radio.ensureNotificationPermission();
  }
  if (!native) {
    // No native notifier linked: nothing to authorize. NOT stored as a
    // denial — the user never answered anything.
    return false;
  }
  try {
    return (await native.requestPermission()) === true;
  } catch {
    return false;
  }
}

/**
 * The in-context ask. Called when a pod feature arms (sharing start,
 * walkie open) — the moment the buzz has an obvious payoff. Returns
 * whether alerts may fire.
 *
 * A stored 'denied' short-circuits SILENTLY: declining once means every
 * later arm degrades without a dialog, a nag, or a toast. Mutation: drop
 * the stored-choice gate — the permission-respect suite line dies.
 */
export async function armPocketAlerts(): Promise<boolean> {
  const choice = readChoice();
  if (choice === 'denied') {
    return false;
  }
  if (choice === 'granted') {
    // Trust the stored grant; if the OS revoked it since, the native
    // notify fails soft (resolve false) and nothing crashes.
    return true;
  }
  const granted = await askPlatform();
  if (Platform?.OS !== 'android' && !native) {
    // Never asked anyone — store nothing (see askPlatform).
    return false;
  }
  writeChoice(granted ? 'granted' : 'denied');
  return granted;
}

/**
 * The Settings row's deliberate re-ask — the ONE path that may revisit a
 * stored 'denied'. Clears the memory first so armPocketAlerts runs the
 * real platform ask again. (On a phone where the OS itself has stopped
 * showing the dialog — Android's two-strike rule, iOS's ask-once — the
 * platform answers denied immediately and the row's copy stays honest.)
 */
export async function reAskPocketAlerts(): Promise<boolean> {
  writeChoice('');
  return armPocketAlerts();
}

/**
 * THE GRANULAR SURFACE IS THE PHONE'S OWN (owner ask, 2026-08-26: "maybe
 * should happen in OS permissions menus linked from app instead to be more
 * elegant"). Both platforms already ship a per-app notification screen with
 * a switch for every channel/category this app posts on — mentions, pod
 * messages, voice notes, calls — plus sound, vibration, lock screen and Do
 * Not Disturb, in the camper's language, with the accessibility settings
 * they have already tuned. An in-app copy of that would be four toggles
 * that agree with the OS only until someone changes one there.
 *
 * So the app keeps ZERO per-type switches and one door:
 *   Android — ACTION_APP_NOTIFICATION_SETTINGS with EXTRA_APP_PACKAGE
 *             (pre-26: the app details page, which is where the switch
 *             lived before channels existed).
 *   iOS     — UIApplication.openNotificationSettingsURLString (iOS 16+),
 *             falling back to openSettingsURLString.
 * Both are built natively, where the package name and the URL constant
 * live; this is the seam. False = no door on this build (an older native,
 * or an OEM with no such screen), and the caller says so instead of
 * pretending the tap worked.
 */
export function openNotificationSettings(): Promise<boolean> {
  const open = (native as { openSettings?: () => Promise<unknown> } | undefined)
    ?.openSettings;
  if (!open) {
    return Promise.resolve(false);
  }
  try {
    return Promise.resolve(open.call(native))
      .then(v => v === true)
      .catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

// ---------------------------------------------------------------- policy

/** Is the app on screen right now? 'active' is the only state where the
 * in-app surfaces own the announcement; 'background', 'inactive' and an
 * unreadable state all mean nobody is looking at our UI. */
function foregroundVisible(): boolean {
  return AppState?.currentState === 'active';
}

function podKinds(): readonly string[] {
  return (require('./messages') as typeof import('./messages')).POD_KINDS;
}

const plural = (n: number, word: string): string =>
  `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * How much of a mentioning message rides on the buzz. Long enough that a
 * glance answers "do I have to get up?", short enough that the shade is
 * not a transcript. Codepoints, so the slice can never split an emoji.
 */
const MENTION_BODY_MAX = 160;

const clampBody = (s: string): string => {
  const cps = [...s.trim().replace(/\s+/g, ' ')];
  return cps.length <= MENTION_BODY_MAX
    ? cps.join('')
    : `${cps.slice(0, MENTION_BODY_MAX - 1).join('')}…`;
};

/** The sender line on a mention buzz. The fallback is the answering
 * machine's own words for an unresolvable hash, so the shade and the
 * thread never name the same person two different ways. */
const senderName = (id: PodIdentity | null, fromHash: number): string =>
  id?.names.get(fromHash) ?? 'Someone in the pod';

/**
 * THE DECISION, pure for tests: given the records one accept batch
 * stored, whose phone this is, and whether the app is visible — buzz or
 * not, and with which words.
 *
 * Null when: the app is foreground-visible (law 3); nothing in the batch
 * is pod mail addressed to me (laws 1+2 — the batch legitimately carries
 * roster records and other people's mail). One PocketAlert per batch,
 * never per record (law 4).
 *
 * `identity` is a RESOLVER keyed by crew code, because one accept batch
 * can legitimately span two pods and each has its own roster. Omitted (or
 * answering null) means this phone cannot name anybody right now, and the
 * batch degrades to the ordinary summary buzz — never to silence.
 */
export function pocketAlertFor(
  records: CrewRecord[],
  myHash: number,
  visible: boolean,
  identity?: (crewCode: string) => PodIdentity | null,
): PocketAlert | null {
  if (visible) {
    return null;
  }
  const kinds = podKinds();
  // The inbox's own "for me" predicate (messages.ts inboxWhere), applied
  // record by record: pod kind, someone else's words, addressed to the
  // whole pod or to me. origin double-checked so a caller handing this
  // function anything but heard rows still cannot buzz a compose.
  const mine = records.filter(
    r =>
      kinds.includes(r.kind) &&
      r.origin === 'heard' &&
      r.from_hash !== myHash &&
      (r.to_hash === null || r.to_hash === myHash),
  );
  if (mine.length === 0) {
    return null;
  }
  // LAW 5, before the summary: one podmate typed my name on purpose.
  // Memoized per batch — a drained mailbox is usually one pod, and the
  // resolver reads the store.
  if (identity) {
    const cache = new Map<string, PodIdentity | null>();
    const idOf = (code: string): PodIdentity | null => {
      if (!cache.has(code)) {
        cache.set(code, identity(code));
      }
      return cache.get(code) ?? null;
    };
    const { mentionsMe } = require('./mentions') as typeof import('./mentions');
    const named = mine.filter(r => {
      if (r.kind !== 'voice') {
        const id = idOf(r.crew_code);
        // A voice note carries audio, not text — there is nothing in it to
        // match, and guessing would be worse than the summary buzz it gets.
        return id !== null && mentionsMe(r.body, id.myName, [...id.names.values()]);
      }
      return false;
    });
    if (named.length > 0) {
      // NEWEST WINS the one slot: if two people called for me while the
      // phone was in a pocket, the freshest is the one still worth walking
      // to. Sender's clock, like every other display time in this app.
      const newest = named.reduce((a, b) =>
        b.created_min > a.created_min || (b.created_min === a.created_min && b.id > a.id)
          ? b
          : a,
      );
      const who = senderName(idOf(newest.crew_code), newest.from_hash);
      const rest = named.length - 1;
      return {
        category: 'mention',
        // Their name FIRST: the whole point of the loud channel is that a
        // glance from across camp answers "who wants me?".
        title: `${who} mentioned you`,
        body:
          rest > 0
            ? `${clampBody(newest.body)} · and ${plural(rest, 'more mention')}`
            : clampBody(newest.body),
      };
    }
  }
  const voices = mine.filter(r => r.kind === 'voice').length;
  const texts = mine.length - voices;
  if (mine.length === 1) {
    // Copy register (hippo-spirit): concrete and unhurried, and it echoes
    // the app's own standing phrase — mail "keeps", it does not demand.
    return voices === 1
      ? {
          category: 'voice',
          title: 'Your pod',
          body: 'A voice note came in — it keeps until you listen.',
        }
      : {
          category: 'message',
          title: 'Your pod',
          body: 'A message came in — it keeps until you look.',
        };
  }
  const parts = [
    texts > 0 ? plural(texts, 'message') : null,
    voices > 0 ? plural(voices, 'voice note') : null,
  ].filter(Boolean);
  return {
    category: 'message',
    title: 'Your pod',
    body: `${parts.join(' and ')} came in while the phone was away.`,
  };
}

// ---------------------------------------------------------------- wiring

let running = false;
let unsub: (() => void) | null = null;

function deliver(alert: PocketAlert): void {
  if (!native || readChoice() !== 'granted') {
    return;
  }
  // Fire-and-forget: a failed post (grant revoked mid-session, torn
  // bridge) must never surface into the sync path that triggered it.
  void Promise.resolve(native.notify(alert.category, alert.title, alert.body)).catch(
    () => {},
  );
}

/**
 * Who this phone can name in one pod, read fresh from the store.
 *
 * SAME RESOLUTION ORDER AS THE THREAD (podMembers.ts, "CARD FIRST,
 * ANNOUNCEMENT SECOND"): announcements laid down first, held cards written
 * over them, so the name on the buzz is the name PodMessages puts over the
 * same message. Two names for one person across two surfaces is the bug
 * this order exists to prevent.
 *
 * Every failure answers null rather than throwing: this runs inside the
 * accept path, and a mesh delivery must never die because a roster read
 * did. Null costs the batch its escalation, not its buzz.
 */
export function defaultPodIdentity(crewCode: string): PodIdentity | null {
  try {
    const { announcedNames } =
      require('./podMembers') as typeof import('./podMembers');
    const cards =
      require('../friends/friendCard') as typeof import('../friends/friendCard');
    const conn = db().getDb();
    const names = announcedNames(crewCode);
    for (const f of cards.listFriends(conn)) {
      names.set(hash32(f.id), f.name);
    }
    return { myName: cards.getMyCard(conn).name, names };
  } catch {
    return null;
  }
}

/**
 * Arm the mail buzz for the life of a mesh session. Called by share.ts
 * beside startMeshSync — records can only ARRIVE while the mesh runs, so
 * the subscription has the same lifetime as the radio window it serves.
 *
 * `myCardId` is a getter (the share.ts knownCrewCodes pattern) so a card
 * regenerated mid-session is read fresh at each batch. `identity` is the
 * mention resolver, defaulted so no caller has to know about it and
 * injectable so the suite can build a pod without a database.
 */
export function startPocketAlerts(
  myCardId: () => string,
  identity: (crewCode: string) => PodIdentity | null = defaultPodIdentity,
): void {
  if (running) {
    return;
  }
  running = true;
  const messages = require('./messages') as typeof import('./messages');
  // subscribeRecordsAccepted and ONLY that (law 1): the store's other two
  // emitters both fire on this phone's own writes.
  unsub = messages.subscribeRecordsAccepted(records => {
    const alert = pocketAlertFor(
      records,
      hash32(myCardId()),
      foregroundVisible(),
      identity,
    );
    if (alert) {
      deliver(alert);
    }
  });
}

export function stopPocketAlerts(): void {
  running = false;
  unsub?.();
  unsub = null;
}

// ------------------------------------------------------------------ calls
//
// An incoming call is the highest-urgency buzz — a human is standing
// somewhere on the same LAN holding a ringing phone at their ear RIGHT
// NOW, and the ring gives up in 30 seconds. It deliberately does NOT ride
// the accepted-records seam (a call is not mail): callRuntime.ts calls
// these two verbs from its dispatch loop, keyed off the SAME reduced
// 'ringing' phase the in-app panel renders — one event, two surfaces,
// zero forked state.
//
// A keyed WALKIE, by contrast, is ambient and never buzzes: people key
// the channel all day, and a pocket that vibrates on every transmission
// is a pocket whose owner turns notifications off by Tuesday. The
// DIRECTED walkie gesture — someone choosing YOU — is the call, and the
// call is what buzzes. (Interpretation noted for the owner in the lane
// report.)

/**
 * Which pocket-ring action a reducer step earns, pure for tests:
 * entering 'ringing' shows the buzz, leaving it clears the shade (the
 * caller hung up, the ring timed out, or the callee answered in-app —
 * a stale "X is calling" outliving the ring is a lie in a pocket).
 */
export function callRingTransition(
  before: CallPhase,
  after: CallPhase,
): 'show' | 'clear' | null {
  if (before !== 'ringing' && after === 'ringing') {
    return 'show';
  }
  if (before === 'ringing' && after !== 'ringing') {
    return 'clear';
  }
  return null;
}

export function notifyCallRing(peerName: string): void {
  if (!native || readChoice() !== 'granted' || foregroundVisible()) {
    return;
  }
  deliver({
    category: 'call',
    title: `${peerName} is calling`,
    body: 'Open Playa Pal to answer — the ring waits about half a minute.',
  });
}

/** Idempotent, and deliberately NOT gated on posture or permission: a
 * shade entry that exists must be clearable from any state. */
export function clearCallRing(): void {
  if (!native) {
    return;
  }
  void Promise.resolve(native.cancel('call')).catch(() => {});
}
