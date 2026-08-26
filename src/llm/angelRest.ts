/**
 * DOES THE ANGEL WAKE UP WITH THE APP?
 *
 * Owner field report 2026-08-25 (iPhone 13 mini, 4 GB): three kills across
 * 0.7.4/0.8.0 with the model resident, and on the 0.8.1 memory-fix build the
 * app was "still very slow" and a push-to-talk attempt died. Every one of
 * them is the same story — ~1.4 GB of weights sitting inside a phone that has
 * ~4 GB for everything. So on a small phone the Angel now RESTS by default,
 * and the deterministic half of the app (Right Now, events, pods, the walkie,
 * the map, the camp board) carries on exactly as it always has: none of it
 * has ever needed a model.
 *
 * Three rules, in order:
 *
 *  1. WHAT THE CAMPER CHOSE WINS, FOREVER. A stored choice is never
 *     second-guessed by the phone's size — an opted-in small phone loads at
 *     startup exactly like it did before this file existed, and an opted-out
 *     big phone stays resting.
 *  2. With no choice on record, the phone decides: measured-small rests,
 *     everything else wakes.
 *  3. A phone that cannot say how much memory it has is NOT small (see
 *     memoryConstrainedDevice) — an unreadable probe must never cost someone
 *     their Angel.
 *
 * The boundary is llm/LlamaSession's CONSTRAINED_RAM_BYTES, the same 6 GB
 * line that already picks the KV-cache size and the mlock decision. One
 * boundary, read twice.
 */

import { getSetting, setSetting } from '../events/db';
import { memoryConstrainedDevice } from './LlamaSession';

/**
 * The per-device choice. Named for the case it was built for (the owner's
 * own wording) even though the switch is offered on every phone: the value
 * it carries is "what this camper said about the Angel on THIS phone", and
 * renaming a key that may already be on a phone buys nothing.
 */
export const ANGEL_ENABLED_KEY = 'angel_enabled_constrained';

/** What the camper said, or null when they have never been asked. */
export type AngelChoice = 'awake' | 'resting' | null;

export interface AngelPosture {
  /** Load the model at startup / keep it loaded now. */
  awake: boolean;
  /** This phone measured below the constrained boundary. */
  constrained: boolean;
  /** The camper has said, so nothing may override it. */
  chosen: boolean;
}

/** The whole rule, as a pure function — the thing worth testing. */
export function angelPosture(
  choice: AngelChoice,
  constrained: boolean,
): AngelPosture {
  return {
    awake: choice === null ? !constrained : choice === 'awake',
    constrained,
    chosen: choice !== null,
  };
}

/**
 * Read the stored choice. Never throws: this runs on the startup path, and a
 * phone whose database is not open yet has simply not chosen — the same
 * fail-soft posture every other boot-time settings read takes.
 */
export function readAngelChoice(): AngelChoice {
  try {
    const stored = getSetting(ANGEL_ENABLED_KEY);
    return stored === 'awake' || stored === 'resting' ? stored : null;
  } catch {
    return null;
  }
}

/**
 * Persist the choice. Never throws — a settings write that fails must not
 * take down the wake/rest action the camper just asked for; it only costs
 * them the same tap next launch.
 */
export function writeAngelChoice(choice: Exclude<AngelChoice, null>): void {
  try {
    setSetting(ANGEL_ENABLED_KEY, choice);
  } catch (error) {
    console.warn('[angel] rest choice not persisted:', error);
  }
}

/**
 * The startup question: stored choice over measured phone size.
 *
 * Never throws, for the same reason rule 3 exists. This is read on the boot
 * path immediately before the model load decision, so a probe that blew up
 * would not merely mis-answer — it would take the load with it, and the
 * Angel would vanish from a phone with plenty of room.
 */
export async function readAngelPosture(): Promise<AngelPosture> {
  let constrained = false;
  try {
    constrained = await memoryConstrainedDevice();
  } catch (error) {
    console.warn('[angel] phone-size probe failed; treating as roomy:', error);
  }
  return angelPosture(readAngelChoice(), constrained);
}
