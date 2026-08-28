/**
 * "LAND ON THIS POD, ON THIS PANE" — an explicit seam into the Pods card,
 * so something OUTSIDE it can send a camper to a specific place inside it
 * without reaching into its state.
 *
 * WHY IT EXISTS. A mention buzzes the pocket, the camper taps the
 * notification, and the app opens… generically. The buzz named a person
 * and their words; the tap answered with a home screen. Everything needed
 * to do better was already on the phone — the notification knows which
 * pod's mail it was minted from — and the only thing missing was a way to
 * say so to a card that owns its own selection.
 *
 * WHY NOT JUST CALL INTO CrewSection. Its pod chips and its pane strip are
 * its own useState, deliberately (the walkie-stage routing comment says
 * why: the session drives the pane, the pane never drives the session).
 * Two callers reaching in through props or refs would be two places that
 * can disagree about which pod is showing. So this is one small store with
 * one verb, in the walkieSession.ts idiom the card already reads through
 * useSyncExternalStore.
 *
 * IT ADDRESSES A POD BY CODE, NOT BY ID. The code is the pod's identity on
 * the mesh — it is what a record carries, what a camper types to join, and
 * what survives this phone forgetting and re-joining the pod. The card's
 * `activePodId` is a local row id, so the card resolves the code against
 * the pods it holds. A landing for a pod this phone does not have is not
 * an error: it is answered by consuming the landing and changing nothing,
 * which is exactly what should happen to a buzz whose pod was left.
 *
 * THE TOKEN IS WHAT KEEPS A LANDING FROM SWALLOWING THE NEXT ONE. The
 * consumer clears the landing it actually handled, by token; a second buzz
 * that arrived while the first was being rendered is still standing after
 * the clear.
 */

/** The Pods card's four panes (mirror of CrewSection's PodPane — the card
 * owns the strip, this names the destinations). */
export type PodPane = 'people' | 'mail' | 'walkie' | 'setup';

export interface PodLanding {
  /** The pod's mesh identity, resolved to a local pod by the card. */
  crewCode: string;
  /** Which pane the camper should be looking at when they arrive. */
  pane: PodPane;
  /** Identifies THIS landing, so a consumer clears what it handled and
   * never a newer one that arrived meanwhile. */
  token: number;
}

let landing: PodLanding | null = null;
let revision = 0;
let nextToken = 1;
const watchers = new Set<() => void>();

function publishLanding(): void {
  revision += 1;
  for (const w of [...watchers]) {
    try {
      w();
    } catch {
      // A subscriber that throws is a rendering bug in that subscriber; it
      // must not stop the others from hearing about the landing.
    }
  }
}

/**
 * Ask the Pods card to show this pod, on this pane, the next time it is
 * able to. Latest wins: two taps in a row are one destination, the second
 * one, because that is the one the camper chose most recently.
 */
export function landOnPod(crewCode: string, pane: PodPane): void {
  if (!crewCode) {
    return;
  }
  landing = { crewCode, pane, token: nextToken++ };
  publishLanding();
}

/** The standing request, or null. */
export function podLanding(): PodLanding | null {
  return landing;
}

/** useSyncExternalStore's pair, exactly as walkieSession exposes them. */
export function subscribePodLanding(fn: () => void): () => void {
  watchers.add(fn);
  return () => {
    watchers.delete(fn);
  };
}

export function podLandingRevision(): number {
  return revision;
}

/** Consume the landing with this token. A clear for a token that is no
 * longer standing does nothing — the newer landing survives. */
export function clearPodLanding(token: number): void {
  if (landing?.token !== token) {
    return;
  }
  landing = null;
  publishLanding();
}

/** Suites only, named so the call site says so (the walkieSession
 * precedent): forget everything, because a landing is app-lifetime state
 * and one test's request must not leak into the next one. */
export function __resetPodLandingForTests(): void {
  landing = null;
  revision = 0;
  nextToken = 1;
  watchers.clear();
}
