# shellcheck shell=bash
#
# common.sh — devices, evidence capture, and the assertion vocabulary.
#
# Everything in here exists to answer one question honestly: did the thing
# actually happen on the actual radio? The bench never trusts that it tapped
# a button, and never trusts that a callback fired. It reads what the phone
# recorded.

# ---------------------------------------------------------------------------
# Serial hygiene
# ---------------------------------------------------------------------------
# Device serials are treated as secrets: they identify the owner's personal
# hardware and this repo is headed for a public tree. They are resolved at
# runtime, never written to a tracked file, and every run artifact records a
# short digest plus the marketing model name instead.
redact() {
  printf '%s' "$1" | sha1sum | cut -c1-8
}

# ---------------------------------------------------------------------------
# Device enumeration
# ---------------------------------------------------------------------------
# Roles rather than names. A1 is whichever Android answered first, A2 the
# second. The scenarios say "A1 talks, A2 listens" so the same catalog runs
# whichever two Pixels are on the cable, and a one-phone night degrades to
# honest SKIPs instead of quietly testing nothing.
A1=""; A1_MODEL=""; A2=""; A2_MODEL=""; IPH=""; IPH_MODEL=""

resolve_devices() {
  local serials=() s model
  while read -r s _; do
    [ -n "$s" ] && serials+=("$s")
  done < <(adb devices 2>/dev/null | awk 'NR>1 && $2=="device" {print $1}')

  for s in "${serials[@]:-}"; do
    [ -z "$s" ] && continue
    model="$(adb -s "$s" shell getprop ro.product.model 2>/dev/null | tr -d '\r')"
    if [ -z "$A1" ]; then A1="$s"; A1_MODEL="$model"
    elif [ -z "$A2" ]; then A2="$s"; A2_MODEL="$model"
    fi
  done

  # The iPhone is optional and its syslog is a loaded gun (see burst_syslog).
  if command -v idevice_id >/dev/null 2>&1; then
    IPH="$(timeout 10 idevice_id -l 2>/dev/null | head -1 | tr -d '\r')"
    if [ -n "$IPH" ] && command -v ideviceinfo >/dev/null 2>&1; then
      IPH_MODEL="$(timeout 10 ideviceinfo -u "$IPH" -k ProductType 2>/dev/null | tr -d '\r')"
    fi
  fi
}

# The logcat ring defaults to 256 KiB on these Pixels, and PlayaMesh's
# scan//result chatter fills it in well under a minute — MEASURED 2026-08-27,
# 8663 lines covering a couple of minutes. A scenario that reads `logcat -d`
# after a 30 s wait can therefore be reading a buffer that has already thrown
# its own evidence away, and would report a false FAIL. Two defences: raise
# the ring, and stream to a file for the whole window rather than dredging it
# afterwards.
prepare_device() {
  local s="$1"
  adb -s "$s" logcat -G 16M >/dev/null 2>&1 || true
  adb -s "$s" shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1 || true
  adb -s "$s" shell svc power stayon usb >/dev/null 2>&1 || true
}

# ---------------------------------------------------------------------------
# Device clock
# ---------------------------------------------------------------------------
# dumpsys audio stamps its audit rows with the DEVICE clock, so windows are
# computed from the device's own time and never from the laptop's.
#
# The quoting is load-bearing. `adb shell date '+%m-%d %H:%M:%S'` looks right
# and is not: the local shell eats the quotes, adb forwards the bare words, and
# the device's toybox `date` sees two arguments and refuses with "Max 1
# argument". The function then returned EMPTY — and an empty window matched
# every row AudioService had ever recorded, so the PTT assertion passed on the
# owner's presses from eight hours earlier instead of the hold it had just
# driven. It reported PASS while testing nothing. Hence the guard below, and
# hence the underscore format: one word, nothing for either shell to split.
dev_now() {
  local t
  t="$(adb -s "$1" shell date +%m-%d_%H:%M:%S 2>/dev/null | tr -d '\r' | tr '_' ' ')"
  case "$t" in
    [0-9][0-9]-[0-9][0-9]\ [0-9][0-9]:[0-9][0-9]:[0-9][0-9]) printf '%s' "$t" ;;
    *) printf '' ;;
  esac
}

# ---------------------------------------------------------------------------
# Streaming logcat capture
# ---------------------------------------------------------------------------
declare -A LOGCAP_PID=()
declare -A LOGCAP_FILE=()

logcap_start() {
  # Separate statements on purpose: `local` expands every one of its word
  # arguments BEFORE it assigns any of them, so `local a="$1" b="$a"` reads an
  # unset `a` and dies under `set -u`. Cost this bench its first real run.
  local s="$1"
  local label="$2"
  local f="$RUN_DIR/logcat-$label.log"
  adb -s "$s" logcat -c >/dev/null 2>&1 || true
  adb -s "$s" logcat -v time > "$f" 2>/dev/null &
  LOGCAP_PID["$label"]=$!
  LOGCAP_FILE["$label"]="$f"
  # The stream needs a beat to attach or the first seconds of a fast
  # scenario land in nobody's file.
  sleep 1
}

logcap_stop() {
  local label="$1"
  local pid="${LOGCAP_PID[$label]:-}"
  [ -n "$pid" ] && kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  unset 'LOGCAP_PID[$label]'
}

logcap_file() { printf '%s' "${LOGCAP_FILE[$1]:-/dev/null}"; }

# ---------------------------------------------------------------------------
# dumpsys audio — the evidence the log does not carry
# ---------------------------------------------------------------------------
# The walkie's receive path is deliberately quiet. WalkieModule logs only
# TRANSITIONS (walkie//row-proven, walkie//row-demoted) and the keep-alive
# probe keeps a healthy row proven continuously, so a PTT across an
# already-proven link emits NOTHING. There is no per-frame log line: the
# framesWritten and staleFlushes counters are AtomicIntegers that only reach
# the log through walkie//stale-flush, which fires under lateness alone.
#
# So "was audio actually captured / actually played" cannot be read from
# logcat at all in this tree. It CAN be read from AudioService, which keeps
# two timestamped audit logs that survive logcat rotation entirely:
#
#   ### Recording Activity  — "rec start|update|stop ... src:VOICE_COMMUNICATION
#                              ... pack:com.playapal"   = the mic really opened
#   ### Playback activity   — "new player ... package:com.playapal
#                              type:android.media.AudioTrack ...
#                              content=CONTENT_TYPE_SPEECH"  = a speaker really ran
#
# Both were verified against the owner's own PTT presses from the 00:19-00:40
# bench on 2026-08-27, which are still in the buffer, and against holds this
# bench drove itself.
#
# CAVEAT, written down rather than discovered later: these stamps carry no
# year, so the lexical window compare below is correct across midnight and
# wrong across New Year's Eve. Playa season is August.
audio_section() {
  local s="$1" header="$2"
  adb -s "$s" shell dumpsys audio 2>/dev/null |
    sed -n "/^### $header/,/^#/p" | tr -d '\r'
}

# Rows from an audio audit section stamped at or after $since ("MM-DD HH:MM:SS").
#
# An unusable window is a HARD ERROR, never an empty filter. A filter that
# cannot bound its window and quietly returns everything is the most dangerous
# thing in a test suite: it turns every downstream assertion green using stale
# evidence, and reads exactly like a pass.
audio_since() {
  local s="$1" header="$2" since="$3"
  if [ -z "$since" ]; then
    echo "BENCH-ERROR: empty time window — refusing to match every historical row" >&2
    return 1
  fi
  audio_section "$s" "$header" | awk -v since="$since" '
    match($0, /^[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]/) {
      stamp = substr($0, RSTART, RLENGTH)
      if (stamp >= since) print
    }'
}

# TX PROOF. Did this phone open its microphone for the walkie inside the window?
# COUNTERFACTUAL: an empty result is exactly what a dead capture path prints —
# the iOS "cached engine corpse" class of bug, and equally the case where the
# PTT button was never really pressed because the layout moved. Both are
# failures worth seeing, and neither is distinguishable from success without
# this check.
mic_sessions_since() {
  audio_since "$1" "Recording Activity" "$2" | grep 'pack:com.playapal' || true
}

# RX PROOF. Did this phone actually run a walkie AudioTrack inside the window?
# The walkie's track is identifiable by three attributes together, so ordinary
# app sounds and the Angel's TTS cannot be mistaken for received voice.
# COUNTERFACTUAL: silence here with a healthy-looking peer row on screen IS the
# bug the owner hit on 2026-08-27 — "pugmi's PTT reached P7 SILENTLY (no audio,
# and no error anywhere)". That failure had no log face at all. It has one now.
speaker_events_since() {
  local s="$1" since="$2"
  local piids
  piids="$(audio_section "$s" "Playback activity" |
    grep 'package:com.playapal' | grep 'android.media.AudioTrack' |
    grep -o 'piid:[0-9]*' | sort -u | sed 's/piid://')"
  [ -z "$piids" ] && return 0
  local p
  for p in $piids; do
    audio_since "$s" "Playback activity" "$since" | grep "piid:$p" || true
  done
}

# ---------------------------------------------------------------------------
# Radio levers — probed, not assumed
# ---------------------------------------------------------------------------
# All three mechanisms named in the brief were tried non-root on a Pixel 7
# (2026-08-27). Results, so the next reader does not re-derive them:
#
#   cmd connectivity airplane-mode enable|disable   WORKS (round-trip verified)
#       ...but it does NOT take Bluetooth down: settings global bluetooth_on
#       stayed 1 across the toggle, because Android remembers a per-user
#       "keep BT on in airplane mode" preference. So airplane mode is the
#       WRONG lever for a walk-away test — it would look like a drive step
#       that ran and prove nothing.
#   cmd bluetooth_manager enable|disable            WORKS (State: ON <-> BLE_ON)
#   svc bluetooth enable|disable                    WORKS (same effect)
#   svc wifi enable|disable                         WORKS
#
# bluetooth_manager is the lever the walk-away scenario uses, and dumpsys
# reports the adapter state so the drive step can be verified rather than
# assumed to have landed.
bt_state() {
  adb -s "$1" shell dumpsys bluetooth_manager 2>/dev/null |
    sed -n 's/^ *State: *\([A-Z_]*\).*/\1/p' | head -1 | tr -d '\r'
}

bt_set() {
  local s="$1" want="$2" deadline
  adb -s "$s" shell cmd bluetooth_manager "$want" >/dev/null 2>&1 || return 1
  deadline=$((SECONDS + 20))
  while [ "$SECONDS" -lt "$deadline" ]; do
    case "$want:$(bt_state "$s")" in
      enable:ON) return 0 ;;
      disable:BLE_ON|disable:OFF) return 0 ;;
    esac
    sleep 1
  done
  return 1
}

airplane_set() {
  local s="$1" want="$2"
  adb -s "$s" shell cmd connectivity airplane-mode "$want" >/dev/null 2>&1 || return 1
  sleep 3
  local got; got="$(adb -s "$s" shell settings get global airplane_mode_on 2>/dev/null | tr -d '\r')"
  case "$want:$got" in enable:1|disable:0) return 0 ;; esac
  return 1
}

# ---------------------------------------------------------------------------
# iPhone burst syslog — HARD LAW
# ---------------------------------------------------------------------------
# A standing idevicesyslog wedges the whole laptop. Every capture is a bounded
# burst under `timeout`, written to a file, and never left running between
# scenarios.
#
# HONEST CEILING, measured 2026-08-27: the iPhone's syslog is a far weaker
# witness than logcat, for two reasons that are not ours to fix tonight.
#   1. VOLUME. PlayaPal's CoreMotion magnetometer stream emits ~10 lines a
#      second and drowns everything; -M CoreMotion is mandatory.
#   2. REDACTION. iOS os_log replaces every dynamic string with <private>
#      unless the format specifier says %{public}. A 15 s burst filtered down
#      to app-level lines produced ZERO usable rows. So an iPhone cannot
#      currently confirm "the frame arrived" — only "the process is alive" and
#      "CoreBluetooth is doing something".
# That is why every i-side row in the catalog is TIER-SEMI or TIER-MANUAL and
# says so, rather than pretending to an assertion it cannot make.
burst_syslog() {
  local udid="$1"
  local secs="$2"
  local label="$3"
  local f="$RUN_DIR/syslog-$label.log"
  command -v idevicesyslog >/dev/null 2>&1 || { echo "" ; return 1; }
  timeout "$secs" idevicesyslog -u "$udid" -p PlayaPal -M CoreMotion \
    >"$f" 2>/dev/null || true
  printf '%s' "$f"
}

# ---------------------------------------------------------------------------
# Assertion vocabulary
# ---------------------------------------------------------------------------
# Each check appends a line of evidence and flips a scenario-scoped verdict.
# Assertions never `exit` — a failing scenario must still run its teardown and
# still take its screenshot.
SC_OK=1
SC_EVIDENCE=()

sc_reset() { SC_OK=1; SC_EVIDENCE=(); }

sc_note() { SC_EVIDENCE+=("$1"); }

sc_fail() { SC_OK=0; SC_EVIDENCE+=("FAIL: $1"); }

# Assert a pattern APPEARS. $4 is the counterfactual: what the log says
# instead when the feature is broken. A scenario whose counterfactual is
# blank is not a test, and bench.sh refuses to register one.
expect_match() {
  local file="$1" pat="$2" what="$3" hits
  hits="$(grep -aE "$pat" "$file" 2>/dev/null | head -3)"
  if [ -n "$hits" ]; then
    sc_note "OK   $what"
    while IFS= read -r l; do [ -n "$l" ] && sc_note "     | $l"; done <<<"$hits"
    return 0
  fi
  sc_fail "$what — no line matching /$pat/"
  return 1
}

# Assert a pattern is ABSENT. Used for the known-bad markers: a run that
# passes its positive checks while also logging voice//ident-reject has not
# actually passed.
expect_absent() {
  local file="$1" pat="$2" what="$3" hits
  hits="$(grep -aE "$pat" "$file" 2>/dev/null | head -3)"
  if [ -z "$hits" ]; then
    sc_note "OK   $what"
    return 0
  fi
  sc_fail "$what — found /$pat/"
  while IFS= read -r l; do [ -n "$l" ] && sc_note "     | $l"; done <<<"$hits"
  return 1
}

# Assert against a string rather than a file (dumpsys output).
expect_str() {
  local blob="$1" pat="$2" what="$3" hits
  hits="$(printf '%s\n' "$blob" | grep -aE "$pat" | head -3)"
  if [ -n "$hits" ]; then
    sc_note "OK   $what"
    while IFS= read -r l; do [ -n "$l" ] && sc_note "     | $l"; done <<<"$hits"
    return 0
  fi
  sc_fail "$what"
  return 1
}

# Wait until a pattern shows up in a streaming capture, or give up. Returns
# non-zero on timeout WITHOUT marking the scenario failed, so callers can
# choose between "this was required" and "this was a nicety".
wait_for_match() {
  local file="$1" pat="$2" secs="$3" deadline=$((SECONDS + $3))
  while [ "$SECONDS" -lt "$deadline" ]; do
    grep -aqE "$pat" "$file" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

# Open an evidence window, or fail the scenario now rather than letting a
# broken clock read produce a vacuous pass downstream.
sc_window() {
  local t
  t="$(dev_now "$1")"
  if [ -z "$t" ]; then
    sc_fail "could not read the device clock — refusing to assert against an unbounded window"
    return 1
  fi
  printf '%s' "$t"
}

screenshot() {
  local s="$1" name="$2"
  adb -s "$s" exec-out screencap -p > "$RUN_DIR/$name.png" 2>/dev/null || true
}
