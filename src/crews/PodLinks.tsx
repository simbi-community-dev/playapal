/**
 * PodLinks — the pod card's connection list (owner ask, 2026-08-25): the
 * compact answer to the two questions in their priority order — am I
 * connected, and to whom? A one-line header carries this phone's own state
 * and a reach summary; tapping it pops the per-member list, each row a
 * small ink-ranked glyph plus a capability phrase (what the link ENABLES,
 * never which radio carries it — podStatus.ts owns that vocabulary and its
 * regression suite bans protocol words).
 *
 * ONE PEER MODEL, ON PURPOSE. Every fact here is read from a store the pod
 * card already trusts: the roster arrives as the SAME folded people
 * CrewSection renders, presence is the sighting store, my own state is the
 * sharing session, and live voice comes off the walkie's own peers event —
 * the exact stream WalkiePanel renders, listed by the native side only
 * after the link is PROVEN (docs/WALKIE-LADDER.md §5). This file computes
 * nothing about the radio; it only translates evidence into words.
 *
 * STALENESS IS THE LIE THIS FILE GUARDS AGAINST: a closed walkie's last
 * peer list rendering as "voice now" would be §5's proven-link rule broken
 * by memory rather than by wishfulness. The walkie session is one store and
 * a render-time walkieOnFor(crewId) gate reads it, so every live-voice
 * claim dies with the channel — and, since the session now outlives this
 * card, only ever belongs to the pod whose channel is actually open.
 */
import React, { useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { agoPhrase } from './CrewSection';
import {
  checkPodUpdates,
  lastPodSyncMs,
  meshRevision,
  subscribeMeshChanged,
} from './meshSync';
import {
  presenceFor,
  presenceRevision,
  subscribePresenceChanged,
} from './presence';
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
} from './podStatus';
import { nameKey, type PodPerson } from './rosterFold';
import {
  radioInterrupted,
  sessionRevision,
  subscribeSessionChanged,
} from './session';
import { mailboxPresenceOn, sharingCrewId } from './share';
import { type WalkiePeerEntry } from './walkie';
import {
  subscribeWalkieSession,
  walkieOnFor,
  walkieSessionRevision,
  walkieSessionState,
} from './walkieSession';
import { colors, spacing, tap, type } from '../theme';

/** Color assists the glyph; it is never the only channel — the phrase and
 * the glyph's own shape carry the tier for every reader. */
const glyphStyle = (t: LinkTier) =>
  t === 'voice' || t === 'voice-lofi'
    ? styles.glyphVoice
    : t === 'near'
    ? styles.glyphNear
    : styles.glyphQuiet;

export function PodLinks({
  crewId,
  members,
}: {
  crewId: string;
  members: PodPerson[];
}) {
  const [open, setOpen] = useState(false);
  // The manual check ("Check for pod updates"): `checking` renders only
  // while the REAL drain promise is in flight — never a staged wait — and
  // the note is checkPodUpdates' own honest report, nothing invented.
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState<string | null>(null);
  // The stores whose changes move this surface: sightings arriving,
  // session flips (sharing on/off, radio interruptions), and the walkie
  // session — which now republishes the channel's own open/close emitter,
  // so one subscription still sees a close nobody on this screen asked for.
  useSyncExternalStore(subscribePresenceChanged, presenceRevision);
  useSyncExternalStore(subscribeSessionChanged, sessionRevision);
  // ...and completed mailbox syncs, which move the "last caught up" line
  // without touching presence or the session.
  useSyncExternalStore(subscribeMeshChanged, meshRevision);
  useSyncExternalStore(subscribeWalkieSession, walkieSessionRevision);

  // Live-voice evidence exists only while the channel is open FOR THIS POD.
  // The pod half is new and load-bearing: the session outlives this card, so
  // it can be holding the big camp pod's channel while the card shows the
  // two-person pod — and a bare "is the walkie on" would then paint voice
  // tiers onto people this radio is not on a channel with. Same §5 rule,
  // asked precisely. A closed channel yields no peers at all, so the stale
  // list cannot outlive the close by even one render.
  const voiceHere = walkieOnFor(crewId);
  const peers: WalkiePeerEntry[] = voiceHere ? walkieSessionState().peers : [];
  const rungs = voiceHere
    ? rungsByName(peers)
    : new Map<string, WalkiePeerEntry['rung']>();

  const rows = members.map(m => {
    const presence = presenceFor(m.cardId);
    return {
      m,
      presence,
      tier: memberLinkTier({
        walkieRung: rungs.get(nameKey(m.name)) ?? null,
        presence,
      }),
    };
  });

  const sharingOn = sharingCrewId() === crewId;
  // The mail surfaces below (last-caught-up, the manual check) used to hang
  // off `sharingOn`, because sharing was the only thing that ever put the
  // radio up. It isn't any more: a phone carrying pod mail with its
  // position private must still be able to say when it last caught up and
  // to check on demand.
  const mailboxOn = mailboxPresenceOn();
  // TWO DIFFERENT INTERRUPTIONS, kept apart here rather than in the words:
  // a dead radio means the pod cannot hear this phone at all, while
  // 'no-fix' means the mailbox is on the air and only the PLACE is missing
  // (session.ts). Folding them together would tell someone waiting on a
  // message that nothing is moving, while their message moves.
  const down = radioInterrupted();
  const me = myLinkStatus({
    sharingOn,
    radioDown: down !== null && down.why !== 'no-fix',
    waitingForFix: down?.why === 'no-fix',
    // The ring lane's per-crew gate survives the mailbox merge: live-voice
    // claims must ask "for WHICH pod?" — a session on another pod's
    // channel is not voice here.
    walkieOn: voiceHere,
    // Mail moves whenever the session is up, in either posture — the header
    // says so instead of reading "quiet" over a working mailbox.
    mailboxOn,
  });
  const summary = linkSummary(rows.map(r => r.tier));
  const lastAt = lastPodSyncMs();

  const runCheck = async () => {
    setChecking(true);
    try {
      setCheckNote(checkOutcomePhrase(await checkPodUpdates()));
    } finally {
      setChecking(false);
    }
  };

  /** The row's recency line — evidence aging in plain words, so an absent
   * member reads as "last heard", never as an error. */
  const recency = (r: (typeof rows)[number]): string | null => {
    if (r.tier === 'recent' && r.presence) {
      return `seen ${agoPhrase(r.presence.atMs) ?? 'a while ago'}`;
    }
    if (r.tier === 'quiet' && r.m.announcedMin !== null) {
      const said = agoPhrase(r.m.announcedMin * 60_000);
      return said ? `said hello ${said}` : null;
    }
    return null;
  };

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => setOpen(o => !o)}
        accessibilityRole="button"
        accessibilityLabel={
          open ? 'Hide the pod connection list' : 'Show who is in reach and how'
        }
        accessibilityState={{ expanded: open }}
        style={styles.headerTap}>
        <Text style={styles.me}>
          {me.glyph}
          {'  '}
          {me.phrase}
        </Text>
        <Text style={styles.summary}>
          {summary}
          {open ? '' : ' · tap for the list'}
        </Text>
        {mailboxOn ? (
          <Text style={styles.summary}>
            {lastSyncPhrase(
              lastAt === null ? null : agoPhrase(lastAt) ?? 'a while ago',
            )}
          </Text>
        ) : null}
      </Pressable>
      {open
        ? rows.map(r => {
            const phrase = tierPhrase(r.tier);
            const extra = recency(r);
            return (
              <View
                key={r.m.cardId}
                style={styles.row}
                accessible
                accessibilityLabel={`${r.m.name} — ${phrase}${
                  extra ? `, ${extra}` : ''
                }`}>
                <Text style={[styles.glyph, glyphStyle(r.tier)]}>
                  {linkGlyph(r.tier)}
                </Text>
                <View style={styles.rowBody}>
                  <Text style={styles.name}>{r.m.name}</Text>
                  <Text
                    style={
                      r.tier === 'quiet' ? styles.phraseQuiet : styles.phrase
                    }>
                    {phrase}
                    {extra ? ` · ${extra}` : ''}
                  </Text>
                </View>
              </View>
            );
          })
        : null}
      {open ? (
        // Reach is PER-PHONE, and no other surface says so: the hub phone
        // lists two podmates while its podmates each list one, and all
        // three screens are right at once. The second clause is traced,
        // not decoration — sharing-on relays everything it carries
        // (meshSync), which is exactly why the asymmetry is harmless.
        <Text style={styles.summary}>
          Each phone lists who it can reach — two podmates can see
          different lists, and both are right. Messages hop phone to
          phone, so they still get through.
        </Text>
      ) : null}
      {open && mailboxOn ? (
        <View style={styles.check}>
          <Pressable
            onPress={() => {
              void runCheck();
            }}
            disabled={checking}
            accessibilityRole="button"
            accessibilityLabel="Check for pod updates"
            style={styles.checkTap}>
            <Text style={styles.checkVerb}>
              {checking ? 'Checking…' : 'Check for pod updates'}
            </Text>
          </Pressable>
          {checkNote !== null && !checking ? (
            <Text style={styles.checkNote}>{checkNote}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  check: { marginTop: spacing.sm },
  checkNote: { color: colors.faded, fontSize: type.tiny, marginTop: 2 },
  checkTap: { justifyContent: 'center', minHeight: tap.minHeight },
  checkVerb: { color: colors.sage, fontSize: type.small, fontWeight: '700' },
  glyph: {
    fontSize: type.small,
    fontWeight: '700',
    width: 34,
  },
  glyphNear: { color: colors.sage },
  glyphQuiet: { color: colors.faded },
  glyphVoice: { color: colors.gold },
  headerTap: { justifyContent: 'center', minHeight: tap.minHeight },
  me: { color: colors.night, fontSize: type.small, fontWeight: '700' },
  name: { color: colors.night, fontSize: type.small, fontWeight: '700' },
  phrase: { color: colors.faded, fontSize: type.tiny, marginTop: 1 },
  // A quiet member's phrase leans back like the roster's stale rows — a
  // memory, visibly, never an alarm.
  phraseQuiet: {
    color: colors.faded,
    fontSize: type.tiny,
    fontStyle: 'italic',
    marginTop: 1,
    opacity: 0.8,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    marginTop: spacing.sm,
  },
  rowBody: { flex: 1 },
  summary: { color: colors.faded, fontSize: type.tiny, marginTop: 2 },
  wrap: {
    borderTopColor: colors.haze,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.md,
    paddingTop: spacing.md,
  },
});
