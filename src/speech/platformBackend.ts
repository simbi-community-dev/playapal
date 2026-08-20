/**
 * Tier-1 spoken replies: the device's own TTS engine via
 * @mhpdev/react-native-speech (New-Architecture TurboModule; on Android this
 * is android.speech.tts over the installed engine — Google TTS on a Pixel —
 * and AVSpeechSynthesizer on iOS). Offline platform voices, zero model
 * download.
 *
 * The ONLY file that imports the TTS native module — the rest of the app
 * talks to the SpeechBackend interface.
 */

import { Platform } from 'react-native';
import Speech, { type EventProps } from '@mhpdev/react-native-speech';
import {
  classifyVoiceNetwork,
  sortVoicesForPicker,
  type SpeakOpts,
  type SpeechBackend,
  type SpeechReadiness,
  type SpeechVoice,
} from './backend';

/** "en-us-x-iob-local" -> "English (US) · iob"; leaves non-Google names as-is. */
function voiceLabel(name: string, language: string): string {
  let display = language;
  try {
    // Hermes ships Intl; if a device locale pack is missing we fall back.
    display =
      new Intl.DisplayNames(['en'], { type: 'language' }).of(language) ??
      language;
  } catch {}
  const variant = name.match(/-x-([a-z]{3})-(?:local|network)$/i);
  return variant ? `${display} · ${variant[1]}` : `${display} · ${name}`;
}

class PlatformSpeechBackend implements SpeechBackend {
  readonly id = 'platform';
  readonly label = 'Device voice';

  private listenersAttached = false;
  /** The one in-flight utterance (speak() always stops the previous). */
  private current: { id: string; opts: SpeakOpts } | null = null;

  /** Lazy: no native event wiring at module import (keeps tests/dev clean). */
  private attachListeners(): void {
    if (this.listenersAttached) {
      return;
    }
    this.listenersAttached = true;
    const settle = (utteranceId: string, errorMessage?: string) => {
      const current = this.current;
      if (!current || current.id !== utteranceId) {
        return;
      }
      this.current = null;
      if (errorMessage) {
        current.opts.onError?.(errorMessage);
      }
      current.opts.onDone?.();
    };
    // Explicit param types: the lib's EventEmitter generic does not survive
    // its published d.ts (broken relative import, skipLibCheck hides it), so
    // the inferred callback param is any.
    Speech.onFinish((e: EventProps) => settle(e.id));
    Speech.onStopped((e: EventProps) => settle(e.id));
    Speech.onError((e: EventProps) => settle(e.id, 'speech synthesis failed'));
  }

  async voices(): Promise<SpeechVoice[]> {
    const raw = await Speech.getAvailableVoices();
    const mapped: SpeechVoice[] = raw.map(v => ({
      id: v.identifier,
      label: voiceLabel(v.name, v.language),
      language: v.language,
      quality: v.quality === 'Enhanced' ? 'enhanced' : 'default',
      network: classifyVoiceNetwork(v.name),
    }));
    return sortVoicesForPicker(mapped);
  }

  async readiness(voiceId?: string | null): Promise<SpeechReadiness> {
    const canInstall = Platform.OS === 'android';
    let all: SpeechVoice[];
    try {
      all = await this.voices();
    } catch {
      return { ok: false, reason: 'no-voices', canInstallVoiceData: canInstall };
    }
    if (all.length === 0) {
      return { ok: false, reason: 'no-voices', canInstallVoiceData: canInstall };
    }
    if (!voiceId) {
      // Engine default. We cannot see which voice the engine will pick, but
      // if the device has ANY offline-classified voice the default is almost
      // always one of them (Google TTS defaults local).
      return all.some(v => v.network === 'offline')
        ? { ok: true }
        : { ok: false, reason: 'unknown-voice', canInstallVoiceData: canInstall };
    }
    const voice = all.find(v => v.id === voiceId);
    if (!voice) {
      return {
        ok: false,
        reason: 'voice-missing',
        canInstallVoiceData: canInstall,
      };
    }
    if (voice.network === 'network') {
      return {
        ok: false,
        reason: 'needs-network',
        canInstallVoiceData: canInstall,
      };
    }
    if (voice.network === 'unknown') {
      return { ok: false, reason: 'unknown-voice', canInstallVoiceData: false };
    }
    return { ok: true };
  }

  async speak(text: string, opts: SpeakOpts = {}): Promise<void> {
    this.attachListeners();
    await this.stop();
    // Android caps one utterance at TextToSpeech.getMaxSpeechInputLength
    // (typically 4000 chars); the engine rejects longer input outright.
    // Assistant replies live far below this — cut at a word break as
    // insurance, not as a feature.
    let trimmed = text.trim();
    const maxLen = 3900;
    if (trimmed.length > maxLen) {
      const cut = trimmed.lastIndexOf(' ', maxLen);
      trimmed = trimmed.slice(0, cut > 0 ? cut : maxLen);
    }
    if (trimmed.length === 0) {
      opts.onDone?.();
      return;
    }
    // Android's engine rate is a plain multiplier (1.0 = normal). iOS rate is
    // the AVSpeechUtterance 0..1 scale where ~0.5 is normal — map our
    // multiplier onto it so 1.0 sounds normal on both platforms.
    const rate = opts.rate ?? 1.0;
    const platformRate =
      Platform.OS === 'ios' ? Math.min(1, Math.max(0, rate * 0.5)) : rate;
    const utteranceId = await Speech.speak(trimmed, {
      ...(opts.voiceId ? { voice: opts.voiceId } : {}),
      rate: platformRate,
      // Duck other audio (camp playlist) instead of talking over it.
      ducking: true,
    });
    this.current = { id: utteranceId, opts };
  }

  async stop(): Promise<void> {
    // Settle the tracked utterance ourselves: onStopped fires only when the
    // engine was mid-utterance, and a queued-but-unstarted one would leak.
    const current = this.current;
    this.current = null;
    await Speech.stop();
    current?.opts.onDone?.();
  }

  openVoiceDataInstaller(): Promise<void> {
    return Speech.openVoiceDataInstaller();
  }
}

export const platformSpeechBackend = new PlatformSpeechBackend();
