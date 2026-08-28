/**
 * Settings — Spoken Replies (master toggle, voice picker, rate slider, the
 * Android offline-voice-data nudge) plus the Field log share row: the
 * on-device conversation log exported session-grouped through the system
 * share sheet. The log never leaves the device any other way. Plus the
 * "Share the app" row: Playa Pal handing ITSELF to a phone that has none
 * (docs/FINAL-WEEK.md "Lane D") — which now lives in ./ShareAppRow.tsx and
 * mounts here AND on the Camp tab's "Share & receive" section (sharing
 * audit, docs/SHARING-SURFACES.md §3.2: two instincts, one implementation).
 */

import React, {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  Alert,
  Linking,
  NativeModules,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  View,
} from 'react-native';
import { Text } from '../components/Text';
// THE TUFTE PASS (owner ask 2026-08-26): "a paragraph of explanation, just
// sitting in tiny print in the main screen … put it behind a question mark
// with a circle around it". Settings is the first screen converted — the
// standalone teaching paragraphs only. Row descriptions under a tappable
// row still read inline here on purpose: a ? inside a Pressable row is a
// nested responder, and nothing on a device has proven that behaves yet.
import { InfoTap } from '../components/InfoTap';
import {
  chatLogStats,
  exportChatLogJson,
  exportQueryLogJson,
  type ChatLogStats,
} from '../log/chatLog';
import {
  getSetting,
  listHidden,
  listPacks,
  unhideItem,
  type HiddenItem,
} from '../events/db';
import { PackRowCard } from './packRows';
import { HelpScreen } from './HelpScreen';
import { PackReader } from './PackReader';
import { version as APP_VERSION } from '../../package.json';

// Lane D lives in its own file now (sharing audit, docs/SHARING-SURFACES.md
// §3.2): handing the app to a phone that has none is the ONLY path that
// reaches someone without Playa Pal, so it also mounts on the Camp tab's
// "Share & receive" section. ONE component, two mount points — the native
// call, the progress wiring and the field-bought copy exist exactly once.
import { ShareAppRow } from './ShareAppRow';
// "Update to latest" (owner ask 2026-08-26). Its sibling above hands the
// app to a phone that has none; this one hands a NEWER copy to a phone
// that already has an old one. Sideloaded installs have no update channel
// at all — Obtainium is the proper answer and nobody sets Obtainium up on
// playa — so the app carries the modest version itself, in the one place a
// camper already goes to read which version they are running.
import { UpdateRow } from './UpdateRow';
import type { PackRow } from '../types';
import { exists as fsExists } from '@dr.pogodin/react-native-fs';
import {
  CATALOG,
  fitEntry,
  localPath,
  readCircumstances,
  recommendedEntry,
  watchLiveDownload,
  type CatalogEntry,
  type Circumstances,
  type EntryFit,
  type LiveDownload,
} from '../llm/modelCatalog';
import {
  getSpeechBackend,
  listSpeechBackends,
  loadSpeechSettings,
  saveSpeechSettings,
  RATE_MAX,
  RATE_MIN,
  RATE_STEP,
  type SpeechReadiness,
  type SpeechSettings,
  type SpeechVoice,
} from '../speech';
import { AngelRestCard } from '../components/AngelRestCard';
import type { AngelPosture } from '../llm/angelRest';
import { RateSlider } from '../components/RateSlider';
import {
  radioInterrupted,
  sessionRevision,
  subscribeSessionChanged,
} from '../crews/session';
import { sharingCrewId, stopCrewSharing } from '../crews/share';
import {
  openNotificationSettings,
  pocketAlertsChoice,
  pocketAlertsPresent,
  reAskPocketAlerts,
} from '../crews/pocketAlerts';
import {
  appearancePref,
  colors,
  nextTextScale,
  radius,
  requestThemeReload,
  setAppearancePref,
  setTextScale,
  spacing,
  tap,
  TEXT_SCALES,
  textScale,
  textScaleLabel,
  themeReloadAvailable,
  type,
} from '../theme';
import type { Appearance as AppearancePref } from '../theme';

const SAMPLE_TEXT =
  'Sunrise yoga, Tuesday, 6 AM, at 7:30 and Esplanade. Bring water, dusty friend.';

const NETWORK_BADGE: Record<SpeechVoice['network'], string | null> = {
  offline: 'offline',
  network: 'needs internet',
  unknown: 'offline unverified',
};

export interface SettingsScreenProps {
  /** The app's ONE model chooser (the same Alert flow the chat header
   * uses). Optional so the screen renders standalone in tests. */
  onChooseModel?: () => void;
  /** Re-opens the feature tour at the app root, above every tab (0.7.3 —
   * a tour is a durable help artifact, never a one-shot modal). Optional
   * so the screen renders standalone in tests. */
  onReplayTour?: () => void;
  /** Re-runs first-run setup (name + home camp) at the app root. A replay
   * never erases earlier answers; skipped steps keep what they had. */
  onReplaySetup?: () => void;
  /** Whether the Angel wakes with the app on this phone (llm/angelRest.ts).
   * The chat surface asks the question warmly when she is resting; THIS is
   * where the answer lives afterwards — including the way back for a camper
   * who woke her, and the way out for a big phone that wants the room. */
  angel?: AngelPosture | null;
  angelBusy?: boolean;
  onAngelChange?: (awake: boolean) => void;
}

interface ModelRowState {
  entry: CatalogEntry;
  downloaded: boolean;
  active: boolean;
  fit: EntryFit;
  recommended: boolean;
}

export function SettingsScreen({
  onChooseModel,
  onReplayTour,
  onReplaySetup,
  angel = null,
  angelBusy = false,
  onAngelChange,
}: SettingsScreenProps = {}) {
  const [settings, setSettings] = useState<SpeechSettings>(() =>
    loadSpeechSettings(),
  );
  // The in-flight pull, straight off the download path's byte callback: a
  // download started from the chooser outlives any screen, and a 5 GB pull
  // with no row movement reads as a hung app (Pixel 7, 2026-08-19 — the
  // only signal was the header dot).
  const [liveDownload, setLiveDownload] = useState<LiveDownload | null>(null);
  useEffect(() => watchLiveDownload(setLiveDownload), []);
  // The model roster with this phone's measured truth: what is installed,
  // what is recommended, what fits, what needs space or memory. Read on
  // mount — Settings is re-mounted on every tab visit, so the numbers stay
  // honest without a listener — and again on download phase edges, so a
  // pull finishing under an open screen flips its row to downloaded/active.
  // Deps carry the PHASE, not the ticks: per-tick deps would sweep the
  // filesystem twice a second.
  const [circ, setCirc] = useState<Circumstances | null>(null);
  const [modelRows, setModelRows] = useState<ModelRowState[]>([]);
  const livePhase = liveDownload === null ? null : liveDownload.phase;
  useEffect(() => {
    let alive = true;
    (async () => {
      const c = await readCircumstances();
      const activePath = getSetting('model_path');
      const downloaded = new Set<string>();
      for (const e of CATALOG) {
        if (await fsExists(localPath(e))) {
          downloaded.add(e.id);
        }
      }
      const rec = recommendedEntry(c, downloaded);
      const rows = CATALOG.map(e => ({
        entry: e,
        downloaded: downloaded.has(e.id),
        active: activePath === localPath(e),
        fit: fitEntry(e, c, downloaded.has(e.id)),
        recommended: e.id === rec.id,
      }));
      if (alive) {
        setCirc(c);
        setModelRows(rows);
      }
    })();
    return () => {
      alive = false;
    };
  }, [livePhase]);
  const [voices, setVoices] = useState<SpeechVoice[]>([]);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<SpeechReadiness | null>(null);
  const [logStats, setLogStats] = useState<ChatLogStats | null>(null);
  // Read once on mount: sync, and null-safe when the db isn't open yet
  // (tryDb inside chatLogStats). Without this the storage line under Chat
  // History rendered nothing, forever — the import and state existed but
  // nothing connected them (public-QA lint catch, 2026-08-19).
  useEffect(() => {
    setLogStats(chatLogStats());
  }, []);
  // Hidden: the UNDO side of "Don't use this" -- people, events and passages
  // in one list. Read fresh on mount and after each restore, so the list
  // never shows something that has already come back.
  // Public packs (Option A consolidation): the retired Packs tab's public
  // half lives here — collapsed by default, low in the page. Camp and
  // private packs live on the Camp tab; import stays there too.
  const [packs, setPacks] = useState<PackRow[]>(() => listPacks());
  // FOUR collapsible groups (a11y+IA review 2026-08-24, DO-NOW #8: Settings
  // had grown from 9 to 13 peer sections — a flat list nobody could scan).
  // Angel & voice · Offline content · Privacy & data · Help & about, in that
  // order, each behind the Public-packs collapsible header pattern. Nothing
  // persists; every group re-decides at mount. The one open-by-default is
  // the group holding an ACTIVE state — speech enabled means someone is
  // mid-relationship with their voice settings and should land inside them.
  const [angelOpen, setAngelOpen] = useState(() => settings.enabled);
  const [offlineOpen, setOfflineOpen] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // The offline reader (owner commission 2026-08-19): 'Read' on a pack row
  // swaps the whole screen for the reader — the LineageScreen pattern, one
  // piece of state, no navigator.
  const [readingPack, setReadingPack] = useState<PackRow | null>(null);
  // In-app Help (owner ask 2026-08-25) rides that same one-piece-of-state
  // pattern: the row lives in "Help & about", the screen replaces Settings
  // whole, and hardware back returns here.
  const [helpScreen, setHelpScreen] = useState(false);
  const refreshPacks = useCallback(() => setPacks(listPacks()), []);
  const publicPacks = packs.filter(p => p.builtin);
  const [hidden, setHidden] = useState<HiddenItem[]>([]);
  const refreshHidden = useCallback(() => {
    try {
      setHidden(listHidden());
    } catch {
      setHidden([]);
    }
  }, []);
  useEffect(() => {
    refreshHidden();
  }, [refreshHidden]);
  const restore = useCallback(
    (h: HiddenItem) => {
      try {
        unhideItem(h.kind, h.key);
      } catch (e: any) {
        Alert.alert("Couldn't bring that back", e?.message ?? String(e));
      }
      refreshHidden();
    },
    [refreshHidden],
  );

  const shareLog = useCallback(async () => {
    try {
      await Share.share(
        { title: 'Playa Pal conversation log', message: exportChatLogJson() },
        { dialogTitle: 'Share conversation log' },
      );
    } catch {
      // Share sheet dismissed or unavailable — nothing to clean up.
    }
  }, []);

  // The QUERY log: what was asked, routed where, and what came back empty --
  // the compact thing to pull off the phone after the burn, and the frequency
  // data the next datagen never had. Same share sheet, different shape.
  const shareQueries = useCallback(async () => {
    try {
      await Share.share(
        { title: 'Playa Pal question log', message: exportQueryLogJson() },
        { dialogTitle: 'Share question log' },
      );
    } catch {
      // Share sheet dismissed or unavailable — nothing to clean up.
    }
  }, []);

  const backend = getSpeechBackend(settings.backendId);

  const update = useCallback((patch: Partial<SpeechSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...patch };
      saveSpeechSettings(next);
      return next;
    });
  }, []);

  // Voice list + readiness re-check whenever speech is on / voice changes.
  useEffect(() => {
    if (!settings.enabled) {
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const list = await backend.voices();
        if (!cancelled) {
          setVoices(list);
          setVoicesError(null);
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setVoicesError(e instanceof Error ? e.message : String(e));
        }
      }
      try {
        const ready = await backend.readiness(settings.voiceId);
        if (!cancelled) {
          setReadiness(ready);
        }
      } catch {
        if (!cancelled) {
          setReadiness(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settings.enabled, settings.voiceId, backend]);

  // Leaving the screen stops any sample playback.
  useEffect(() => {
    return () => {
      backend.stop().catch(() => {});
    };
  }, [backend]);

  const speakSample = useCallback(
    (voiceId: string | null, rate: number) => {
      backend
        .speak(SAMPLE_TEXT, { voiceId, rate })
        .catch(() => {});
    },
    [backend],
  );

  const pickVoice = useCallback(
    (voiceId: string | null) => {
      update({ voiceId });
      speakSample(voiceId, settings.rate);
    },
    [update, speakSample, settings.rate],
  );

  const englishVoices = voices.filter(v =>
    v.language.toLowerCase().startsWith('en'),
  );
  const shownVoices = englishVoices.length > 0 ? englishVoices : voices;

  const gb = (n: number) => (n / 1e9).toFixed(1);
  const phoneLine = circ
    ? [
        circ.totalRamBytes !== undefined ? `${gb(circ.totalRamBytes)} GB memory` : null,
        circ.freeBytes !== undefined ? `${gb(circ.freeBytes)} GB free` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;

  // Crew sharing's master off-switch (design §2/§5): distinct from the
  // per-crew toggle, visible at the TOP of Settings whenever any session is
  // live — the kill switch must be the easiest thing in the app to find.
  useSyncExternalStore(subscribeSessionChanged, sessionRevision);
  // A SESSION IS NO LONGER A SHARE (mailbox decoupling, 2026-08-25): the app
  // holds one whenever it is open with a pod, carrying mail with no position
  // in it. Asking sessionActive() here would put "Sharing is ON right now —
  // your pod can see your position" at the top of Settings for a camper who
  // has shared nothing, which is the exact class of lie this row exists to
  // prevent. The question is whether a POSITION is on the air.
  const crewSharingOn = sharingCrewId() !== null;

  // Pocket alerts (src/crews/pocketAlerts.ts): the buzz for pod mail,
  // mentions and calls is asked in context when a pod feature first arms,
  // and a decline is permanently respected there — THIS row is the one
  // deliberate way back. Read once at mount (Settings re-mounts per tab
  // visit, the model roster's own pattern) and re-read after the tap.
  const [alertsChoice, setAlertsChoice] = useState<'' | 'granted' | 'denied'>(
    () => pocketAlertsChoice(),
  );

  /**
   * ONE ROW, TWO DOORS, and which one opens is decided by the state the
   * row is already describing (owner ask, 2026-08-26: "on by default,
   * granular disable/modify? maybe should happen in OS permissions menus
   * linked from app instead to be more elegant").
   *
   *  - Not granted → ASK. The app's own in-context ask is the only thing
   *    that can actually turn buzzing on, so it goes first.
   *  - Granted → the OS's notification page, where every type this app
   *    posts (mentions, pod messages, voice notes, calls) has its own
   *    switch, sound and importance. The app keeps no copies of those.
   *  - Asked and refused → the OS page too. This is the case the old copy
   *    could only DESCRIBE ("allow notifications for Playa Pal in system
   *    settings"): once Android's two-strike rule or iOS's ask-once has
   *    swallowed the dialog, the ask returns false instantly and a camper
   *    who taps a row about notifications must not be left holding a
   *    sentence. The tap takes them to the switch instead.
   */
  const openAlerts = useCallback(async () => {
    if (!pocketAlertsPresent()) {
      // Nothing to ask for and no page worth opening — the row says so.
      return;
    }
    if (alertsChoice === 'granted') {
      await openNotificationSettings();
      return;
    }
    const granted = await reAskPocketAlerts();
    setAlertsChoice(granted ? 'granted' : 'denied');
    if (!granted) {
      await openNotificationSettings();
    }
  }, [alertsChoice]);

  // The microphone check runs for about eight seconds and shows NOTHING
  // until it finishes — a row that looks untapped for eight seconds gets
  // tapped again, which is how two sweeps end up sharing one AVAudioSession
  // and one file (the native side now refuses the second one outright; this
  // is so the camper never has to be refused). The row says what it is
  // doing and stops taking taps while it does it.
  const [micChecking, setMicChecking] = useState(false);

  // Appearance (owner ruling 2026-08-24). Picking a mode writes the
  // preference and flips the palette in memory at once — but every mounted
  // screen froze its colors at import time (the boot-order note in
  // src/theme.ts), so the honest full flip is a JS reload through the
  // ThemeReload native module. In a build without that module the picked
  // row says plainly that the change lands next launch: a delayed truth
  // beats a half-themed screen.
  const [appearance, setAppearance] = useState<AppearancePref>(() =>
    appearancePref(),
  );
  const [appearanceNextLaunch, setAppearanceNextLaunch] = useState(false);
  const pickAppearance = useCallback(
    async (pref: AppearancePref) => {
      // Tapping the mode that is already on used to restart the app for
      // nothing. That was merely wasteful until the restart was measured to
      // also end a live sharing session (field sweep X2) — a no-op tap must
      // not cost a camper their radio.
      if (pref === appearance) {
        return;
      }
      setAppearance(pref);
      setAppearancePref(pref);
      const reloaded = await requestThemeReload();
      if (!reloaded) {
        setAppearanceNextLaunch(true);
      }
    },
    [appearance],
  );

  /**
   * SAY IT BEFORE THE TAP, because there is no after (field sweep X2).
   *
   * A mode change is a JS reload, and the reload takes the whole JS context
   * with it: the sharing session is one object in one module variable
   * (src/crews/session.ts) and the native side stops the radio and the
   * foreground service on the way out (CrewBeaconModule.invalidate()). So
   * the camper comes back to an unchecked switch and a pod that cannot see
   * them, and nothing anywhere said so — the reload's promise resolves and
   * THEN the context dies, so no toast written after the tap would survive
   * to be read.
   *
   * Both halves of the condition are load-bearing. With no session there is
   * nothing to lose, and on a build with no ThemeReload module nothing
   * restarts at all — warning in either case would be the same defect
   * pointed the other way.
   */
  // Text size (owner ask 2026-08-26). Local state only mirrors the live
  // scale so this row can name the rung and grey out its ends; the
  // repaint itself needs nothing from here, because every Text in the app
  // — including the ones on this screen — reads the scale at render
  // (src/components/Text.tsx). Nothing restarts, which is why this row
  // sits under the mode rows rather than among them.
  const [size, setSize] = useState<number>(() => textScale());
  const stepSize = useCallback(
    (delta: number) => {
      const next = nextTextScale(size, delta);
      if (next === size) {
        return; // already at the floor or the ceiling
      }
      setSize(next);
      setTextScale(next);
    },
    [size],
  );

  const appearanceEndsSharing = crewSharingOn && themeReloadAvailable();
  // SPLIT ON THE RADIO, the same way the master switch's copy is: "your pod
  // stops seeing your position" promises they can see it NOW, which is
  // false through a radio outage. The interrupted line is not a softer
  // version of the other — it carries a fact the other does not, because a
  // session interrupted by Bluetooth heals itself when the adapter comes
  // back (session.ts resumeRadio) and a session destroyed by a restart has
  // nothing left to heal.
  //
  // Neither line opens by restating "sharing is on": the master switch says
  // that in the card directly above, and a second copy of it here would
  // bury the one sentence this notice exists to add.
  const appearanceWarning = radioInterrupted()
    ? 'Changing this restarts the app, which ends the sharing session you have running. The radio is already down — once the session is gone as well, the radio coming back cannot restore it.'
    : 'Changing this restarts the app, which ends the sharing session you have running — your pod stops seeing your position until you turn it back on.';

  if (helpScreen) {
    return <HelpScreen onClose={() => setHelpScreen(false)} />;
  }

  if (readingPack) {
    return (
      <PackReader
        packId={readingPack.id}
        packName={readingPack.name}
        onClose={() => setReadingPack(null)}
      />
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {crewSharingOn ? (
        <>
          <Text style={styles.sectionTitle} accessibilityRole="header">
            Mesh settings
          </Text>
          <View style={styles.card}>
            <Pressable
              style={styles.row}
              onPress={() => {
                stopCrewSharing().catch(() => {});
              }}
              accessibilityRole="button"
              accessibilityLabel="Stop sharing with everyone">
              <View style={styles.rowBody}>
                <Text style={styles.rowTitle}>Stop sharing with everyone</Text>
                <Text style={styles.rowDesc}>
                  {/* MIRRORS CrewSection's radio truth. "Sharing is ON" is a
                      statement about INTENT; whether the pod can actually see
                      you is a statement about the RADIO, and the two came
                      apart every time Bluetooth went off. Saying the first
                      while the second is false is the failure this line
                      existed to prevent, made by this line. */}
                  {/* SCOPED HONESTLY (mailbox decoupling, 2026-08-25): this
                      switch ends POSITION sharing everywhere. The app goes
                      on carrying your pod's messages while it is open —
                      saying "ends every session" would promise a silence
                      the phone does not keep. */}
                  {radioInterrupted()
                    ? 'Sharing is on, but the radio is down — nobody can see your position right now. One tap here turns position sharing off everywhere; pod messages keep moving while the app is open.'
                    : 'Sharing is ON right now — your pod can see your position. One tap here turns it off for every pod at once; pod messages keep moving while the app is open.'}
                </Text>
              </View>
            </Pressable>
          </View>
        </>
      ) : null}
      {/* Appearance sits at the top of Settings: mode is identity-level,
          and the only card ever above it is the crew-sharing kill switch,
          which outranks everything while sharing is live. */}
      <Text style={styles.sectionTitle} accessibilityRole="header">
        Appearance
      </Text>
      <View style={styles.card}>
        {appearanceEndsSharing ? (
          // The screen's own read-this-first callout, above the rows it is
          // about. Also folded into each row's hint below, so a camper
          // moving row by row with a screen reader cannot arrive at the tap
          // without it.
          <View style={styles.notice}>
            <Text style={styles.noticeText}>{appearanceWarning}</Text>
          </View>
        ) : null}
        {APPEARANCE_CHOICES.map(c => (
          <AppearanceRow
            key={c.value}
            title={c.title}
            desc={
              appearanceNextLaunch && appearance === c.value
                ? 'Takes effect next time the app opens.'
                : c.desc
            }
            selected={appearance === c.value}
            // No warning on the mode already chosen: tapping it does
            // nothing now, so promising a consequence would be its own lie.
            hint={
              appearanceEndsSharing && appearance !== c.value
                ? appearanceWarning
                : undefined
            }
            onPress={() => pickAppearance(c.value)}
          />
        ))}
        {/* Text size lives with the modes because it is the same kind of
            choice — how the app looks to THESE eyes — but it is the one
            that costs nothing to try, so it says so. */}
        <TextSizeRow
          label={textScaleLabel(size)}
          canShrink={size > TEXT_SCALES[0]}
          canGrow={size < TEXT_SCALES[TEXT_SCALES.length - 1]}
          onStep={stepSize}
        />
      </View>
      {/* NOTIFICATIONS — one row, uncollapsed, near the top, because a
          camper looking for it is looking for this word (owner ask,
          2026-08-26). ON BY DEFAULT: nothing here is an in-app off switch.
          The app asks once, in context, the first time a pod feature arms,
          and every per-type control — mentions loud, pod messages quiet,
          calls through Do Not Disturb — is a channel/category switch on the
          phone's own notification page, which this row opens. A second set
          of toggles in here could only drift out of agreement with those. */}
      <Text style={styles.sectionTitle} accessibilityRole="header">
        Notifications
      </Text>
      <View style={styles.card}>
        <Pressable
          style={styles.row}
          onPress={() => {
            void openAlerts();
          }}
          accessibilityRole="button"
          accessibilityLabel="Notifications">
          <View style={styles.rowBody}>
            <Text style={styles.rowTitle}>Notifications</Text>
            <Text style={styles.rowDesc}>
              {/* THE MESH TRUTH, in the row itself. There is no push
                  server and no internet out there: a buzz is minted by the
                  RECEIVING phone the moment it hears the message over the
                  mesh. Saying "instantly" here would teach a camper to
                  expect something the radio cannot promise, and they would
                  learn it was false at the worst possible moment. */}
              {!pocketAlertsPresent()
                ? 'This build cannot post notifications — pocket alerts arrive with a newer install.'
                : alertsChoice === 'granted'
                ? 'On. Someone naming you with an @ buzzes loudly; pod messages and calls buzz too. Buzzes ride the mesh — they land when your phone hears the message. Tap to turn each kind up or down in system settings.'
                : alertsChoice === 'denied'
                ? 'Off — you said no and the app has not asked since. Tap to be asked again; if the phone will not ask any more, this opens Playa Pal’s notification settings.'
                : 'On by default — the app asks the phone for permission the first time you share with a pod or open the walkie. Tap to answer now instead.'}
            </Text>
          </View>
          <Text style={styles.rowChevron}>›</Text>
        </Pressable>
      </View>
      {/* Angel & voice — everything about the Angel's brain and its voice,
          one collapsible group (a11y+IA review 2026-08-24): model roster +
          chooser + spoken replies + engine/voice/speed/sample. */}
      <Pressable
        style={styles.sectionTitleRow}
        onPress={() => setAngelOpen(o => !o)}
        accessibilityRole="button"
        accessibilityLabel="Angel and voice"
        accessibilityState={{ expanded: angelOpen }}>
        <Text style={styles.sectionTitle}>Angel & voice</Text>
        <Text style={styles.sectionChevron}>{angelOpen ? '˅' : '›'}</Text>
      </Pressable>
      {angelOpen ? (
        <>
      {/* The model roster: every option the app knows, each stamped with
          this phone's measured verdict. The section only reads; the one
          download/switch mechanism stays the chooser Alert (Angel tab and
          the button below), so there is exactly one way models move. */}
      <Text style={styles.subTitle} accessibilityRole="header">
        Angel model
      </Text>
      {/* Before WHICH model comes WHETHER: on a small phone she rests by
          default, and this is the durable home of that choice once the
          conversation surface has asked it. */}
      {angel && onAngelChange ? (
        <AngelRestCard posture={angel} busy={angelBusy} onChange={onAngelChange} />
      ) : null}
      <View style={styles.card}>
        {modelRows.map(r => {
          const live =
            liveDownload && liveDownload.id === r.entry.id ? liveDownload : null;
          const status = live
            ? live.phase === 'verifying'
              ? 'Checking the download…'
              : `Downloading… ${gb(live.bytesWritten)} of ${gb(live.contentLength)} GB`
            : r.active
            ? 'Active on this phone'
            : r.fit.status === 'low-ram'
            ? 'Needs a phone with more memory'
            : r.fit.status === 'no-room'
            ? `Needs ${gb(r.fit.shortBytes)} GB more free space`
            : r.downloaded
            ? 'Downloaded — switch from the chooser'
            : r.entry.sha256
            ? 'Available to download'
            : 'Not published yet';
          return (
            <View style={styles.row} key={r.entry.id}>
              <View style={styles.rowBody}>
                <Text style={styles.rowTitle}>
                  {r.entry.title} · ~{gb(r.entry.bytes)} GB
                  {r.recommended && !r.active ? '  ★ recommended' : ''}
                </Text>
                <Text style={styles.rowDesc}>
                  {status}. {r.entry.blurb}
                </Text>
              </View>
            </View>
          );
        })}
        {onChooseModel ? (
          // The measured line about THIS phone stays under the thumb; what
          // a download costs is the same lesson on every phone, so it goes
          // behind the ? — mounted OUTSIDE the row, never inside it.
          <View style={styles.infoRow}>
            <Pressable
              style={[styles.row, styles.infoFlex]}
              onPress={onChooseModel}
              accessibilityRole="button"
              accessibilityLabel="Choose or download a model">
              <View style={styles.rowBody}>
                <Text style={styles.rowTitle}>Choose or download a model</Text>
                {phoneLine ? (
                  <Text style={styles.rowDesc}>{`This phone: ${phoneLine}.`}</Text>
                ) : null}
              </View>
              <Text style={styles.rowChevron}>›</Text>
            </Pressable>
            <InfoTap
              topic="downloading a model"
              text={
                'Downloads need Wi-Fi; core chat, events, and guides run ' +
                'offline after.'
              }
            />
          </View>
        ) : null}
      </View>

      <Text style={styles.subTitle} accessibilityRole="header">
        Spoken replies
      </Text>
      <View style={styles.card}>
        <View style={styles.row}>
          <View style={styles.rowBody}>
            <Text style={styles.rowTitle}>Speak answers out loud</Text>
          </View>
          {/* Pure teaching, and the row is a plain View + Switch — the ?
              sits between them without ever contending for the touch. */}
          <InfoTap
            topic="spoken replies"
            text={
              "The Angel reads each finished reply with your device's own " +
              'voice — fully offline with an offline voice installed.'
            }
          />
          {/* The Switch names ITS OWN setting (a11y review 2026-08-24) —
              an unlabeled switch reads as bare "switch, off". */}
          <Switch
            value={settings.enabled}
            onValueChange={enabled => update({ enabled })}
            accessibilityLabel="Speak answers out loud"
            accessibilityState={{ checked: settings.enabled }}
            trackColor={{ true: colors.sage, false: colors.haze }}
          />
        </View>
      </View>

      {settings.enabled ? (
        <>
          {listSpeechBackends().length > 1 ? (
            <>
              <Text style={styles.subTitle} accessibilityRole="header">
                Voice engine
              </Text>
              <View style={[styles.card, styles.backendRow]}>
                {listSpeechBackends().map(b => (
                  // One engine at a time — a radio, and said so (a11y
                  // review 2026-08-24).
                  <Pressable
                    key={b.id}
                    accessibilityRole="radio"
                    accessibilityLabel={b.label}
                    accessibilityState={{
                      selected: settings.backendId === b.id,
                    }}
                    style={[
                      styles.backendChip,
                      settings.backendId === b.id && styles.backendChipActive,
                    ]}
                    onPress={() =>
                      // Engine switch: voice ids don't transfer between
                      // engines, so the selection resets to its default.
                      update({ backendId: b.id, voiceId: null })
                    }>
                    <Text
                      style={[
                        styles.backendChipText,
                        settings.backendId === b.id &&
                          styles.backendChipTextActive,
                      ]}>
                      {b.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </>
          ) : null}

          {readiness && !readiness.ok ? (
            <View style={styles.notice}>
              <Text style={styles.noticeText}>
                {readiness.reason === 'needs-network'
                  ? 'The selected voice needs internet — there is none on playa. Pick an offline voice, or download offline voice data before you go.'
                  : readiness.reason === 'voice-missing'
                  ? 'Your saved voice is no longer on this device. Pick another below.'
                  : readiness.reason === 'no-voices'
                  ? 'No text-to-speech voices found on this device. Install voice data to speak replies.'
                  : readiness.reason === 'model-missing'
                  ? 'Angel voice is not available on this phone yet. Choose Device voice.'
                  : 'Could not confirm this voice works offline. Test it in airplane mode before the burn.'}
              </Text>
              {readiness.canInstallVoiceData && backend.openVoiceDataInstaller ? (
                <Pressable
                  style={styles.noticeBtn}
                  onPress={() => backend.openVoiceDataInstaller!().catch(() => {})}
                  accessibilityRole="button"
                  accessibilityLabel="Get offline voice data">
                  <Text style={styles.noticeBtnText}>
                    Get offline voice data…
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}

          <Text style={styles.subTitle} accessibilityRole="header">
            Voice
          </Text>
          <View style={styles.card}>
            <VoiceRow
              label="System default"
              badge={null}
              selected={settings.voiceId === null}
              onPress={() => pickVoice(null)}
            />
            {shownVoices.map(v => (
              <VoiceRow
                key={v.id}
                label={v.label + (v.quality === 'enhanced' ? ' · enhanced' : '')}
                badge={NETWORK_BADGE[v.network]}
                badgeGood={v.network === 'offline'}
                selected={settings.voiceId === v.id}
                onPress={() => pickVoice(v.id)}
              />
            ))}
            {voices.length === 0 ? (
              <Text style={styles.rowDesc}>
                {voicesError
                  ? `Could not list voices: ${voicesError}`
                  : 'Loading voices…'}
              </Text>
            ) : null}
          </View>
          {/* The instruction stays; the lesson about the badge goes behind
              the ?. A camper who already knows what "offline" means on this
              list should not have to read it again on every visit. */}
          <View style={styles.hintRow}>
            <Text style={styles.hintFlex}>Tap a voice to hear it.</Text>
            <InfoTap
              topic="offline voices"
              text={
                "Voices marked offline work with no signal — that's what you " +
                'want out there.'
              }
            />
          </View>

          <Text style={styles.subTitle} accessibilityRole="header">
            Speed · {settings.rate.toFixed(2)}×
          </Text>
          <View style={styles.card}>
            <RateSlider
              value={settings.rate}
              min={RATE_MIN}
              max={RATE_MAX}
              step={RATE_STEP}
              onChange={rate => update({ rate })}
              onRelease={rate => speakSample(settings.voiceId, rate)}
            />
            <View style={styles.rateLabels}>
              <Text style={styles.rateLabel}>slower</Text>
              <Text style={styles.rateLabel}>normal</Text>
              <Text style={styles.rateLabel}>faster</Text>
            </View>
          </View>

          <Pressable
            style={styles.testBtn}
            onPress={() => speakSample(settings.voiceId, settings.rate)}
            accessibilityRole="button"
            accessibilityLabel="Hear a sample">
            <Text style={styles.testBtnText}>Hear a sample</Text>
          </Pressable>
        </>
      ) : null}
        </>
      ) : null}

      {/* Offline content (a11y+IA review 2026-08-24, DO-NOW #8) — the
          retired Packs tab's public half (Option A), grouped and collapsed:
          public packs need no tending, so they no longer stretch the page.
          Camp and private packs stay on the Camp tab. */}
      <Pressable
        style={styles.sectionTitleRow}
        onPress={() => setOfflineOpen(o => !o)}
        accessibilityRole="button"
        accessibilityLabel="Offline content"
        accessibilityState={{ expanded: offlineOpen }}>
        <Text style={styles.sectionTitle}>Offline content</Text>
        <Text style={styles.sectionChevron}>{offlineOpen ? '˅' : '›'}</Text>
      </Pressable>
      {offlineOpen ? (
        <>
          {/* "Public packs" keeps its NAME inside the group — Right Now's
              empty state sends people to "Settings › Offline content ›
              Public packs". */}
          {/* The ? rides the heading, which is where a question about a
              section actually forms. The list underneath is the data; the
              paragraph explaining what the list IS was the ink Tufte
              objected to. */}
          <View style={styles.headingRow}>
            <Text style={styles.subTitle} accessibilityRole="header">
              Public packs
            </Text>
            <InfoTap
              topic="public packs"
              text={
                'Included with Playa Pal and updated when the app is updated. ' +
                'Camp and private packs live on the Camp tab.'
              }
            />
          </View>
          <View style={styles.card}>
            {publicPacks.map(p => (
              <PackRowCard
                key={p.id}
                pack={p}
                all={packs}
                onChanged={refreshPacks}
                onRead={() => setReadingPack(p)}
              />
            ))}
          </View>
        </>
      ) : null}

      {/* Privacy & data (a11y+IA review 2026-08-24, DO-NOW #8): the field
          logs and the Hidden list — everything about what this phone keeps
          and what it will not say — in one group. */}
      <Pressable
        style={styles.sectionTitleRow}
        onPress={() => setPrivacyOpen(o => !o)}
        accessibilityRole="button"
        accessibilityLabel="Privacy and data"
        accessibilityState={{ expanded: privacyOpen }}>
        <Text style={styles.sectionTitle}>Privacy & data</Text>
        <Text style={styles.sectionChevron}>{privacyOpen ? '˅' : '›'}</Text>
      </Pressable>
      {privacyOpen ? (
        <>
          {/* The pocket-alerts row used to live here, because what a phone
              may say while it is in a pocket is a privacy-adjacent choice.
              It moved OUT to its own top-level Notifications section
              (2026-08-26): a camper hunting for notification settings looks
              for the word "Notifications", not inside a collapsed Privacy
              group, and the row now leads to the OS's own page rather than
              only re-asking. */}
          {NativeModules.MicProbe != null ? (
            <>
              <Text style={styles.subTitle} accessibilityRole="header">
                Microphone check
              </Text>
              <View style={styles.card}>
                {/* The controlled smoke test the mini's mic saga earned:
                    one tap runs every capture strategy on THIS device and
                    lists each outcome — so a fix ships knowing, not
                    guessing. iOS-only by presence; harmless to leave in. */}
                <View style={styles.infoRow}>
                  <Pressable
                    style={[styles.row, styles.infoFlex]}
                    onPress={() => {
                      setMicChecking(true);
                      NativeModules.MicProbe.run()
                        .then((r: string) => Alert.alert('Microphone check', r))
                        .catch((e: any) =>
                          Alert.alert(
                            'Microphone check',
                            String(e?.message ?? e),
                          ),
                        )
                        // Both endings clear it, including the reject the
                        // native side sends when a check is somehow already
                        // running — a row stuck on "Listening…" would be a
                        // worse bug than the double tap it replaced.
                        .finally(() => setMicChecking(false));
                    }}
                    disabled={micChecking}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: micChecking, busy: micChecking }}
                    accessibilityLabel="Run the microphone check">
                    <View style={styles.rowBody}>
                      <Text style={styles.rowTitle}>
                        {micChecking
                          ? 'Listening…'
                          : 'Run the microphone check'}
                      </Text>
                      <Text style={styles.rowDesc}>
                        {micChecking
                          ? 'Running every check in turn — the results appear when it finishes. Keep the phone still and quiet-ish.'
                          : 'Tries every way of listening this phone supports and shows what each one said — takes about eight seconds, best with the walkie off.'}
                      </Text>
                    </View>
                    <Text style={styles.rowChevron}>
                      {micChecking ? '⋯' : '›'}
                    </Text>
                  </Pressable>
                  {/* What to DO with the result is advice for the one camper
                      in a hundred whose talk is broken — not a line the
                      other ninety-nine need under the button. */}
                  <InfoTap
                    topic="the microphone check result"
                    text={
                      'Screenshot the result if live talk is not working.'
                    }
                  />
                </View>
              </View>
            </>
          ) : null}

          <Text style={styles.subTitle} accessibilityRole="header">
            Field log
          </Text>
          <View style={styles.card}>
            {/* Both rows keep the same two things inline: the PRIVACY
                clause, which is the reason a camper hesitates, and — on the
                chat log — the live count of what is actually in there. What
                each export CONTAINS is a fixed list, and a fixed list is
                exactly what the ? was made for. */}
            <View style={styles.infoRow}>
              <Pressable
                style={[styles.row, styles.infoFlex]}
                onPress={shareLog}
                accessibilityRole="button"
                accessibilityLabel="Share conversation log">
                <View style={styles.rowBody}>
                  <Text style={styles.rowTitle}>Share conversation log</Text>
                  <Text style={styles.rowDesc}>
                    Kept on this device until you share it; review before
                    sharing.
                    {logStats && logStats.rows > 0
                      ? ` ${logStats.rows} entries across ${logStats.sessions} chat${
                          logStats.sessions === 1 ? '' : 's'
                        } · ~${Math.max(1, Math.round(logStats.bytes / 1024))} KB.`
                      : ' Nothing logged yet.'}
                  </Text>
                </View>
                <Text style={styles.rowChevron}>›</Text>
              </Pressable>
              <InfoTap
                topic="what the conversation log holds"
                text={
                  'Exports full chats, retrieved passages and tool details, ' +
                  'model name, and timings.'
                }
              />
            </View>
            <View style={styles.infoRow}>
              <Pressable
                style={[styles.row, styles.infoFlex]}
                onPress={shareQueries}
                accessibilityRole="button"
                accessibilityLabel="Share question log">
                <View style={styles.rowBody}>
                  <Text style={styles.rowTitle}>Share question log</Text>
                  <Text style={styles.rowDesc}>
                    Kept on this device until you share it; review before
                    sharing.
                  </Text>
                </View>
                <Text style={styles.rowChevron}>›</Text>
              </Pressable>
              <InfoTap
                topic="what the question log holds"
                text={
                  'Questions asked, what the app looked up, answer excerpts, ' +
                  'timestamps, and timings — small enough to send after the ' +
                  'burn.'
                }
              />
            </View>
          </View>

          {/* "Don't use this" promises Settings > Hidden. This is that —
              now inside Privacy & data, which is exactly what hiding IS.
              Present even when empty, so the promise is never a dead end --
              an empty list is an honest state, a missing section is a
              broken one. */}
          <Text style={styles.subTitle} accessibilityRole="header">
            Hidden
          </Text>
          <View style={styles.card}>
            {hidden.length === 0 ? (
              // An empty list is the STATE and stays inline; how the list
              // fills up is the lesson, and it only matters to whoever is
              // asking. This View is not a Pressable, so the ? is the only
              // touch target in the row.
              <View style={styles.row}>
                <View style={styles.rowBody}>
                  <Text style={styles.rowDesc}>Nothing hidden.</Text>
                </View>
                <InfoTap
                  topic="hiding things from answers"
                  text={
                    'Press and hold anything the Angel shows you — a person, ' +
                    'an event, a source — and choose "Don\'t use" to keep it ' +
                    'out of answers on this phone. It lands here so you can ' +
                    'bring it back.'
                  }
                />
              </View>
            ) : (
              hidden.map(h => (
                <Pressable
                  key={`${h.kind}:${h.key}`}
                  style={styles.row}
                  onPress={() => restore(h)}
                  accessibilityRole="button"
                  accessibilityLabel={`Bring back ${h.label}`}>
                  <View style={styles.rowBody}>
                    <Text style={styles.rowTitle}>{h.label}</Text>
                    <Text style={styles.rowDesc}>
                      {h.kind === 'person' ? 'Person' : h.kind === 'event' ? 'Event' : 'Passage'}
                      {' '}hidden from answers. Tap to bring back.
                    </Text>
                  </View>
                  <Text style={styles.rowChevron}>↺</Text>
                </Pressable>
              ))
            )}
          </View>
        </>
      ) : null}

      {/* Help & about (a11y+IA review 2026-08-24, DO-NOW #8): handing the
          app on, the replayable tour and setup, and who made this — the
          "everything else" a person reaches for occasionally. */}
      <Pressable
        style={styles.sectionTitleRow}
        onPress={() => setHelpOpen(o => !o)}
        accessibilityRole="button"
        accessibilityLabel="Help and about"
        accessibilityState={{ expanded: helpOpen }}>
        <Text style={styles.sectionTitle}>Help & about</Text>
        <Text style={styles.sectionChevron}>{helpOpen ? '˅' : '›'}</Text>
      </Pressable>
      {helpOpen ? (
        <>
          {/* FIRST in the group, above sharing and the tour: the camper who
              opens "Help & about" with no signal and no manual is asking
              "what does this do, and what won't it do?" — and that answer
              should not sit under two other things. */}
          <Text style={styles.subTitle} accessibilityRole="header">
            Help
          </Text>
          <View style={styles.card}>
            <Pressable
              style={styles.row}
              onPress={() => setHelpScreen(true)}
              accessibilityRole="button"
              accessibilityLabel="How Playa Pal works">
              <View style={styles.rowBody}>
                <Text style={styles.rowTitle}>How Playa Pal works</Text>
                <Text style={styles.rowDesc}>
                  What works with no signal, how your pod's phones find each
                  other, and what the app honestly cannot do yet.
                </Text>
              </View>
              <Text style={styles.rowChevron}>›</Text>
            </Pressable>
          </View>

          <View style={styles.headingRow}>
            <Text style={styles.subTitle} accessibilityRole="header">
              Share the app
            </Text>
            {/* Where ELSE this door is, for the person who wonders. The row
                below works without ever reading it. */}
            <InfoTap
              topic="the other way to share the app"
              text={
                'Also on the Camp tab, under "Share & receive" — next to the ' +
                'beams and cards, for when someone is standing right there.'
              }
            />
          </View>
          <View style={styles.card}>
            {/* The same row the Camp tab's "Share & receive" mounts — one
                component, two doors onto one gesture (sharing audit §3.3).
                This one serves the "where do I get / give this app" instinct
                that sends people to Settings in every app they own. */}
            <ShareAppRow />
          </View>

          {/* Getting started (0.7.3): the tour and setup, replayable forever —
              the app explains itself on demand, not once. Both mount at the app
              root (App.tsx), so they overlay every tab, not just Settings. */}
          {onReplayTour || onReplaySetup ? (
            <>
              <Text style={styles.subTitle} accessibilityRole="header">
                Getting started
              </Text>
              <View style={styles.card}>
                {onReplayTour ? (
                  <Pressable
                    style={styles.row}
                    onPress={onReplayTour}
                    accessibilityRole="button"
                    accessibilityLabel="Replay the feature tour">
                    <View style={styles.rowBody}>
                      <Text style={styles.rowTitle}>Replay the feature tour</Text>
                      <Text style={styles.rowDesc}>
                        Five cards, the whole app in under a minute.
                      </Text>
                    </View>
                    <Text style={styles.rowChevron}>›</Text>
                  </Pressable>
                ) : null}
                {onReplaySetup ? (
                  <View style={styles.infoRow}>
                    <Pressable
                      style={[styles.row, styles.infoFlex]}
                      onPress={onReplaySetup}
                      accessibilityRole="button"
                      accessibilityLabel="Run setup again">
                      <View style={styles.rowBody}>
                        <Text style={styles.rowTitle}>Run setup again</Text>
                        <Text style={styles.rowDesc}>
                          Change your name or home camp.
                        </Text>
                      </View>
                      <Text style={styles.rowChevron}>›</Text>
                    </Pressable>
                    {/* The row's job is the first sentence; the reassurance
                        is for whoever is afraid of losing what they set. */}
                    <InfoTap
                      topic="running setup again"
                      text={
                        'Every step is optional — skipping keeps what you ' +
                        'already set.'
                      }
                    />
                  </View>
                ) : null}
              </View>
            </>
          ) : null}

          {/* About (owner ask 2026-08-19): who made this, which version, where
              it lives. The version is package.json's — the single source. */}
          <Text style={styles.subTitle} accessibilityRole="header">
            About
          </Text>
          <View style={styles.card}>
            <Text style={styles.rowTitle}>Playa Pal {APP_VERSION}</Text>
            {/* Directly under the version, because "which one am I on" and
                "is there a newer one" are the same question two seconds
                apart. Android only; on an iPhone this becomes one quiet
                line about TestFlight. */}
            <UpdateRow version={APP_VERSION} />
            {/* NOT "open source" (CLAUDE.md, Legal). The CODE is Apache-2.0
                and the fine print below says so; the REPOSITORY carries
                bundled data and third-party assets whose redistribution
                terms are unresolved, so calling the whole thing open source
                is a claim this project has not earned yet. "Source readable
                on GitHub" is the true version of what that adjective was
                there to tell people, and it costs the sentence nothing. */}
            <Text style={styles.rowDesc}>
              Free, source readable on GitHub, and completely vibe-coded:
              written by AI (Claude and Codex) under human direction, tested on
              real phones in real dust. Published by Simbi Community
              Development, a 501(c)(3).
            </Text>
            <Pressable
              onPress={() => Linking.openURL('https://playapal.lol')}
              accessibilityRole="link"
              accessibilityLabel="Open playapal.lol"
              style={styles.linkTap}>
              <Text style={styles.aboutLink}>playapal.lol</Text>
            </Pressable>
            <Pressable
              onPress={() =>
                Linking.openURL('https://github.com/simbi-community-dev/playapal')
              }
              accessibilityRole="link"
              accessibilityLabel="Open the source on GitHub"
              style={styles.linkTap}>
              <Text style={styles.aboutLink}>Source on GitHub</Text>
            </Pressable>
            {/* The privacy policy, in the app and not only in a store
                listing. Both stores demand the URL on the listing; a camper
                who wants to know what the app does with their position
                should not have to go to a store page to find out, and on
                playa they cannot. Same row idiom as its two neighbours. */}
            <Pressable
              onPress={() => Linking.openURL('https://playapal.lol/privacy')}
              accessibilityRole="link"
              accessibilityLabel="Read the privacy policy"
              style={styles.linkTap}>
              <Text style={styles.aboutLink}>Privacy policy</Text>
            </Pressable>
            <Pressable
              onPress={() => Linking.openURL('https://simbi.com/donate')}
              accessibilityRole="link"
              accessibilityLabel="Support the nonprofit"
              style={styles.linkTap}>
              <Text style={styles.aboutLink}>Support the nonprofit</Text>
            </Pressable>
            <Text style={styles.aboutFine}>
              Not affiliated with, endorsed by, or verified by Burning Man
              Project. Code: Apache-2.0; downloaded models and bundled data
              carry their own licenses and credits (see NOTICE in the
              repository).
            </Text>
          </View>
        </>
      ) : null}
    </ScrollView>
  );
}

const APPEARANCE_CHOICES: {
  value: AppearancePref;
  title: string;
  desc: string;
}[] = [
  { value: 'system', title: 'System', desc: 'Match this phone.' },
  { value: 'light', title: 'Light', desc: 'Always light.' },
  { value: 'dark', title: 'Dark', desc: 'Always dark.' },
];

/** The VoiceRow ●/○ radio pattern, plus the description line Appearance
 * needs ("Match this phone" — and the next-launch notice when a live
 * reload is not available). */
function AppearanceRow({
  title,
  desc,
  selected,
  hint,
  onPress,
}: {
  title: string;
  desc: string;
  selected: boolean;
  /** What this tap will COST, spoken before it happens — accessibilityHint
   * is exactly the affordance for that, and it keeps the consequence
   * attached to the control rather than to a callout a screen reader can
   * pass by. */
  hint?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={styles.voiceRow}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityHint={hint}
      accessibilityLabel={title}>
      <Text style={[styles.voiceMark, selected && styles.voiceMarkSelected]}>
        {selected ? '●' : '○'}
      </Text>
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowDesc}>{desc}</Text>
      </View>
    </Pressable>
  );
}

/**
 * THE READING-GLASSES STEPPER (owner ask 2026-08-26: "settings needs a
 * font size +/- option, doesnt have to be elaborate"). Two big taps, the
 * current rung named between them, and no restart — the whole screen
 * grows under the thumb that pressed A+, this row included.
 *
 * A stepper and not a slider: gloves, dust, and a phone held at arm's
 * length in the sun are not slider conditions. The ends grey out rather
 * than disappear, so the control never changes shape mid-tap.
 */
function TextSizeRow({
  label,
  canShrink,
  canGrow,
  onStep,
}: {
  /** What the current rung is called — 'Default', 'Bigger', … */
  label: string;
  canShrink: boolean;
  canGrow: boolean;
  onStep: (delta: number) => void;
}) {
  return (
    <View style={styles.sizeRow}>
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle}>Text size</Text>
        <Text style={styles.rowDesc}>
          {/* The contrast with the mode rows directly above is the point:
              those can cost a camper their live sharing session, this one
              costs nothing. Say so where the thumb is. */}
          {label}. Every screen follows right away — nothing restarts.
        </Text>
      </View>
      <Pressable
        style={[styles.sizeBtn, !canShrink && styles.sizeBtnOff]}
        onPress={() => onStep(-1)}
        disabled={!canShrink}
        accessibilityRole="button"
        accessibilityState={{ disabled: !canShrink }}
        accessibilityLabel="Smaller text"
        accessibilityHint={`Text is ${label}.`}>
        <Text style={[styles.sizeBtnText, !canShrink && styles.sizeBtnTextOff]}>
          A−
        </Text>
      </Pressable>
      <Pressable
        style={[styles.sizeBtn, !canGrow && styles.sizeBtnOff]}
        onPress={() => onStep(1)}
        disabled={!canGrow}
        accessibilityRole="button"
        accessibilityState={{ disabled: !canGrow }}
        accessibilityLabel="Bigger text"
        accessibilityHint={`Text is ${label}.`}>
        <Text style={[styles.sizeBtnText, !canGrow && styles.sizeBtnTextOff]}>
          A+
        </Text>
      </Pressable>
    </View>
  );
}

function VoiceRow({
  label,
  badge,
  badgeGood,
  selected,
  onPress,
}: {
  label: string;
  badge: string | null;
  badgeGood?: boolean;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    // One voice at a time — a radio, with the badge folded into the spoken
    // label so "offline" travels to a screen reader too (a11y review
    // 2026-08-24; the ●/○ glyphs alone were color-and-shape state).
    <Pressable
      style={styles.voiceRow}
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityLabel={badge ? `${label}, ${badge}` : label}
      accessibilityState={{ selected }}>
      <Text style={[styles.voiceMark, selected && styles.voiceMarkSelected]}>
        {selected ? '●' : '○'}
      </Text>
      <Text style={styles.voiceLabel} numberOfLines={1}>
        {label}
      </Text>
      {badge ? (
        <Text style={[styles.badge, badgeGood ? styles.badgeGood : styles.badgeWarn]}>
          {badge}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: spacing.lg },
  content: { paddingBottom: spacing.xl },
  aboutLink: {
    color: colors.clay,
    fontSize: type.body,
    fontWeight: '700',
    marginTop: spacing.sm,
  },
  aboutFine: {
    color: colors.faded,
    fontSize: type.tiny,
    marginTop: spacing.md,
  },
  sectionTitle: {
    color: colors.night,
    fontSize: type.body,
    fontWeight: '800',
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  // Collapsible group header: title left, chevron right, 44pt floor —
  // the header IS a button now (a11y+IA review 2026-08-24).
  sectionTitleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    minHeight: tap.minHeight,
  },
  // Sub-headers INSIDE a collapsible group (Angel model, Voice, Field
  // log…): quieter than the group titles so the two levels read as two
  // levels (a11y+IA review 2026-08-24 — thirteen same-weight titles was
  // the defect).
  subTitle: {
    color: colors.faded,
    fontSize: type.small,
    fontWeight: '800',
    letterSpacing: 1,
    marginTop: spacing.md,
    marginBottom: spacing.xs,
    textTransform: 'uppercase',
  },
  sectionChevron: {
    color: colors.faded,
    fontSize: type.title,
    fontWeight: '300',
    marginLeft: spacing.sm,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  card: {
    backgroundColor: colors.sand,
    borderRadius: radius.card,
    padding: spacing.md,
  },
  // minHeight: the 44pt row floor (a11y review 2026-08-24).
  row: { alignItems: 'center', flexDirection: 'row', minHeight: tap.minHeight },
  backendRow: { flexDirection: 'row' },
  backendChip: {
    ...tap, // 44pt chip floor (a11y review 2026-08-24)
    alignItems: 'center',
    backgroundColor: colors.dust,
    borderRadius: radius.chip,
    borderWidth: 1,
    borderColor: colors.haze,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    marginRight: spacing.sm,
  },
  backendChipActive: { backgroundColor: colors.plum, borderColor: colors.plum },
  backendChipText: { color: colors.night, fontSize: type.small },
  // onAccent: scheme-aware ink on the plum fill (a11y review 2026-08-24).
  backendChipTextActive: { color: colors.onAccent, fontWeight: '700' },
  rowBody: { flex: 1, marginRight: spacing.md },
  rowTitle: { color: colors.night, fontSize: type.body, fontWeight: '700' },
  rowDesc: { color: colors.faded, fontSize: type.small, marginTop: 2 },
  rowChevron: { color: colors.faded, fontSize: type.title, fontWeight: '300' },
  notice: {
    backgroundColor: colors.gold + '22',
    borderColor: colors.gold,
    borderWidth: 1,
    borderRadius: radius.card,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  noticeText: { color: colors.night, fontSize: type.small },
  noticeBtn: {
    justifyContent: 'center',
    marginTop: spacing.sm,
    minHeight: tap.minHeight, // 44pt floor (a11y review 2026-08-24)
  },
  noticeBtnText: { color: colors.clayDeep, fontSize: type.small, fontWeight: '700' },
  voiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: tap.minHeight, // 44pt row floor (a11y review 2026-08-24)
    paddingVertical: spacing.sm,
  },
  voiceMark: { color: colors.faded, fontSize: type.body, width: 24 },
  voiceMarkSelected: { color: colors.clay },
  // The text-size stepper. Wrapping row, because at the biggest rung the
  // description and the two buttons stop fitting on one line — and a row
  // that wraps is a row that still works, where a row that clips is not.
  sizeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.haze,
    marginTop: spacing.sm,
  },
  sizeBtn: {
    ...tap, // 44pt floor — the whole point of this row is reachability
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    marginLeft: spacing.sm,
    borderRadius: radius.chip,
    backgroundColor: colors.field,
    borderWidth: 1,
    borderColor: colors.haze,
  },
  // Greyed, not hidden: an end of the range that vanishes moves the other
  // button under a thumb already travelling toward it.
  sizeBtnOff: { backgroundColor: colors.dust, borderColor: colors.haze },
  sizeBtnText: { color: colors.night, fontSize: type.title, fontWeight: '700' },
  sizeBtnTextOff: { color: colors.haze },
  voiceLabel: { flex: 1, color: colors.night, fontSize: type.small },
  badge: {
    fontSize: type.tiny,
    fontWeight: '700',
    borderRadius: radius.chip,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    overflow: 'hidden',
    marginLeft: spacing.sm,
  },
  // onAccent: dark mode brightens sage, so the badge ink flips dark there
  // (a11y review 2026-08-24 — cream read 2.58:1 on dark sage).
  badgeGood: { color: colors.onAccent, backgroundColor: colors.sage },
  badgeWarn: { color: colors.night, backgroundColor: colors.haze },
  // THE TUFTE PASS's two layouts. A heading and its ? on one line — the
  // subTitle keeps its own vertical margins, so the row needs none.
  headingRow: { alignItems: 'center', flexDirection: 'row' },
  // …and the third layout, added when the fan-out reached the rows the
  // exemplar deliberately skipped: a whole tappable row with its ? mounted
  // BESIDE it rather than inside. Same picture on screen, but the glyph is
  // a sibling of the Pressable, so nothing nests and nothing contends.
  infoRow: { alignItems: 'center', flexDirection: 'row' },
  infoFlex: { flex: 1 },
  // …and a surviving inline clause with its ? beside it. It keeps the old
  // inline hint's marginTop, which moved off the text and onto the row with
  // it — otherwise the clause hugs the card above. flex on the text so a
  // long clause wraps instead of shoving the glyph off the edge.
  hintRow: {
    alignItems: 'center',
    flexDirection: 'row',
    marginTop: spacing.sm,
  },
  hintFlex: { color: colors.faded, flex: 1, fontSize: type.small },
  rateLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
  },
  rateLabel: { color: colors.faded, fontSize: type.tiny },
  testBtn: {
    ...tap, // 44pt floor (a11y review 2026-08-24)
    backgroundColor: colors.clay,
    borderRadius: radius.card,
    padding: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.lg,
  },
  testBtnText: { color: colors.onAccent, fontSize: type.body, fontWeight: '700' },
  // Text links keep the quiet look but gain the 44pt floor (a11y review).
  linkTap: { justifyContent: 'center', minHeight: tap.minHeight },
});
