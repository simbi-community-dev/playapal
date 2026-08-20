import React, { useCallback } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import type {
  FactCard as FactCardData,
  FactEvidence,
  FactRelationship,
  PersonFactCard as PersonFactCardData,
} from '../types';
import { colors, radius, spacing, type } from '../theme';
import { describeEvidence } from '../facts/lineageView';
import { confirmDontUse, HOLD_MS, type OnHide } from './dontUseThis';

interface Props {
  fact: FactCardData;
  /** "Don't use this" on a person card. Optional: a card rendered without it
   * is simply a card without the affordance. */
  onHide?: OnHide;
}

function Evidence({ value }: { value: FactEvidence }) {
  return (
    <Text style={styles.evidence}>
      Source: {describeEvidence(value.evidence_ref)}
    </Text>
  );
}
/**
 * A relationship row is a `sponsored_by` edge: `from` was sponsored by `to`.
 * Rendered as WORDS in the human direction — "Pug sponsored Coco" — never as
 * the storage arrow. The arrow read backwards on the owner's phone
 * (2026-08-17): under "Pug · Sponsees" the first row said "Coco → Pug",
 * which any camper reads as Coco sponsoring Pug — the opposite of the fact.
 * A wrong-looking relationship on the camp's own memory bank is the
 * trust-killer class exactly.
 */
function Relationship({ value }: { value: FactRelationship }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowBody}>
        <Text style={styles.value}>
          {value.to} sponsored {value.from}
        </Text>
        <Evidence value={value} />
      </View>
      {value.year !== null ? <Text style={styles.year}>{value.year}</Text> : null}
    </View>
  );
}

/**
 * "DON'T USE THIS" ON A PERSON CARD -- see components/dontUseThis.ts for the
 * shared gesture and wording. What is specific here:
 *
 * WHY THE PERSON CARD CARRIES IT. The exclusion mechanism for a person is a
 * graph-node hide (setFactNodeExcluded), keyed by person_ref {pack_id, id}
 * -- exactly what this card carries. A source chip carries a CHUNK, and its
 * hide is a different, simpler filter, so each surface hides the thing it
 * actually is.
 *
 * MEMORIAL CARDS GET IT TOO -- reversed on codex review 2026-08-17. The first
 * version exempted memorials on the file's own rule that a remembrance must
 * never read as a database row. But that rule governs how a memorial RENDERS
 * (gentle register, no evidence line, sage edge), not whether the user may
 * stop it appearing. A wrong or harmful remembrance with NO local revocable
 * correction is the worse outcome: it keeps surfacing, in that gentle
 * register, and the only remedy is a pack edit the user cannot make on the
 * playa. Hiding is not deleting; the pack is untouched and the undo is one
 * tap. So the gesture is offered on every person card, and the memorial keeps
 * its register in the card AND in the confirmation.
 */
function hidePerson(fact: PersonFactCardData, onHide: OnHide) {
  const ref = fact.person_ref;
  if (!ref) {
    // Legacy retrieval cards omit person_ref on purpose (types.ts) -- there
    // is no exact identity to hide, so there is nothing safe to hide.
    Alert.alert(
      "Can't hide this one yet",
      'This card came from an older pack without an exact identity. ' +
        'Reinstall the pack to get the newer format, then try again.',
    );
    return;
  }
  confirmDontUse(
    { kind: 'person', key: `${ref.pack_id} ${ref.id}`, label: fact.name, memorial: fact.memoriam !== null },
    onHide,
  );
}

function Person({ fact, onHide }: { fact: PersonFactCardData; onHide?: OnHide }) {
  const memorial = fact.memoriam !== null;
  const tenure =
    fact.tenure.to === null
      ? fact.tenure.from
      : `${fact.tenure.from} – ${fact.tenure.to}`;
  const canHide = onHide !== undefined;
  const onLongPress = useCallback(() => {
    if (canHide) {
      hidePerson(fact, onHide!);
    }
  }, [canHide, fact, onHide]);
  return (
    <Pressable
      onLongPress={onLongPress}
      delayLongPress={HOLD_MS}
      disabled={!canHide}
      accessibilityHint={canHide ? "Long press: don't use this" : undefined}
      style={[styles.card, memorial ? styles.memorial : null]}>
      <Text style={styles.title}>
        {fact.alsoKnownAs ? `${fact.name} (${fact.alsoKnownAs})` : fact.name}
      </Text>
      {fact.memoriam !== null ? (
        <Text style={styles.memoriamText}>{fact.memoriam}</Text>
      ) : null}
      <Text style={styles.tenure}>{tenure} on the camp list</Text>
      <Text style={styles.summary}>{fact.summary}</Text>
      {fact.aliases.length > 0 ? (
        <Text style={styles.aliases}>
          {memorial ? 'Also appeared on the list as' : 'Also on the list as'}{' '}
          {fact.aliases.join(', ')}
        </Text>
      ) : null}
      {memorial ? null : <Evidence value={fact} />}
    </Pressable>
  );
}

export function FactCard({ fact, onHide }: Props) {
  if (fact.kind === 'person') {
    return <Person fact={fact} onHide={onHide} />;
  }

  if (fact.kind === 'attendance') {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>{fact.person} · Attendance</Text>
        {fact.years.map(item => (
          <View key={`${item.pack_id}:${item.year}:${item.evidence_ref}`} style={styles.row}>
            <View style={styles.rowBody}>
              <Text style={styles.value}>Attended</Text>
              <Evidence value={item} />
            </View>
            <Text style={styles.year}>{item.year}</Text>
          </View>
        ))}
      </View>
    );
  }

  if (fact.kind === 'projects') {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>{fact.person} · Projects</Text>
        {fact.projects.map(item => (
          <View key={`${item.pack_id}:${item.name}:${item.evidence_ref}`} style={styles.row}>
            <View style={styles.rowBody}>
              <Text style={styles.value}>{item.name}</Text>
              <Evidence value={item} />
            </View>
            {item.year !== null ? <Text style={styles.year}>{item.year}</Text> : null}
          </View>
        ))}
      </View>
    );
  }

  if (fact.kind === 'cohort') {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>{fact.year} cohort</Text>
        {fact.people.map(item => (
          <View key={`${item.pack_id}:${item.name}:${item.evidence_ref}`} style={styles.row}>
            <View style={styles.rowBody}>
              <Text style={styles.value}>{item.name}</Text>
              <Evidence value={item} />
            </View>
          </View>
        ))}
      </View>
    );
  }

  // Lineage titles say the relation in words too; the rows beneath are the
  // whole chain (a lineage is transitive), each one readable on its own.
  const title =
    fact.kind === 'lineage'
      ? fact.direction === 'sponsors'
        ? `Who sponsored ${fact.person} — the lineage`
        : `Who ${fact.person} sponsored — the lineage`
      : `Sponsorship path: ${fact.from} to ${fact.to}`;
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{title}</Text>
      {fact.relationships.map((item, index) => (
        <Relationship
          key={`${item.pack_id}:${item.from}:${item.to}:${item.evidence_ref}:${index}`}
          value={item}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.sand,
    borderRadius: radius.card,
    borderLeftWidth: 3,
    borderLeftColor: colors.plum,
    padding: spacing.md,
    marginVertical: spacing.xs,
  },
  title: {
    color: colors.night,
    fontSize: type.body,
    fontWeight: '700',
    marginBottom: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderTopWidth: 1,
    borderTopColor: colors.haze,
    paddingTop: spacing.xs,
    marginTop: spacing.xs,
  },
  rowBody: { flex: 1 },
  value: { color: colors.night, fontSize: type.small, fontWeight: '600' },
  // A memorial reads as a remembrance, not a record: softer edge, no rows.
  memorial: { borderLeftColor: colors.sage, backgroundColor: colors.dust },
  memoriamText: {
    color: colors.night,
    fontSize: type.small,
    fontStyle: 'italic',
    marginBottom: spacing.xs,
  },
  tenure: { color: colors.plum, fontSize: type.small, fontWeight: '700' },
  summary: { color: colors.night, fontSize: type.small, marginTop: spacing.xs },
  aliases: { color: colors.faded, fontSize: type.small, marginTop: spacing.xs },
  year: {
    color: colors.plum,
    fontSize: type.body,
    fontWeight: '800',
    marginLeft: spacing.md,
  },
  evidence: { color: colors.faded, fontSize: type.tiny, marginTop: 2 },
});
