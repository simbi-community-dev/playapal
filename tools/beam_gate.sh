#!/usr/bin/env bash
#
# beam_gate.sh — the device + negative gate for beam ingress
# (ds4pro lane, docs/BEAM-INGRESS-CONTRACT.md §7).
#
# For each fixture × {VIEW application/octet-stream, VIEW our MIME,
# SEND via EXTRA_STREAM} × {app killed, app warm}: deliver the file, fire the
# intent, wait, then assert the DB row delta in the board + notes tables
# against tools/beam_fixtures/manifest.json. Prints a PASS/FAIL matrix.
#
# It runs ON the box that owns adb to the device (the emulator host,
# the hub for the two Pixels) — never through an ssh hop, because nested
# quoting mangles the run-as sqlite queries (measured). scp this script and
# tools/beam_fixtures/ to the box, then run it there.
#
# Delivery primitive (proven by pug-claude-5's first emulator run, folded in):
# push to /sdcard/Download → `content call --method scan_file --arg <abs-path>`
# → resolve the MediaStore Downloads content id → `am start -W
# --grant-read-uri-permission -a <ACTION> [-t <mime>] -d content://...`. The
# landed native module (ea1ba6e, BeamIngressModule.copyIn) reads the URI with
# contentResolver.openInputStream(uri), so the URI must be a RESOLVABLE
# content:// URI — never file:// (openInputStream throws) and never the app's
# own FileProvider (it exposes no incoming root).
#
# The DB-delta assertion reads camp_posts + camp_notes through `run-as <pkg>
# sqlite3 <db>` (debug-signed build). The camp state is RESET to a known
# baseline before each case (passphrase kept, imported writers cleared) so a
# fixture's delta is measured first-arrival, not cumulative; the idempotence
# case (same beam twice → 0 delta) is asserted as its own row.
#
# Box law: no jest, no bare grep (git grep or /usr/bin/rg in-repo), no -o with
# unanchored patterns on fetched/minified files.
#
# Usage:
#   tools/beam_gate.sh --dry-run
#   beam_gate.sh -s emulator-5554 --run               # on the emulator host
#   beam_gate.sh -s <device-serial> --run             # on a real handset
#   beam_gate.sh -s emulator-5554 --fixture valid-2-envelope.playapal --run

set -u

SERIAL=""
PKG="com.playapal"
MIME="application/vnd.playapal.beam+json"
DB_NAME="pocket-hippo.db"          # the on-disk name (see src/events/db.ts)
# op-sqlite ANDROID_FILES_PATH == context.filesDir.absolutePath == /data/user/0/<pkg>/files
DB_PATH="/data/user/0/${PKG}/files/${DB_NAME}"
FIXTURE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/beam_fixtures" && pwd)"
MANIFEST="${FIXTURE_DIR}/manifest.json"
MODE="dry-run"
ONE_FIXTURE=""
PASSPHRASE="dusty mary"             # every fixture shares this camp (manifest.json)

while [ $# -gt 0 ]; do
  case "$1" in
    -s) SERIAL="$2"; shift 2 ;;
    --run) MODE="run"; shift ;;
    --dry-run) MODE="dry-run"; shift ;;
    --fixture) ONE_FIXTURE="$2"; shift 2 ;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

ADB=(adb)
[ -n "$SERIAL" ] && ADB=(adb -s "$SERIAL")

# ---------------------------------------------------------------------------
# sqlite helpers (single run-as call each; the SQL is a single double-quoted
# word exactly as emu-deliver.sh does it — this is the shape that survives).
# ---------------------------------------------------------------------------
q() { "${ADB[@]}" shell "run-as $PKG sqlite3 $DB_PATH \"$1\"" 2>/dev/null | tr -d '\r'; }

posts_count() { q "select count(*) from camp_posts;"; }
notes_count() { q "select count(*) from camp_notes;"; }
friends_count() { q "select count(*) from friend_cards;"; }

# ---------------------------------------------------------------------------
# Identity + baseline. The receiver must be in the same camp as the fixtures
# (passphrase "dusty mary" → camp 0b7868f0) or the seam refuses with "Set your
# camp passphrase first" / "different camp". saveCampProfile stores the
# passphrase under settings.camp_passphrase (normalized) and the writer id
# under settings.camp_writer_id; both are what a real Camp-sync UI write does.
# ---------------------------------------------------------------------------
seed_identity() {
  q "insert into settings(key,value) values('camp_passphrase','$PASSPHRASE') on conflict(key) do update set value=excluded.value;"
  q "insert into settings(key,value) values('camp_author_name','Gate') on conflict(key) do update set value=excluded.value;"
  # writer id already minted by first launch; leave it (this is the receiver's
  # own identity, and installCampBundle skips its own writer).
  echo "seeded passphrase=$PASSPHRASE writer_id=$(q "select value from settings where key='camp_writer_id';")"
}

# Clear every imported camp artifact, keep the receiver's own identity.
reset_camp() {
  q "delete from camp_posts;"
  q "delete from camp_notes;"
  q "delete from camp_writers;"
  q "delete from camp_forks;"
  q "delete from doc_chunks where pack_id like 'camp-%';"
  q "delete from events where source_kind='camp_note';"
  q "delete from packs where id like 'camp-%';"
  "${ADB[@]}" shell run-as "$PKG" rm -rf cache/beam-ingress 2>/dev/null
}

# ---------------------------------------------------------------------------
# Delivery: resolve the MediaStore Downloads content id, then fire the intent.
# ---------------------------------------------------------------------------
media_id_for() {
  local file="$1" base
  base="$(basename "$file")"
  "${ADB[@]}" shell rm -f "/sdcard/Download/$base" 2>/dev/null
  "${ADB[@]}" push "$file" "/sdcard/Download/$base" >/dev/null
  "${ADB[@]}" shell content call --uri content://media/external/file \
    --method scan_file --arg "/storage/emulated/0/Download/$base" >/dev/null 2>&1
  local row nid
  # The `\\'` escaping below is the exact form that survives adb shell +
  # the on-device `content` tokenizer (proven by pug-claude-5's emu-deliver.sh:
  # a bare ' or \" here yields "Invalid token <name>" from provider:media).
  row=$("${ADB[@]}" shell content query --uri content://media/external/downloads \
    --projection _id:mime_type --where "_display_name=\\'$base\\'" 2>/dev/null \
    | tr -d '\r' | /usr/bin/rg -m1 'Row')
  nid=$(echo "$row" | sed -n 's/.*_id=\([0-9]*\).*/\1/p')
  echo "$nid"
}

deliver() {
  local action="$1" mime="$2" uri="$3"
  case "$action" in
    VIEW)
      "${ADB[@]}" shell am start -W --grant-read-uri-permission \
        -a android.intent.action.VIEW -t "$mime" -d "$uri" -n "$PKG/.MainActivity" \
        | /usr/bin/rg -m1 '^(Status|Error)'
      ;;
    SEND)
      # --grant-read-uri-permission grants the DATA uri only. The native module
      # reads EXTRA_STREAM (BeamIngressModule.streamExtra), so without -d the
      # extra's content:// uri has no read grant and copyIn throws
      # SecurityException ("no access to content://..."). On a real phone the
      # originating share sheet mints that grant; shell `am` cannot, so pass the
      # SAME uri as -d (for the grant) and --eu (for the module). Same string,
      # so the grant covers the stream read.
      "${ADB[@]}" shell am start -W --grant-read-uri-permission \
        -a android.intent.action.SEND -t "$mime" -n "$PKG/.MainActivity" \
        -d "$uri" --eu android.intent.extra.STREAM "$uri" \
        | /usr/bin/rg -m1 '^(Status|Error)'
      ;;
  esac
}

kill_app() { "${ADB[@]}" shell am force-stop "$PKG"; }
warm_app() { "${ADB[@]}" shell am start -n "$PKG/.MainActivity" >/dev/null 2>&1; sleep 4; }

expected_for() {
  python3 - "$MANIFEST" "$1" <<'PY'
import json, sys
f = json.load(open(sys.argv[1])).get(sys.argv[2], {})
print(f"{f['posts_delta']} {f['notes_delta']}" if "posts_delta" in f else "REFUSE")
PY
}

# One matrix row: seed baseline, deliver ONE fixture, assert the delta.
run_case() {
  local fixture="$1" action="$2" state="$3"
  local mime="$MIME"
  [ "$action" = "VIEW-octet" ] && mime="application/octet-stream"
  reset_camp
  local nid uri
  nid="$(media_id_for "$FIXTURE_DIR/$fixture")"
  if [ -z "$nid" ]; then
    echo "[FAIL] $fixture × $action × $state: MediaStore id lookup failed"; return
  fi
  uri="content://media/external/downloads/$nid"
  local exp before after bp bn ap an
  exp="$(expected_for "$fixture")"
  "$state"
  before="$(posts_count)/$(notes_count)"
  deliver "${action%%-*}" "$mime" "$uri" >/dev/null
  sleep 8
  after="$(posts_count)/$(notes_count)"
  bp="${before%/*}"; bn="${before#*/}"; ap="${after%/*}"; an="${after#*/}"
  local verdict why
  if [ "$exp" = "REFUSE" ]; then
    if [ "$bp:$bn" = "$ap:$an" ]; then verdict=PASS; why="0 delta (refused)"; else verdict=FAIL; why="delta $bp/$bn → $ap/$an (should be 0)"; fi
  else
    local ep en
    ep="${exp% *}"; en="${exp#* }"
    if [ "$ap" = "$((bp + ep))" ] && [ "$an" = "$((bn + en))" ]; then
      verdict=PASS; why="posts +$ep notes +$en"
    else
      verdict=FAIL; why="posts $bp→$ap (want +$ep) notes $bn→$an (want +$en)"
    fi
  fi
  printf '[%s] %-32s × %-10s × %-8s : %s\n' "$verdict" "$fixture" "$action" "$state" "$why"
}

# Same beam twice: idempotent — first delivery installs, second is a no-op.
idempotence_case() {
  local fixture="valid-2-envelope.playapal"
  reset_camp
  local nid uri before mid after
  nid="$(media_id_for "$FIXTURE_DIR/$fixture")"; uri="content://media/external/downloads/$nid"
  kill_app
  before="$(posts_count)/$(notes_count)"
  deliver VIEW "application/octet-stream" "$uri" >/dev/null; sleep 8
  mid="$(posts_count)/$(notes_count)"
  deliver VIEW "application/octet-stream" "$uri" >/dev/null; sleep 8
  after="$(posts_count)/$(notes_count)"
  if [ "$mid" = "2/1" ] && [ "$after" = "$mid" ]; then
    printf '[PASS] %-32s × %-10s × %-8s : %s\n' "$fixture" "VIEW-octet" "twice" "first 2/1, second idempotent 0 delta"
  else
    printf '[FAIL] %-32s × %-10s × %-8s : first %s then %s (want 2/1 then 2/1)\n' "$fixture" "VIEW-octet" "twice" "$mid" "$after"
  fi
}

print_matrix() {
  printf '\n%-34s %-28s %-8s %s\n' "fixture" "action" "state" "expectation"
  printf '%.0s-' {1..110}; echo
  local fixtures
  if [ -n "$ONE_FIXTURE" ]; then fixtures="$ONE_FIXTURE"; else
    fixtures="valid-2-envelope.playapal truncated-60.playapal byte-flipped.playapal future-kind.playapal unrelated-octet-stream.playapal oversize-4mib-plus-1.playapal"
  fi
  for f in $fixtures; do
    for action in VIEW-octet VIEW-mime SEND; do
      for state in kill_app warm_app; do
        printf '%-34s %-28s %-8s %s\n' "$f" "$action" "$state" "$(expected_for "$f")"
      done
    done
  done
}

if [ "$MODE" = "dry-run" ]; then
  echo "== DRY RUN == (validates fixtures against manifest.json; no device)"
  python3 -c "import json; m=json.load(open('$MANIFEST')); print('manifest ok, camp', m['camp_id'])" 2>/dev/null \
    || { echo "FAIL: cannot parse $MANIFEST" >&2; exit 1; }
  for f in valid-2-envelope.playapal truncated-60.playapal byte-flipped.playapal future-kind.playapal unrelated-octet-stream.playapal; do
    [ -f "$FIXTURE_DIR/$f" ] && echo "fixture present: $f ($(wc -c < "$FIXTURE_DIR/$f") bytes)" \
      || echo "MISSING fixture: $f" >&2
  done
  echo "oversize fixture: /tmp/beam-oversize-4mib-plus-1.playapal (regenerated by gen.js; copy beside the committed fixtures before a live run)"
  print_matrix
  exit 0
fi

# ---------------------------------------------------------------------------
# --run: the real device pass.
# ---------------------------------------------------------------------------
if [ -z "$SERIAL" ]; then
  echo "FAIL: --run needs -s <serial>" >&2; exit 2
fi
echo "== LIVE RUN on $SERIAL =="
echo "device state: $("${ADB[@]}" get-state 2>&1)"
seed_identity
echo

if [ -n "$ONE_FIXTURE" ]; then
  run_case "$ONE_FIXTURE" VIEW-octet kill_app
  run_case "$ONE_FIXTURE" VIEW-mime kill_app
  run_case "$ONE_FIXTURE" SEND kill_app
  exit 0
fi

# The full matrix (6 fixtures × 3 modes × 2 states = 36 rows), then the two
# contract-§7 specials that need a non-reset sequence.
for f in valid-2-envelope.playapal truncated-60.playapal byte-flipped.playapal future-kind.playapal unrelated-octet-stream.playapal oversize-4mib-plus-1.playapal; do
  for action in VIEW-octet VIEW-mime SEND; do
    for state in kill_app warm_app; do
      run_case "$f" "$action" "$state"
    done
  done
done
idempotence_case
echo
echo "done — full matrix above. (friend-link /f + playapal://friend regression is kimi's scan-path pass; the file-type filter shadowing it is already asserted by __tests__/beamIngressContract.test.ts.)"
