/**
 * Add to camp knowledge — the notes composer sheet (CAMP-NOTES-DESIGN).
 *
 * Four kinds, 2-4 plain fields each, only the text required (the model
 * layer validates; event dates hard-fail at authoring per ruling E). The
 * sheet is presentation only: Save hands buildNoteInput()'s NoteInput to
 * upsertCampNote and shows any CampNoteError verbatim — the human-readable
 * message IS the validation UX, including "set your camp passphrase first"
 * (ruling F). Fix notes opened from a person card / fact row arrive with a
 * typed subject prefilled (ruling C); typed free-text subjects ride in
 * `title` with subject_type ''.
 *
 * No KeyboardAvoidingView here — the app root owns keyboard insets; the
 * sheet body is a ScrollView so fields scroll into view.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { getDb, rebuildFtsIndexes } from '../events/db';
import { getCampIdentity, removeCampNote, upsertCampNote } from '../camp/campBoard';
import {
  CampNoteError,
  ownNoteRows,
  type CampNote,
  type NoteInput,
  type NoteKind,
} from '../camp/campNotes';
import { colors, radius, spacing, type } from '../theme';
import { useKeyboardInset } from '../hooks/useKeyboardInset';

export interface AddNotePrefill {
  kind?: NoteKind;
  subject_type?: 'person';
  subject_key?: string;
  subjectLabel?: string;
}

/** The chip labels — also what onSaved reports for the confirmation. */
const KIND_LABELS: Record<NoteKind, string> = {
  memory: 'Memory',
  event: 'Event',
  fix: 'Fix a fact',
  resource: 'Resource',
};
const KINDS: NoteKind[] = ['memory', 'event', 'fix', 'resource'];

export interface NoteFields {
  year: string;
  title: string;
  date: string;
  start: string;
  end: string;
  where: string;
  subject: string;
  text: string;
}

const EMPTY_FIELDS: NoteFields = {
  year: '',
  title: '',
  date: '',
  start: '',
  end: '',
  where: '',
  subject: '',
  text: '',
};

/**
 * Pure per-kind field mapping: what the sheet's Save hands to
 * upsertCampNote. Fix free-text subjects become `title`; a typed prefill
 * subject wins over free text and carries subject_type/subject_key
 * (ruling C). Exported for direct unit testing.
 */
export function buildNoteInput(
  kind: NoteKind,
  f: NoteFields,
  prefill?: AddNotePrefill,
): NoteInput {
  if (kind === 'memory') {
    return { kind, text: f.text, year: f.year };
  }
  if (kind === 'event') {
    return {
      kind,
      title: f.title,
      when_date: f.date,
      time_start: f.start,
      time_end: f.end,
      where_addr: f.where,
      text: f.text,
    };
  }
  if (kind === 'fix') {
    return {
      kind,
      title: prefill?.subjectLabel ?? f.subject,
      subject_type: prefill?.subject_type ?? '',
      subject_key: prefill?.subject_key ?? '',
      text: f.text,
    };
  }
  return { kind, text: f.text, title: f.title };
}

export function AddNoteSheet({
  visible,
  onClose,
  onSaved,
  prefill,
}: {
  visible: boolean;
  onClose: () => void;
  onSaved: (kindLabel: string, wasEdit: boolean) => void;
  prefill?: AddNotePrefill;
}) {
  // The root's keyboard inset never reaches an RN Modal (Marisol finding:
  // Save note hid behind the IME). The sheet carries its own.
  const kbInset = useKeyboardInset();
  const [kind, setKind] = useState<NoteKind>(prefill?.kind ?? 'memory');
  const [fields, setFields] = useState<NoteFields>(EMPTY_FIELDS);
  const [err, setErr] = useState('');
  // Marisol finding: the model always had reviseNote/removeCampNote, but a
  // camper who typo'd had NO surface — a typo was forever. Own notes list
  // here, editable and deletable, in the same sheet that made them.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [mine, setMine] = useState<CampNote[]>([]);
  useEffect(() => {
    if (!visible) {
      return;
    }
    const conn = getDb();
    const id = getCampIdentity(conn);
    setMine(id.campId ? ownNoteRows(conn, id.campId, id.writerId) : []);
  }, [visible, err, editingId]);

  // Each open re-reads the prefill (a "Suggest a fix" long-press lands
  // here mid-session); typed drafts survive an accidental dismiss.
  useEffect(() => {
    if (visible) {
      setKind(prefill?.kind ?? 'memory');
      setErr('');
    }
  }, [visible, prefill]);

  const set = useCallback(
    (key: keyof NoteFields) => (t: string) =>
      setFields(f => ({ ...f, [key]: t })),
    [],
  );

  const save = useCallback(() => {
    try {
      const conn = getDb();
      upsertCampNote(conn, {
        ...buildNoteInput(kind, fields, prefill),
        ...(editingId ? { id: editingId } : null),
      });
      rebuildFtsIndexes(conn);
    } catch (e: any) {
      if (e instanceof CampNoteError) {
        setErr(e.message);
        return;
      }
      Alert.alert('Could not save', e?.message ?? String(e));
      return;
    }
    setFields(EMPTY_FIELDS);
    setErr('');
    setEditingId(null);
    onSaved(KIND_LABELS[kind], editingId !== null);
    onClose();
  }, [kind, fields, prefill, editingId, onSaved, onClose]);

  const startEdit = useCallback((n: CampNote) => {
    setEditingId(n.id);
    setKind(n.kind);
    setFields({
      year: n.year,
      title: n.kind === 'fix' ? '' : n.title,
      date: n.when_date,
      start: n.time_start,
      end: n.time_end,
      where: n.where_addr,
      subject: n.kind === 'fix' ? n.title : '',
      text: n.text,
    });
    setErr('');
  }, []);

  const deleteNote = useCallback((n: CampNote) => {
    Alert.alert('Remove this note?', 'It leaves this phone now and campmates\u2019 phones with your next beam.', [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          const conn = getDb();
          removeCampNote(conn, n.id);
          rebuildFtsIndexes(conn);
          setEditingId(cur => (cur === n.id ? null : cur));
          setErr(e => e);
          setMine(m => m.filter(x => x.id !== n.id));
        },
      },
    ]);
  }, []);

  const input = (
    key: keyof NoteFields,
    placeholder: string,
    extra?: object,
  ) => (
    <TextInput
      style={styles.input}
      placeholder={placeholder}
      placeholderTextColor={colors.faded}
      value={fields[key]}
      onChangeText={set(key)}
      {...extra}
    />
  );

  const textArea = (placeholder: string) => (
    <TextInput
      style={[styles.input, styles.textArea]}
      placeholder={placeholder}
      placeholderTextColor={colors.faded}
      value={fields.text}
      onChangeText={set('text')}
      multiline
    />
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={styles.scrim} onPress={onClose} />
        <View style={styles.sheet}>
          <ScrollView
            contentContainerStyle={[styles.content, { paddingBottom: kbInset + spacing.lg }]}
            keyboardShouldPersistTaps="handled">
            <View style={styles.headerRow}>
              <Text style={styles.title}>Add to camp knowledge</Text>
              <Pressable onPress={onClose} hitSlop={spacing.md}>
                <Text style={styles.close}>Close</Text>
              </Pressable>
            </View>

            {/* Kind picker — the board's chip toggle, generalized to four. */}
            <View style={styles.chipRow}>
              {KINDS.map(k => (
                <Pressable
                  key={k}
                  style={[styles.chip, kind === k && styles.chipActive]}
                  onPress={() => setKind(k)}>
                  <Text
                    style={[styles.chipText, kind === k && styles.chipTextActive]}>
                    {KIND_LABELS[k]}
                  </Text>
                </Pressable>
              ))}
            </View>

            {kind === 'memory' ? (
              <>
                {input('year', 'Year (optional) — like 2019', {
                  keyboardType: 'number-pad',
                  maxLength: 4,
                })}
                {textArea('The memory*')}
              </>
            ) : null}

            {kind === 'event' ? (
              <>
                {input('title', 'Title (optional)')}
                {input('date', 'Date* — like 2026-09-02')}
                {input('start', 'Start* — like 19:30')}
                {input('end', 'End (optional)')}
                {input('where', 'Where (optional) — like 7:32 & C')}
                {textArea("What's happening*")}
              </>
            ) : null}

            {kind === 'fix' ? (
              <>
                {prefill?.subjectLabel ? (
                  <Text style={styles.fixing}>Fixing: {prefill.subjectLabel}</Text>
                ) : (
                  input('subject', 'What needs fixing (who or what)*')
                )}
                {textArea('The correction*')}
              </>
            ) : null}

            {kind === 'resource' ? (
              <>
                {input('title', 'Title (optional)')}
                {textArea('What and where*')}
              </>
            ) : null}

            {err.length > 0 ? <Text style={styles.errLine}>{err}</Text> : null}

            <Pressable style={styles.primaryBtn} onPress={save}>
              <Text style={styles.primaryBtnText}>
                {editingId ? 'Save changes' : 'Save note'}
              </Text>
            </Pressable>
            {editingId ? (
              <Pressable
                onPress={() => {
                  setEditingId(null);
                  setFields(EMPTY_FIELDS);
                  setErr('');
                }}>
                <Text style={styles.noteAction}>Cancel editing</Text>
              </Pressable>
            ) : null}

            <Text style={styles.hint}>
              Notes travel with your camp beam and show up in search, the
              reader, and (events) the Now tab.
              {kind === 'fix'
                ? ' Fixes ride along wherever the Angel cites the original fact.'
                : ''}
            </Text>

            {mine.length > 0 ? (
              <>
                <Text style={styles.mineTitle}>My notes</Text>
                {mine.map(n => (
                  <View key={n.id} style={styles.mineRow}>
                    <Text style={styles.mineText} numberOfLines={2}>
                      {KIND_LABELS[n.kind]}
                      {n.title ? ` — ${n.title}` : ''}: {n.text}
                    </Text>
                    <View style={styles.mineActions}>
                      <Pressable onPress={() => startEdit(n)} hitSlop={spacing.sm}>
                        <Text style={styles.noteAction}>Edit</Text>
                      </Pressable>
                      <Pressable onPress={() => deleteNote(n)} hitSlop={spacing.sm}>
                        <Text style={styles.noteAction}>Remove</Text>
                      </Pressable>
                    </View>
                  </View>
                ))}
              </>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    backgroundColor: '#000000aa',
    flex: 1,
    justifyContent: 'flex-end',
  },
  scrim: { flex: 1 },
  sheet: {
    backgroundColor: colors.dust,
    borderTopLeftRadius: radius.card,
    borderTopRightRadius: radius.card,
    maxHeight: '85%',
  },
  content: { padding: spacing.lg },
  headerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  title: { color: colors.night, fontSize: type.title, fontWeight: '800' },
  close: { color: colors.clay, fontSize: type.small, fontWeight: '700' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap' },
  chip: {
    backgroundColor: colors.sand,
    borderColor: colors.haze,
    borderRadius: radius.chip,
    borderWidth: 1,
    marginBottom: spacing.sm,
    marginRight: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  chipActive: { backgroundColor: colors.sage, borderColor: colors.sage },
  chipText: { color: colors.night, fontSize: type.small },
  chipTextActive: { color: colors.cream, fontWeight: '700' },
  input: {
    backgroundColor: colors.sand,
    borderColor: colors.haze,
    borderRadius: radius.card,
    borderWidth: 1,
    color: colors.night,
    fontSize: type.body,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  textArea: { minHeight: 72, textAlignVertical: 'top' },
  fixing: {
    color: colors.night,
    fontSize: type.body,
    fontWeight: '700',
    marginBottom: spacing.sm,
  },
  errLine: { color: colors.clay, fontSize: type.small, marginBottom: spacing.sm },
  primaryBtn: {
    alignItems: 'center',
    backgroundColor: colors.clay,
    borderRadius: radius.card,
    padding: spacing.md,
  },
  primaryBtnText: { color: colors.cream, fontSize: type.body, fontWeight: '700' },
  hint: { color: colors.faded, fontSize: type.small, marginTop: spacing.sm },
  mineTitle: {
    color: colors.night,
    fontSize: type.body,
    fontWeight: '700',
    marginTop: spacing.lg,
    marginBottom: spacing.xs,
  },
  mineRow: { marginTop: spacing.sm },
  mineText: { color: colors.night, fontSize: type.small },
  mineActions: { flexDirection: 'row', gap: spacing.lg, marginTop: 2 },
  noteAction: { color: colors.clay, fontSize: type.small, fontWeight: '700', marginTop: spacing.xs },
});
