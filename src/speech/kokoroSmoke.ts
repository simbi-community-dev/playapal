/**
 * Dev/QA smoke for the Angel voice: speak a greeting through the phone
 * speaker AND dump the same line to a WAV in app documents, logging engine
 * init / first-audio / RTF timings to logcat (ReactNativeJS).
 *
 * Not wired into any screen — a bench build (or future dev menu) calls it:
 *   import { runKokoroSmoke } from './src/speech/kokoroSmoke';
 *   useEffect(() => { setTimeout(runKokoroSmoke, 8000); }, []);
 * Pull the artifact with:
 *   adb shell run-as com.playapal cat files/angel-smoke.wav > angel-smoke.wav
 */

import { DocumentDirectoryPath } from '@dr.pogodin/react-native-fs';
import { kokoroSpeechBackend } from './kokoroBackend';

const SMOKE_LINE =
  'Welcome home, dusty one. The playa provides, but pack your own water: ' +
  'one point five gallons per person, per day.';

export async function runKokoroSmoke(): Promise<void> {
  const ready = await kokoroSpeechBackend.readiness();
  console.log(`[kokoro-smoke] readiness: ${JSON.stringify(ready)}`);
  if (!ready.ok) {
    return;
  }
  const voices = await kokoroSpeechBackend.voices();
  console.log(
    `[kokoro-smoke] voices: ${voices.map(v => v.id).join(', ')}`,
  );
  // WAV artifact first (also warms the engine), then audible playback.
  const wav = await kokoroSpeechBackend.synthesizeToWavFile(
    SMOKE_LINE,
    `${DocumentDirectoryPath}/angel-smoke.wav`,
  );
  console.log(`[kokoro-smoke] wav: ${JSON.stringify(wav)}`);
  await new Promise<void>(resolve => {
    kokoroSpeechBackend.speak(SMOKE_LINE, {
      onDone: () => {
        console.log('[kokoro-smoke] playback done');
        resolve();
      },
      onError: message => console.log(`[kokoro-smoke] error: ${message}`),
    });
  });
}
