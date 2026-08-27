/**
 * KokoroSpeechBackend — tier-2 on-device NEURAL voice ("Angel voice") behind
 * the SpeechBackend seam, via react-native-sherpa-onnx (sherpa-onnx TTS,
 * TurboModule, streaming synthesis + built-in PCM player).
 *
 * Model: kokoro-int8-multi-lang-v1_1 (Kokoro 82M, int8 onnx). NOT bundled in
 * the APK (~187 MB slimmed) — loaded from app documents like the GGUF.
 *
 * Dev fast-path (mirrors llm/modelFile.ts; picker import can come later):
 *   adb push kokoro-int8-multi-lang-v1_1 /data/local/tmp/kokoro
 *   adb shell chmod -R a+rX /data/local/tmp/kokoro
 *   adb shell run-as com.playapal sh -c \
 *     'mkdir -p files/tts && cp -r /data/local/tmp/kokoro files/tts/kokoro'
 *   adb shell rm -rf /data/local/tmp/kokoro
 * Push ONLY: model.int8.onnx, voices.bin, tokens.txt, lexicon-us-en.txt,
 * espeak-ng-data/ (drop lexicon-gb-en/zh + dict/ + *-zh.fst: the binding
 * sorts lexicon candidates alphabetically, so a stray gb-en would win, and
 * the zh jieba dict is never read by its Kokoro config).
 *
 * Streaming: sherpa-onnx generates sentence-by-sentence (maxNumSentences=1);
 * each chunk is written to the native PCM player as it lands, so first audio
 * plays after the FIRST sentence is synthesized, not the whole reply.
 */

import { DocumentDirectoryPath, exists } from '@dr.pogodin/react-native-fs';
import {
  createStreamingTTS,
  saveAudioToFile,
} from 'react-native-sherpa-onnx/tts';
import type {
  StreamingTtsEngine,
  TtsStreamChunk,
} from 'react-native-sherpa-onnx/tts';
import type { SpeakOpts, SpeechBackend, SpeechReadiness, SpeechVoice } from './backend';
import {
  KOKORO_VOICES,
  clampSpeechRate,
  drainMsRemaining,
  kokoroVoiceForId,
} from './kokoroVoices';

/** Where the model directory lives on device (dev adb push / future import). */
export const KOKORO_MODEL_DIR = `${DocumentDirectoryPath}/tts/kokoro`;

/** Files that must exist for the engine to load (int8 or fp32 model). */
async function findKokoroModelDir(): Promise<string | null> {
  const dir = KOKORO_MODEL_DIR;
  const [hasInt8, hasFp32, hasVoices, hasTokens] = await Promise.all([
    exists(`${dir}/model.int8.onnx`),
    exists(`${dir}/model.onnx`),
    exists(`${dir}/voices.bin`),
    exists(`${dir}/tokens.txt`),
  ]);
  return (hasInt8 || hasFp32) && hasVoices && hasTokens ? dir : null;
}

const TAG = '[kokoro-tts]';

export class KokoroSpeechBackend implements SpeechBackend {
  readonly id = 'kokoro';
  readonly label = 'Angel voice';

  private enginePromise: Promise<StreamingTtsEngine> | null = null;
  private sampleRate = 24000;
  /** Bumped by stop()/speak() to invalidate in-flight callbacks + timers. */
  private generation = 0;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingDone: (() => void) | null = null;

  async voices(): Promise<SpeechVoice[]> {
    if (!(await findKokoroModelDir())) {
      return [];
    }
    return KOKORO_VOICES.map(v => ({
      id: v.id,
      label: v.label,
      language: v.language,
      quality: 'enhanced' as const,
      network: 'offline' as const,
    }));
  }

  async readiness(voiceId?: string | null): Promise<SpeechReadiness> {
    if (!(await findKokoroModelDir())) {
      return { ok: false, reason: 'model-missing' };
    }
    if (voiceId != null && voiceId !== '' && !kokoroVoiceForId(voiceId)) {
      return { ok: false, reason: 'voice-missing' };
    }
    return { ok: true };
  }

  /**
   * Lazy engine init (one instance for the app session — the int8 model is
   * ~165 MB of RAM; created on first speak, kept resident like the LLM).
   */
  private engine(): Promise<StreamingTtsEngine> {
    if (!this.enginePromise) {
      this.enginePromise = (async () => {
        const dir = await findKokoroModelDir();
        if (!dir) {
          throw new Error(
            'Angel voice model not installed (expected under files/tts/kokoro)',
          );
        }
        const t0 = Date.now();
        const engine = await createStreamingTTS({
          modelPath: { type: 'file', path: dir },
          modelType: 'kokoro',
          numThreads: 4,
        });
        this.sampleRate = await engine.getSampleRate();
        console.log(
          `${TAG} engine ready in ${Date.now() - t0} ms (sampleRate ${
            this.sampleRate
          })`,
        );
        return engine;
      })();
      // A failed init must not poison every later attempt.
      this.enginePromise.catch(() => {
        this.enginePromise = null;
      });
    }
    return this.enginePromise;
  }

  async speak(text: string, opts?: SpeakOpts): Promise<void> {
    const { voiceId, rate, onDone, onError } = opts ?? {};
    await this.stop();
    const gen = ++this.generation;
    const fail = (message: string) => {
      console.log(`${TAG} error: ${message}`);
      onError?.(message);
      onDone?.();
    };
    const voice = kokoroVoiceForId(voiceId);
    if (!voice) {
      fail(`Unknown Angel voice: ${voiceId}`);
      return;
    }
    let engine: StreamingTtsEngine;
    try {
      engine = await this.engine();
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
      return;
    }
    if (gen !== this.generation) {
      onDone?.(); // stopped while the engine was loading
      return;
    }

    const sampleRate = this.sampleRate;
    await engine.startPcmPlayer(sampleRate, 1);
    const t0 = Date.now();
    let firstAudioAt = 0;
    let queuedSamples = 0;
    this.pendingDone = onDone ?? null;

    const finish = () => {
      if (gen !== this.generation) {
        return;
      }
      this.pendingDone = null;
      this.drainTimer = null;
      engine.stopPcmPlayer().catch(() => {});
      onDone?.();
    };

    try {
      await engine.generateSpeechStream(
        text,
        { sid: voice.sid, speed: clampSpeechRate(rate) },
        {
          onChunk: (chunk: TtsStreamChunk) => {
            if (gen !== this.generation) {
              return;
            }
            if (firstAudioAt === 0) {
              firstAudioAt = Date.now();
              console.log(
                `${TAG} first audio in ${firstAudioAt - t0} ms (${voice.id})`,
              );
            }
            queuedSamples += chunk.samples.length;
            engine.writePcmChunk(chunk.samples).catch(() => {});
          },
          onEnd: event => {
            if (gen !== this.generation || event.cancelled) {
              return;
            }
            const synthMs = Date.now() - t0;
            const audioSec = queuedSamples / sampleRate;
            const rtf = audioSec > 0 ? synthMs / 1000 / audioSec : 0;
            console.log(
              `${TAG} synth done: ${synthMs} ms for ${audioSec.toFixed(
                1,
              )} s audio, RTF ${rtf.toFixed(2)}, first audio ${
                firstAudioAt - t0
              } ms`,
            );
            // The native player truncates on stop — wait out the queued
            // audio (plus a pad for the AudioTrack buffer) before release.
            const drainMs =
              drainMsRemaining(queuedSamples, sampleRate, firstAudioAt, Date.now()) +
              300;
            this.drainTimer = setTimeout(finish, drainMs);
          },
          onError: event => {
            if (gen !== this.generation) {
              return;
            }
            this.pendingDone = null;
            engine.stopPcmPlayer().catch(() => {});
            fail(event.message);
          },
        },
      );
    } catch (e) {
      engine.stopPcmPlayer().catch(() => {});
      this.pendingDone = null;
      fail(e instanceof Error ? e.message : String(e));
    }
  }

  async stop(): Promise<void> {
    this.generation++;
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    const pending = this.pendingDone;
    this.pendingDone = null;
    if (this.enginePromise) {
      const engine = await this.enginePromise.catch(() => null);
      if (engine) {
        await engine.cancelSpeechStream().catch(() => {});
        await engine.stopPcmPlayer().catch(() => {});
      }
    }
    pending?.(); // contract: onDone fires when stopped, too
  }

  /**
   * Synthesize to a WAV file (no playback) — dev/QA evidence path and the
   * future "export this answer as audio" affordance. Returns timing metrics.
   */
  async synthesizeToWavFile(
    text: string,
    filePath: string,
    voiceId?: string | null,
  ): Promise<{ path: string; synthMs: number; audioSec: number; rtf: number }> {
    const engine = await this.engine();
    const voice = kokoroVoiceForId(voiceId);
    if (!voice) {
      throw new Error(`Unknown Angel voice: ${voiceId}`);
    }
    const sampleRate = this.sampleRate;
    const all: number[] = [];
    const t0 = Date.now();
    await new Promise<void>((resolve, reject) => {
      engine
        .generateSpeechStream(
          text,
          { sid: voice.sid },
          {
            onChunk: chunk => {
              for (const s of chunk.samples) {
                all.push(s);
              }
            },
            onEnd: () => resolve(),
            onError: event => reject(new Error(event.message)),
          },
        )
        .catch(reject);
    });
    const synthMs = Date.now() - t0;
    const audioSec = all.length / sampleRate;
    const path = await saveAudioToFile({ samples: all, sampleRate }, filePath);
    const rtf = audioSec > 0 ? synthMs / 1000 / audioSec : 0;
    console.log(
      `${TAG} wav dump: ${path} — ${synthMs} ms for ${audioSec.toFixed(
        1,
      )} s, RTF ${rtf.toFixed(2)}`,
    );
    return { path, synthMs, audioSec, rtf };
  }
}

export const kokoroSpeechBackend = new KokoroSpeechBackend();
