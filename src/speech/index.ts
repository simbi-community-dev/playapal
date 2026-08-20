/**
 * Speech wiring: registers the available backends exactly once and re-exports
 * the surface the UI consumes. Tier 2 (KokoroSpeechBackend, "Angel voice")
 * registers here when it lands — nothing else changes.
 */

import { registerSpeechBackend } from './backend';
import { platformSpeechBackend } from './platformBackend';

registerSpeechBackend(platformSpeechBackend);

export {
  getSpeechBackend,
  listSpeechBackends,
  type SpeechBackend,
  type SpeechReadiness,
  type SpeechVoice,
} from './backend';
export {
  loadSpeechSettings,
  saveSpeechSettings,
  RATE_MIN,
  RATE_MAX,
  RATE_STEP,
  type SpeechSettings,
} from './settings';
export {
  eventToSpeech,
  speechForAssistantMessage,
  toMarkdownlessSpeech,
} from './toSpeech';
export { SentenceFeed } from './sentenceFeed';
export { useSpeaker } from './useSpeaker';
