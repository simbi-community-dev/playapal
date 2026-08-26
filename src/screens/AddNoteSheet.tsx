/**
 * Add to camp knowledge — the notes composer sheet (CAMP-NOTES-DESIGN).
 *
 * Five kinds, 2-4 plain fields each, only the text required (the model
 * layer validates; event dates hard-fail at authoring per ruling E). The
 * sheet is presentation only: Save hands buildNoteInput()'s NoteInput to
 * upsertCampNote and shows any CampNoteError verbatim — the human-readable
 * message IS the validation UX, including "set your camp passphrase first"
 * (ruling F). Fix notes opened from a person card / fact row arrive with a
 * typed subject prefilled (ruling C); typed free-text subjects ride in
 * `title` with subject_type ''. Art notes opened from the compass arrive
 * with the selected spot's clock address seeded into Where — the camper is
 * standing at the piece, and retyping an address you just tapped is the
 * kind of work this app exists to remove.
 *
 * No KeyboardAvoidingView here — the app root owns keyboard insets; the
 * sheet body is a ScrollView so fields scroll into view.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Image,
  Modal,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { Text, TextInput } from '../components/Text';
import { InfoTap } from '../components/InfoTap';
import {
  launchCamera,
  launchImageLibrary,
  type ImagePickerResponse,
} from 'react-native-image-picker';
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
  /** A clock address the caller already knows — the compass hands in the
   * address of the spot you are standing on ("4:36 & G"). It SEEDS the
   * editable Where field rather than locking it, unlike subjectLabel: a
   * typed fix subject is a pack pointer free text cannot express, while an
   * address is plain text the camper standing there may want to sharpen. */
  where?: string;
}

/** The chip labels — also what onSaved reports for the confirmation. */
const KIND_LABELS: Record<NoteKind, string> = {
  memory: 'Memory',
  event: 'Event',
  fix: 'Fix a fact',
  resource: 'Resource',
  art: 'Art',
};
const KINDS: NoteKind[] = ['memory', 'event', 'fix', 'resource', 'art'];

export interface NoteFields {
  year: string;
  title: string;
  artist: string;
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
  artist: '',
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
  if (kind === 'art') {
    return {
      kind,
      // Piece AND artist in the title, because the title becomes the chunk
      // HEADING and FTS weights headings far above body text — so either
      // name finds the piece. Same shape tools/load_art.py gives the
      // imported art pack ("## <name> — by <artist>"), so a live sighting
      // and an official listing rank alike in one search.
      title: f.artist ? `${f.title} — by ${f.artist}` : f.title,
      where_addr: f.where,
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
  // Art photo (ruling H): raw base64 JPEG of a 320px thumbnail — the
  // picker's native resize IS the size discipline (docs/FINAL-WEEK.md:
  // full-res never travels, only the thumb).
  const [photo, setPhoto] = useState('');
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
  // Depends on the prefill's CONTENTS, never the object: the compass builds
  // its prefill from the selected spot, and an inline object would be a new
  // identity every render — re-seeding Where under the camper's fingers on
  // every keystroke.
  const prefillKind = prefill?.kind;
  const prefillWhere = prefill?.where;
  useEffect(() => {
    if (!visible) {
      return;
    }
    setKind(prefillKind ?? 'memory');
    if (prefillWhere) {
      setFields(f => ({ ...f, where: prefillWhere }));
    }
    setErr('');
  }, [visible, prefillKind, prefillWhere]);

  const set = useCallback(
    (key: keyof NoteFields) => (t: string) =>
      setFields(f => ({ ...f, [key]: t })),
    [],
  );

  const takePhoto = useCallback(async (fromCamera: boolean) => {
    try {
      if (fromCamera && Platform.OS === 'android') {
        // Declaring CAMERA in the manifest makes the runtime grant
        // MANDATORY before launchCamera (image-picker refuses otherwise).
        const got = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.CAMERA,
          {
            title: 'Photograph the art',
            message: 'Playa Pal takes a small photo of the art piece — it stays on this phone and in your camp beams.',
            buttonPositive: 'OK',
            buttonNegative: 'Not now',
          },
        );
        if (got !== PermissionsAndroid.RESULTS.GRANTED) {
          setErr('No camera permission — you can pick a photo from the gallery instead.');
          return;
        }
      }
      const opts = {
        mediaType: 'photo' as const,
        maxWidth: 320,
        maxHeight: 320,
        quality: 0.6 as const,
        includeBase64: true,
        selectionLimit: 1,
        // iOS PHPicker defaults to Automatic representation, which hands
        // HEIC over as HEIC — and the JPEG check below would then refuse
        // every iPhone gallery pick. 'compatible' forces the JPEG
        // re-encode at the source (image-picker 8.2.1, measured by codex).
        assetRepresentationMode: 'compatible' as const,
        presentationStyle: 'fullScreen' as const,
      };
      const res: ImagePickerResponse = fromCamera
        ? await launchCamera(opts)
        : await launchImageLibrary(opts);
      if (res.didCancel) {
        return;
      }
      if (res.errorCode) {
        setErr(`Could not get a photo (${res.errorMessage ?? res.errorCode}).`);
        return;
      }
      const asset = res.assets?.[0];
      const b64 = asset?.base64 ?? '';
      if (!b64) {
        setErr('That photo did not come through — try again.');
        return;
      }
      // iOS image-picker 8.2.1 reports JPEG as 'image/jpg' (getFileType in
      // ImagePickerUtils.mm returns 'jpg' for the 0xFF magic); Android says
      // 'image/jpeg'. Both are the same bytes (codex review blocker 4).
      const mime = asset?.type ?? 'image/jpeg';
      if (mime !== 'image/jpeg' && mime !== 'image/jpg') {
        setErr('That image is not a JPEG — snap it with the camera instead.');
        return;
      }
      setPhoto(b64.replace(/\s+/g, ''));
      setErr('');
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }, []);

  const save = useCallback(() => {
    try {
      const conn = getDb();
      upsertCampNote(conn, {
        ...buildNoteInput(kind, fields, prefill),
        ...(kind === 'art' ? { photo } : null),
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
    setPhoto('');
    setErr('');
    setEditingId(null);
    onSaved(KIND_LABELS[kind], editingId !== null);
    onClose();
  }, [kind, fields, photo, prefill, editingId, onSaved, onClose]);

  const startEdit = useCallback((n: CampNote) => {
    setEditingId(n.id);
    setKind(n.kind);
    setFields({
      year: n.year,
      // Art titles carry "<piece> — by <artist>" as one string; putting it
      // back whole and leaving Artist empty round-trips it unchanged (the
      // build only appends an artist when the Artist field has one).
      title: n.kind === 'fix' ? '' : n.title,
      artist: '',
      date: n.when_date,
      start: n.time_start,
      end: n.time_end,
      where: n.where_addr,
      subject: n.kind === 'fix' ? n.title : '',
      text: n.text,
    });
    // The sheet's photo state mirrors the note's truth while editing, so
    // Save can always pass it: keeping, replacing and removing all mean
    // exactly what the screen shows.
    setPhoto(n.photo);
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
          setEditingId(cur => {
            if (cur === n.id) {
              // the sheet was editing the note that just died — its photo
              // must not survive into the next unrelated save
              setPhoto('');
              return null;
            }
            return cur;
          });
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

            {kind === 'art' ? (
              <>
                {input('title', 'Name of the piece (optional)')}
                {input('artist', 'Artist (optional)')}
                {input('where', 'Where — like 4:36 & G, or 3:00 & 2000ft')}
                {textArea('What it looks like*')}
                {photo ? (
                  <View style={styles.photoRow}>
                    <Image
                      source={{ uri: `data:image/jpeg;base64,${photo}` }}
                      style={styles.photoThumb}
                    />
                    <Pressable onPress={() => setPhoto('')}>
                      <Text style={styles.noteAction}>Remove photo</Text>
                    </Pressable>
                  </View>
                ) : (
                  <View style={styles.photoBtnRow}>
                    <Pressable
                      style={styles.secondaryBtn}
                      onPress={() => void takePhoto(true)}>
                      <Text style={styles.secondaryBtnText}>📷 Snap the piece</Text>
                    </Pressable>
                    <Pressable
                      style={styles.secondaryBtn}
                      onPress={() => void takePhoto(false)}>
                      <Text style={styles.secondaryBtnText}>Choose photo</Text>
                    </Pressable>
                  </View>
                )}
              </>
            ) : null}

            {err.length > 0 ? <Text style={styles.errLine}>{err}</Text> : null}

            {/* THE TUFTE PASS (owner ask 2026-08-26): where a note GOES is
                the same lesson every time — it varies with the kind being
                written, not with anything this phone has measured. The ?
                rides beside Save, never inside it: a Pressable within a
                Pressable is a nested responder. */}
            <View style={styles.saveRow}>
              <Pressable style={[styles.primaryBtn, styles.saveFlex]} onPress={save}>
                <Text style={styles.primaryBtnText}>
                  {editingId ? 'Save changes' : 'Save note'}
                </Text>
              </Pressable>
              <InfoTap
                topic="where your note goes"
                text={
                  'Notes travel with your camp beam and show up in search, ' +
                  'the reader, and (events) the Now tab.' +
                  (kind === 'fix'
                    ? ' Fixes ride along wherever the Angel cites the ' +
                      'original fact.'
                    : '') +
                  (kind === 'art'
                    ? ' Art you log is your camp’s own directory — it needs ' +
                      'no official listing and no signal.'
                    : '')
                }
              />
            </View>
            {editingId ? (
              <Pressable
                onPress={() => {
                  setEditingId(null);
                  setFields(EMPTY_FIELDS);
                  setPhoto('');
                  setErr('');
                }}>
                <Text style={styles.noteAction}>Cancel editing</Text>
              </Pressable>
            ) : null}


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
    backgroundColor: colors.backdrop, // shared sheet veil — themed both modes
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
  chipTextActive: { color: colors.onAccent, fontWeight: '700' },
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
  primaryBtnText: { color: colors.onAccent, fontSize: type.body, fontWeight: '700' },
  // THE TUFTE PASS (2026-08-26): Save keeps the width it had; the ? takes
  // the space beside it, and `hint` — this file's only user — left with the
  // paragraph it styled.
  saveRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  saveFlex: { flex: 1 },
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
  photoBtnRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  photoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.xs },
  photoThumb: { width: 96, height: 96, borderRadius: radius.card, backgroundColor: colors.haze },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: colors.clay,
    borderRadius: radius.card,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  // fontSize is STATED, not inherited from react-native's 14pt default: the
  // size dial multiplies the numbers a style actually carries (see
  // src/components/Text.tsx), so a top-level label with no fontSize is a
  // label that ignores Bigger and Biggest. These two are top-level — "Snap
  // the piece" and "Choose photo" sit in their own row, under no parent
  // Text to inherit a grown size from (a11y review 2026-08-26).
  secondaryBtnText: { color: colors.clay, fontSize: type.body, fontWeight: '700' },
});
