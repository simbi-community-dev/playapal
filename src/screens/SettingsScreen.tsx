/**
 * Settings — Spoken Replies (master toggle, voice picker, rate slider, the
 * Android offline-voice-data nudge) plus the Field log share row: the
 * on-device conversation log exported session-grouped through the system
 * share sheet. The log never leaves the device any other way. Plus the
 * "Share the app" row: Playa Pal handing ITSELF to a phone that has none
 * (docs/FINAL-WEEK.md "Lane D").
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Linking,
  Alert,
  DeviceEventEmitter,
  NativeModules,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
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
import { PackReader } from './PackReader';
import { version as APP_VERSION } from '../../package.json';

/**
 * Lane D — the app-bootstrap hole. A campmate with no app cannot receive a
 * beam, and on playa they cannot download one. Android can hand over its own
 * installed APK with no internet at all; iOS cannot sideload, so that half is
 * the TestFlight public link and the one moment of signal it needs.
 *
 * An EMPTY link is an honest state, not a bug: the row says the build is not
 * published yet rather than opening a dead URL. Pending from the coordinator
 * (asked in #playapal, 2026-08-21).
 */
const TESTFLIGHT_PUBLIC_LINK = '';
const SHARE_APP_PROGRESS_EVENT = 'PlayaPalShareAppProgress';

type AppShareInfo = {
  versionName: string;
  bytes: number;
  shareable: boolean;
  splitInstall: boolean;
};
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
import { RateSlider } from '../components/RateSlider';
import { colors, radius, spacing, type } from '../theme';

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
}

interface ModelRowState {
  entry: CatalogEntry;
  downloaded: boolean;
  active: boolean;
  fit: EntryFit;
  recommended: boolean;
}

export function SettingsScreen({ onChooseModel }: SettingsScreenProps = {}) {
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
  const [publicPacksOpen, setPublicPacksOpen] = useState(false);
  // The offline reader (owner commission 2026-08-19): 'Read' on a pack row
  // swaps the whole screen for the reader — the LineageScreen pattern, one
  // piece of state, no navigator.
  const [readingPack, setReadingPack] = useState<PackRow | null>(null);
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

  // The app ITSELF, handed phone-to-phone. `describe` costs a stat() and no
  // copy, so the row can name the real size before the tap; the progress
  // event carries the whole-APK copy (132.5 MB release, 292.5 debug), which
  // is far too long to leave a row
  // looking dead.
  const [appShare, setAppShare] = useState<AppShareInfo | null>(null);
  const [preparingPct, setPreparingPct] = useState<number | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'android' || !NativeModules.ShareApp) {
      return;
    }
    let alive = true;
    NativeModules.ShareApp.describe()
      .then((d: AppShareInfo) => {
        if (alive) {
          setAppShare(d);
        }
      })
      .catch(() => {
        // A phone that cannot read its own APK still gets the row; the tap
        // is where it says so, with the native error.
      });
    const sub = DeviceEventEmitter.addListener(
      SHARE_APP_PROGRESS_EVENT,
      (e: { percent?: number }) => {
        setPreparingPct(typeof e?.percent === 'number' ? e.percent : null);
      },
    );
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  const shareApp = useCallback(async () => {
    if (Platform.OS === 'android') {
      const mod = NativeModules.ShareApp;
      if (!mod) {
        Alert.alert(
          'Not available in this build',
          'This copy of Playa Pal cannot pass itself on. Update from a phone that can.',
        );
        return;
      }
      setPreparingPct(0);
      try {
        await mod.shareApp();
      } catch (e: any) {
        Alert.alert('Could not prepare the app', e?.message ?? String(e));
      } finally {
        setPreparingPct(null);
      }
      return;
    }
    if (!TESTFLIGHT_PUBLIC_LINK) {
      Alert.alert(
        'No install link yet',
        'The public TestFlight link is not published yet. An Android phone nearby can pass Playa Pal along with no internet at all.',
      );
      return;
    }
    try {
      await Share.share({
        title: 'Playa Pal',
        message: `Playa Pal — the offline playa companion. Install it here: ${TESTFLIGHT_PUBLIC_LINK}`,
      });
    } catch {
      // Share sheet dismissed or unavailable — nothing to clean up.
    }
  }, []);

  const appShareMb =
    appShare && appShare.bytes > 0
      ? ` (${Math.round(appShare.bytes / 1048576)} MB)`
      : '';
  const shareAppDesc =
    Platform.OS === 'android'
      ? appShare && !appShare.shareable
        ? 'This copy was installed in per-device pieces, so it cannot be passed on whole. A phone that installed the APK directly can share it.'
        : `Hands the whole app${appShareMb} to a phone that has none — Quick Share, Bluetooth or a cable, no internet needed.\n\nOn their phone, open it from Files → Downloads, not the transfer popup’s own Open button, which can launch the wrong app.\n\nThen turn on “Allow from this source” when Android asks, and when Play Protect says the developer is unknown, tap “More details” and the small “Install anyway” — the big button cancels.\n\nOne rule of the road: a phone that installed Playa Pal from the Play Store updates from the Play Store — beams install only onto phones that have no app yet, or got it by beam.`
      : TESTFLIGHT_PUBLIC_LINK
      ? 'Sends the TestFlight invite. iPhones can only install from Apple, so they need signal once — an Android phone nearby can pass the app along with none.'
      : 'The public TestFlight link is not published yet.';

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
      } catch (e: any) {
        if (!cancelled) {
          setVoicesError(e?.message ?? String(e));
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
      {/* The model roster: every option the app knows, each stamped with
          this phone's measured verdict. The section only reads; the one
          download/switch mechanism stays the chooser Alert (Angel tab and
          the button below), so there is exactly one way models move. */}
      <Text style={styles.sectionTitle}>Angel model</Text>
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
          <Pressable style={styles.row} onPress={onChooseModel}>
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>Choose or download a model</Text>
              <Text style={styles.rowDesc}>
                {phoneLine
                  ? `This phone: ${phoneLine}.`
                  : 'Downloads need Wi-Fi; core chat, events, and guides run offline after.'}
              </Text>
            </View>
            <Text style={styles.rowChevron}>›</Text>
          </Pressable>
        ) : null}
      </View>

      <Text style={styles.sectionTitle}>Spoken replies</Text>
      <View style={styles.card}>
        <View style={styles.row}>
          <View style={styles.rowBody}>
            <Text style={styles.rowTitle}>Speak answers out loud</Text>
            <Text style={styles.rowDesc}>
              The Angel reads each finished reply with your device's own
              voice — fully offline with an offline voice installed.
            </Text>
          </View>
          <Switch
            value={settings.enabled}
            onValueChange={enabled => update({ enabled })}
            trackColor={{ true: colors.sage, false: colors.haze }}
          />
        </View>
      </View>

      {settings.enabled ? (
        <>
          {listSpeechBackends().length > 1 ? (
            <>
              <Text style={styles.sectionTitle}>Voice engine</Text>
              <View style={[styles.card, styles.backendRow]}>
                {listSpeechBackends().map(b => (
                  <Pressable
                    key={b.id}
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
                  onPress={() => backend.openVoiceDataInstaller!().catch(() => {})}>
                  <Text style={styles.noticeBtnText}>
                    Get offline voice data…
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}

          <Text style={styles.sectionTitle}>Voice</Text>
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
          <Text style={styles.hint}>
            Tap a voice to hear it. Voices marked offline work with no signal —
            that's what you want out there.
          </Text>

          <Text style={styles.sectionTitle}>
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
            onPress={() => speakSample(settings.voiceId, settings.rate)}>
            <Text style={styles.testBtnText}>Hear a sample</Text>
          </Pressable>
        </>
      ) : null}

      <Text style={styles.sectionTitle}>Share the app</Text>
      <View style={styles.card}>
        <Pressable
          style={styles.row}
          onPress={shareApp}
          disabled={preparingPct !== null}
          accessibilityRole="button"
          accessibilityState={{ disabled: preparingPct !== null }}
          accessibilityLabel="Share Playa Pal">
          <View style={styles.rowBody}>
            <Text style={styles.rowTitle}>
              {preparingPct === null
                ? 'Share Playa Pal'
                : `Preparing… ${preparingPct}%`}
            </Text>
            <Text style={styles.rowDesc}>{shareAppDesc}</Text>
          </View>
          <Text style={styles.rowChevron}>›</Text>
        </Pressable>
      </View>

      <Text style={styles.sectionTitle}>Field log</Text>
      <View style={styles.card}>
        <Pressable style={styles.row} onPress={shareLog}>
          <View style={styles.rowBody}>
            <Text style={styles.rowTitle}>Share conversation log</Text>
            <Text style={styles.rowDesc}>
              Kept on this device until you share it. Exports full chats,
              retrieved passages and tool details, model name, and timings —
              review before sharing.
              {logStats && logStats.rows > 0
                ? ` ${logStats.rows} entries across ${logStats.sessions} chat${
                    logStats.sessions === 1 ? '' : 's'
                  } · ~${Math.max(1, Math.round(logStats.bytes / 1024))} KB.`
                : ' Nothing logged yet.'}
            </Text>
          </View>
          <Text style={styles.rowChevron}>›</Text>
        </Pressable>
        <Pressable style={styles.row} onPress={shareQueries}>
          <View style={styles.rowBody}>
            <Text style={styles.rowTitle}>Share question log</Text>
            <Text style={styles.rowDesc}>
              Questions asked, what the app looked up, answer excerpts,
              timestamps, and timings — small enough to send after the burn.
              Kept on this device until you share it; review before sharing.
            </Text>
          </View>
          <Text style={styles.rowChevron}>›</Text>
        </Pressable>
      </View>

      {/* Public packs — the retired Packs tab's public half (Option A).
          Camp and private packs are managed on the Camp tab; this section
          is collapsed by default since public packs need no tending. */}
      <Pressable
        style={styles.sectionTitleRow}
        onPress={() => setPublicPacksOpen(o => !o)}
        accessibilityRole="button"
        accessibilityLabel="Public packs">
        <Text style={styles.sectionTitle}>Public packs</Text>
        <Text style={styles.sectionChevron}>{publicPacksOpen ? '˅' : '›'}</Text>
      </Pressable>
      {publicPacksOpen ? (
        <View style={styles.card}>
          <Text style={styles.rowDesc}>
            Included with Playa Pal and updated when the app is updated. Camp
            and private packs live on the Camp tab.
          </Text>
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
      ) : null}

      {/* "Don't use this" promises Settings > Hidden. This is that. Present
          even when empty, so the promise is never a dead end -- an empty list
          is an honest state, a missing section is a broken one. */}
      <Text style={styles.sectionTitle}>Hidden</Text>
      <View style={styles.card}>
        {hidden.length === 0 ? (
          <View style={styles.row}>
            <View style={styles.rowBody}>
              <Text style={styles.rowDesc}>
                Nothing hidden. Press and hold anything the Angel shows you —
                a person, an event, a source — and choose "Don't use" to keep
                it out of answers on this phone. It lands here so you can bring
                it back.
              </Text>
            </View>
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

      {/* About (owner ask 2026-08-19): who made this, which version, where
          it lives. The version is package.json's — the single source. */}
      <Text style={styles.sectionTitle}>About</Text>
      <View style={styles.card}>
        <Text style={styles.rowTitle}>Playa Pal {APP_VERSION}</Text>
        <Text style={styles.rowDesc}>
          Free, open source, and completely vibe-coded: written by AI (Claude
          and Codex) under human direction, tested on real phones in real
          dust. Published by Simbi Community Development, a 501(c)(3).
        </Text>
        <Pressable onPress={() => Linking.openURL('https://playapal.lol')}>
          <Text style={styles.aboutLink}>playapal.lol</Text>
        </Pressable>
        <Pressable
          onPress={() =>
            Linking.openURL('https://github.com/simbi-community-dev/playapal')
          }>
          <Text style={styles.aboutLink}>Source on GitHub</Text>
        </Pressable>
        <Pressable onPress={() => Linking.openURL('https://simbi.com/donate')}>
          <Text style={styles.aboutLink}>Support the nonprofit</Text>
        </Pressable>
        <Text style={styles.aboutFine}>
          Not affiliated with, endorsed by, or verified by Burning Man
          Project. Code: Apache-2.0; bundled data carries its own credits
          (see NOTICE in the repository).
        </Text>
      </View>
    </ScrollView>
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
    <Pressable style={styles.voiceRow} onPress={onPress}>
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
  // Collapsible section header (Public packs): title left, chevron right.
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center' },
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
  row: { flexDirection: 'row', alignItems: 'center' },
  backendRow: { flexDirection: 'row' },
  backendChip: {
    backgroundColor: colors.dust,
    borderRadius: radius.chip,
    borderWidth: 1,
    borderColor: colors.haze,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    marginRight: spacing.sm,
  },
  backendChipActive: { backgroundColor: colors.plum, borderColor: colors.plum },
  backendChipText: { color: colors.night, fontSize: type.small },
  backendChipTextActive: { color: colors.cream, fontWeight: '700' },
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
  noticeBtn: { marginTop: spacing.sm },
  noticeBtnText: { color: colors.clayDeep, fontSize: type.small, fontWeight: '700' },
  voiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  voiceMark: { color: colors.faded, fontSize: type.body, width: 24 },
  voiceMarkSelected: { color: colors.clay },
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
  badgeGood: { color: colors.cream, backgroundColor: colors.sage },
  badgeWarn: { color: colors.night, backgroundColor: colors.haze },
  hint: {
    color: colors.faded,
    fontSize: type.small,
    marginTop: spacing.sm,
  },
  rateLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
  },
  rateLabel: { color: colors.faded, fontSize: type.tiny },
  testBtn: {
    backgroundColor: colors.clay,
    borderRadius: radius.card,
    padding: spacing.md,
    alignItems: 'center',
    marginTop: spacing.lg,
  },
  testBtnText: { color: colors.cream, fontSize: type.body, fontWeight: '700' },
});
