/**
 * PodMessages — the answering machine's face (Camp Mesh, docs/CREW-DESIGN.md
 * §6b): the messages strip INSIDE the Pod card, mounted by CrewSection under
 * the member rows. One composed surface for text + PTT voice notes over the
 * store-and-forward gossip in src/crews/messages.ts — "leave a message for a
 * crewmate; it arrives when radios meet."
 *
 * WHAT IT SHOWS. The thread merges my inbox (messages FOR me: crew-wide or
 * addressed to my card hash) with my own outbox — a sender who can't see
 * their own note would reasonably conclude it was lost, and the answering
 * machine's honesty posture is the opposite of that. NEWEST AT THE BOTTOM,
 * the way every messaging app on the phone already reads (owner report,
 * 2026-08-25: "it's hard to follow because new shows up on top, unlike every
 * messaging platform ever"). Sender names resolve by hashing the friend
 * cards this phone holds (from_hash = hash32(FriendCard.id), the beacon.ts identity),
 * then by the pod's member announcements (src/crews/podMembers.ts) — a
 * podmate you joined by code and have never swapped cards with still gets
 * their name over their message. A hash with neither renders "someone in
 * the pod": honest, and now rare rather than routine.
 *
 * WHAT IT NEVER DOES. No clocks in logic — epochMinutes(Date.now()) only at
 * the UI boundary (send, tap-to-read, the mount-time prune). No radios — the
 * sync conductor (meshSync.ts) moves bytes; this strip only reads the store
 * and re-renders on its revision. No native audio — recording/playback go
 * through injected seams (recorder/player props) defaulting to a LAZY
 * require of ./fieldAudio, so tests run with pure fakes and the native
 * module is only touched when a finger actually holds the mic.
 *
 * A TAP IS NOT A VOICE NOTE. The mic shares a row with Send and the draft
 * field, so a thumb finds it by accident; a press shorter than
 * VOICE_NOTE_MIN_MS ends the take, drops it, and says so inline rather than
 * minting a note with nothing in it (owner report, 2026-08-26).
 *
 * THE VOICE ROW IS THE BUTTON. "The play button is tiny on received
 * voicenotes" (owner report, 2026-08-26). The whole row has always carried
 * the press — but nothing on it LOOKED like a control, so a gloved thumb
 * aimed at a 16pt ▶ and a sun-blind eye had to hunt for it first. The
 * affordance is now the size of the target: a full-width surface at the
 * 44pt floor, a transport glyph at type.glyph, and a lit row while the note
 * is talking so "is it playing?" is answerable at arm's length. Sent and
 * received notes share renderRow and therefore share all of it.
 *
 * DELIVERY HONESTY. Gossip is minutes-to-hours, not instant, and the copy
 * says so out loud (the friend-card "note board" posture): the footer names
 * the transport, and the base station appears as what it really is — a
 * plugged-in phone that keeps the mailbox.
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  AccessibilityInfo,
  Alert,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
} from 'react-native';
import { Text, TextInput } from '../components/Text';
import { InfoTap } from '../components/InfoTap';
import { getDb } from '../events/db';
import {
  getMyCard,
  listFriends,
  subscribeFriendsChanged,
  type FriendCard,
} from '../friends/friendCard';
import { hash32 } from './beacon';
import { agoPhrase } from './CrewSection';
import {
  TEXT_MAX_BYTES,
  composeText,
  composeVoice,
  epochMinutes,
  inbox,
  markRead,
  messagesRevision,
  myOutbox,
  pruneExpired,
  subscribeMessagesChanged,
  unreadCount,
  utf8ByteLength,
  type CrewMessage,
} from './messages';
import { announcedNames } from './podMembers';
import {
  DAMAGED_VOICE_LABEL,
  arrivalDamageCopy,
  inspectVoiceClip,
  recordingDamageCopy,
} from './voiceClip';
import { colors, radius, spacing, tap, type } from '../theme';

/** Guarded screen-reader announcement (a11y review 2026-08-24): recording
 * state changes are otherwise VISUAL-ONLY, invisible to a listener holding
 * the button. try/catch so a bridge without AccessibilityInfo (tests,
 * stripped builds) makes this a silent no-op, never a crash. */
function announce(message: string): void {
  try {
    AccessibilityInfo.announceForAccessibility(message);
  } catch {
    // no announcer here — the visible copy still tells the story
  }
}

/** The recorder seam PodMessages holds a mic press against. Injected in
 * tests; the app default is fieldRecorder (lazy-required below). */
export interface PodRecorder {
  start(): Promise<void>;
  stop(): Promise<{ base64: string; mime: string; durationMs: number }>;
}

/** The playback seam a voice row taps into. play resolves duration ms. */
export interface PodPlayer {
  play(b64: string): Promise<number>;
  stop(): Promise<void>;
}

/**
 * The receiver's duration estimate for a voice row: the store carries
 * bodies, not durations (a wire column for something derivable would just
 * drift), so length is read back from the bytes. FieldAudio records ~24
 * kbps AAC ≈ 3000 audio bytes/s ≈ 4000 base64 chars/s. Floor of 1 s: a
 * clip short enough to round to zero still exists, and "0s" reads broken.
 */
const B64_CHARS_PER_SECOND = 4000;
const voiceSeconds = (b64Body: string): number =>
  Math.max(1, Math.round(b64Body.length / B64_CHARS_PER_SECOND));

/**
 * The shortest press that can become a voice note (owner report, 2026-08-26:
 * "it's really easy to tap it and let go and create one with no content, i
 * think it should be min 1+ sec of pressing before a msg is created"). The
 * mic sits beside Send in a compose row that is otherwise all taps, so a
 * thumb reaching for it taps it — and a tap is long enough for the encoder
 * to hand back a container with a breath in it, which then rides the mesh
 * as a note that says nothing. The gesture is the thing being measured, not
 * the audio: a press this short was never a decision to speak.
 */
const VOICE_NOTE_MIN_MS = 1000;

/**
 * What a too-short press says back — the next move, in the register the
 * recorder's own copy already uses ("hold the button a moment longer"). One
 * sentence for one mistake: it stands in for the native side's 'empty'
 * reject too, so the same gesture never comes back worded two ways.
 */
const TOO_QUICK_COPY =
  'Too quick — hold the button a full second to leave a voice note.';

/**
 * The one sentence a damaged voice row shows, or null when the bytes are
 * something a player can open. One function so the ROW's copy and the TAP's
 * copy can never drift apart — a row that says "won't play" and then plays
 * would be its own bug.
 */
const voiceTroubleOf = (m: CrewMessage): string | null => {
  if (m.kind !== 'voice') {
    return null;
  }
  const verdict = inspectVoiceClip(m.body);
  return verdict.state === 'damaged' ? arrivalDamageCopy(verdict.damage) : null;
};

/**
 * READING ORDER: oldest at the top, newest at the BOTTOM — the store's
 * order (created_min DESC, id DESC) turned around, re-asserted over the
 * merged inbox+outbox so interleaved senders read as one timeline.
 *
 * The store still serves newest-first and MUST: syncDigest offers the
 * freshest mail first so a capped exchange moves the liveliest rows, and the
 * inbox/outbox readers share that ordering with the sync side. Which end a
 * HUMAN reads from is a different question, and the answer is the one every
 * messaging app already taught them (owner, 2026-08-25). So the flip lives
 * here, at the surface, and the wire order is untouched.
 */
const oldestFirst = (a: CrewMessage, b: CrewMessage): number =>
  a.created_min - b.created_min || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * How close to the bottom still counts as "reading the newest". Not zero:
 * momentum scrolling, a rounding pixel and a keyboard opening all leave a
 * few points of slack, and a thread that refuses to re-pin because it is two
 * points short reads as broken.
 */
const PIN_SLACK_PT = 24;

/**
 * The thread's own scroll window inside the Pod card. It has to be bounded
 * for "newest at the bottom" to mean anything — an unbounded strip pushes
 * the composer off the end of a growing page, and the pod card already
 * carries the roster above it. About four rows; longer threads scroll.
 */
const THREAD_MAX_HEIGHT = 320;

/** Distance from the bottom of a scroll frame, in points. */
const distanceFromBottom = (e: NativeScrollEvent): number =>
  e.contentSize.height - e.contentOffset.y - e.layoutMeasurement.height;

export function PodMessages({
  crew,
  recorder,
  player,
}: {
  crew: { id: string; name: string; code: string; memberIds: string[] };
  recorder?: PodRecorder;
  player?: PodPlayer;
}) {
  const conn = getDb();

  // The store's revision emitter drives every re-render: composes, accepts
  // off the radio, markRead, prunes (the favorites.ts pattern).
  const msgRev = useSyncExternalStore(
    subscribeMessagesChanged,
    messagesRevision,
  );

  // My card id is the inbox identity (to_hash = hash32(me.id)); friend
  // cards are the sender-name table. Both refresh on the friends signal,
  // exactly like CrewSection's member rows. A phone with no self card yet
  // gets an unsaved random-id card — it still reads crew-wide mail, and
  // directed mail starts working the moment the card is saved.
  const [me, setMe] = useState(() => getMyCard(conn));
  const [friends, setFriends] = useState<FriendCard[]>(() => listFriends(conn));
  useEffect(
    () =>
      subscribeFriendsChanged(() => {
        setFriends(listFriends(conn));
        setMe(getMyCard(conn));
      }),
    [conn],
  );

  // Expired mail falls at mount — the UI's turn of the shared prune cadence
  // (messages.ts: "the sync conductor runs this before serving; the UI runs
  // it on its own cadence"). If anything fell, the revision bump above
  // re-renders with the survivors.
  useEffect(() => {
    pruneExpired(epochMinutes(Date.now()));
  }, []);

  const codes = [crew.code];

  // from_hash -> display name. Membership is NOT required to resolve — mail
  // relayed from a pod-mate whose card you hold but haven't picked into the
  // pod still deserves their name.
  //
  // TWO SOURCES, cards LAST so they win: an announcement is what the sender
  // calls themselves, a card is what this phone calls them, and the rest of
  // the app already shows the card's spelling — one person under two names
  // on one screen is worse than a slightly stale one. Rebuilt on every
  // message revision because that is when an announcement can land.
  const names = useMemo(() => {
    const m = announcedNames(crew.code);
    for (const f of friends) {
      m.set(hash32(f.id), f.name);
    }
    return m;
    // msgRev looks unused to the linter and is the entire point: it is the
    // store signal that says an announcement may have arrived.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [friends, crew.code, msgRev]);
  const heard = inbox(codes, me.id);
  const mine = myOutbox(codes, me.id);
  const thread = [...heard, ...mine].sort(oldestFirst);
  const unread = unreadCount(codes, me.id);

  // The strip rides COLLAPSED behind its header by default (a11y+IA review
  // 2026-08-24, DO-NOW #2: the Pod card was too long to scan) — the
  // Public-packs collapsible pattern. EXPANDED at mount when mail is
  // waiting: a message someone left must never hide behind a chevron.
  // Nothing persists; switching pods remounts (key={crew.id}) and re-asks.
  const [open, setOpen] = useState(() => unread > 0);

  const [draft, setDraft] = useState('');
  // One quiet line for whatever last went wrong (a failed take, a clip the
  // caps refuse) — inline, where the action happened, never a modal for
  // routine friction.
  const [notice, setNotice] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);

  // ------------------------------------------------------- the row that is talking
  //
  // WHICH VOICE ROW IS PLAYING, and how it learns that it stopped. The
  // player seam hands back the clip's real length and then plays on in the
  // background: FieldAudioModule.play resolves p.duration the moment start()
  // succeeds, and the only completion signal that reaches JS is the clock.
  // So the row is lit for exactly that long and then clears itself — a
  // duration measured by the decoder, not a guess about how long a note is.
  const [playingId, setPlayingId] = useState<string | null>(null);
  const playTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Every start takes a number. The late resolve, the end-of-clip timer and
  // the stop press all compare against it, so the FIRST note's timer can
  // never reach in and darken the SECOND note's row.
  const playTokenRef = useRef(0);

  // ------------------------------------------------------- staying at the newest
  //
  // THE PIN AND ITS REVERSE ARC. A messaging thread opens at the newest
  // message and stays there as mail lands — but only while the reader is
  // actually AT the bottom. Someone scrolled up reading yesterday's plan
  // must not be yanked away mid-sentence by a note arriving over the mesh,
  // which is the exact thing gossip delivery does at unpredictable moments.
  // So: pinned -> follow; scrolled up -> hold their place and offer a way
  // back, which is the only honest substitute for the yank.
  //
  // Refs, not state, for the two facts read inside callbacks: they are
  // written on every scroll frame and re-rendering the strip at 60 Hz to
  // store a boolean the render does not use would be its own defect.
  const listRef = useRef<ScrollViewInstance | null>(null);
  const pinnedRef = useRef(true);
  const lastHeightRef = useRef(0);
  // The ONE piece of scroll state the render does use: mail landed below the
  // fold while the reader was up in the history.
  const [newBelow, setNewBelow] = useState(false);

  /** Go to the newest and resume following. The jump button, and every
   * action of the reader's OWN (sending, recording) — a person who just
   * spoke is by definition caught up. */
  const jumpToNewest = useCallback((animated: boolean) => {
    pinnedRef.current = true;
    setNewBelow(false);
    // The ref is a no-op under a test renderer (no native node); the ORDER
    // and the button are what the suite pins, the scroll offset is the
    // device's half.
    listRef.current?.scrollToEnd?.({ animated });
  }, []);

  const onThreadScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const pinned = distanceFromBottom(e.nativeEvent) <= PIN_SLACK_PT;
      pinnedRef.current = pinned;
      if (pinned) {
        // Scrolled back down to the newest by hand: the offer is answered.
        setNewBelow(false);
      }
    },
    [],
  );

  /** The collapsible header. Reopening the strip lands at the NEWEST, like
   * opening any chat: the thread remounts, so its measured height starts
   * over and any stale offer is withdrawn. */
  const toggleOpen = useCallback(() => {
    if (!open) {
      lastHeightRef.current = 0;
      pinnedRef.current = true;
      setNewBelow(false);
    }
    setOpen(o => !o);
  }, [open]);

  /** Content grew — either follow it or say that it happened. */
  const onThreadResize = useCallback((_w: number, h: number) => {
    const grew = h > lastHeightRef.current;
    const first = lastHeightRef.current === 0;
    lastHeightRef.current = h;
    if (pinnedRef.current) {
      // First layout lands AT the newest without a visible animation — the
      // strip should open already there, not scroll there while being read.
      listRef.current?.scrollToEnd?.({ animated: !first });
      return;
    }
    if (grew) {
      setNewBelow(true);
    }
  }, []);

  // Cap-aware BEFORE the store can throw: the byte overage renders inline
  // while typing, the draft is never truncated, and Send simply refuses
  // until it fits. utf8ByteLength because the cap is a radio-budget byte
  // cap, not a character count (emoji are 4 bytes each).
  const overBytes = Math.max(0, utf8ByteLength(draft) - TEXT_MAX_BYTES);

  // Seam defaults resolve LAZILY, at the moment of use — so a test that
  // injects both props never loads fieldAudio (and through it
  // NativeModules), and the app pays the import only on first real use.
  const getRecorder = useCallback(
    (): PodRecorder =>
      recorder ??
      (require('./fieldAudio') as typeof import('./fieldAudio')).fieldRecorder,
    [recorder],
  );
  const getPlayer = useCallback(
    (): PodPlayer =>
      player ??
      (require('./fieldAudio') as typeof import('./fieldAudio')).fieldPlayer,
    [player],
  );

  /** Forget any armed end-of-clip timer. */
  const clearPlayTimer = useCallback(() => {
    if (playTimerRef.current !== null) {
      clearTimeout(playTimerRef.current);
      playTimerRef.current = null;
    }
  }, []);

  /** Silence now, and every row back to ▶. */
  const stopPlaying = useCallback(() => {
    playTokenRef.current += 1;
    clearPlayTimer();
    setPlayingId(null);
    getPlayer()
      .stop()
      .catch(() => {
        // already silent IS the goal state — nothing worth a notice line
      });
  }, [clearPlayTimer, getPlayer]);

  // The strip going away must not leave a timer holding a dead setState.
  // The AUDIO is deliberately left alone: a note halfway through a sentence
  // when the pod card collapses should finish it, the way a call does not
  // hang up because someone opened another screen.
  useEffect(
    () => () => {
      playTokenRef.current += 1;
      if (playTimerRef.current !== null) {
        clearTimeout(playTimerRef.current);
        playTimerRef.current = null;
      }
    },
    [],
  );

  const send = useCallback(() => {
    const text = draft.trim();
    if (text.length === 0 || overBytes > 0) {
      // Nothing to send, or the inline over-cap copy is already showing —
      // a press here must never truncate or half-send.
      return;
    }
    try {
      composeText(crew.code, me.id, text, null, epochMinutes(Date.now()));
      setDraft('');
      setNotice(null);
      // My own message always wins the pin back: nobody sends a note and
      // then wants to keep looking at yesterday.
      jumpToNewest(true);
    } catch (e: any) {
      // The store's own honest copy (its throws are written for humans).
      setNotice(e?.message ?? String(e));
    }
  }, [crew.code, draft, jumpToNewest, me.id, overBytes]);

  // Hold lifecycle. holdRef (not state) is the truth the async callbacks
  // check, because a fast tap can land onPressOut before start() resolves:
  // - pressOut before start settles -> stop() rejects 'idle', swallowed,
  //   and when start() then resolves the finger is gone, so the take is
  //   stopped and discarded immediately (no orphaned open mic).
  const holdRef = useRef(false);
  // When the finger landed. Read at release to answer the one question the
  // create gate asks (VOICE_NOTE_MIN_MS): was this a press, or a tap? A ref
  // for the same reason holdRef is one — the async release path reads it,
  // and no render depends on it.
  const holdStartRef = useRef(0);

  /** The too-quick press, said once: on screen and out loud (a listener
   * holding the mic has no other way to learn the note was dropped). */
  const sayTooQuick = useCallback(() => {
    setNotice(TOO_QUICK_COPY);
    announce(TOO_QUICK_COPY);
  }, []);

  const startHold = useCallback(async () => {
    holdRef.current = true;
    holdStartRef.current = Date.now();
    setNotice(null);
    try {
      await getRecorder().start();
    } catch (e: any) {
      holdRef.current = false;
      if (e?.code === 'permission') {
        // The native side never asks (radio.ts discipline) — this is the
        // in-context ask, payoff first. The Allow button raises the real
        // OS sheet on Android; iOS asks by itself on first native mic use.
        Alert.alert(
          'Voice notes',
          'Playa Pal needs the microphone for voice notes — allow it and hold the button again.',
          [
            { text: 'Not now', style: 'cancel' },
            {
              text: 'Allow the mic',
              onPress: () => {
                if (Platform.OS === 'android') {
                  PermissionsAndroid.request(
                    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
                  ).catch(() => {});
                }
              },
            },
          ],
        );
        return;
      }
      setNotice(e?.message ?? String(e));
      return;
    }
    if (!holdRef.current) {
      // Finger already lifted while the recorder was arming: end the take
      // now and drop it — an accidental brush must not leave the mic open.
      try {
        await getRecorder().stop();
      } catch {
        // an empty or already-idle take is exactly the goal state here
      }
      return;
    }
    setRecording(true);
    announce('Recording — let go to send');
  }, [getRecorder]);

  const stopHold = useCallback(async () => {
    const wasHolding = holdRef.current;
    const heldMs = Date.now() - holdStartRef.current;
    holdRef.current = false;
    setRecording(false);
    if (!wasHolding) {
      return; // the failed-start path already cleaned up
    }
    try {
      // stop() runs even for a tap, and FIRST: the mic has to come back
      // whatever happens next, or the tap that sends nothing also costs the
      // camper their next real note. The take is dropped AFTER, below.
      const clip = await getRecorder().stop();
      if (heldMs < VOICE_NOTE_MIN_MS) {
        // A TAP IS NOT A VOICE NOTE. Gated here, at the mint, rather than at
        // the button: the press is what the finger did, and the same rule
        // then covers every way a short take can come back — a clip of
        // silence, an 'empty' reject, the arming race startHold handles.
        sayTooQuick();
        return;
      }
      // A TAKE THAT CANNOT PLAY MUST NOT ENTER THE MESH (owner report,
      // 2026-08-25). The native side hands back whatever the recorder wrote,
      // and a take whose stop() failed is a file with audio bytes but no
      // index — non-empty, under the cap, and unplayable forever. Sent, it
      // costs every relay in camp its 90 KB and gives the recipient a row
      // that does nothing. Checked HERE and not in composeVoice on purpose:
      // messages.ts sizes the envelope and never reads inside a body (its
      // header's rule), and this is a codec question.
      const verdict = inspectVoiceClip(clip.base64);
      if (verdict.state === 'damaged') {
        const why = recordingDamageCopy(verdict.damage);
        setNotice(why);
        // Said out loud too: a listener holding the mic has no other way to
        // learn the take was dropped.
        announce(why);
        return;
      }
      composeVoice(
        crew.code,
        me.id,
        clip.base64,
        clip.mime,
        null,
        epochMinutes(Date.now()),
      );
      setNotice(null);
      jumpToNewest(true);
      announce('Voice note sent');
    } catch (e: any) {
      if (heldMs < VOICE_NOTE_MIN_MS) {
        // The recorder refusing an empty take ('empty') and the recorder
        // never having armed ('idle') are the SAME gesture seen from the
        // native side — answer them the way the press already earned,
        // before either message reaches a camper.
        sayTooQuick();
        return;
      }
      if (e?.code === 'idle') {
        return; // the pressOut-before-start race; startHold owns cleanup
      }
      // The voice byte cap, a recorder fault — all arrive with human copy
      // already on them.
      setNotice(e?.message ?? String(e));
    }
  }, [crew.code, getRecorder, jumpToNewest, me.id, sayTooQuick]);

  const tapRow = useCallback(
    (m: CrewMessage) => {
      // Tapping is the read receipt (local-only, never synced). My own
      // rows have no unread state; already-read rows are a store no-op,
      // but the guard here also skips the pointless call.
      if (m.origin !== 'mine' && m.read_at === null) {
        markRead(m.id, epochMinutes(Date.now()));
      }
      if (m.kind === 'voice') {
        const trouble = voiceTroubleOf(m);
        if (trouble !== null) {
          // Say what happened to it, in one sentence with something to do in
          // it. Handing these bytes to MediaPlayer would put 'prepare failed
          // status=0x1' on a camper's screen, which is what this whole lane
          // is about.
          setNotice(trouble);
          return;
        }
        if (playingId === m.id) {
          // The second press on a talking row. STOP, not pause: the native
          // side releases the player and deletes its scratch file
          // (FieldAudioModule.stopPlaybackInternal), so there is no position
          // to resume from — and a control labelled "pause" that restarts
          // from the top is the row lying about what the press does.
          stopPlaying();
          return;
        }
        // Lit before the round trip, so the press answers itself. The
        // native side stops whatever else was playing (fieldAudio: "one at
        // a time"), so one lit row at a time is also the literal truth.
        const token = ++playTokenRef.current;
        clearPlayTimer();
        setPlayingId(m.id);
        getPlayer()
          .play(m.body)
          .then(durationMs => {
            if (playTokenRef.current !== token) {
              return; // superseded — another row, or a stop, owns the state
            }
            playTimerRef.current = setTimeout(() => {
              playTimerRef.current = null;
              if (playTokenRef.current === token) {
                setPlayingId(null);
              }
            }, Math.max(0, durationMs));
          })
          .catch((e: any) => {
            if (playTokenRef.current === token) {
              setPlayingId(null);
            }
            setNotice(e?.message ?? String(e));
          });
      }
    },
    [clearPlayTimer, getPlayer, playingId, stopPlaying],
  );

  const renderRow = (m: CrewMessage) => {
    const isMine = m.origin === 'mine';
    const isUnread = !isMine && m.read_at === null;
    // A voice note that cannot be played must not LOOK like one that can
    // (owner, 2026-08-25): the row wears the trouble before the tap, not
    // after it.
    const trouble = voiceTroubleOf(m);
    // Is THIS the row that is talking? Drives the glyph, the lit surface,
    // the spoken verb and what the next press does — one fact, four faces,
    // so they can never disagree with each other.
    const isPlaying = playingId === m.id;
    const known = isMine ? 'You' : names.get(m.from_hash);
    // The LAST resort, and now a rare one: neither a card nor a member
    // announcement has reached this phone for that hash. Say WHY, because
    // an anonymous message in a small pod reads like a stranger got in —
    // and on a gossip mesh the truthful answer is "not yet".
    const unknownSender = known === undefined;
    const sender = known ?? 'someone in the pod';
    // Inbox rows with a to_hash are addressed to ME specifically (the inbox
    // predicate guarantees it) — say so; a directed note reads differently.
    const direct = !isMine && m.to_hash !== null ? ' · just for you' : '';
    // The row's spoken label SAYS "unread" (a11y review 2026-08-24, DO-NOW
    // #10): the gold ● stays for eyes, but a dot is silent to a screen
    // reader — the word carries the state.
    const when = agoPhrase(m.created_min * 60_000);
    const rowLabel =
      (isUnread ? 'Unread — ' : '') +
      (m.kind === 'voice'
        ? trouble !== null
          ? // The spoken row carries the whole trouble, not a "▶" a screen
            // reader cannot see is crossed out.
            `voice note from ${sender}${
              direct ? ', just for you' : ''
            } — ${trouble}`
          : `voice note from ${sender}${
              direct ? ', just for you' : ''
            }, ${voiceSeconds(m.body)} seconds — ${
              isPlaying ? 'playing, tap to stop' : 'tap to play'
            }`
        : `message from ${sender}${direct ? ', just for you' : ''}: ${
            m.body
          }`) +
      (when ? ` · ${when}` : '') +
      (unknownSender ? " — their hello hasn't reached this phone yet" : '');
    return (
      <Pressable
        key={m.id}
        style={styles.msgRow}
        onPress={() => tapRow(m)}
        accessibilityRole="button"
        accessibilityLabel={rowLabel}
        // The mic button's lesson, one surface over (a11y review
        // 2026-08-24): playing state was about to be color-and-glyph only,
        // which a screen reader cannot see either.
        accessibilityState={m.kind === 'voice' ? { selected: isPlaying } : undefined}>
        <View style={styles.metaRow}>
          {isUnread ? <Text style={styles.unreadDot}>●</Text> : null}
          <Text style={isUnread ? styles.senderUnread : styles.sender}>
            {sender}
            {direct}
          </Text>
          <Text style={styles.when}>
            {agoPhrase(m.created_min * 60_000) ?? ''}
          </Text>
        </View>
        {m.kind === 'text' ? (
          <Text style={isUnread ? styles.bodyUnread : styles.body}>
            {m.body}
          </Text>
        ) : trouble !== null ? (
          // No ▶ and no duration: both are promises this row cannot keep.
          <Text style={styles.voiceBroken}>⚠ {DAMAGED_VOICE_LABEL}</Text>
        ) : (
          // THE CONTROL — a button-shaped surface, not a line of text with
          // a triangle in front of it (owner report, 2026-08-26). The press
          // belongs to the Pressable around the whole row, as it always
          // has; this is the part that finally SAYS so, at a size that
          // survives gloves, dust and low sun. Full width on purpose: the
          // affordance and the tap target are now the same shape.
          <View style={[styles.voiceCtl, isPlaying && styles.voiceCtlLive]}>
            <Text style={[styles.voiceGlyph, isPlaying && styles.voiceGlyphLive]}>
              {isPlaying ? '■' : '▶'}
            </Text>
            <Text style={[styles.voice, isPlaying && styles.voiceLive]}>
              {isPlaying ? 'Playing' : 'Voice note'} · {voiceSeconds(m.body)}s
            </Text>
          </View>
        )}
        {trouble !== null ? (
          <Text style={styles.senderHint}>{trouble}</Text>
        ) : null}
        {unknownSender ? (
          <Text style={styles.senderHint}>
            Their hello hasn't reached this phone yet — it comes with the next
            time you pass.
          </Text>
        ) : null}
      </Pressable>
    );
  };

  return (
    <View style={styles.wrap}>
      {/* The whole strip lives behind this header (a11y+IA review
          2026-08-24, DO-NOW #2) — the Public-packs collapsible pattern:
          title + unread badge + chevron, expanded state said out loud. */}
      <Pressable
        style={styles.headerRow}
        onPress={toggleOpen}
        accessibilityRole="button"
        accessibilityLabel={
          unread > 0 ? `Answering machine, ${unread} new` : 'Answering machine'
        }
        accessibilityState={{ expanded: open }}>
        {/* "Answering machine" is USER-FACING by owner ruling (§6c #3): it
            "harkens cutely back to the era before cell phones when people
            left messages and checked them" — which is literally this
            transport's delivery model. */}
        <Text style={styles.title}>Answering machine</Text>
        {unread > 0 ? <Text style={styles.newBadge}>{unread} new</Text> : null}
        <Text style={styles.chevron}>{open ? '˅' : '›'}</Text>
      </Pressable>
      {open ? (
        <>
          {thread.length === 0 ? (
            <Text style={styles.empty}>
              No messages waiting. Leave one — the pod picks it up when phones
              pass in range, like the answering machine at your first house.
            </Text>
          ) : (
            // The thread scrolls INSIDE the card so "newest at the bottom"
            // has a bottom to be at. nestedScrollEnabled because the pod
            // screen is itself a ScrollView: without it Android hands every
            // drag to the parent and this window never moves.
            <ScrollView
              ref={listRef}
              style={styles.thread}
              nestedScrollEnabled
              onScroll={onThreadScroll}
              scrollEventThrottle={32}
              onContentSizeChange={onThreadResize}
              keyboardShouldPersistTaps="handled">
              {thread.map(renderRow)}
            </ScrollView>
          )}
          {newBelow ? (
            // The reverse arc's other half: they were not yanked, so they
            // have to be TOLD, and given the one tap back.
            <Pressable
              style={styles.jumpBtn}
              onPress={() => jumpToNewest(true)}
              accessibilityRole="button"
              accessibilityLabel="New messages below — jump to the newest">
              <Text style={styles.jumpText}>New messages ↓</Text>
            </Pressable>
          ) : null}
          {overBytes > 0 ? (
            <Text style={styles.notice}>
              That message is too long to carry — trim it down.
            </Text>
          ) : null}
          {notice ? <Text style={styles.notice}>{notice}</Text> : null}
          <View style={styles.composeRow}>
            <TextInput
              style={styles.input}
              placeholder="Message the pod…"
              placeholderTextColor={colors.faded}
              value={draft}
              onChangeText={setDraft}
              multiline
            />
            <Pressable
              style={styles.sendBtn}
              onPress={send}
              accessibilityRole="button"
              accessibilityLabel="Send message">
              <Text style={styles.sendText}>Send</Text>
            </Pressable>
            <Pressable
              style={[styles.micBtn, recording && styles.micBtnLive]}
              onPressIn={startHold}
              onPressOut={stopHold}
              accessibilityRole="button"
              accessibilityLabel="Hold to record a voice note"
              // Same defect as the walkie's talk button: recording state was
              // color-only, so a screen reader could not tell a hot mic from
              // a cold one.
              accessibilityState={{ selected: recording }}>
              <Text style={styles.micIcon}>🎤</Text>
            </Pressable>
          </View>
          {recording ? (
            <Text style={styles.recordingLine}>
              Recording — let go to send
            </Text>
          ) : null}
          {/* This line said "while position sharing is on" until the
              mailbox decoupling (2026-08-25) — which was true, and was the
              bug: mail rode on a consent question it has nothing to do
              with. Now the app is open is the whole condition.

              THE TUFTE PASS (owner ask 2026-08-26): pure transport
              teaching, identical on every phone, sitting under the composer
              at all times. The per-message states above it — "Their hello
              hasn't reached this phone yet", the empty mailbox, "Recording
              — let go to send" — stay exactly where they are. */}
          <View style={styles.footerInfo}>
            <InfoTap
              topic="how messages travel"
              text={
                'Messages move whenever Playa Pal is open on both phones, ' +
                'hopping pod phone to pod phone — seconds when someone is ' +
                'beside you, longer when they are across camp. A plugged-in ' +
                'phone at camp keeps the mailbox.'
              }
            />
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderTopColor: colors.haze,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.md,
    paddingTop: spacing.md,
  },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    minHeight: tap.minHeight, // a collapsible header is a button now — 44pt
  },
  title: { color: colors.night, fontSize: type.body, fontWeight: '700' },
  newBadge: { color: colors.gold, fontSize: type.small, fontWeight: '700' },
  chevron: {
    color: colors.faded,
    fontSize: type.title,
    fontWeight: '300',
    marginLeft: 'auto',
  },
  empty: {
    color: colors.faded,
    fontSize: type.small,
    fontStyle: 'italic',
    marginVertical: spacing.sm,
  },
  msgRow: { marginTop: spacing.sm },
  metaRow: { alignItems: 'baseline', flexDirection: 'row', gap: spacing.sm },
  unreadDot: { color: colors.gold, fontSize: type.tiny },
  sender: { color: colors.faded, fontSize: type.small, fontWeight: '700' },
  senderUnread: { color: colors.night, fontSize: type.small, fontWeight: '700' },
  when: { color: colors.faded, fontSize: type.tiny },
  // Why a message is anonymous, said where the anonymity shows.
  senderHint: {
    color: colors.faded,
    fontSize: type.tiny,
    fontStyle: 'italic',
    marginTop: 2,
  },
  body: { color: colors.faded, fontSize: type.body, marginTop: 2 },
  bodyUnread: { color: colors.night, fontSize: type.body, marginTop: 2 },
  /**
   * The voice row's control surface (owner report, 2026-08-26: "the play
   * button is tiny on received voicenotes"). `...tap` is the 44pt floor
   * every other button on this card already stands on; the row stretches to
   * the card's full width because the PRESS covers the whole row and an
   * affordance narrower than its own target is how the ▶ read as tiny in
   * the first place. `field` is the raised chip surface in both palettes.
   */
  voiceCtl: {
    ...tap,
    alignItems: 'center',
    backgroundColor: colors.field,
    borderRadius: radius.card,
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
    paddingHorizontal: spacing.md,
  },
  // Talking: the same gold the live mic wears, so "something is playing"
  // reads across the card without hunting for a glyph.
  voiceCtlLive: { backgroundColor: colors.gold },
  // lineHeight stated, not inherited: a glyph this far above body size
  // clips against a default line box on Android — and a stated pair is what
  // keeps the mark and its box in proportion when anything scales the text
  // (the OS accessibility size, for one) instead of the glyph alone.
  voiceGlyph: {
    color: colors.clay,
    fontSize: type.glyph,
    lineHeight: type.glyph + spacing.xs,
  },
  voiceGlyphLive: { color: colors.onAccent },
  voice: { color: colors.clay, fontSize: type.body, fontWeight: '700' },
  voiceLive: { color: colors.onAccent, fontSize: type.body, fontWeight: '700' },
  // Faded, not alarming: a damaged note is a disappointment, not an error
  // state — and it must not read as louder than the notes that DO play.
  voiceBroken: {
    color: colors.faded,
    fontSize: type.body,
    fontWeight: '700',
    marginTop: 2,
  },
  thread: { maxHeight: THREAD_MAX_HEIGHT },
  jumpBtn: {
    alignSelf: 'center',
    backgroundColor: colors.gold,
    borderRadius: radius.chip,
    marginTop: spacing.sm,
    minHeight: tap.minHeight,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  jumpText: { color: colors.onAccent, fontSize: type.small, fontWeight: '700' },
  notice: { color: colors.clay, fontSize: type.small, marginTop: spacing.sm },
  composeRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  input: {
    // field, not cream: cream stays light in dark mode (text-on-accent),
    // a field surface must follow the ground (dark-mode sweep)
    backgroundColor: colors.field,
    borderRadius: radius.card,
    color: colors.night,
    flex: 1,
    fontSize: type.body,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  sendBtn: {
    ...tap, // 44pt send floor (a11y review 2026-08-24)
    alignItems: 'center',
    backgroundColor: colors.clay,
    borderRadius: radius.card,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  sendText: { color: colors.onAccent, fontSize: type.body, fontWeight: '700' },
  micBtn: {
    ...tap, // the mic is the smallest hold target on the card — 44pt floor
    alignItems: 'center',
    borderColor: colors.haze,
    borderRadius: radius.chip,
    borderWidth: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  micBtnLive: { backgroundColor: colors.gold, borderColor: colors.gold },
  micIcon: { fontSize: type.body },
  recordingLine: {
    color: colors.gold,
    fontSize: type.small,
    fontWeight: '700',
    marginTop: spacing.xs,
  },
  // The transport lesson moved behind a ? (the Tufte pass, 2026-08-26) and
  // `footer` went with the paragraph it styled; the glyph keeps that
  // paragraph's own top margin so the composer's foot does not shift.
  footerInfo: { alignItems: 'flex-start', marginTop: spacing.md },
});
