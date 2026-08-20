/**
 * Playa Pal — offline LLM companion for
 * Black Rock City. "Playa Angel" is the default GUIDE PERSONA inside the app,
 * not the app name.
 *
 * Tabs: Right Now (default, deterministic, works with no model), Angel
 * (persona chat over llama.rn), Camp (shared camp inventory — camp pack v0),
 * Settings.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Linking,
  Alert,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import { RightNowScreen } from './src/screens/RightNowScreen';
import { CompassScreen } from './src/screens/CompassScreen';
import type { WaypointTarget } from './src/geo/brcGeo';
import { ChatScreen } from './src/screens/ChatScreen';
import { CampScreen } from './src/screens/CampScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { useKeyboardInset } from './src/hooks/useKeyboardInset';
import { LlamaSession } from './src/llm/LlamaSession';
import { DEFAULT_PERSONA_ID } from './src/llm/personas';
import { findModel, pickModel } from './src/llm/modelFile';
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
import { installFriendBundle } from './src/friends/friendCard';
import { decodeFriendLink } from './src/friends/friendLink';
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
import { APP_DISPLAY_NAME } from './src/legal';
import type { ModelStatus } from './src/types';
import { colors, spacing, type } from './src/theme';

type Tab = 'now' | 'camp' | 'settings';

// Tier-2 neural "Angel voice" (Kokoro via sherpa-onnx) joins the speech
// registry at startup; the platform backend registers itself as tier 1 and
// stays the default. Registration is idempotent and does NOT load the model
// (that happens lazily on first speak).
registerSpeechBackend(kokoroSpeechBackend);

// Option A consolidation (owner-picked 2026-08-19): three questions, three
// tabs — the Angel is not a place, it is the ask-mode of Now, reachable from
// the wing button and every "Ask the Angel" affordance, rendered as a
// full-screen conversation overlay. Packs dissolved into Camp (camp/private
// packs + import + campmates' boards) and Settings (public packs).
const TABS: { key: Tab; label: string }[] = [
  { key: 'now', label: 'Now' },
  { key: 'camp', label: 'Camp' },
  { key: 'settings', label: 'Settings' },
];

function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <AppContent />
    </SafeAreaProvider>
  );
}

function AppContent() {
  const insets = useSafeAreaInsets();
  // Keyboard inset on the ROOT: the whole layout (tab bar included) rises
  // above the IME, so the chat input is always visible while typing.
  const keyboardInset = useKeyboardInset();
  const [tab, setTab] = useState<Tab>('now');
  const [status, setStatus] = useState<ModelStatus>({ state: 'idle' });
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null);
  // Waypoint compass overlay (no nav library — same plain-state pattern as
  // tabs). Open/target are separate: open-with-null shows the pins picker.
  const [compassOpen, setCompassOpen] = useState(false);
  const [compassTarget, setCompassTarget] = useState<WaypointTarget | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const sessionRef = useRef<LlamaSession | null>(null);
  if (!sessionRef.current) {
    sessionRef.current = new LlamaSession(DEFAULT_PERSONA_ID);
  }
  const session = sessionRef.current;

  // Auto-load a previously imported (or adb-pushed) model at startup.
  // The model then stays RESIDENT for the whole app session.
  useEffect(() => {
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
        const path = await findModel();
        if (path) {
          await session.load(path, setStatus);
        }
      } catch (e: any) {
        // Surface EVERY startup failure (findModel included) to the status
        // bar — a swallowed error here once left the app silently model-less
        // (measured 2026-08-13). Raw detail is diagnostics, not camper UI
        // (public-QA P2-5): console carries it, the bar stays plain.
        console.warn('[startup] model load failed:', e?.message ?? e);
        setStatus({ state: 'error', detail: 'The model could not start — try choosing it again in Settings.' });
      }
    })();
  }, [session]);

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
      await session.load(r.path, setStatus);
    },
    [session],
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
          try {
            setStatus({ state: 'copying', detail: 'Importing model…' });
            const path = await pickModel();
            if (!path) {
              setStatus({ state: 'idle' });
              return;
            }
            await session.load(path, setStatus);
          } catch (e: any) {
            console.warn('[import] model load failed:', e?.message ?? e);
            setStatus({ state: 'error', detail: 'That file could not be loaded as a model — it may be damaged or incompatible.' });
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
  }, [downloadAndLoad, session]);

  const onAskAngel = useCallback((question: string) => {
    setPendingQuestion(question);
    setChatOpen(true);
  }, []);

  // Friend-card deep links (Friends on playa, 2026-08-19): a scanned QR or
  // tapped link opens the app carrying the card in the URL fragment — decode,
  // install, tell the camper. Works with zero connectivity by design.
  useEffect(() => {
    const handle = (url: string | null | undefined) => {
      if (!url) {
        return;
      }
      try {
        const json = decodeFriendLink(url);
        if (!json) {
          return;
        }
        const r = installFriendBundle(getDb(), json);
        const bits = [
          r.added.length > 0 ? `added ${r.added.join(', ')}` : null,
          r.updated.length > 0 ? `updated ${r.updated.join(', ')}` : null,
          r.added.length + r.updated.length === 0 ? 'nothing new' : null,
        ].filter(Boolean);
        Alert.alert('Friends on playa', `${bits.join('; ')} — see the Camp tab.`);
      } catch (e: any) {
        Alert.alert("Couldn't read that card", e?.message ?? String(e));
      }
    };
    Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener('url', ev => handle(ev.url));
    return () => sub.remove();
  }, []);

  const onOpenCompass = useCallback((target: WaypointTarget | null) => {
    setCompassTarget(target);
    setCompassOpen(true);
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
        <Pressable
          onPress={() => setChatOpen(true)}
          hitSlop={spacing.md}
          accessibilityLabel="Open the Angel conversation"
          style={styles.headerWingPill}>
          <Text style={styles.headerWing}>🪽 Angel</Text>
        </Pressable>
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
      <View style={styles.body}>
        {tab === 'now' ? (
          <RightNowScreen onAskAngel={onAskAngel} onOpenCompass={onOpenCompass} />
        ) : null}
        {/* ChatScreen stays MOUNTED across tab switches. Its message list
            is the UI half of the llama session's transcript, and the session
            is a singleton that survives navigation — unmounting orphaned the
            pair (Pixel 7, 2026-08-17): the tab came back showing a fresh
            thread while the session still carried the old exchanges, so the
            next question rode invisible history and the model echoed its own
            stale answer without calling a single tool. */}
        {tab === 'camp' ? <CampScreen onOpenCompass={onOpenCompass} /> : null}
        {tab === 'settings' ? <SettingsScreen onChooseModel={onPickModel} /> : null}
      </View>
      <View style={styles.tabBar}>
        {TABS.map(t => (
          <Pressable
            key={t.key}
            style={styles.tabBtn}
            onPress={() => setTab(t.key)}>
            <Text style={[styles.tabText, tab === t.key && styles.tabActive]}>
              {t.label}
            </Text>
          </Pressable>
        ))}
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
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: colors.haze,
    backgroundColor: colors.dust,
  },
  tabBtn: { flex: 1, alignItems: 'center', paddingVertical: spacing.md },
  tabText: { color: colors.faded, fontSize: type.small, fontWeight: '600' },
  tabActive: { color: colors.clay, fontWeight: '800' },
});

export default App;
