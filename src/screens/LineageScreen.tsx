/**
 * Lineage — the ego view of "who sponsored whom" (LINEAGE-STATEMENTS-DESIGN
 * §6, read-only half). One person centered, sponsor above, sponsees below;
 * tap anyone to re-center; every year chip opens its evidence; "≠" / "?"
 * chips mark where the record wants a human. Drawn with plain Views —
 * connector lines are 2px Views positioned from the fan's measured width —
 * so it needs no SVG, no webview, no native rebuild.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Keyboard, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { FactNodeRef } from '../facts/factGraph';
import { listPacks } from '../events/db';
import {
  describeEvidence,
  egoView,
  flagGlyph,
  lineageRoots,
  lineageSearch,
  tierLabel,
  topSponsors,
  type LineageEgoView,
  type LineageFlag,
  type LineageLink,
  type LineagePerson,
} from '../facts/lineageView';
import { colors, radius, spacing, type } from '../theme';

interface Props {
  /** Leave the lineage view for the Camp board. */
  onBack: () => void;
}
interface Sheet {
  title: string;
  lines: string[];
}
type Side = 'above' | 'below';

const LINE = 2; // connector thickness
const STUB = 14; // card-to-bus stub height
const SPINE_PAD = 14; // left gutter for the wrap spine
const MAX_COLS = 3;
const SOLO_MAX = 260; // a lone sponsor/sponsee card's max width

const sameRef = (a: FactNodeRef, b: FactNodeRef) => a.pack_id === b.pack_id && a.id === b.id;
const inYear = (year: number | null) => (year !== null ? ` in ${year}` : '');
const sourcePackName = (packId: string) =>
  listPacks().find(pack => pack.id === packId)?.name ?? 'Camp pack';
const said = (l: LineageLink, sponsor: string, sponsee: string) =>
  `${sponsor} sponsored ${sponsee}${inYear(l.year)} — ${describeEvidence(l.evidence_ref)}`;

/** Provenance for one arrow, in the human direction ("Pug sponsored Coco"). */
function linkSheet(link: LineageLink, me: LineagePerson, side: Side): Sheet {
  const [sponsor, sponsee] = side === 'above' ? [link.person.name, me.name] : [me.name, link.person.name];
  return {
    title: `${sponsor} sponsored ${sponsee}${link.year !== null ? ` · ${link.year}` : ''}`,
    lines: [
      link.year === null ? 'Year not on record.' : `Dated ${link.year}.`,
      `Where to check: ${describeEvidence(link.evidence_ref)}`,
      `How we know: ${tierLabel(link.tier)}`,
      `Source pack: ${sourcePackName(link.person.ref.pack_id)}`,
    ],
  };
}

function flagSheet(flag: LineageFlag): Sheet {
  return {
    title: flag.kind === 'backwards-chain' ? '≠  The years disagree' : '?  Worth a second look',
    lines: [
      `${flag.why}.`,
      ...flag.evidence_refs.map(ref => `Where to check: ${describeEvidence(ref)}`),
      "Nothing is changed by this chip — it just shows where the camp's memory wants help.",
    ],
  };
}

/** Every arrow touching the centered person, plus their camp-list years. */
function personSheet(v: LineageEgoView): Sheet {
  const lines = [
    ...v.sponsors.map(s => said(s, s.person.name, v.person.name)),
    ...v.sponsees.map(s => said(s, v.person.name, s.person.name)),
  ];
  return {
    title: v.person.name,
    lines: [
      ...(lines.length ? lines : ['No sponsorship on record yet.']),
      v.yearsAttended.length ? `On the camp list: ${v.yearsAttended.join(', ')}` : 'Not on any camp list yet.',
    ],
  };
}

function Card({
  person,
  year,
  flags,
  center,
  onOpen,
  onYear,
  onFlag,
}: {
  person: LineagePerson;
  year?: number | null; // undefined = no year chip (the centered person)
  flags: LineageFlag[];
  center?: boolean;
  onOpen: () => void;
  onYear?: () => void;
  onFlag: (f: LineageFlag) => void;
}) {
  return (
    <Pressable style={[styles.card, center && styles.cardCenter]} onPress={onOpen}>
      <Text style={[styles.cardName, center && styles.cardNameCenter]} numberOfLines={2}>
        {person.name}
      </Text>
      {person.aliases.length ? (
        <Text style={styles.cardAlias} numberOfLines={center ? 2 : 1}>
          {person.aliases.join(' · ')}
        </Text>
      ) : null}
      {year !== undefined || flags.length ? (
        <View style={styles.chipRow}>
          {year !== undefined ? (
            <Pressable style={styles.yearChip} onPress={onYear} hitSlop={6}>
              <Text style={styles.yearText}>{year ?? 'year?'}</Text>
            </Pressable>
          ) : null}
          {flags.map((f, i) => (
            <Pressable key={`${f.kind}:${i}`} style={styles.flagChip} onPress={() => onFlag(f)} hitSlop={6}>
              <Text style={styles.flagText}>{flagGlyph(f.kind)}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </Pressable>
  );
}

/** Sponsors above / sponsees below the centered card. Rows of ≤3 cards, each
 * row joined by a bus that the trunk from the center meets; past one row a
 * spine down the left gutter feeds every row's bus (an org chart, wrapped). */
function Fan({
  links,
  side,
  onOpen,
  onYear,
  onFlag,
}: {
  links: LineageLink[];
  side: Side;
  onOpen: (l: LineageLink) => void;
  onYear: (l: LineageLink) => void;
  onFlag: (f: LineageFlag) => void;
}) {
  const [width, setWidth] = useState(0);
  const cols = Math.min(MAX_COLS, Math.max(1, links.length));
  const spine = links.length > MAX_COLS;
  const pad = spine ? SPINE_PAD : 0;
  const spineX = SPINE_PAD / 2 - LINE / 2;
  const colW = width > 0 ? (width - pad) / cols : 0;
  const centerX = (i: number) => pad + (i + 0.5) * colW;
  // A lone card is centered under/over the trunk at a readable width, not
  // stretched edge to edge (no bus to meet, so no geometry depends on it).
  const colStyle = colW ? { width: cols === 1 ? Math.min(colW, SOLO_MAX) : colW } : styles.fanColFlex;
  const rows: LineageLink[][] = [];
  for (let i = 0; i < links.length; i += cols) {
    rows.push(links.slice(i, i + cols));
  }
  const above = side === 'above';
  return (
    <View onLayout={e => setWidth(e.nativeEvent.layout.width)}>
      {rows.map((row, r) => {
        const left = spine ? spineX : centerX(0);
        const right = centerX(row.length - 1);
        return (
          <View
            key={r}
            style={[styles.fanRow, above && styles.fanRowAbove, cols === 1 && styles.fanRowSolo, { paddingLeft: pad }]}>
            {width > 0 && (row.length > 1 || spine) ? (
              <View
                style={[styles.line, above ? styles.busBottom : styles.busTop, { left, width: Math.max(LINE, right - left) }]}
              />
            ) : null}
            {width > 0 && spine && r < rows.length - 1 ? (
              <View style={[styles.line, styles.spine, { left: spineX }]} />
            ) : null}
            {row.map(link => (
              <View
                key={`${link.person.ref.pack_id}:${link.person.ref.id}:${link.evidence_ref}`}
                style={[styles.fanCol, above ? styles.fanColAbove : styles.fanColBelow, colStyle]}>
                {above ? null : <View style={styles.stub} />}
                <Card
                  person={link.person}
                  year={link.year}
                  flags={link.flags}
                  onOpen={() => onOpen(link)}
                  onYear={() => onYear(link)}
                  onFlag={onFlag}
                />
                {above ? <View style={styles.stub} /> : null}
              </View>
            ))}
          </View>
        );
      })}
    </View>
  );
}

export function LineageScreen({ onBack }: Props) {
  const [stack, setStack] = useState<FactNodeRef[]>([]);
  const [query, setQuery] = useState('');
  const [sheet, setSheet] = useState<Sheet | null>(null);

  const center = stack.length ? stack[stack.length - 1] : null;
  const view = useMemo(() => (center ? egoView(center) : null), [center]);
  const hits = useMemo(() => lineageSearch(query), [query]);
  const starters = useMemo(() => topSponsors(8), []);
  const roots = useMemo(() => lineageRoots(), []);

  const open = useCallback((ref: FactNodeRef) => {
    setQuery('');
    // The tree is the thing to look at now — a keyboard left up after a
    // search-tap covered the sponsee row (Pixel, first on-device look).
    Keyboard.dismiss();
    setStack(s => (s.length && sameRef(s[s.length - 1], ref) ? s : [...s, ref]));
  }, []);
  const back = useCallback(() => (stack.length ? setStack(s => s.slice(0, -1)) : onBack()), [stack.length, onBack]);
  const showFlag = useCallback((f: LineageFlag) => setSheet(flagSheet(f)), []);

  const personRow = (p: LineagePerson, meta?: string) => (
    <Pressable key={`${p.ref.pack_id}:${p.ref.id}`} style={styles.listRow} onPress={() => open(p.ref)}>
      <View style={styles.listBody}>
        <Text style={styles.listName}>{p.name}</Text>
        {p.aliases.length ? (
          <Text style={styles.listMeta} numberOfLines={1}>
            {p.aliases.join(' · ')}
          </Text>
        ) : null}
      </View>
      {meta ? <Text style={styles.listMeta}>{meta}</Text> : null}
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );

  const fan = (links: LineageLink[], side: Side) => (
    <Fan
      links={links}
      side={side}
      onOpen={l => open(l.person.ref)}
      onYear={l => setSheet(linkSheet(l, view!.person, side))}
      onFlag={showFlag}
    />
  );

  const body = () => {
    if (query.trim()) {
      return hits.length ? hits.map(p => personRow(p)) : <Text style={styles.empty}>No one by that name in your camp packs.</Text>;
    }
    if (!center) {
      return (
        <>
          <Text style={styles.groupHeader}>Start with someone</Text>
          {starters.map(s => personRow(s.person, `${s.sponseeCount} sponsee${s.sponseeCount === 1 ? '' : 's'}`))}
          <Text style={styles.groupHeader}>Your camp's roots</Text>
          <Text style={styles.hint}>
            People who brought others in but whose own sponsor nobody has named — as far as the record goes.
          </Text>
          <View style={styles.rootWrap}>
            {roots.map(r => (
              <Pressable
                key={`${r.person.ref.pack_id}:${r.person.ref.id}`}
                style={styles.rootChip}
                onPress={() => open(r.person.ref)}>
                <Text style={styles.rootText}>{r.person.name}</Text>
              </Pressable>
            ))}
          </View>
        </>
      );
    }
    if (!view) {
      return <Text style={styles.empty}>That person isn't in an enabled pack any more. Go back and pick someone else.</Text>;
    }
    const me = view.person;
    return (
      <View style={styles.tree}>
        {view.sponsors.length ? (
          <>
            {fan(view.sponsors, 'above')}
            <View style={styles.stub} />
          </>
        ) : (
          <Text style={styles.gap}>nobody has named {me.name}'s sponsor</Text>
        )}
        <View style={styles.centerWrap}>
          <Card person={me} flags={view.flags} center onOpen={() => setSheet(personSheet(view))} onFlag={showFlag} />
          <Text style={styles.years}>
            {view.yearsAttended.length ? `on the camp list ${view.yearsAttended.join(' · ')}` : 'not on a camp list yet'}
          </Text>
        </View>
        {view.sponsees.length ? (
          <>
            <View style={styles.stub} />
            {fan(view.sponsees, 'below')}
          </>
        ) : (
          <Text style={styles.gap}>no one on record as sponsored by {me.name}</Text>
        )}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={back} hitSlop={8} style={styles.headerBtn}>
          <Text style={styles.headerBtnText}>{stack.length ? '‹ back' : '‹ Camp'}</Text>
        </Pressable>
        <Text style={styles.title}>Lineage</Text>
        <Pressable onPress={() => setStack([])} hitSlop={8} style={[styles.headerBtn, styles.headerRight]} disabled={!stack.length}>
          <Text style={[styles.headerBtnText, !stack.length && styles.headerBtnOff]}>start over</Text>
        </Pressable>
      </View>
      <TextInput
        style={styles.search}
        placeholder="Find someone — name or playa name"
        placeholderTextColor={colors.faded}
        value={query}
        onChangeText={setQuery}
        autoCorrect={false}
        clearButtonMode="while-editing"
      />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {body()}
      </ScrollView>
      <Modal visible={sheet !== null} transparent animationType="fade" onRequestClose={() => setSheet(null)}>
        <Pressable style={styles.backdrop} onPress={() => setSheet(null)}>
          <Pressable style={styles.sheet} onPress={() => undefined}>
            <Text style={styles.sheetTitle}>{sheet?.title}</Text>
            {sheet?.lines.map((line, i) => (
              <Text key={i} style={styles.sheetLine}>
                {line}
              </Text>
            ))}
            <Pressable style={styles.sheetBtn} onPress={() => setSheet(null)}>
              <Text style={styles.sheetBtnText}>Close</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const field = {
  backgroundColor: colors.sand,
  borderRadius: radius.card,
  borderWidth: 1,
  borderColor: colors.haze,
} as const;

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: spacing.lg },
  content: { paddingBottom: spacing.xl },
  header: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.lg, marginBottom: spacing.sm },
  headerBtn: { minWidth: 72 },
  headerRight: { alignItems: 'flex-end' },
  headerBtnText: { color: colors.clay, fontSize: type.small, fontWeight: '700' },
  headerBtnOff: { color: colors.haze },
  title: { flex: 1, textAlign: 'center', color: colors.night, fontSize: type.body, fontWeight: '800' },
  search: { ...field, color: colors.night, fontSize: type.body, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, marginBottom: spacing.sm },
  groupHeader: { color: colors.sage, fontSize: type.small, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1, marginTop: spacing.md, marginBottom: spacing.xs },
  hint: { color: colors.faded, fontSize: type.small, marginBottom: spacing.sm },
  empty: { color: colors.faded, fontSize: type.small, textAlign: 'center', marginTop: spacing.xl },
  listRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.sand, borderRadius: radius.card, padding: spacing.md, marginBottom: spacing.xs },
  listBody: { flex: 1, marginRight: spacing.sm },
  listName: { color: colors.night, fontSize: type.body, fontWeight: '600' },
  listMeta: { color: colors.faded, fontSize: type.tiny, marginTop: 2 },
  chevron: { color: colors.faded, fontSize: type.title, fontWeight: '300', marginLeft: spacing.sm },
  rootWrap: { flexDirection: 'row', flexWrap: 'wrap' },
  rootChip: { ...field, borderRadius: radius.chip, paddingHorizontal: spacing.md, paddingVertical: spacing.xs, marginRight: spacing.sm, marginBottom: spacing.sm },
  rootText: { color: colors.night, fontSize: type.small },
  tree: { marginTop: spacing.sm },
  centerWrap: { alignItems: 'center', paddingHorizontal: '18%' },
  years: { color: colors.faded, fontSize: type.tiny, marginTop: spacing.xs, textAlign: 'center' },
  gap: { color: colors.faded, fontSize: type.tiny, textAlign: 'center', marginVertical: spacing.md, fontStyle: 'italic' },
  card: { backgroundColor: colors.sand, borderRadius: radius.card, borderLeftWidth: 3, borderLeftColor: colors.plum, padding: spacing.sm, alignSelf: 'stretch' },
  cardCenter: { borderWidth: 1, borderColor: colors.clay, borderLeftWidth: 3, borderLeftColor: colors.clay, padding: spacing.md, minWidth: 180 },
  cardName: { color: colors.night, fontSize: type.small, fontWeight: '700' },
  cardNameCenter: { fontSize: type.title, textAlign: 'center' },
  cardAlias: { color: colors.faded, fontSize: type.tiny, marginTop: 2 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', marginTop: spacing.xs },
  yearChip: { backgroundColor: colors.plum, borderRadius: radius.chip, paddingHorizontal: spacing.sm, paddingVertical: 2, marginRight: spacing.xs, marginTop: 2 },
  // onAccent, not cream (a11y review 2026-08-24): these tiny badges were the
  // worst pairs in the app — cream-on-gold read 2.41:1 light / 1.97:1 dark.
  // With the deepened light gold and scheme-aware ink, both modes clear AA.
  yearText: { color: colors.onAccent, fontSize: type.tiny, fontWeight: '800' },
  flagChip: { backgroundColor: colors.gold, borderRadius: radius.chip, minWidth: 22, alignItems: 'center', paddingHorizontal: spacing.xs, paddingVertical: 2, marginRight: spacing.xs, marginTop: 2 },
  flagText: { color: colors.onAccent, fontSize: type.tiny, fontWeight: '900' },
  fanRow: { flexDirection: 'row', alignItems: 'flex-start' },
  fanRowAbove: { alignItems: 'flex-end' },
  fanRowSolo: { justifyContent: 'center' },
  fanCol: { alignItems: 'center', paddingHorizontal: 3, flexShrink: 1 },
  fanColAbove: { paddingTop: spacing.xs },
  fanColBelow: { paddingBottom: spacing.xs },
  fanColFlex: { flex: 1 },
  stub: { width: LINE, height: STUB, backgroundColor: colors.sage, alignSelf: 'center' },
  line: { position: 'absolute', backgroundColor: colors.sage },
  busTop: { top: 0, height: LINE },
  busBottom: { bottom: 0, height: LINE },
  spine: { top: 0, bottom: 0, width: LINE },
  backdrop: { flex: 1, backgroundColor: colors.backdrop, justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.sand, borderTopLeftRadius: radius.bubble, borderTopRightRadius: radius.bubble, padding: spacing.lg, paddingBottom: spacing.xl },
  sheetTitle: { color: colors.night, fontSize: type.body, fontWeight: '800', marginBottom: spacing.sm },
  sheetLine: { color: colors.night, fontSize: type.small, marginBottom: spacing.xs },
  sheetBtn: { marginTop: spacing.md, borderRadius: radius.card, borderWidth: 1, borderColor: colors.haze, padding: spacing.md, alignItems: 'center' },
  sheetBtnText: { color: colors.night, fontSize: type.body },
});
