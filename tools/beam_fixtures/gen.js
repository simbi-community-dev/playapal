#!/usr/bin/env node
/* global Buffer */
/**
 * Beam fixture generator (ds4pro lane — docs/BEAM-INGRESS-CONTRACT.md §7).
 *
 * Reproduces, under node, the exact beams a real pair of phones produces, by
 * compiling the app's OWN modules (src/camp/campBoard.ts + src/events/schema.ts)
 * to CommonJS in a temp dir and driving them through node:sqlite — the same
 * host __tests__/campBoard.test.ts uses. Nothing here is reimplemented that
 * does not have to be: only the future-kind envelope is hand-sealed, because
 * the app's authoring API (upsertCampNote) coerces an unknown kind to 'memory'
 * by design — an unknown kind can only ever arrive from a NEWER build, so it
 * must be manufactured at the wire boundary.
 *
 * Every fixture is proven by the generator itself: the valid beam is imported
 * into a fresh phone and the delta asserted; the future-kind beam is imported
 * and its unknown-kind note read back as 'memory' (degrade, never throw).
 *
 * Outputs (into this directory):
 *   valid-2-envelope.playapal         2 writers, 2 posts, 1 note (Maria+Ben)
 *   truncated-60.playapal             the valid beam cut at 60% (invalid JSON)
 *   byte-flipped.playapal             valid beam, one text byte flipped (seal breaks)
 *   future-kind.playapal              sealed beam carrying a note kind 'sculpture'
 *   unrelated-octet-stream.playapal   not JSON, not a beam (honest refusal)
 *   oversize-4mib-plus-1.playapal     valid beam padded to exactly 4 MiB + 1 byte
 *                                     (committed? NO — generated here + by beam_gate.sh)
 *
 * The oversize fixture is written to /tmp (not committed) because it is 4 MiB
 * of deterministic padding; beam_gate.sh regenerates it identically.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..');
const OUT = __dirname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-fixtures-'));
const TSC = path.join(REPO, 'node_modules', '.bin', 'tsc');

// 1. Compile the two modules we drive (+ their import graph) to CommonJS.
execFileSync(TSC, [
  '--ignoreConfig',
  '--module', 'commonjs',
  '--target', 'es2020',
  '--moduleResolution', 'node',
  '--ignoreDeprecations', '6.0',
  '--esModuleInterop',
  '--skipLibCheck',
  '--types', 'node',
  '--outDir', TMP,
  path.join(REPO, 'src', 'camp', 'campBoard.ts'),
  path.join(REPO, 'src', 'events', 'schema.ts'),
], { cwd: REPO, stdio: 'inherit' });

const CB = require(path.join(TMP, 'camp', 'campBoard.js'));
const NOTES = require(path.join(TMP, 'camp', 'campNotes.js'));
const HMAC = require(path.join(TMP, 'camp', 'hmac.js'));
const SCHEMA = require(path.join(TMP, 'events', 'schema.js'));

const { DatabaseSync } = require('node:sqlite');

// 2. The node:sqlite shim the tests use — same result shape the app speaks.
function makePhone(writerId) {
  const db = new DatabaseSync(':memory:');
  const conn = {
    execute(sql, params = []) {
      const stmt = db.prepare(sql);
      if (/^\s*(select|with|pragma)/i.test(sql)) {
        const rows = stmt.all(...params);
        return { rows: { _array: rows, length: rows.length, item: i => rows[i] } };
      }
      stmt.run(...params);
      return { rows: undefined };
    },
  };
  for (const sql of [...SCHEMA.BASE_TABLES_SQL, ...SCHEMA.FTS_TABLES_SQL]) {
    conn.execute(sql);
  }
  if (writerId) {
    conn.execute('INSERT INTO settings (key, value) VALUES (?, ?)', [
      'camp_writer_id',
      writerId,
    ]);
  }
  return conn;
}

const sha256Hex = s =>
  Array.from(HMAC.sha256(HMAC.utf8Bytes(s)), b => b.toString(16).padStart(2, '0')).join('');

// Manual wire sealing (future-kind only). These are the four internal helpers
// from campBoard.ts, transcribed so an unknown note kind can be sealed:
//   canonicalPosts   (field-ordered, id-sorted, unit-separated)
//   canonicalPayload (posts RS notes, format >= 2)
//   macMessage       (kind + head + canonical, newline-joined)
//   sealKey          ('playapal-camp-v0:' + normalized passphrase)
const canonicalPosts = posts =>
  posts
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(p =>
      [p.id, p.ref_id ?? '', p.type, p.text, p.author_name, p.created_at, p.done ? '1' : '0'].join(''),
    )
    .join('\n');

const canonicalPayload = (format, posts, notes) =>
  format >= 2
    ? `${canonicalPosts(posts)}\n${NOTES.canonicalNotes(notes)}`
    : canonicalPosts(posts);

const macMessage = (head, canonical) =>
  [
    CB.CAMP_BUNDLE_KIND,
    String(head.format),
    head.camp_id,
    head.writer_id,
    head.author_name,
    head.key_id,
    String(head.seq),
    head.payload_hash,
    canonical,
  ].join('\n');

const sealKey = passphrase => `playapal-camp-v0:${CB.normalizePassphrase(passphrase)}`;

/** One CampPost as listCampBoard returns it, narrowed to the wire fields. */
const wirePost = p => ({
  id: p.id,
  ref_id: p.ref_id,
  type: p.type,
  text: p.text,
  author_name: p.author_name,
  created_at: p.created_at,
  done: p.done,
});

// 3. Build the two phones and the valid 2-envelope beam.
const maria = makePhone('aaaa1111');
const ben = makePhone('bbbb2222');
CB.saveCampProfile(maria, { authorName: 'Maria', passphrase: 'Dusty Mary' });
CB.saveCampProfile(ben, { authorName: 'Ben', passphrase: 'dusty mary' });
CB.upsertCampPost(maria, { type: 'offer', text: '3 spare bike tubes' });
CB.upsertCampPost(ben, { type: 'need', text: 'ride to Reno Tuesday' });
CB.upsertCampNote(maria, { kind: 'resource', title: 'Spare parts', text: 'spare bike chain in the bin by camp' });
CB.installCampBundle(maria, CB.exportCampBundle(ben)); // Maria now relays Ben too
const valid = CB.exportCampBundle(maria);

const parsed = JSON.parse(valid);
if (parsed.envelopes.length !== 2) {
  throw new Error(`expected 2 envelopes, got ${parsed.envelopes.length}`);
}

// Prove it: a fresh phone imports the beam and sees both writers + the note.
const fresh = makePhone('cccc3333');
CB.saveCampProfile(fresh, { authorName: 'Caro', passphrase: 'dusty mary' });
const r = CB.installCampBundle(fresh, valid);
if (r.installed.sort().join(',') !== 'Ben,Maria') {
  throw new Error(`unexpected install: ${r.installed.join(',')}`);
}
const freshNotes = NOTES.listCampNotes(fresh, CB.campIdFor('dusty mary'));
if (freshNotes.length !== 1 || freshNotes[0].kind !== 'resource') {
  throw new Error(`note did not install: ${JSON.stringify(freshNotes)}`);
}

fs.writeFileSync(path.join(OUT, 'valid-2-envelope.playapal'), valid);

// 4. Truncated at 60% (invalid JSON).
const cut = Math.floor(valid.length * 0.6);
fs.writeFileSync(path.join(OUT, 'truncated-60.playapal'), valid.slice(0, cut));

// 5. Byte-flipped: one text byte swapped, JSON stays valid, the seal breaks.
const flipAt = valid.indexOf('bike tubes');
if (flipAt < 0) {
  throw new Error('fixture anchor not found');
}
const flipped =
  valid.slice(0, flipAt) + 'bike tubef' + valid.slice(flipAt + 'bike tubes'.length);
// Prove it is still JSON but fails the seal.
if (CB.parseCampBundle(flipped) === null) {
  throw new Error('flipped fixture stopped being JSON — anchor is structural, not textual');
}
let refused = false;
try {
  CB.installCampBundle(fresh, flipped);
} catch (e) {
  refused = /integrity/i.test(String(e.message));
}
if (!refused) {
  throw new Error('flipped fixture did not fail the integrity check');
}
fs.writeFileSync(path.join(OUT, 'byte-flipped.playapal'), flipped);

// 6. Future-kind: a note kind this build cannot name ('sculpture'), sealed as
// a NEWER build would. Authoring coerces, so hand-build the envelope and seal.
const futurePhone = makePhone('ffffaaaa');
CB.saveCampProfile(futurePhone, { authorName: 'Future', passphrase: 'dusty mary' });
CB.upsertCampPost(futurePhone, { type: 'offer', text: 'a future-built board' });
const fIdentity = CB.getCampIdentity(futurePhone);
const fPosts = CB.listCampBoard(futurePhone)
  .filter(p => !p.ref_id)
  .map(wirePost);
const futureNote = {
  id: 'ffffaaaa:n-future-1',
  writer_id: 'ffffaaaa',
  author_name: 'Future',
  kind: 'sculpture', // unknown to this build
  title: 'Art the future knows',
  when_date: '',
  time_start: '',
  time_end: '',
  where_addr: '',
  text: 'a note kind this build cannot name',
  subject_type: '',
  subject_key: '',
  year: '',
  supersedes: '',
  created_at: new Date().toISOString(),
  revised_at: '',
};
const seq = 1; // the single post above bumped own seq to 1
const fCanonical = canonicalPayload(CB.CAMP_BUNDLE_FORMAT, fPosts, [futureNote]);
const fHead = {
  format: CB.CAMP_BUNDLE_FORMAT,
  camp_id: fIdentity.campId,
  writer_id: fIdentity.writerId,
  author_name: fIdentity.authorName,
  key_id: fIdentity.keyId,
  seq,
  payload_hash: sha256Hex(fCanonical),
};
const futureBundle = {
  kind: CB.CAMP_BUNDLE_KIND,
  format: CB.CAMP_BUNDLE_FORMAT,
  camp_id: fIdentity.campId,
  envelopes: [
    {
      ...fHead,
      posts: fPosts,
      notes: [futureNote],
      tag: HMAC.hmacSha256Hex(sealKey('dusty mary'), macMessage(fHead, fCanonical)),
    },
  ],
};
const futureJson = JSON.stringify(futureBundle, null, 1);
// Prove it: imports cleanly, note degrades to 'memory', never throws.
const futureFresh = makePhone('dddd4444');
CB.saveCampProfile(futureFresh, { authorName: 'Dee', passphrase: 'dusty mary' });
CB.installCampBundle(futureFresh, futureJson);
const fNotes = NOTES.listCampNotes(futureFresh, CB.campIdFor('dusty mary'));
if (fNotes.length !== 1 || fNotes[0].kind !== 'memory') {
  throw new Error(`future-kind note did not degrade: ${JSON.stringify(fNotes)}`);
}
fs.writeFileSync(path.join(OUT, 'future-kind.playapal'), futureJson);

// 7. Unrelated octet-stream: bytes that are not JSON and not any beam.
const octet = Buffer.from(
  'Not a Playa Pal beam.\nJust a file someone handed over.\n',
  'utf8',
);
fs.writeFileSync(path.join(OUT, 'unrelated-octet-stream.playapal'), octet);

// 8. Oversize: valid beam padded to exactly 4 MiB + 1 byte. Over the JS
// MAX_BEAM_BYTES size gate (4 MiB), under the native 4 MiB + 4 KiB cap — the
// seam must refuse it honestly with zero DB delta. Not committed (4 MiB).
const TARGET = 4 * 1024 * 1024 + 1;
// The '\n' below is 1 byte; pad to make the whole file land exactly on TARGET.
const pad = TARGET - Buffer.byteLength(valid) - 1;
if (pad < 0) {
  throw new Error('valid beam already exceeds the oversize target');
}
const oversize = valid + '\n' + ' '.repeat(pad);
if (Buffer.byteLength(oversize) !== TARGET) {
  throw new Error(`oversize length ${Buffer.byteLength(oversize)} != ${TARGET}`);
}
fs.writeFileSync('/tmp/beam-oversize-4mib-plus-1.playapal', oversize);

// 9. Manifest of expected device deltas (the gate script's single source of
// truth for the matrix it prints).
const manifest = {
  passphrase: 'dusty mary',
  camp_id: CB.campIdFor('dusty mary'),
  'valid-2-envelope.playapal': {
    expect: 'installs 2 writers (Maria, Ben); +2 camp_posts; +1 camp_note (resource)',
    posts_delta: 2,
    notes_delta: 1,
  },
  'truncated-60.playapal': { expect: 'refused (not a beam / damaged); 0 delta' },
  'byte-flipped.playapal': { expect: 'refused (integrity); 0 delta' },
  'future-kind.playapal': {
    expect: 'installs Future; +1 camp_post; +1 camp_note stored kind sculpture, reads memory',
    posts_delta: 1,
    notes_delta: 1,
  },
  'unrelated-octet-stream.playapal': { expect: 'refused (not a beam); 0 delta' },
  'oversize-4mib-plus-1.playapal': { expect: 'refused (size gate); 0 delta' },
};
fs.writeFileSync(
  path.join(OUT, 'manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);

console.log('wrote fixtures to', OUT);
for (const f of [
  'valid-2-envelope.playapal',
  'truncated-60.playapal',
  'byte-flipped.playapal',
  'future-kind.playapal',
  'unrelated-octet-stream.playapal',
  'manifest.json',
]) {
  const st = fs.statSync(path.join(OUT, f));
  console.log(`  ${f}\t${st.size} bytes`);
}
console.log('oversize fixture -> /tmp/beam-oversize-4mib-plus-1.playapal (4 MiB + 1 B)');
