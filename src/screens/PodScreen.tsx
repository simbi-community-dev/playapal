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
 * ASYNC IS NOT THE FALLBACK (owner, 2026-08-24: "live walkies are great,
 * but async is also preferred much of the time"). The answering machine and
 * the walkie are peers. In the card the messages strip already sits above
 * the walkie panel, which is the right order — and the tab bar's unread
 * count is an async-only signal the walkie has no equivalent of, because
 * mail that arrives while a phone is in a pocket is the normal case and
 * live voice is the special one. What is still wrong is what sits ABOVE
 * both: the roster. See docs/CREW-DESIGN.md §6g.
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
 * made during the week): this is a plain ScrollView, so a sixty-person roster and
 * a week-long thread render every row every frame. The container is the
 * same one the Camp tab gave them, so nothing regressed here — but the
 * fix (a virtualized list, and a roster that becomes a destination once a
 * pod outgrows a glance) lives inside the card, not around it. See
 * docs/CREW-DESIGN.md §6g.
 */
import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { CrewSection } from '../crews/CrewSection';
import type { WaypointTarget } from '../geo/brcGeo';
import { spacing } from '../theme';

export function PodScreen({
  onOpenCompass,
}: {
  onOpenCompass: (target: WaypointTarget | null) => void;
}) {
  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      // The messages composer lives inside this scroll: a tap on Send must
      // land on Send, not be eaten dismissing the keyboard.
      keyboardShouldPersistTaps="handled">
      <CrewSection onOpenCompass={onOpenCompass} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: spacing.lg },
  content: { paddingBottom: spacing.xl },
});
