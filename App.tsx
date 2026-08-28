/**
 * Playa Pal — offline LLM companion for Black Rock City. "Playa Angel" is
 * the guide inside the app (one merged persona), not the app name.
 *
 * Tabs: Right Now (default, deterministic, works with no model), Pods (the
 * people whose phones stay in touch — presence, the answering machine, the
 * walkie), Camp (the camp board and everything that moves it). The bar's
 * fourth slot is the Angel's DOOR (owner IA, Aug 27) — the Angel itself is
 * still not a tab, it is the ask-mode overlay it always was. Settings lives
 * behind the header gear.
 */

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import {
  Linking,
  Alert,
  Pressable,
  StatusBar,
  StyleSheet,
  View,
} from 'react-native';
import { Text } from './src/components/Text';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import { HomeArrow } from './src/components/HomeArrow';
import { OnboardingFlow } from './src/onboarding/OnboardingFlow';
import { onboardingDone } from './src/onboarding/onboarding';
import { Tour } from './src/tour/Tour';
import { tourSeen } from './src/tour/tourState';
import { RightNowScreen } from './src/screens/RightNowScreen';
import { CompassScreen } from './src/screens/CompassScreen';
import type { WaypointTarget } from './src/geo/brcGeo';
import { ChatScreen } from './src/screens/ChatScreen';
import { CampScreen } from './src/screens/CampScreen';
import { PodScreen } from './src/screens/PodScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import {
  canAdoptPodName,
  crewsRevision,
  joinCrew,
  listCrews,
  placeholderPodName,
  saveCrew,
  subscribeCrewsChanged,
} from './src/crews/crew';
import {
  messagesRevision,
  subscribeMessagesChanged,
  unreadCount,
} from './src/crews/messages';
import { installMailboxPresence } from './src/crews/share';
import { useKeyboardInset } from './src/hooks/useKeyboardInset';
import { LlamaSession } from './src/llm/LlamaSession';
import {
  readAngelPosture,
  writeAngelChoice,
  type AngelPosture,
} from './src/llm/angelRest';
import { DEFAULT_PERSONA_ID } from './src/llm/personas';
import {
  discardUnpublishedModel,
  findModel,
  pickModel,
  rememberModel,
} from './src/llm/modelFile';
import {
  CATALOG,
  downloadModel,
  fitEntry,
  localPath,
  readCircumstances,
  recommendedEntry,
  type CatalogEntry,
} from './src/llm/modelCatalog';
import { registerSpeechBackend } from './src/speech/backend';
import { kokoroSpeechBackend } from './src/speech/kokoroBackend';
import { pruneChatLog } from './src/log/chatLog';
import {
  migrateLegacyOwnPack,
  pruneCampPosts,
  reconcileWriterIncarnation,
} from './src/camp/campBoard';
import { getDb, rebuildFtsIndexes } from './src/events/db';
import { startMyPlansSync } from './src/rightnow/myPlans';
import { getMyCard, installFriendBundle } from './src/friends/friendCard';
import { notifyBeamInstalled, startBeamIngress } from './src/beam/ingress';
import { startPocketAlertTaps } from './src/crews/pocketAlerts';
import { decodeBeamLink } from './src/beam/beamLink';
import { describeInstall, installIncomingPayload } from './src/packs/importPack';
import { decodeFriendLink } from './src/friends/friendLink';
import {
  decodePodLink,
  inviteCardBundleJson,
  type PodInvite,
} from './src/crews/podLink';
import { subscribeIncomingUrl } from './src/links/incoming';
import {
  CachesDirectoryPath,
  exists as fsExists,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
} from '@dr.pogodin/react-native-fs';

// Writer-incarnation token lives in Caches — the one app-writable place
// iOS backup/restore does NOT carry (Android is covered by
// allowBackup=false). A restored clone arrives without it and rotates to a
// fresh writer id instead of forking against the original.
const INCARNATION_TOKEN_PATH = `${CachesDirectoryPath}/camp-writer-incarnation`;
import { onWalkieSpeaking, walkiePresent } from './src/crews/walkie';
import { WalkieDeck } from './src/crews/WalkieDeck';
import { APP_DISPLAY_NAME } from './src/legal';
import type { ModelStatus } from './src/types';
import { activeScheme, colors, radius, spacing, tap, type } from './src/theme';

type Tab = 'now' | 'pod' | 'camp' | 'settings';

async function releaseSessionUntilDone(session: LlamaSession): Promise<void> {
  let delayMs = 250;
  for (;;) {
    try {
      await session.release();
      return;
    } catch (error) {
      console.warn('[llm] app teardown release failed; retrying:', error);
      await new Promise<void>(resolve => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 5000);
    }
  }
}

// Tier-2 neural "Angel voice" (Kokoro via sherpa-onnx) joins the speech
// registry at startup; the platform backend registers itself as tier 1 and
// stays the default. Registration is idempotent and does NOT load the model
// (that happens lazily on first speak).
registerSpeechBackend(kokoroSpeechBackend);

// Option A consolidation (owner-picked 2026-08-19): three questions, three
// tabs — the Angel is not a place, it is the ask-mode of Now, reachable from
// its bar-slot door (header wing until Aug 27) and every "Ask the Angel"
// affordance, rendered as a full-screen conversation overlay. Packs
// dissolved into Camp (camp/private packs + import + campmates' boards)
// and Settings (public packs, door = the header gear).
//
// POD COMMS BECAME THE FOURTH TAB (owner, 2026-08-24: "the camp tab is now
// totally unmanageable, all this useful comms is buried halfway down a long
// scroll"). Messaging is an activity, not camp administration: the pod card
// — presence, the answering machine, the walkie — was the last section of
// the Camp scroll, roughly two screens down, and it is the thing a camper
// opens most. It is now one tap from anywhere, and Camp lost its largest
// block in the same move.
//
// Order is deliberate: the two LIVE surfaces (what's happening, who I'm
// with) take the left and the reachable middle; the two you go to on
// purpose (the camp's board, the phone's settings) take the right.
// Settings has no bar slot (owner IA, Aug 27): its door is the header gear,
// which frees the fourth slot for the Angel — the row a camper actually
// lives in is Now · Pods · Camp · Angel. The 'settings' Tab key survives;
// only its door moved.
const TABS: { key: Tab; label: string }[] = [
  { key: 'now', label: 'Now' },
  { key: 'pod', label: 'Pods' },
  { key: 'camp', label: 'Camp' },
];

/**
 * Messages waiting across EVERY pod on this phone. Answering-machine mail
 * arrives minutes-to-hours after it was spoken (gossip, not a server), so a
 * camper has no reason to open the tab on a hunch — the count is the only
 * thing that tells them there is anything to check. Never throws: a phone
 * with no db yet, no card and no pods reads zero rather than failing at
 * boot, because this runs on the tab bar, which paints on every frame of
 * every tab.
 */
function podUnreadCount(): number {
  try {
    const codes = listCrews().map(c => c.code);
    if (codes.length === 0) {
      return 0;
    }
    return unreadCount(codes, getMyCard(getDb()).id);
  } catch {
    return 0;
  }
}

function App() {
  return (
    <GestureHandlerRootView style={rootFlex}>
      <SafeAreaProvider>
        {/* Status-bar icons must contrast the ground: dark icons on the
            light palette, light icons on the dark one. activeScheme() is
            what boot resolved before this module loaded; a mid-session
            preference change lands via the JS reload, which re-renders
            this from scratch. */}
        <StatusBar
          barStyle={activeScheme() === 'dark' ? 'light-content' : 'dark-content'}
        />
        <AppContent />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const rootFlex = { flex: 1 } as const;

function AppContent() {
  const insets = useSafeAreaInsets();
  // Keyboard inset on the ROOT: the whole layout (tab bar included) rises
  // above the IME, so the chat input is always visible while typing.
  const keyboardInset = useKeyboardInset();
  const [tab, setTab] = useState<Tab>('now');
  // Has Pods ever been opened? Once true it stays true — see the mount
  // below for why that tab, alone, is kept alive.
  const [podMounted, setPodMounted] = useState(false);
  const openTab = useCallback((t: Tab) => {
    if (t === 'pod') {
      setPodMounted(true);
    }
    setTab(t);
  }, []);
  // The Pods badge follows the two stores that can change the answer: mail
  // arriving or being read, and pods being joined, made or disbanded. Both
  // are revision emitters, so the tab bar re-renders on the same signal the
  // pod screen does — never on a timer.
  const msgRev = useSyncExternalStore(subscribeMessagesChanged, messagesRevision);
  const crewRev = useSyncExternalStore(subscribeCrewsChanged, crewsRevision);
  // The revisions are the deps ON PURPOSE: they are the stores' change
  // signals, not values the count reads, so recomputing exactly when one
  // bumps is the whole contract.
  const podUnread = React.useMemo(podUnreadCount, [msgRev, crewRev]);
  const [status, setStatus] = useState<ModelStatus>({ state: 'idle' });
  // Does the Angel wake up with the app on THIS phone (src/llm/angelRest.ts)?
  // Null until the startup probe answers — nothing may claim she is resting
  // before the phone has been asked how big it is.
  const [angel, setAngel] = useState<AngelPosture | null>(null);
  /** A wake (load) or a rest (unload) actually in flight. */
  const [angelBusy, setAngelBusy] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  // WHO IS TALKING, app-wide (owner field test 2026-08-25): walkie audio
  // plays wherever the camper is in the app, but the only visual lived
  // inside the walkie panel — a muted phone gave no sign at all that a
  // podmate was talking at them. One floating chip, anywhere, ~2.5s.
  const [walkieTalker, setWalkieTalker] = useState<string | null>(null);
  useEffect(() => {
    if (!walkiePresent()) {
      return;
    }
    let clear: ReturnType<typeof setTimeout> | null = null;
    const off = onWalkieSpeaking(sample => {
      setWalkieTalker(sample.name || 'someone');
      if (clear) {
        clearTimeout(clear);
      }
      clear = setTimeout(() => setWalkieTalker(null), 2500);
    });
    return () => {
      off();
      if (clear) {
        clearTimeout(clear);
      }
    };
  }, []);
  // Waypoint compass overlay (no nav library — same plain-state pattern as
  // tabs). Open/target are separate: open-with-null shows the pins picker.
  const [compassOpen, setCompassOpen] = useState(false);
  const [compassTarget, setCompassTarget] = useState<WaypointTarget | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  // First-run gates (0.7.3): onboarding, then the tour, rendered as the LAST
  // overlays so they sit above the tabs and the chat/compass overlays. Lazy
  // initializers read settings (getDb opens on demand — the same pattern as
  // every screen's mount reads). The tour's initializer covers the app being
  // killed between onboarding and the tour: seen-state is only written when a
  // card flow actually ends. Settings can re-open either one (replay rows);
  // the tour ignores tour_seen by construction and a replayed onboarding
  // never erases skipped answers, so neither replay needs a state reset.
  const [showOnboarding, setShowOnboarding] = useState(() => !onboardingDone());
  const [showTour, setShowTour] = useState(() => onboardingDone() && !tourSeen());
  const explicitModelRef = useRef<Promise<boolean> | null>(null);
  /** The path whose load last PUBLISHED — App-owned (the session names only
   * the file), so every explicit chooser can no-op on the already-resident
   * model instead of allocating a second context beside it (review batch
   * 5.2 — dual-context OOM on phones that fit exactly one). */
  const loadedPathRef = useRef<string | null>(null);
  const sessionRef = useRef<LlamaSession | null>(null);
  if (!sessionRef.current) {
    sessionRef.current = new LlamaSession(DEFAULT_PERSONA_ID);
  }
  const session = sessionRef.current;
  const publishModelStatus = useCallback((next: ModelStatus) => {
    setStatus(current => {
      if (
        session.isReady &&
        (next.state === 'loading' || next.state === 'copying')
      ) {
        return current.state === 'ready'
          ? { ...current, detail: next.detail }
          : { state: 'ready', modelName: 'current model', detail: next.detail };
      }
      return next;
    });
  }, [session]);

  // Auto-load a previously imported (or adb-pushed) model at startup.
  // The model then stays RESIDENT for the whole app session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Field-log retention (90 days / 20 MB, oldest first) runs once per
        // launch, before anything writes new rows. Never throws.
        pruneChatLog();
        // Camp-board startup reconciliation: legacy pack-id migration, the
        // writer-incarnation check (restore-clone → rotate, never fork),
        // then the 30-day LOCAL prune. All internally transactional and
        // no-throw; guarded regardless so a camp failure can never block
        // model load.
        try {
          const conn = getDb();
          migrateLegacyOwnPack(conn);
          let fileToken: string | null = null;
          try {
            fileToken = (await fsExists(INCARNATION_TOKEN_PATH))
              ? (await fsReadFile(INCARNATION_TOKEN_PATH, 'utf8')).trim()
              : null;
          } catch {
            fileToken = null; // unreadable = missing; reconcile decides
          }
          const incarnation = reconcileWriterIncarnation(conn, fileToken);
          try {
            await fsWriteFile(INCARNATION_TOKEN_PATH, incarnation.token, 'utf8');
          } catch (e) {
            console.warn('[camp] incarnation token not persisted:', e);
          }
          pruneCampPosts(conn);
          rebuildFtsIndexes(conn);
        } catch (e) {
          console.warn('[camp] startup reconciliation skipped:', e);
        }
        // "My plans" (faves + pins -> searchable doc, src/rightnow/myPlans.ts)
        // lives HERE beside the other once-per-launch data upkeep: its first
        // build rides its own debounce, off the model-load critical path.
        startMyPlansSync();
        const path = await findModel();
        // THE ANGEL'S OWN GATE (owner field report 2026-08-25: a 4 GB phone
        // jetsam-killed three times with the model resident). A phone
        // measured below the constrained boundary leaves her resting unless
        // this camper has said otherwise; every other phone is untouched —
        // posture.awake is true for them exactly as it always was. The
        // deterministic half of the app never asked for a model anyway.
        const posture = await readAngelPosture();
        // First writer wins: a camper who already flipped the switch while
        // this slow boot was still probing must not be overruled by it.
        if (!cancelled) {
          setAngel(current => current ?? posture);
        }
        const explicitLoaded = await (explicitModelRef.current ?? Promise.resolve(false));
        if (path && posture.awake && !explicitLoaded && !session.isReady && !cancelled) {
          if (
            await session.load(path, next => {
              if (!cancelled) {
                publishModelStatus(next);
              }
            })
          ) {
            loadedPathRef.current = path;
          }
        }
      } catch (e: unknown) {
        // A failed replacement publishes a ready diagnostic before rejecting;
        // do not overwrite that usable resident model with a blocking error.
        // With no resident model, every startup failure still surfaces — as
        // a PLAIN sentence: raw detail is diagnostics, not camper UI
        // (public-QA P2-5); the console carries it (a swallowed error here
        // once left the app silently model-less, measured 2026-08-13).
        console.warn(
          '[startup] model load failed:',
          e instanceof Error ? e.message : e,
        );
        if (!cancelled && !session.isReady) {
          setStatus({
            state: 'error',
            detail: 'The model could not start — try choosing it again in Settings.',
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publishModelStatus, session]);

  useEffect(() => () => {
    releaseSessionUntilDone(session).catch(error => {
      console.warn('[llm] app teardown release retry loop failed:', error);
    });
  }, [session]);

  // THE POD'S MAILBOX IS OPEN WHILE THE APP IS (mailbox decoupling,
  // 2026-08-25). Until this line, the crew radio only ever came up from the
  // position-sharing toggle, so two phones sitting next to each other with
  // that switch off exchanged NOTHING — measured, 47 s, zero log lines, an
  // hour of the owner's playa. Mail is not a side-effect of consenting to be
  // located: with a pod on this phone, the app advertises position-free,
  // scans and serves its mailbox for as long as it is on screen. The
  // position toggle still owns every coordinate that leaves this phone.
  useEffect(() => installMailboxPresence(), []);

  /**
   * ONE publication path for every EXPLICIT model choice — import and
   * catalog alike (review batch 5.2; the import row had grown this
   * discipline while the catalog path kept none of it):
   *  - already-resident same path → publish ready and stop, so re-choosing
   *    the loaded model never builds a second context beside it;
   *  - the load is what the delayed startup discovery awaits, so a slow
   *    boot cannot override the camper's in-flight choice;
   *  - a load that publishes REMEMBERS its path (next boot starts on the
   *    model the camper actually picked) and retires the superseded copy;
   *  - persistence failing AFTER publication keeps the running model on a
   *    ready-diagnostic — a settings write must never unpublish a model;
   *  - on failure the copy is discarded only when the caller says so:
   *    an import copy is unreferenced junk, a verified catalog download is
   *    a cached asset the camper should not pay 4 GB to re-fetch.
   * Load rejections propagate (after the discard rule) for caller wording.
   */
  const publishExplicitModel = useCallback(
    async (path: string, keepCopyOnFailure: boolean): Promise<boolean> => {
      if (session.isReady && loadedPathRef.current === path) {
        setStatus({ state: 'ready', modelName: session.loadedModelName ?? 'model' });
        return true;
      }
      const load = session.load(path, setStatus);
      explicitModelRef.current = load.catch(() => false);
      let published: boolean;
      try {
        published = await load;
      } catch (e) {
        if (!keepCopyOnFailure) {
          await discardUnpublishedModel(path).catch(() => {});
        }
        throw e;
      }
      if (!published) {
        if (!keepCopyOnFailure) {
          await discardUnpublishedModel(path);
        }
        return false;
      }
      loadedPathRef.current = path;
      // CHOOSING A MODEL IS OPTING IN. A camper on a small phone who goes to
      // the chooser and waits out a multi-GB download has said what they
      // want more plainly than any switch could; without this the download
      // would finish into an Angel that goes back to resting next launch.
      writeAngelChoice('awake');
      setAngel(current =>
        current ? { ...current, awake: true, chosen: true } : current,
      );
      try {
        const previousPath = rememberModel(path);
        if (previousPath && previousPath !== path) {
          await discardUnpublishedModel(previousPath);
        }
      } catch (e: any) {
        console.warn('[model] choice not persisted:', e?.message ?? e);
        setStatus({
          state: 'ready',
          modelName: session.loadedModelName ?? 'model',
          detail: "Running now, but the choice couldn't be saved — this phone may ask again next launch.",
        });
      }
      return true;
    },
    [session],
  );

  // Pull one catalog entry, showing progress in the status bar's existing
  // 'copying' state (no new UI), then load it. The digest is checked before
  // load, so a torn download reads as "didn't verify, try again" and never
  // as a broken phone.
  const downloadAndLoad = useCallback(
    async (entry: CatalogEntry) => {
      const mb = (n: number) => (n / 1_048_576).toFixed(0);
      setStatus({ state: 'copying', detail: `Downloading ${entry.title}…` });
      const r = await downloadModel(
        entry,
        p => {
          const pct = p.contentLength > 0 ? Math.floor((100 * p.bytesWritten) / p.contentLength) : 0;
          setStatus({
            state: 'copying',
            detail: `Downloading ${entry.title}… ${pct}% (${mb(p.bytesWritten)} of ${mb(p.contentLength)} MB)`,
          });
        },
        phase => {
          if (phase === 'verifying') {
            setStatus({ state: 'copying', detail: `Verifying ${entry.title}'s checksum… (about a minute)` });
          }
        },
      );
      if (!r.ok) {
        // A failed download must NEVER brick a working Angel: chat input
        // gates on status==='ready', so leaving 'error' here disabled a
        // loaded, functioning model until app restart (owner hit it live
        // 2026-08-18 — the 401 from the still-private model repo). Surface
        // the failure, then fall back to ready if a model is resident.
        // Map machine reasons to camper words; raw detail goes to console
        // (public-QA P2-5).
        console.warn('[download] failed:', r.reason, r.detail);
        const friendly =
          r.reason === 'network'
            ? "The download couldn't finish — check your connection and try again."
            : r.reason === 'digest'
              ? "The download didn't verify, so it was removed — try again."
              : 'This model is not available in this build.';
        if (session.isReady) {
          Alert.alert('Download failed', `${friendly}\n\nYour current model is untouched and still running.`);
          setStatus({ state: 'ready', modelName: session.loadedModelName ?? 'model' });
        } else {
          setStatus({ state: 'error', detail: friendly });
        }
        return;
      }
      // keepCopyOnFailure: the download VERIFIED — a load failure (low RAM,
      // interrupted init) must not cost the camper a multi-GB re-fetch.
      try {
        await publishExplicitModel(r.path, true);
      } catch (e: any) {
        console.warn('[download] model load failed:', e?.message ?? e);
        if (session.isReady) {
          Alert.alert(
            'Model failed to start',
            `${entry.title} could not start on this phone.\n\nYour current model is untouched and still running.`,
          );
          setStatus({ state: 'ready', modelName: session.loadedModelName ?? 'model' });
        } else {
          setStatus({
            state: 'error',
            detail: `${entry.title} could not start on this phone — it may need more memory than is free right now.`,
          });
        }
      }
    },
    [publishExplicitModel, session],
  );

  // "Choose model…" -- the one entry point for getting a model onto the
  // phone. Offers the catalog (downloads) first, with "a file on this phone"
  // last, so the adb/Finder path still works for dev without being what a
  // stranger sees first. The phone's REAL numbers drive the labels now:
  // readCircumstances() (total RAM via device-info, free space via the fs
  // probe) feeds recommendedEntry() and per-entry fitEntry(), so the tag a
  // user sees -- recommended / needs more memory / needs N GB free -- is a
  // measurement, not a vibe: the app recommends the best fit while showing
  // every option. A
  // model that does not fit stays VISIBLE and tappable: low-RAM offers "try
  // anyway" (it may load slowly; the error is real and recoverable), while
  // no-room says plainly how much space to free.
  const onPickModel = useCallback(() => {
    (async () => {
      const gb = (n: number) => (n / 1e9).toFixed(1);
      const c = await readCircumstances();
      const downloaded = new Set<string>();
      for (const e of CATALOG) {
        if (await fsExists(localPath(e))) {
          downloaded.add(e.id);
        }
      }
      const rec = recommendedEntry(c, downloaded);
      const buttons: { text: string; onPress: () => void; style?: 'cancel' }[] =
        CATALOG.map(e => {
          const fit = fitEntry(e, c, downloaded.has(e.id));
          const tag =
            fit.status === 'low-ram'
              ? '⚠ needs a phone with more memory'
              : fit.status === 'no-room'
              ? `⚠ needs ${gb(fit.shortBytes)} GB more free space`
              : e.id === rec.id
              ? '★ recommended for this phone'
              : downloaded.has(e.id)
              ? 'already on this phone'
              : '';
          return {
            text: `${e.title} · ~${gb(e.bytes)} GB${tag ? ` · ${tag}` : ''}\n${e.blurb}`,
            onPress: () => {
              if (fit.status === 'fits') {
                downloadAndLoad(e);
                return;
              }
              if (fit.status === 'no-room') {
                Alert.alert(
                  'Not enough free space',
                  `${e.title} needs about ${gb(fit.shortBytes)} GB more free space before it can download.`,
                );
                return;
              }
              Alert.alert(
                'This phone may struggle',
                `${e.title} is sized for phones with ${gb(e.minTotalRamBytes)} GB+ of memory; this one has ${
                  c.totalRamBytes !== undefined ? gb(c.totalRamBytes) : 'an unknown amount'
                }. It may fail to load or run very slowly.`,
                [
                  { text: 'Try anyway', onPress: () => downloadAndLoad(e) },
                  { text: 'Cancel', style: 'cancel' },
                ],
              );
            },
          };
        });
    buttons.push({
      text: 'A file on this phone…',
      onPress: () => {
        (async () => {
          // The resident model's status survives a cancelled or failed
          // import (codex parent behavior, guarded by AppChatLifecycle):
          // 'idle' on cancel or 'error' on a picker failure disabled and
          // hid a model that was still loaded and answering. Restored from
          // the LIVE session, never a captured status — the closure's copy
          // goes stale the moment a load publishes after it was built.
          const restoreResident = () => {
            setStatus(current =>
              current.state === 'copying' ||
              ('detail' in current && current.detail === 'Importing model…')
                ? session.isReady
                  ? { state: 'ready', modelName: session.loadedModelName ?? 'model' }
                  : { state: 'idle' }
                : current,
            );
          };
          try {
            setStatus({ state: 'copying', detail: 'Importing model…' });
            const path = await pickModel();
            if (!path) {
              restoreResident();
              return;
            }
            // Import hygiene rides publishExplicitModel (review batch 5.2):
            // a copy that never published is deleted, a load that publishes
            // remembers its path and retires the superseded copy, and a
            // slow boot's discovery cannot override this in-flight choice.
            await publishExplicitModel(path, false);
          } catch (e: any) {
            console.warn('[import] model load failed:', e?.message ?? e);
            if (session.isReady) {
              // The failed IMPORT must not read as a broken RESIDENT: the
              // loaded model is still answering, so its status returns —
              // and the failure is SAID (binding review C10): restoring
              // ready silently left the camper re-attempting a doomed
              // import with zero feedback.
              Alert.alert(
                'Import failed',
                'That file could not be loaded as a model — it may be damaged or incompatible.\n\nYour current model is untouched and still running.',
              );
              restoreResident();
            } else {
              setStatus({ state: 'error', detail: 'That file could not be loaded as a model — it may be damaged or incompatible.' });
            }
          }
        })();
      },
    });
      // NO dedicated cancel button, ON PURPOSE: Android renders at most
      // THREE Alert buttons and silently drops the rest — with two catalog
      // entries plus the file row we are already at three, and a fourth
      // "Not now" was the one being dropped. Combined with RN's Android
      // default cancelable:false, that shipped a dialog that trapped the
      // user (no outside-tap, no BACK — measured on the Pixel 7,
      // 2026-08-18). cancelable:true IS the cancel affordance. When the
      // catalog grows past two entries this Alert stops fitting at all —
      // the chooser must then become a real screen.
      const known: string[] = [];
      if (c.totalRamBytes !== undefined) {
        known.push(`${gb(c.totalRamBytes)} GB memory`);
      }
      if (c.freeBytes !== undefined) {
        known.push(`${gb(c.freeBytes)} GB free`);
      }
      Alert.alert(
        'Choose a model',
        `${known.length ? `This phone: ${known.join(' · ')}.\n` : ''}Downloads need Wi-Fi and a little patience. Once it is on the phone it works with no signal at all.`,
        buttons,
        { cancelable: true },
      );
    })();
  }, [downloadAndLoad, publishExplicitModel, session]);

  /**
   * THE SWITCH, BOTH WAYS — and both arcs happen NOW, not next launch:
   *
   *  - wake: load the remembered model this instant (through the one
   *    explicit-choice path, so a slow startup discovery cannot race it),
   *    or open the chooser when this phone has no model yet — an Angel you
   *    asked for and cannot get is not a wake.
   *  - rest: unload() frees the native context immediately. That is the
   *    whole point on the phone this was built for: the camper is asking
   *    for the room back for the walkie and the map, and "after you restart
   *    the app" is not an answer when they are standing in the dust.
   *
   * The choice is persisted FIRST, so it survives even if the load fails.
   */
  const setAngelAwake = useCallback(
    (awake: boolean) => {
      writeAngelChoice(awake ? 'awake' : 'resting');
      setAngel(current =>
        current ? { ...current, awake, chosen: true } : current,
      );
      setAngelBusy(true);
      (async () => {
        try {
          if (!awake) {
            await session.unload();
            loadedPathRef.current = null;
            setStatus({ state: 'idle' });
            return;
          }
          const path = await findModel();
          if (!path) {
            onPickModel();
            return;
          }
          // keepCopyOnFailure: nothing was downloaded for this — the file was
          // already on the phone and must survive a load that fails.
          await publishExplicitModel(path, true);
        } catch (e: unknown) {
          // publishExplicitModel already published the camper-facing status
          // (a load failure) and unload's own failure keeps the context
          // owned and retryable; the raw reason is diagnostics.
          console.warn(
            '[angel] wake/rest failed:',
            e instanceof Error ? e.message : e,
          );
        } finally {
          setAngelBusy(false);
        }
      })();
    },
    [onPickModel, publishExplicitModel, session],
  );

  const onAskAngel = useCallback((question: string) => {
    setPendingQuestion(question);
    setChatOpen(true);
  }, []);

  // A scanned pod invite (docs/WALKIE-LADDER.md §8, rung 0) — the third
  // member of the deep-link family, and the ONLY one that asks first.
  //
  // A beam and a friend card are copies: something arrives on the phone and
  // the app says so. A pod is a RELATIONSHIP — joining puts this phone's
  // nameplate on the mesh for that pod (podMembers.ts announces on the next
  // reconcile) and offers a position toggle. That is consent, so it wears
  // the app's established consent shape: the two-button Alert the disband
  // ask uses, with the true sentence in it and no state written until the
  // camper taps Join.
  const askToJoinPod = useCallback(
    (invite: PodInvite) => {
      // The pod's own name when the inviter had named it, and the honest
      // placeholder — which still carries the code — when nobody has. The
      // one thing this ask must never do is put a bare join code where a
      // name belongs (crew.ts, podLabel).
      const podName = invite.name ?? placeholderPodName(invite.code);
      // The card rides along when it fit one QR, and it is who the invite is
      // FROM. Without it the ask names the pod and nothing else, which is
      // still true — a link forwarded through three people has no face.
      const inviter = invite.card?.name.trim() ?? '';
      const from =
        inviter.length > 0 ? `${inviter} invited you — their card comes with it.\n\n` : '';
      Alert.alert(
        `Join ${podName}?`,
        `${from}Joining puts your name on the air in this pod, and where you are while you're sharing. You'll see the same of them.`,
        [
          // Declining writes NOTHING: no crew, no card, no tab change. The
          // invite is just a URL, so a second scan asks again.
          { text: 'Not now', style: 'cancel' },
          {
            text: 'Join',
            onPress: () => {
              try {
                // The code is the identity and joinCrew is idempotent on it,
                // so scanning the same invite twice — or scanning a pod this
                // phone already types into — lands in the SAME pod.
                const joined = joinCrew(invite.code);
                // The invite's name is the MESH's name delivered by eyeball,
                // not a name this phone's owner typed. joinCrew's `name`
                // argument stores nameSource 'mine', which would freeze the
                // pod against a later rename AND make this phone re-broadcast
                // a name it never chose — the exact regression podMembers.ts
                // records as measured ("a joiner adopted the name and
                // immediately started announcing it as their own"). So the
                // name is adopted through adoptPodName's own rule instead:
                // 'mesh', and only over a name nobody here chose.
                if (
                  invite.name !== undefined &&
                  invite.name !== joined.name &&
                  canAdoptPodName(joined)
                ) {
                  saveCrew({ ...joined, name: invite.name, nameSource: 'mesh' });
                }
              } catch (e: any) {
                Alert.alert("Couldn't join that pod", e?.message ?? String(e));
                return;
              }
              try {
                // The inviter's card through the ONE import path a beamed
                // friend card uses — same merge rules (greatest seq wins, my
                // own id skipped), no second importer to drift.
                const bundle = inviteCardBundleJson(invite);
                if (bundle) {
                  installFriendBundle(getDb(), bundle);
                }
              } catch (e: any) {
                // A card that will not install costs a face for a few
                // minutes; the mesh delivers it anyway. It must never cost
                // the pod the camper just agreed to join.
                console.warn('[pod invite] card not installed:', e?.message ?? e);
              }
              // RADIOS (invite.radios, §4): nothing to do here, and that is
              // a finding rather than an omission. The announce/reconcile
              // seam only ever puts THIS phone's rungs on the air — the
              // `radios` reconcilePods passes is myRungsSync(), and the only
              // store of a PEER's rungs is announcedMembers(), which is
              // built from pod-member records that peer actually authored.
              // Writing the inviter's bitmap there would mean minting a
              // record in their name, which the relay would then spread as
              // their word — §5's line is that capability is announced by
              // the phone that has it. So the invite's radios rides the
              // NORMAL flow: the inviter's own announcement carries the same
              // field and arrives over rung 1/2. Nothing in this build reads
              // a peer's rungs yet either way (§10: "inert but travelling").
              //
              // Landing on Pods is not decoration: it MOUNTS CrewSection,
              // whose reconcile effect is what actually announces this phone
              // into the pod it just joined. The new pod is saveCrew's
              // unshift, so it is the first chip; a camper who had already
              // selected another pod stays on that one and picks the new
              // chip themselves (activePodId is CrewSection's own state).
              openTab('pod');
            },
          },
        ],
      );
    },
    [openTab],
  );

  // Deep links (Friends on playa, 2026-08-19; pod invites 2026-08-24): a
  // scanned QR or tapped link opens the app carrying its whole payload in the
  // URL FRAGMENT, which no browser ever sends to a server — decode, act, tell
  // the camper. Works with zero connectivity by design.
  //
  // Three path-anchored families, one door: /b a camp beam, /f a friend card,
  // /p a pod invite. The first two are COPIES and install on arrival; the
  // third starts a relationship and therefore asks. A URL that is none of
  // them falls through silently — this handler also sees every link the two
  // other filters carry.
  //
  // TWO SOURCES, ONE ACTOR (2026-08-25). `Linking` is no longer the only way
  // a link arrives: the in-app scanner reads a QR off the phone in front of
  // you and hands the text to subscribeIncomingUrl. It DELIVERS rather than
  // acts, on purpose — the merge rules, the consent ask and the sentences a
  // camper reads all live in this handler, and a second copy of them would
  // drift the first time one was edited.
  useEffect(() => {
    const handle = (url: string | null | undefined) => {
      if (!url) {
        return;
      }
      try {
        // A beam link (the sibling of the friend card, contract §5): a small
        // board scanned off a campmate's screen. Path-anchored decoders mean
        // the two can never be mistaken for each other.
        const beamJson = decodeBeamLink(url);
        if (beamJson) {
          const r = installIncomingPayload({ name: 'beam link', content: beamJson, source: 'link' });
          notifyBeamInstalled();
          Alert.alert('Beam received', describeInstall(r));
          return;
        }
        const json = decodeFriendLink(url);
        if (json) {
          const r = installFriendBundle(getDb(), json);
          const bits = [
            r.added.length > 0 ? `added ${r.added.join(', ')}` : null,
            r.updated.length > 0 ? `updated ${r.updated.join(', ')}` : null,
            r.added.length + r.updated.length === 0 ? 'nothing new' : null,
          ].filter(Boolean);
          Alert.alert('Friends on playa', `${bits.join('; ')} — see the Camp tab.`);
          return;
        }
        // A pod invite (rung 0). Third and last, in the same path-anchored
        // family — a /f or /b link returns null here and a /p link returns
        // null from the two decoders above, so the order is for reading, not
        // for correctness. Unlike its two siblings this one INSTALLS
        // NOTHING: it opens a question (askToJoinPod).
        const invite = decodePodLink(url);
        if (invite) {
          askToJoinPod(invite);
        }
      } catch (e: any) {
        Alert.alert("Couldn't read that card", e?.message ?? String(e));
      }
    };
    Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener('url', ev => handle(ev.url));
    const offScan = subscribeIncomingUrl(handle);
    return () => {
      sub.remove();
      offScan();
    };
  }, [askToJoinPod]);

  // Beam files (docs/BEAM-INGRESS-CONTRACT.md): a .playapal opened from
  // Files / Quick Share / AirDrop / a share sheet was copied by native code
  // and queued; this drains the queue on mount (cold start) and on every
  // warm delivery, and installs through the same seam as the picker.
  useEffect(() => startBeamIngress(), []);

  // A TAPPED POCKET BUZZ LANDS SOMEWHERE (src/crews/pocketAlerts.ts, the
  // taps section). The notification was minted on this phone from a record
  // in this phone's store, so it knows which pod it is about; the tap
  // hands that pod back and the camper arrives at its Mail pane instead of
  // at a home screen with the finding still to do.
  //
  // The tab open is this shell's half, exactly as it is for a pod invite:
  // openTab('pod') is what MOUNTS CrewSection, and the card reads the
  // standing landing (podLanding.ts) on its first effect. A call's tap
  // asks for nothing here — its ringing panel is above every tab already.
  useEffect(() => startPocketAlertTaps(() => openTab('pod')), [openTab]);

  const onOpenCompass = useCallback((target: WaypointTarget | null) => {
    setCompassTarget(target);
    setCompassOpen(true);
  }, []);

  // Onboarding done (first run or replay): the flow has already persisted its
  // answers, seeded the Home pin, and marked itself done — the host only
  // unmounts it, then hands first-runners straight to the tour.
  const finishOnboarding = useCallback(() => {
    setShowOnboarding(false);
    if (!tourSeen()) {
      setShowTour(true);
    }
  }, []);

  return (
    <View
      style={[
        styles.root,
        {
          paddingTop: insets.top,
          paddingBottom: Math.max(insets.bottom, keyboardInset),
        },
      ]}>
      <View style={styles.header}>
        <Text style={styles.title}>🦛 {APP_DISPLAY_NAME}</Text>
        {/* The two header doors — rendered ABOVE the tab conditional, so
            both are one tap from every tab. The Map pill kept its 2026-08-20
            seat; the Angel's door moved DOWN to the tab bar (owner IA,
            Aug 27: the Angel is optional, the row is for what campers live
            in — and a bar slot is a steadier door than a pill). Settings
            took the Angel's header seat as a gear, which is where a decade
            of app habit already looks for it. The giant Take-me-home button
            stays on Now: this is the everyday map, not the 3am emergency,
            and the emergency outranks tidiness. */}
        <View style={styles.headerDoors}>
          <HomeArrow
            onPress={() => onOpenCompass(null)}
            pillStyle={styles.headerWingPill}
            textStyle={styles.headerWing}
          />
          <Pressable
            onPress={() => openTab('settings')}
            hitSlop={spacing.md}
            accessibilityLabel="Open Settings"
            style={styles.headerWingPill}>
            <Text style={styles.headerWing}>⚙️</Text>
          </Pressable>
        </View>
        <View
          style={[
            styles.modelDot,
            {
              backgroundColor:
                status.state === 'ready'
                  ? colors.sage
                  : status.state === 'loading' || status.state === 'copying'
                  ? colors.gold
                  : colors.haze,
            },
          ]}
        />
      </View>
      {walkieTalker ? (
        // The chip floats over every tab; pointerEvents none so it can
        // never eat a tap. Live region: a screen reader says it too.
        <View
          style={styles.talkChip}
          pointerEvents="none"
          accessibilityLiveRegion="polite">
          <Text style={styles.talkChipText}>🔊 {walkieTalker} is talking</Text>
        </View>
      ) : null}
      <View style={styles.body}>
        {tab === 'now' ? (
          <RightNowScreen onAskAngel={onAskAngel} onOpenCompass={onOpenCompass} />
        ) : null}
        {/* Pods mounts on first visit and then STAYS mounted, hidden — the
            ChatScreen treatment, for the same reason and two more. A tab
            switch must not throw away a half-typed message, must not put a
            camper back on the wrong pod after they deliberately switched to
            their small one, and must not hang up a walkie channel they
            turned on to go look at the map. Lazy, not eager: a phone whose
            owner never opens Pods never pays for the roster query. */}
        {podMounted ? (
          <View style={tab === 'pod' ? styles.screenShown : styles.screenHidden}>
            <PodScreen onOpenCompass={onOpenCompass} active={tab === 'pod'} />
          </View>
        ) : null}
        {/* ChatScreen stays MOUNTED across tab switches. Its message list
            is the UI half of the llama session's transcript, and the session
            is a singleton that survives navigation — unmounting orphaned the
            pair (Pixel 7, 2026-08-17): the tab came back showing a fresh
            thread while the session still carried the old exchanges, so the
            next question rode invisible history and the model echoed its own
            stale answer without calling a single tool. */}
        {tab === 'camp' ? <CampScreen onOpenCompass={onOpenCompass} /> : null}
        {tab === 'settings' ? (
          <SettingsScreen
            onChooseModel={onPickModel}
            onReplayTour={() => setShowTour(true)}
            onReplaySetup={() => setShowOnboarding(true)}
            angel={angel}
            angelBusy={angelBusy}
            onAngelChange={setAngelAwake}
          />
        ) : null}
      </View>
      {/* CALLS RING ANYWHERE (owner un-defer, 2026-08-25). The walkie
          session is owned above the pod card now (src/crews/walkieSession.ts),
          so its two app-level surfaces mount HERE, once, outside every tab:
          the ring/call surface, which floats over whatever is on screen with
          a zIndex above the talking chip, and the mini-bar, which is a plain
          row that takes its space directly ABOVE the tab bar — a permanent
          bar covering the tabs would be a worse lie than the one it fixes.

          NOT the same as ringing with the app closed. That needs an Android
          foreground service and Apple PushToTalk (the capability is enabled
          on the App ID) and is the named next step.

          Opening from the mini-bar lands on Pods; CrewSection brings its
          card to the pod whose channel is actually open. */}
      <WalkieDeck onOpenPanel={() => openTab('pod')} />
      <View style={styles.tabBar} accessibilityRole="tablist">
        {TABS.map(t => {
          const unread = t.key === 'pod' ? podUnread : 0;
          return (
            <Pressable
              key={t.key}
              style={styles.tabBtn}
              onPress={() => openTab(t.key)}
              // A tab says it IS a tab and whether it is the one showing
              // (a11y review 2026-08-24): the active tab was a color change
              // and nothing else, which is silent to a screen reader.
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === t.key }}
              accessibilityLabel={
                unread > 0
                  ? `${t.label}, ${unread} message${unread === 1 ? '' : 's'} waiting`
                  : t.label
              }>
              <View style={styles.tabInner}>
                <Text style={[styles.tabText, tab === t.key && styles.tabActive]}>
                  {t.label}
                </Text>
                {/* The count is spoken in the tab's own label above, so the
                    badge is decorative to a screen reader — hidden on both
                    platforms (they spell it differently) so it is never
                    read a second time as a bare number. */}
                {unread > 0 ? (
                  <View
                    style={styles.tabBadge}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants">
                    <Text style={styles.tabBadgeText}>
                      {unread > 99 ? '99+' : String(unread)}
                    </Text>
                  </View>
                ) : null}
              </View>
            </Pressable>
          );
        })}
        {/* The Angel's door, in the row (owner IA, Aug 27). Not a Tab —
            the Angel remains the ask-mode overlay it always was, and the
            label below is the one AppChatLifecycle has always pressed —
            but the door now sits where a thumb expects a fourth room.
            While the overlay is up it covers this bar, so the selected
            state exists for the screen reader, not the eye. */}
        <Pressable
          style={styles.tabBtn}
          onPress={() => setChatOpen(true)}
          accessibilityRole="tab"
          accessibilityState={{ selected: chatOpen }}
          accessibilityLabel="Open the Angel conversation">
          <View style={styles.tabInner}>
            <Text style={[styles.tabText, chatOpen && styles.tabActive]}>
              Angel
            </Text>
          </View>
        </Pressable>
      </View>
      <View
        style={
          chatOpen
            ? [
                styles.chatOverlay,
                { top: insets.top, bottom: Math.max(insets.bottom, keyboardInset) },
              ]
            : styles.screenHidden
        }>
        <View style={styles.chatOverlayHeader}>
          <Text style={styles.chatOverlayTitle}>🪽 Angel</Text>
          <Pressable
            onPress={() => setChatOpen(false)}
            hitSlop={spacing.md}
            accessibilityLabel="Close the conversation">
            <Text style={styles.chatOverlayClose}>✕</Text>
          </Pressable>
        </View>
        <ChatScreen
          session={session}
          status={status}
          onStatus={setStatus}
          onPickModel={onPickModel}
          angel={angel}
          angelBusy={angelBusy}
          onAngelChange={setAngelAwake}
          // The overlay retains the screen hidden (screenHidden), so the
          // visibility signal is what stops a hidden chat from speaking —
          // the exact defect the prop exists for (codex batch).
          active={chatOpen}
          pendingQuestion={pendingQuestion}
          onPendingConsumed={() => setPendingQuestion(null)}
        />
      </View>
      {compassOpen ? (
        <View
          style={[
            styles.compassOverlay,
            { top: insets.top, bottom: Math.max(insets.bottom, keyboardInset) },
          ]}>
          <CompassScreen
            initialTarget={compassTarget}
            onClose={() => setCompassOpen(false)}
          />
        </View>
      ) : null}
      {showOnboarding ? (
        <View
          style={[
            styles.firstRunOverlay,
            { top: insets.top, bottom: Math.max(insets.bottom, keyboardInset) },
          ]}>
          <OnboardingFlow onDone={finishOnboarding} />
        </View>
      ) : null}
      {showTour ? <Tour onDone={() => setShowTour(false)} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.dust },
  screenShown: { flex: 1 },
  screenHidden: { display: 'none' },
  // Absolute children position against the root's border box, NOT its
  // padding box (Pixel 7, 2026-08-19: the Angel header rendered under the
  // status-bar clock and the input hid behind the keyboard while every tab
  // screen rose correctly). So each overlay carries the safe-area +
  // keyboard insets itself, inline at the mount.
  chatOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.dust,
  },
  chatOverlayHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  chatOverlayTitle: { color: colors.night, fontSize: type.body, fontWeight: '700' },
  chatOverlayClose: { color: colors.night, fontSize: 22, paddingHorizontal: spacing.sm },
  // the two doors travel together, so space-between still reads
  // title | doors | model-dot rather than spreading four children
  headerDoors: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  headerWingPill: {
    backgroundColor: colors.sand,
    borderRadius: 999,
    paddingHorizontal: spacing.md,
    paddingVertical: 4,
  },
  headerWing: { fontSize: type.small, fontWeight: '700', color: colors.night },
  compassOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.dust,
  },
  // Onboarding rides the same inset-carrying absolute-overlay shape as the
  // chat/compass overlays (see the border-box note above); its TextInputs
  // need the keyboard inset just like the chat's.
  firstRunOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.dust,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  title: { color: colors.night, fontSize: type.title, fontWeight: '800' },
  modelDot: { width: 10, height: 10, borderRadius: 5 },
  body: { flex: 1 },
  activeScreen: { flex: 1 },
  hiddenScreen: { display: 'none' },
  talkChip: {
    alignSelf: 'center',
    backgroundColor: colors.sage,
    borderRadius: radius.card,
    elevation: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    position: 'absolute',
    top: 108,
    zIndex: 40,
  },
  talkChipText: {
    color: colors.onAccent,
    fontSize: type.body,
    fontWeight: '800',
  },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: colors.haze,
    backgroundColor: colors.dust,
  },
  tabBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: tap.minHeight, // 44pt floor — padding alone left this at ~40
    paddingVertical: spacing.md,
  },
  // Label and badge ride one row so the badge sits beside the word rather
  // than over it: at four tabs there is room, and an overlapping dot on a
  // text-only bar reads as damage.
  tabInner: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  tabText: { color: colors.faded, fontSize: type.small, fontWeight: '600' },
  tabActive: { color: colors.clay, fontWeight: '800' },
  tabBadge: {
    backgroundColor: colors.clay,
    borderRadius: radius.chip,
    minWidth: 18,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  tabBadgeText: {
    color: colors.onAccent,
    fontSize: type.tiny,
    fontWeight: '800',
    textAlign: 'center',
  },
});

export default App;
