/**
 * Crew — Phase A of docs/CREW-DESIGN.md (§4), mounted as the top section of
 * the Camp tab's friends surface (§6.2 — no new screens). A crew is a named
 * subset of the friend cards you already hold; each member row is the same
 * glance the friend rows give — where they said they'd be, a compass tap, a
 * walk time — plus a "last confirmed" timestamp from the card itself.
 * Honesty floor stated on screen: cards, not a live feed.
 *
 * PHASE B SEAM: `presenceFor`. When a presence source (BLE pings, built in
 * parallel) hands a row a coordinate, the row flips to its live state and
 * the compass tap uses those coords instead of the card's address. Wiring
 * later is one prop; nothing here imports the presence module. Rows call
 * presenceFor on every render, so Phase B re-renders by bumping whatever
 * state feeds the prop.
 *
 * MEMBERS COME FROM TWO PLACES NOW (§6f): the cards you picked AND the
 * podmates whose phones announced themselves over the mesh. A pod joined
 * by code starts with neither a name nor a roster — both arrive as
 * announcements — so this section reconciles them on every store change
 * (src/crews/podMembers.ts) and renders a member who has no card as what
 * they are: a name, no address, and a swap-cards invitation.
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  Alert,
  Pressable,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { getDb } from '../events/db';
import {
  exportMyCard,
  getMyCard,
  listFriends,
  saveMyCard,
  subscribeFriendsChanged,
  type FriendCard,
} from '../friends/friendCard';
import {
  addressToLatLon,
  formatDistanceFt,
  gpsVector,
  type WaypointTarget,
} from '../geo/brcGeo';
import { getCityGeometry } from '../geo/cityGeometry';
import { playaWalkMinutes } from '../rightnow/playaWalk';
import {
  crewsRevision,
  isPlaceholderPodName,
  joinCrew,
  listCrews,
  newCrew,
  podDisplayName,
  podLabel,
  podNameSource,
  removeCrew,
  saveCrew,
  subscribeCrewsChanged,
} from './crew';
import {
  epochMinutes,
  messagesRevision,
  subscribeMessagesChanged,
} from './messages';
import {
  MEMBER_STALE_MIN,
  podRoster,
  reconcilePods,
} from './podMembers';
import {
  foldPodRoster,
  selfGhostNote,
  type PodPerson,
} from './rosterFold';
import {
  presenceFor as presenceForStore,
  presenceRevision,
  subscribePresenceChanged,
} from './presence';
import {
  radioInterrupted,
  type RadioDownReason,
  sessionRevision,
  subscribeSessionChanged,
} from './session';
import { crewRadioPresent } from './radio';
import {
  sharingCrewId,
  sharingDiedWithProcess,
  startCrewSharing,
  stopCrewSharing,
} from './share';
import { PodMessages } from './PodMessages';
import { WalkiePanel } from './WalkiePanel';
import PodQr from './PodQr';
import { encodePodLink, type PodInvite } from './podLink';
import { myRungsSync, primeMyRungs } from './wifiAware';
import { colors, radius, spacing, tap, type } from '../theme';

/**
 * One sentence per interruption reason, keyed by the reason itself.
 *
 * A TERNARY CHAIN WAS WRONG HERE and a test caught it: the last arm is an
 * ELSE, so 'advertise-failed' never appeared as a literal and any FOURTH
 * reason added to RadioDownReason later would have silently inherited its
 * copy — a camper told "it keeps trying; nothing to do" about a problem that
 * needs them. A keyed record makes a new reason a missing key instead of a
 * wrong sentence.
 *
 * The three are NOT one problem, which is why they are not one sentence:
 * 'permission' can never self-heal and must send the user somewhere, while
 * the other two recover on their own and the honest instruction is to wait.
 * Every one states the CONSEQUENCE before the remedy — a camper needs to
 * know they are invisible before they are told what to do about it.
 */
const PAUSED_COPY: Record<RadioDownReason, string> = {
  permission:
    'Paused — Playa Pal lost the Bluetooth permission, so your pod cannot see you. Turn it back on in Settings and sharing resumes.',
  'bluetooth-off':
    'Paused — Bluetooth is off, so your pod cannot see you right now. Turn Bluetooth on and this picks itself back up.',
  'advertise-failed':
    'Paused — the radio would not start, so your pod cannot see you right now. It keeps trying; nothing to do.',
  // A beacon IS a position, so with no fix there is nothing to send. Normally
  // a second or two at session start; long only where the sky is blocked.
  // Says WAITING rather than broken, because that is what it is — and names
  // the one thing that helps, without implying the app is stuck.
  'no-fix':
    'Getting your position — your pod will see you as soon as this phone has a fix. Under a shade structure it can take a minute; stepping into the open speeds it up.',
};

/** What Phase B's presence source hands a member row. */
export interface CrewPresence {
  lat: number;
  lon: number;
  atMs: number;
  live: boolean;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * A timestamp rendered the way a person would say it: "just now", "25m ago",
 * "2h ago", then a weekday ("Tue") inside a week, then "Aug 3". Null when
 * the input is not a time — the caller renders honesty, not a blank.
 * Hand-rolled names, not toLocaleDateString: Hermes Intl coverage varies by
 * build (same reason brcGeo formats its own thousands commas).
 */
export function agoPhrase(
  when: string | number,
  now: number = Date.now(),
): string | null {
  const t = typeof when === 'number' ? when : Date.parse(when);
  if (!Number.isFinite(t)) {
    return null;
  }
  const mins = Math.round((now - t) / 60000);
  if (mins < 1) {
    return 'just now';
  }
  if (mins < 60) {
    return `${mins}m ago`;
  }
  const hours = Math.round(mins / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const d = new Date(t);
  if (Math.round((now - t) / 86400000) < 7) {
    return DAYS[d.getDay()];
  }
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export function CrewSection({
  onOpenCompass,
  presenceFor,
}: {
  onOpenCompass: (t: WaypointTarget) => void;
  presenceFor?: (cardId: string) => CrewPresence | null;
}) {
  const conn = getDb();
  const geo = getCityGeometry();

  // Crews re-read on every revision bump (the EventCard/favorites pattern).
  useSyncExternalStore(subscribeCrewsChanged, crewsRevision);
  // Presence bumps on every decoded sighting — this subscription is the
  // re-render driver the Phase B seam asked for; rows call the resolver per
  // render. The prop stays as the test override.
  useSyncExternalStore(subscribePresenceChanged, presenceRevision);
  // Member announcements ride the message store, so the roster and the
  // pod's own name both move on this revision — a podmate who walks into
  // range fills in a row without anyone tapping anything.
  const msgRev = useSyncExternalStore(
    subscribeMessagesChanged,
    messagesRevision,
  );
  const presence = presenceFor ?? presenceForStore;
  // The sharing toggle re-renders on session flips (start/stop/master-off).
  useSyncExternalStore(subscribeSessionChanged, sessionRevision);
  // Hide the radio affordance entirely when the native module is absent —
  // a dead switch is worse than no switch. Checked SYNCHRONOUSLY: an async
  // probe here meant a state update after unmount in tests and after first
  // paint on phones, for a fact that never changes within a build.
  const radioOk = crewRadioPresent();
  const toggleShare = useCallback(
    (on: boolean, c: { id: string; name: string; code: string; memberIds: string[] }) => {
      (async () => {
        try {
          if (on) {
            await startCrewSharing(c);
          } else {
            await stopCrewSharing();
          }
        } catch (e: any) {
          Alert.alert('Before you share', e?.message ?? String(e));
        }
      })();
    },
    [],
  );
  // Plural pods, owner-ruled UI (§6c #4: "it's called pods, just like n2y
  // called it groups"): a chip row switches the card between pods; the
  // engine already scans for ALL pods (knownCrewCodes) while broadcasting
  // for at most one (share.ts exclusivity), so switching the VIEW never
  // touches the radio.
  const crews = listCrews();
  const [activePodId, setActivePodId] = useState<string | null>(null);
  const [qrOpen, setQrOpen] = useState(false);

  // Ask the radio probe once (docs/WALKIE-LADDER.md §4), into STATE.
  //
  // The obvious version of this — fire-and-forget into the module cache and
  // read it with myRungsSync() during render — silently does nothing: the
  // probe resolves asynchronously, a module-level cache is not a React store,
  // so nothing re-renders and nothing re-runs the announcement effect. The
  // phone would learn its own radios and never tell anyone, which is the
  // exact failure class this lane keeps finding in other people's code.
  //
  // Seeded from the cache so a REMOUNT is instant (the probe is a device fact
  // asked once per process), and 0 until it lands — "no rungs above the
  // floor", both the safe answer and the true one for a phone that never
  // answers. An invite minted before it lands carries no radios field, which
  // is exactly what a phone one release older sends.
  const [rungs, setRungs] = useState(myRungsSync());
  useEffect(() => {
    let alive = true;
    void primeMyRungs().then(r => {
      if (alive) {
        setRungs(r);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const crew = crews.find(c => c.id === activePodId) ?? crews[0] ?? null;
  // Picker mode: editing the shown pod vs minting a new one.
  const [creatingNew, setCreatingNew] = useState(false);
  // Join-by-code (the other half of "same code, same pod").
  const [joining, setJoining] = useState(false);
  // The one action door on the chip row (a11y+IA review 2026-08-24): the
  // chips are a PURE selection row now — "Add or join…" opens a tiny
  // two-option row instead of two action chips masquerading as pods.
  const [addOpen, setAddOpen] = useState(false);
  const [codeDraft, setCodeDraft] = useState('');
  // Codes are 4-digit PINs now (owner, Aug 24). The retired word phrases
  // still join, so the join field can drop to a letter keyboard on request.
  const [wordCode, setWordCode] = useState(false);
  const [friends, setFriends] = useState<FriendCard[]>(() => listFriends(conn));
  const [me, setMe] = useState(() => getMyCard(conn));
  useEffect(
    () =>
      subscribeFriendsChanged(() => {
        setFriends(listFriends(conn));
        setMe(getMyCard(conn));
      }),
    [conn],
  );

  const doJoin = useCallback(() => {
    const code = codeDraft.trim();
    if (!code) {
      return;
    }
    // No name is passed: a joined pod's name arrives over the mesh from
    // whoever named it (podMembers.ts), and until then the pod wears a
    // placeholder that nothing mistakes for a chosen name. Joining a code
    // this phone already holds returns that pod rather than a duplicate.
    const made = joinCrew(code);
    // EAGER (cross-family review, Aug 24): announce NOW, not on the next
    // tick. In a two-person pod the first sighting is the whole story —
    // waiting for a refresh would leave the pair looking at each other's
    // empty rosters. Also adopts a name if this pod's announcements are
    // already sitting in the store from an earlier stretch of gossip.
    reconcilePods([made], me.id, me.name, epochMinutes(Date.now()), rungs);
    setActivePodId(made.id);
    setJoining(false);
    setCodeDraft('');
    setWordCode(false);
  }, [codeDraft, me.id, me.name, rungs]);

  // Say who I am in every pod on this phone, and take the pod's name from
  // whoever named it — the two halves of "a join code carries no identity"
  // (§6f). This is the whole schedule: joining, creating, renaming myself,
  // renaming the pod and a podmate's announcement arriving all land here as
  // a dep change, and podMembers.ts owns the idempotence, so a spurious
  // re-run costs one read. A phone with no name on its card announces
  // nothing — the repair row below is that case's answer.
  const podSignature = crews
    .map(c => `${c.id}:${c.code}:${c.name}`)
    .join('|');
  useEffect(() => {
    reconcilePods(listCrews(), me.id, me.name, epochMinutes(Date.now()), rungs);
    // podSignature and msgRev are the store's own change signals; listing
    // the crews array itself would re-run on every render instead. rungs is
    // here because the probe lands AFTER first paint: without it the phone
    // would learn its own radios and never announce them.
  }, [podSignature, msgRev, me.id, me.name, rungs]);

  // THE ONE-TAP REPAIR (owner, Aug 24: "if the user hasnt set it they
  // should be asked to run setup again with a tap"). Identity is automatic
  // now — except for the one phone that has no name to announce, which must
  // not quietly broadcast an empty nameplate. The field is inline because
  // the pod card is where the missing name HURTS, and it writes through the
  // same saveMyCard the card editor uses, so there is no second store and
  // no second consent surface (scope is left exactly as it was).
  const myNameMissing = me.name.trim().length === 0;
  const [nameFixOpen, setNameFixOpen] = useState(false);
  const [myNameDraft, setMyNameDraft] = useState('');
  const saveMyName = useCallback(() => {
    try {
      saveMyCard(conn, {
        name: myNameDraft,
        camp: me.camp,
        address: me.address,
        note: me.note,
      });
    } catch (e: any) {
      // The card store's own copy ("Your card needs a name…").
      Alert.alert('Almost', e?.message ?? String(e));
      return;
    }
    // saveMyCard notifies; the friends subscription refreshes `me`, and the
    // reconcile effect then announces into every pod — which is the whole
    // reason for asking.
    setNameFixOpen(false);
    setMyNameDraft('');
  }, [conn, me.address, me.camp, me.note, myNameDraft]);

  // The picker: one inline card for both "start" and "edit".
  const [picking, setPicking] = useState(false);
  const [nameDraft, setNameDraft] = useState('My pod');
  const [picked, setPicked] = useState<string[]>([]);

  const openPicker = useCallback(() => {
    setCreatingNew(false);
    setNameDraft(crew ? crew.name : 'My pod');
    setPicked(crew ? [...crew.memberIds] : []);
    setPicking(true);
  }, [crew]);

  const openNewPod = useCallback(() => {
    setCreatingNew(true);
    setNameDraft('My pod');
    setPicked([]);
    setPicking(true);
  }, []);

  const togglePick = useCallback((id: string) => {
    setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]));
  }, []);

  const savePicker = useCallback(() => {
    if (crew && !creatingNew) {
      // A name the user TYPED is theirs; a placeholder they left alone is
      // still a placeholder. Without that distinction, the fresh joiner who
      // taps Edit to pick people (which the empty state invites) would
      // silently adopt the join code as the pod's name and never receive
      // the real one off the mesh.
      const kept = nameDraft.trim() === crew.name.trim();
      const saved = saveCrew({
        ...crew,
        name: nameDraft,
        memberIds: picked,
        nameSource: kept ? podNameSource(crew) : 'mine',
      });
      // A rename is something the pod has to hear about.
      reconcilePods([saved], me.id, me.name, epochMinutes(Date.now()), rungs);
    } else {
      const made = saveCrew(newCrew(nameDraft, picked));
      // EAGER at creation, for the same reason as at join: the pod's namer
      // is the one member who can tell everyone else what it is called.
      reconcilePods([made], me.id, me.name, epochMinutes(Date.now()), rungs);
      setActivePodId(made.id); // a new pod is the one you're looking at
    }
    setPicking(false);
    setCreatingNew(false);
  }, [crew, creatingNew, me.id, me.name, nameDraft, picked, rungs]);

  const disband = useCallback(() => {
    if (!crew) {
      return;
    }
    Alert.alert(
      'Disband this pod?',
      'The friend cards stay — only the grouping goes.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disband',
          style: 'destructive',
          onPress: () => {
            // Disbanding the pod you're broadcasting FOR must take the
            // radio down with it (composed review: storage-only removal
            // left the session advertising for a pod that no longer
            // exists).
            if (sharingCrewId() === crew.id) {
              void stopCrewSharing();
            }
            removeCrew(crew.id);
            setActivePodId(null); // fall back to the first remaining pod
            setPicking(false);
          },
        },
      ],
    );
  }, [crew]);

  // The transport policy made visible (design §4): "we're together" fires
  // the exact share lane FriendsSection already runs for a card — framed as
  // a refresh, not a first meeting. exportMyCard carries the remembered
  // "just for them / pass it on" pick, so no re-ask here.

  // What one scan hands over (docs/WALKIE-LADDER.md §8, rung 0). The code is
  // the identity and travels alone if it must; everything else is a courtesy
  // that arrives EARLY rather than over the air minutes later — the pod's
  // name (field test #3) and the inviter's card (field test #5), plus the
  // radios bitmap so the ladder starts warm. PodQr drops the card by itself
  // if the whole thing overflows one QR; it never refuses the invite.
  const invite: PodInvite | null = useMemo(
    () =>
      crew
        ? {
            code: crew.code,
            ...(isPlaceholderPodName(crew) ? {} : { name: crew.name }),
            ...(me.name.trim().length > 0 ? { card: me } : {}),
            ...(rungs > 0 ? { radios: rungs } : {}),
          }
        : null,
    [crew, me, rungs],
  );

  // The link carrier, for a campmate who is NOT standing in front of you.
  // Same payload, https form so it has a web fallback.
  const shareInvite = useCallback(async () => {
    if (!invite) {
      return;
    }
    try {
      await Share.share(
        { title: 'Join my pod on Playa Pal', message: encodePodLink(invite) },
        { dialogTitle: 'Join my pod on Playa Pal' },
      );
    } catch {
      // Share sheet dismissed — nothing to clean up.
    }
  }, [invite]);

  const swapCards = useCallback(async () => {
    let message: string;
    try {
      message = exportMyCard(conn);
    } catch (e: any) {
      Alert.alert('Before you swap', e?.message ?? String(e));
      return;
    }
    try {
      await Share.share(
        { title: 'Playa Pal friend card', message },
        { dialogTitle: 'Playa Pal friend card' },
      );
    } catch {
      // Share sheet dismissed — nothing to clean up.
    }
  }, [conn]);

  // The roster is announced ∪ picked (podMembers.ts). Before announcements
  // this was picked-cards-only, which meant a podmate who joined by code —
  // beaconing, messaging, standing right there — could not produce a row on
  // anyone's phone. A picked id whose card was removed still has no row: the
  // card IS the data, and an announcement is what puts them back.
  // ...then folded, because a reinstall leaves its old announcement behind
  // on a mesh that has no retraction: the wiped phone mints a NEW card id,
  // so the roster correctly resolves two authors who both spell one name.
  // Seen in the field — two "Pug" rows and a "2 so far" count for one
  // person. The fold is a reading and says so on the row; it reverses itself
  // the moment the quiet phone is heard from again. Folding at THIS binding
  // is what fixes the duplicate row and the count in one place.
  // The self partition runs inside: the roster excludes ME before anyone
  // looks at it, so my own pre-reinstall identity reads as another person
  // — the one ghost the group fold can never claim. My name anchors it.
  const { people: members, selfGhosts } = foldPodRoster(
    crew ? podRoster(crew, friends, me.id) : [],
    Date.now(),
    me.name || null,
  );

  // My own anchor, for the live rows' "how far" — my card's address.
  const myAnchor =
    geo && me.address.length > 0 ? addressToLatLon(me.address, geo) : null;

  const renderMember = (m: PodPerson) => {
    const f = m.card;
    // Presence keys on the CARD ID, which is exactly what an announcement
    // carries — so a podmate with no card on this phone still goes live the
    // moment their beacon is heard.
    const p = presence(m.cardId);
    const where = f
      ? [f.address, f.camp].filter(s => s.length > 0).join(' — ') ||
        'address TBD'
      : 'no card on this phone yet';
    const parsed =
      geo && f && f.address.length > 0 ? addressToLatLon(f.address, geo) : null;
    // Presence coords win, and need no geometry — the pure-GPS floor.
    const target: WaypointTarget | null = p
      ? { label: m.name, lat: p.lat, lon: p.lon }
      : parsed
      ? { label: m.name, lat: parsed.lat, lon: parsed.lon }
      : null;
    const walk =
      !p && f && me.address.length > 0 && f.address.length > 0
        ? playaWalkMinutes(me.address, f.address)
        : null;
    let status: string;
    if (p) {
      const away = myAnchor
        ? `${formatDistanceFt(
            gpsVector(myAnchor.lat, myAnchor.lon, p.lat, p.lon).distanceFt,
          )} away`
        : null;
      const word = p.live ? 'live' : `seen ${agoPhrase(p.atMs) ?? 'a while ago'}`;
      status = away ? `${word} · ${away}` : word;
    } else if (f) {
      const confirmed = agoPhrase(f.updated_at);
      status = confirmed
        ? `last confirmed ${confirmed}`
        : 'not confirmed yet — swap cards when you meet';
    } else {
      // Announced only: their phone said hello over the mesh, and that is
      // ALL this phone knows. The age matters here in a way it doesn't for
      // a card — a nameplate keeps circulating for a week after someone
      // walks away, so an old one must look old rather than read as
      // current, and must not vanish either (only expiry removes a row).
      const said = m.announcedMin !== null
        ? agoPhrase(m.announcedMin * 60_000)
        : null;
      status = said
        ? `in the pod · said hello ${said}`
        : 'in the pod — swap cards to see where they are';
    }
    const stale =
      !p &&
      m.card === null &&
      m.announcedMin !== null &&
      epochMinutes(Date.now()) - m.announcedMin > MEMBER_STALE_MIN;
    return (
      <View key={m.cardId} style={styles.memberRow}>
        <Text style={styles.memberName}>{m.name}</Text>
        {target ? (
          <Pressable
            onPress={() => onOpenCompass(target)}
            accessibilityRole="button"
            accessibilityLabel={`Open the compass to ${m.name} — ${where}`}>
            <Text style={styles.whereLink}>
              🧭 {where}
              {walk !== null ? ` · ~${walk} min walk` : ''}
            </Text>
          </Pressable>
        ) : (
          <Text style={styles.where}>{where}</Text>
        )}
        <Text
          style={
            p && p.live ? styles.live : stale ? styles.stale : styles.confirmed
          }>
          {status}
        </Text>
        {m.quietNote ? (
          <Text style={styles.confirmed}>{m.quietNote}</Text>
        ) : null}
        <Pressable
          onPress={swapCards}
          accessibilityRole="button"
          accessibilityLabel="We're together — swap cards"
          style={styles.linkTap}>
          <Text style={styles.swap}>We're together — swap cards</Text>
        </Pressable>
      </View>
    );
  };

  return (
    <>
      {/* A group of hippos is a POD (owner-named, Aug 24) — the app's
          🦛 register, and it even dissolves the FriendScope 'crew' word
          collision. Internal module names stay crew/CrewBeacon; only the
          surface speaks hippo. */}
      <Text style={styles.sectionTitle} accessibilityRole="header">
        Pods
      </Text>
      <View style={styles.card}>
        {crews.length > 0 && !picking ? (
          <View style={styles.podChips}>
            {crews.map(c => (
              // Selection semantics said out loud (a11y review 2026-08-24):
              // a screen reader hears which pod is showing, not just a
              // color flip.
              <Pressable
                key={c.id}
                onPress={() => setActivePodId(c.id)}
                accessibilityRole="button"
                accessibilityLabel={podDisplayName(c)}
                accessibilityState={{ selected: crew?.id === c.id }}
                style={[styles.podChip, crew?.id === c.id && styles.podChipOn]}>
                <Text
                  style={[
                    styles.podChipText,
                    crew?.id === c.id && styles.podChipTextOn,
                  ]}>
                  {podDisplayName(c)}
                </Text>
              </Pressable>
            ))}
            {/* ONE action door (a11y+IA review 2026-08-24, DO-NOW #3):
                "+ New pod" and "Join with a code" used to sit in the row
                dressed as pods. Actions and selections no longer share a
                costume. */}
            <Pressable
              onPress={() => setAddOpen(o => !o)}
              accessibilityRole="button"
              accessibilityLabel="Add or join a pod"
              accessibilityState={{ expanded: addOpen }}
              style={styles.podChip}>
              <Text style={styles.podChipText}>Add or join…</Text>
            </Pressable>
          </View>
        ) : null}
        {addOpen && !picking && !joining && crews.length > 0 ? (
          <View style={styles.addRow}>
            <Pressable
              style={styles.addOption}
              accessibilityRole="button"
              onPress={() => {
                setAddOpen(false);
                openNewPod();
              }}>
              <Text style={styles.addOptionText}>New pod</Text>
            </Pressable>
            <Pressable
              style={styles.addOption}
              accessibilityRole="button"
              onPress={() => {
                setAddOpen(false);
                setJoining(true);
              }}>
              <Text style={styles.addOptionText}>Join with a code</Text>
            </Pressable>
          </View>
        ) : null}
        {joining ? (
          <View>
            <TextInput
              style={styles.input}
              placeholder={
                wordCode ? 'Pod code — the whole phrase' : 'Pod code — 4 digits'
              }
              placeholderTextColor={colors.faded}
              value={codeDraft}
              onChangeText={setCodeDraft}
              autoCapitalize="none"
              // Every code this app mints is now four digits, so the number
              // pad is the right keyboard — but the older word phrases still
              // join (crew.ts), and someone holding one written down needs
              // letters. The link below switches the field rather than
              // making everyone type digits on a full keyboard.
              keyboardType={wordCode ? 'default' : 'number-pad'}
              returnKeyType="done"
              onSubmitEditing={doJoin}
            />
            <Pressable
              style={styles.primaryBtn}
              onPress={doJoin}
              accessibilityRole="button"
              accessibilityLabel="Join pod">
              <Text style={styles.primaryBtnText}>Join pod</Text>
            </Pressable>
            {wordCode ? null : (
              <Pressable
                onPress={() => setWordCode(true)}
                accessibilityRole="button"
                accessibilityLabel="Enter an older word code with letters"
                style={styles.linkTap}>
                <Text style={styles.disband}>
                  Older code with words? Tap for letters
                </Text>
              </Pressable>
            )}
            <Pressable
              onPress={() => setJoining(false)}
              accessibilityRole="button"
              accessibilityLabel="Cancel joining"
              style={styles.linkTap}>
              <Text style={styles.disband}>Cancel</Text>
            </Pressable>
          </View>
        ) : null}
        {picking ? (
          <View>
            <TextInput
              style={styles.input}
              placeholder="Pod name"
              placeholderTextColor={colors.faded}
              value={nameDraft}
              onChangeText={setNameDraft}
            />
            {friends.length === 0 ? (
              <Text style={styles.empty}>
                No friend cards on this phone yet — collect one in "Friends on
                playa" below, then pick your pod.
              </Text>
            ) : (
              friends.map(f => {
                const on = picked.includes(f.id);
                return (
                  // A member pick is a checkbox in behavior — say so, with
                  // the checked state (a11y review 2026-08-24: the ☑ glyph
                  // alone is a color-and-shape secret).
                  <Pressable
                    key={f.id}
                    style={styles.pickRow}
                    accessibilityRole="checkbox"
                    accessibilityLabel={
                      f.camp.length > 0 ? `${f.name}, ${f.camp}` : f.name
                    }
                    accessibilityState={{ checked: on }}
                    onPress={() => togglePick(f.id)}>
                    <Text style={[styles.pickMark, on && styles.pickMarkOn]}>
                      {on ? '☑' : '☐'}
                    </Text>
                    <Text style={styles.pickName}>{f.name}</Text>
                    {f.camp.length > 0 ? (
                      <Text style={styles.pickCamp}> · {f.camp}</Text>
                    ) : null}
                  </Pressable>
                );
              })
            )}
            <Pressable
              style={styles.primaryBtn}
              onPress={savePicker}
              accessibilityRole="button"
              accessibilityLabel="Save pod">
              <Text style={styles.primaryBtnText}>Save pod</Text>
            </Pressable>
            {crew ? (
              <Pressable
                onPress={disband}
                accessibilityRole="button"
                accessibilityLabel="Disband this pod"
                style={styles.linkTap}>
                <Text style={styles.disband}>Disband pod</Text>
              </Pressable>
            ) : null}
          </View>
        ) : crew ? (
          <View>
            <View style={styles.headerRow}>
              {/* A placeholder is styled as the CODE it is, not as a name a
                  human chose — the reader can tell at a glance that this
                  pod's name has not arrived yet. */}
              <Text
                style={[
                  styles.crewName,
                  isPlaceholderPodName(crew) && styles.crewNamePlaceholder,
                ]}>
                {podDisplayName(crew)}
              </Text>
              {/* "SO FAR", never a total (the "Dust Bunnies — 0 people"
                  lesson): membership lives in the gossiped log, so this
                  phone can only ever report what has reached it. Rendering
                  the local pick list as the pod's size is exactly the bug
                  that showed 0 while three podmates were beaconing. */}
              <Text
                style={styles.crewCount}
                accessibilityLabel={
                  members.length > 0
                    ? `${members.length} so far — what this phone has heard, not a total`
                    : selfGhosts.length > 0
                      ? 'Only this phone so far — an older identity of it was heard, nobody else'
                      : 'Nobody yet — this pod fills in as phones meet'
                }>
                {members.length > 0
                  ? `${members.length} so far`
                  : // With a claimed past, "nobody yet" beside a footer
                    // explaining what WAS heard is two lines disagreeing
                    // about whether the air was silent (review, round 3).
                    // Everything heard traces to this phone, so say that.
                    selfGhosts.length > 0
                    ? 'only this phone so far'
                    : 'nobody yet'}
              </Text>
              <Pressable
                onPress={openPicker}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`Edit ${podLabel(crew)}`}>
                <Text style={styles.editLink}>Edit</Text>
              </Pressable>
            </View>
            {isPlaceholderPodName(crew) ? (
              <Text style={styles.empty}>
                No name yet — it arrives with the first podmate's phone.
              </Text>
            ) : null}
            <View style={styles.codeRow}>
              <Text style={styles.codeLabel}>Share code</Text>
              <Text style={styles.code}>{crew.code}</Text>
            </View>
            <Text style={styles.codeHint}>
              Campmates join with this code — same code, same pod. Anyone who
              has it sees the pod's names, and where the people sharing are.
              Hand it around like a note, not a password.
            </Text>
            {/* RUNG 0 (docs/WALKIE-LADDER.md §8). The friend card and the camp
                beam have had a QR and a link since August; a pod had four
                typed digits, which made it the only shareable thing in the
                app you could not hand over by pointing a camera at a screen.
                A scan also carries the pod's NAME and the inviter's CARD, so
                the joiner skips both "electric-flamingo-54" and "someone in
                the pod". No radio involved — this works with Bluetooth off,
                Wi-Fi off and no signal. */}
            {invite ? (
              <View style={styles.inviteRow}>
                <Pressable
                  onPress={() => setQrOpen(o => !o)}
                  accessibilityRole="button"
                  accessibilityLabel={
                    qrOpen ? 'Hide the join QR' : 'Show a QR for joining this pod'
                  }
                  accessibilityState={{ expanded: qrOpen }}
                  style={styles.inviteBtn}>
                  <Text style={styles.inviteBtnText}>
                    {qrOpen ? 'Hide QR' : 'Show QR'}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={shareInvite}
                  accessibilityRole="button"
                  accessibilityLabel="Send a join link for this pod"
                  style={styles.inviteBtn}>
                  <Text style={styles.inviteBtnText}>Send a link</Text>
                </Pressable>
              </View>
            ) : null}
            {invite && qrOpen ? (
              <View style={styles.qrWrap}>
                <PodQr invite={invite} />
              </View>
            ) : null}
            {myNameMissing ? (
              // Identity has to be automatic (owner, Aug 24) — and it is,
              // EXCEPT that a card with no name has nothing to announce.
              // This is the one-tap way back into setup, said as the
              // concrete thing it is.
              <View style={styles.nameFix}>
                <Text style={styles.nameFixTitle}>
                  Your pod can't see who you are yet.
                </Text>
                <Text style={styles.shareHint}>
                  Your card's name is what travels — it's how podmates know
                  who's nearby and who left a message.
                </Text>
                {nameFixOpen ? (
                  <>
                    <TextInput
                      style={styles.input}
                      placeholder="Your playa name"
                      placeholderTextColor={colors.faded}
                      value={myNameDraft}
                      onChangeText={setMyNameDraft}
                      returnKeyType="done"
                      onSubmitEditing={saveMyName}
                    />
                    <Pressable
                      style={styles.primaryBtn}
                      onPress={saveMyName}
                      accessibilityRole="button"
                      accessibilityLabel="Save my name">
                      <Text style={styles.primaryBtnText}>Save my name</Text>
                    </Pressable>
                  </>
                ) : (
                  <Pressable
                    style={styles.primaryBtn}
                    onPress={() => setNameFixOpen(true)}
                    accessibilityRole="button"
                    accessibilityLabel="Add my name">
                    <Text style={styles.primaryBtnText}>Add my name</Text>
                  </Pressable>
                )}
              </View>
            ) : null}
            {radioOk ? (
              <View style={styles.shareRow}>
                <View style={styles.shareBody}>
                  <Text style={styles.shareTitle}>
                    Share my position with {podLabel(crew)}
                  </Text>
                  {(() => {
                    // RADIO TRUTH. The switch reflects INTENT — that sharing
                    // is turned on — and intent is not carriage. When the
                    // adapter is off, the grant is gone, or the radio refused
                    // the advertisement, this pod sees NOTHING, and the copy
                    // below promised the opposite: "your pod sees which way
                    // and how far".
                    //
                    // A worker that died silently must never render as
                    // in-progress. This surface was inferring "carrying" from
                    // the ABSENCE of a stop, and absence has two causes.
                    // session.ts had the state machine, the reasons and the
                    // tests; it had no reader, so the only honest surface in
                    // the app was the foreground-service notification.
                    //
                    // Each reason gets its OWN route back, because they are
                    // not the same problem: bluetooth-off and
                    // advertise-failed recover on their own and the user
                    // should be told to wait, while 'permission' can NEVER
                    // self-heal and needs them to act.
                    // THE DEATH THE SWITCH CANNOT REPORT. A session lives
                    // in process memory and native state; a restart — the
                    // appearance toggle, Android reclaiming memory, a
                    // force-stop — takes it whole, and the switch simply
                    // renders off with nothing anywhere saying sharing HAD
                    // been on. Measured three times in one evening. The
                    // persisted intent (share.ts) outlives the process, so
                    // this row can say what happened; the switch beside it
                    // is the one-tap resume, and flipping it either way
                    // resolves the intent honestly.
                    if (sharingDiedWithProcess(crew.id)) {
                      return (
                        <Text
                          style={styles.sharePaused}
                          accessibilityLiveRegion="polite">
                          Sharing was on when the app last closed — it does
                          not survive a restart. Flip it back on and your pod
                          sees you again.
                        </Text>
                      );
                    }
                    const down = radioInterrupted();
                    if (!down) {
                      return (
                        <Text style={styles.shareHint}>
                          Only while this is on — your pod sees which way and
                          how far. Bluetooth, never the internet. iPhones
                          share while the app is open.
                        </Text>
                      );
                    }
                    return (
                      <Text
                        style={styles.sharePaused}
                        accessibilityLiveRegion="polite">
                        {PAUSED_COPY[down.why]}
                      </Text>
                    );
                  })()}
                </View>
                {/* The Switch names ITS OWN setting (a11y review
                    2026-08-24): an unlabeled switch reads as "switch,
                    off" — this one says what turns on. */}
                <Switch
                  value={sharingCrewId() === crew.id}
                  onValueChange={on => toggleShare(on, crew)}
                  accessibilityLabel={`Share my position with ${podLabel(crew)}`}
                  accessibilityState={{
                    checked: sharingCrewId() === crew.id,
                  }}
                  trackColor={{ true: colors.sage, false: colors.haze }}
                />
              </View>
            ) : null}
            {members.length === 0 ? (
              // The old copy ("tap Edit to choose your people") was written
              // for the pod you START, and it was a dead end for the joiner
              // it actually greeted: someone fresh off a join code has no
              // cards to choose from. Say what is really true — nobody's
              // phone has said hello yet — and only point at Edit when
              // there are cards on this phone to point at.
              //
              // Suppressed when the self anchor claimed rows: "nobody's
              // phone has said hello" directly above "an older phone here
              // went by your name" is two sentences contradicting each
              // other about whether anything was heard (review, round 2).
              // The footer below carries the whole story in that state.
              selfGhosts.length === 0 ? (
                <Text style={styles.empty}>
                  {friends.length === 0
                    ? "Nobody's phone has said hello yet. Podmates fill in here when one passes in range."
                    : 'Nobody here yet — tap Edit to add people whose cards you hold, or wait for a podmate to pass in range.'}
                </Text>
              ) : null
            ) : (
              members.map(renderMember)
            )}
            {selfGhosts.length > 0 ? (
              // A claimed past has no row to carry its note, so the note
              // stands under the roster — the same honesty contract as a
              // row's quietNote: the reading, then the recourse.
              <Text style={styles.empty}>
                {selfGhostNote(me.name, selfGhosts.length)}
              </Text>
            ) : null}
            {/* The pod's three verbs share one card: FIND (the rows above),
                MESSAGE (the strip), TALK (the walkie) — §6c's one-noun
                frame. */}
            {/* key={crew.id}: switching pods REMOUNTS both strips, so the
                walkie channel closes (its unmount cleanup) and the thread,
                composer draft and unread state can never bleed across pods
                (composed review, Aug 24). */}
            <PodMessages key={crew.id} crew={crew} />
            <WalkiePanel
              key={`w-${crew.id}`}
              crewCode={crew.code}
              myCardId={me.id}
              myName={me.name}
            />
            <Text style={styles.hint}>
              Where people said they'd be, as of their last card — not a live
              feed. Swap cards when you're together to freshen a row.
            </Text>
          </View>
        ) : (
          <View>
            <Text style={styles.copy}>
              Your pod is the people whose phones stay in touch — for a
              night, a day, or the whole camp all week. One glance: which
              way, how far.
            </Text>
            <Pressable
              style={styles.primaryBtn}
              onPress={openPicker}
              accessibilityRole="button"
              accessibilityLabel="Start a pod">
              <Text style={styles.primaryBtnText}>Start a pod</Text>
            </Pressable>
            <Pressable
              onPress={() => setJoining(true)}
              accessibilityRole="button"
              accessibilityLabel="Join a pod with a code"
              style={styles.linkTap}>
              <Text style={styles.disband}>Have a code? Join a pod</Text>
            </Pressable>
          </View>
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  sectionTitle: {
    color: colors.night,
    fontSize: type.title,
    fontWeight: '800',
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  card: {
    backgroundColor: colors.sand,
    borderRadius: radius.card,
    padding: spacing.md,
  },
  copy: { color: colors.faded, fontSize: type.small },
  primaryBtn: {
    // ...tap: the 44pt floor (a11y review 2026-08-24) — padding alone left
    // this under 40pt.
    ...tap,
    backgroundColor: colors.clay,
    borderRadius: radius.card,
    justifyContent: 'center',
    marginTop: spacing.sm,
    paddingVertical: spacing.sm,
  },
  primaryBtnText: {
    color: colors.onAccent, // scheme-aware ink on the clay fill (a11y review)
    fontSize: type.body,
    fontWeight: '700',
    textAlign: 'center',
  },
  // Text links (Cancel / Disband / swap) keep their quiet look but gain the
  // 44pt touch floor (a11y review 2026-08-24).
  linkTap: { justifyContent: 'center', minHeight: tap.minHeight },
  // The Add-or-join door's two options — plain small buttons, clearly not
  // pods (a11y+IA review 2026-08-24, DO-NOW #3).
  addRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  addOption: {
    ...tap,
    alignItems: 'center',
    borderColor: colors.haze,
    borderRadius: radius.card,
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  addOptionText: { color: colors.night, fontSize: type.small, fontWeight: '700' },
  input: {
    // field, not cream: cream stays light in dark mode (text-on-accent),
    // a field surface must follow the ground (dark-mode sweep)
    backgroundColor: colors.field,
    borderRadius: radius.card,
    color: colors.night,
    fontSize: type.body,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  pickRow: {
    alignItems: 'center',
    flexDirection: 'row',
    minHeight: tap.minHeight, // 44pt row floor (a11y review 2026-08-24)
    paddingVertical: spacing.xs,
  },
  pickMark: { color: colors.faded, fontSize: type.body, width: 28 },
  pickMarkOn: { color: colors.clay },
  pickName: { color: colors.night, fontSize: type.body, fontWeight: '700' },
  pickCamp: { color: colors.faded, fontSize: type.small },
  empty: {
    color: colors.faded,
    fontSize: type.small,
    fontStyle: 'italic',
    marginVertical: spacing.sm,
  },
  disband: {
    color: colors.clay,
    fontSize: type.small,
    marginTop: spacing.md,
    textAlign: 'center',
  },
  headerRow: { alignItems: 'baseline', flexDirection: 'row', gap: spacing.sm },
  crewName: { color: colors.night, fontSize: type.body, fontWeight: '800' },
  // A code standing in for a name reads as a code: quieter, spaced, not the
  // confident weight of something a person chose.
  crewNamePlaceholder: {
    color: colors.faded,
    fontWeight: '600',
    letterSpacing: 1,
  },
  crewCount: { color: colors.faded, flex: 1, fontSize: type.small },
  editLink: { color: colors.clay, fontSize: type.small, fontWeight: '700' },
  codeRow: {
    alignItems: 'baseline',
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  codeLabel: { color: colors.faded, fontSize: type.small },
  code: { color: colors.night, fontSize: type.small, fontWeight: '700' },
  codeHint: { color: colors.faded, fontSize: type.tiny, marginTop: 2 },
  // Status gold, not the faded metadata grey: a paused share is something
  // the camper must be able to SEE, not something they discover later.
  sharePaused: { color: colors.gold, fontSize: type.small, marginTop: 2 },
  inviteRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  // Secondary weight on purpose: the code line above is still the primary
  // way in, and a pod card already has a primary control.
  inviteBtn: {
    alignItems: 'center',
    borderColor: colors.clay,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    minHeight: tap.minHeight,
    paddingHorizontal: spacing.lg,
  },
  inviteBtnText: { color: colors.clay, fontSize: type.small, fontWeight: '700' },
  qrWrap: { alignItems: 'center', marginTop: spacing.md },
  podChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  podChip: {
    ...tap, // 44pt chip floor (a11y review 2026-08-24)
    alignItems: 'center',
    backgroundColor: colors.dust,
    borderColor: colors.haze,
    borderRadius: radius.chip,
    borderWidth: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  podChipOn: { backgroundColor: colors.clay, borderColor: colors.clay },
  podChipText: { color: colors.night, fontSize: type.small, fontWeight: '700' },
  podChipTextOn: { color: colors.onAccent }, // scheme-aware ink on clay
  shareRow: {
    alignItems: 'center',
    borderTopColor: colors.haze,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    marginTop: spacing.md,
    paddingTop: spacing.md,
  },
  shareBody: { flex: 1, marginRight: spacing.md },
  shareTitle: { color: colors.night, fontSize: type.body, fontWeight: '700' },
  // The missing-name repair sits between the code and the roster, where a
  // nameless card is about to cost the user something.
  nameFix: {
    borderTopColor: colors.haze,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.md,
    paddingTop: spacing.md,
  },
  nameFixTitle: { color: colors.night, fontSize: type.body, fontWeight: '700' },
  shareHint: { color: colors.faded, fontSize: type.tiny, marginTop: 2 },
  memberRow: {
    borderTopColor: colors.haze,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.md,
    paddingTop: spacing.md,
  },
  memberName: { color: colors.night, fontSize: type.body, fontWeight: '700' },
  whereLink: {
    color: colors.clay,
    fontSize: type.small,
    fontWeight: '700',
    marginTop: 2,
  },
  where: { color: colors.faded, fontSize: type.small, marginTop: 2 },
  live: {
    color: colors.gold,
    fontSize: type.small,
    fontWeight: '700',
    marginTop: 2,
  },
  confirmed: { color: colors.faded, fontSize: type.small, marginTop: 2 },
  // A nameplate nobody has refreshed in half a day: still here (only expiry
  // removes a member), visibly a memory rather than a presence.
  stale: {
    color: colors.faded,
    fontSize: type.small,
    fontStyle: 'italic',
    marginTop: 2,
    opacity: 0.7,
  },
  swap: { color: colors.clay, fontSize: type.small, marginTop: spacing.xs },
  hint: { color: colors.faded, fontSize: type.small, marginTop: spacing.md },
});
