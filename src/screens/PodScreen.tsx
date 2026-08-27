/**
 * Pods — the comms tab (owner, 2026-08-24: "the camp tab is now totally
 * unmanageable, all this useful comms is buried halfway down a long
 * scroll").
 *
 * WHY THIS IS A TAB AND NOT A SECTION. The pod card carries the three verbs
 * a camper uses all day — FIND (who is where), MESSAGE (the answering
 * machine) and TALK (the walkie) — and it was the LAST block of the Camp
 * scroll, under the board, the sync card, the share doors, the packs and
 * the friend list. Messaging is an activity, not camp administration; a
 * camp-wide pod of sixty people is the busiest surface in the app, and it
 * cannot live at the bottom of somebody else's page. Its own destination
 * also gives the unread count a home on the tab bar, which is the only
 * thing that tells a camper mail arrived — gossip delivers minutes to
 * hours late, so nobody checks on a hunch.
 *
 * WHAT THIS FILE OWNS: the destination, and nothing else. Everything on
 * screen is CrewSection (src/crews/), mounted whole — the pod switcher,
 * the join code, the position toggle, the roster, the messages strip and
 * the walkie. Moving a mount point is navigation; the card's insides
 * belong to the mesh lane.
 *
 * THE SCROLL MOVED INSIDE (UX review 2026-08-26: the page read as
 * "horrifying … extremely confused. The visual cues are not easy at all,
 * and the various sections are not very organized"). This file used to own
 * ONE ScrollView with the whole pod card poured into it, so reaching the
 * walkie from the answering machine was a thumb-drag past the roster, the
 * join code and the hotspot. The Camp tab already solved this shape — a
 * strip of panes that never scrolls away (CampScreen.tsx) — and the owner
 * asked for the same pattern here, because consistency IS the fix.
 *
 * A pane strip has to sit ABOVE the scroll, and the pane a camper is on is
 * card state, not screen state — so CrewSection owns the strip AND one
 * scroll per pane, and this file is the plain flex box they live in. That
 * is the same division as before (this file: where the card lives; the
 * card: what is in it), with the scroll on the correct side of the line.
 *
 * ASYNC IS NOT THE FALLBACK (owner, 2026-08-24: "live walkies are great,
 * but async is also preferred much of the time"). The answering machine and
 * the walkie are peers. In the card the messages strip already sits above
 * the walkie panel, which is the right order — and the tab bar's unread
 * count is an async-only signal the walkie has no equivalent of, because
 * mail that arrives while a phone is in a pocket is the normal case and
 * live voice is the special one. What used to be wrong was what sat ABOVE
 * both — the roster, the join code and the hotspot, in one column. The
 * panes settled it: Mail and Walkie are now siblings on one strip, a tap
 * apart, with nothing stacked on top of either. See docs/CREW-DESIGN.md
 * §6g.
 *
 * NOTHING HERE INVENTS GROUP TRUTH (the Dust Bunnies rule). This screen
 * renders no name, no roster and no count of its own — every one of those
 * belongs to the converging log the mesh maintains, and a destination that
 * summarised them would be a second, staler copy. The one number this lane
 * does own is the tab badge (App.tsx), and it is a fact about THIS phone's
 * mailbox — "waiting for you", not "the pod has". It only ever reports
 * mail that arrived; a zero is silence, never a claim that nobody wrote.
 *
 * SCALE NOTE for that lane (owner, 2026-08-24, paraphrased: the whole camp
 * in a single murmurating chat, plus people's private friend-group pods
 * made during the week): every pane is still a plain ScrollView, so a
 * sixty-person roster renders every row every frame and so does a
 * week-long thread. The panes HALVED the standing cost rather than fixing
 * it — a hidden pane is `display:'none'`, which is still mounted and still
 * re-rendered, so the roster and the thread no longer LAY OUT together but
 * they do still render together. The real fix (a virtualized list, and a
 * roster that becomes a destination once a pod outgrows a glance) lives
 * inside the card, not around it, and is still owed. See
 * docs/CREW-DESIGN.md §6g.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { CrewSection } from '../crews/CrewSection';
import type { WaypointTarget } from '../geo/brcGeo';

export function PodScreen({
  onOpenCompass,
}: {
  onOpenCompass: (target: WaypointTarget | null) => void;
}) {
  return (
    <View style={styles.container}>
      <CrewSection onOpenCompass={onOpenCompass} />
    </View>
  );
}

const styles = StyleSheet.create({
  // flex:1 and nothing else. The horizontal padding went with the scroll —
  // a pane strip that stops short of the screen edge loses the tap target
  // at each end, so the strip runs full width and each pane pads its own
  // content (CampScreen's division exactly).
  container: { flex: 1 },
});
