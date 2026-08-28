#!/usr/bin/env bash
#
# bench.sh — the p2p comms battery.
#
#   tools/p2p-bench/bench.sh --dry-run        show the whole plan, touch nothing
#   tools/p2p-bench/bench.sh                  run every scenario the cabled
#                                             devices can support
#   tools/p2p-bench/bench.sh --tier AUTO      only the hands-off rows
#   tools/p2p-bench/bench.sh --with-human     also run TIER-SEMI, prompting for
#                                             the iPhone gestures it needs
#   tools/p2p-bench/bench.sh --only aa-ptt    one scenario by id
#
# Output lands in tools/p2p-bench/runs/<timestamp>/ : one JSON scorecard, the
# streamed logcats, the iPhone syslog bursts, and a screenshot of every phone
# at the moment anything went red.
#
#   tools/p2p-bench/bench.sh --patch-matrix   fold the newest run into
#                                             docs/TEST-MATRIX.md
#
# DESIGN NOTE, because it is the whole point. This suite reads EVIDENCE, never
# callbacks and never its own actions. It does not believe it tapped a button
# (it re-reads the Switch's checked attribute), it does not believe a peer is
# alive because a row is on screen (the app's own lesson: "callbacks are not
# proof, inbound frames are"), and it does not believe audio was delivered
# because a frame was sent (it reads AudioService's playback audit on the
# RECEIVING phone). Where it cannot get evidence it says UNDRIVABLE or MANUAL
# and moves on. An honest gap is worth more than a green box.

set -uo pipefail

BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$BENCH_DIR/../.." && pwd)"

DRY=0
WITH_HUMAN=0
TIER_FILTER=""
ONLY=""
PATCH=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --with-human) WITH_HUMAN=1 ;;
    --tier) TIER_FILTER="${2:-}"; shift ;;
    --only) ONLY="${2:-}"; shift ;;
    --patch-matrix) PATCH=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# A human gesture the bench cannot perform. Printed loudly, with a countdown,
# because TIER-SEMI is only honest if the person actually did the thing.
# ---------------------------------------------------------------------------
human_gesture() {
  local msg="$1" secs="${2:-30}" i
  if [ "$WITH_HUMAN" -eq 0 ]; then
    sc_note "SKIP this row needs a human gesture; re-run with --with-human"
    SC_HUMAN_MISSING=1
    return 1
  fi
  printf '\n  \033[1;33m>>> HANDS ON: %s\033[0m\n' "$msg"
  for ((i = secs; i > 0; i--)); do
    printf '\r      continuing in %2ds ... ' "$i"
    sleep 1
  done
  printf '\r      continuing now.            \n\n'
  return 0
}

# shellcheck source=lib/common.sh
. "$BENCH_DIR/lib/common.sh"
# shellcheck source=lib/ui.sh
. "$BENCH_DIR/lib/ui.sh"
# shellcheck source=lib/scenarios.sh
. "$BENCH_DIR/lib/scenarios.sh"

# ---------------------------------------------------------------------------
# Which scenarios can run right now
# ---------------------------------------------------------------------------
requirement_met() {
  case "$1" in
    none)    return 1 ;;                       # MANUAL rows never "run"
    a1)      [ -n "$A1" ] ;;
    a1+a2)   [ -n "$A1" ] && [ -n "$A2" ] ;;
    a1+i)    [ -n "$A1" ] && [ -n "$IPH" ] ;;
    i)       [ -n "$IPH" ] ;;
    *)       return 1 ;;
  esac
}

requirement_english() {
  case "$1" in
    none)  echo "a human, in the field" ;;
    a1)    echo "one Android" ;;
    a1+a2) echo "two Androids" ;;
    a1+i)  echo "one Android + a cabled iPhone" ;;
    i)     echo "a cabled iPhone" ;;
  esac
}

selected() {
  local id="$1"
  [ -n "$ONLY" ] && [ "$id" != "$ONLY" ] && return 1
  [ -n "$TIER_FILTER" ] && [ "${SC_TIER[$id]}" != "$TIER_FILTER" ] && return 1
  return 0
}

# ---------------------------------------------------------------------------
# Patch mode is a separate errand
# ---------------------------------------------------------------------------
if [ "$PATCH" -eq 1 ]; then
  latest="$(ls -1d "$BENCH_DIR"/runs/*/ 2>/dev/null | sort | tail -1)"
  if [ -z "$latest" ] || [ ! -f "$latest/scorecard.json" ]; then
    echo "no run to patch from — run the bench first" >&2
    exit 1
  fi
  exec node "$BENCH_DIR/patch-matrix.js" "$latest/scorecard.json" "$REPO_DIR/docs/TEST-MATRIX.md"
fi

resolve_devices

# ---------------------------------------------------------------------------
# Dry run: the whole plan, no device touched
# ---------------------------------------------------------------------------
if [ "$DRY" -eq 1 ]; then
  echo
  echo "PLAYA PAL p2p COMMS BATTERY — PLAN (dry run, nothing was touched)"
  echo
  echo "Devices this laptop can see right now:"
  # Model plus a digest, never the serial itself: these are the owner's
  # personal phones and this repo is headed for a public tree.
  describe_dev() {
    if [ -n "$1" ]; then printf '%s  [%s]' "${2:-unknown model}" "$(redact "$1")"
    else printf -- '— none cabled'; fi
  }
  printf '  Android A1 : %s\n' "$(describe_dev "$A1" "$A1_MODEL")"
  printf '  Android A2 : %s\n' "$(describe_dev "$A2" "$A2_MODEL")"
  printf '  iPhone     : %s\n' "$(describe_dev "$IPH" "$IPH_MODEL")"
  echo
  for tier in AUTO SEMI MANUAL; do
    echo "── TIER-$tier ─────────────────────────────────────────────────────────"
    for id in "${SCENARIOS[@]}"; do
      [ "${SC_TIER[$id]}" != "$tier" ] && continue
      selected "$id" || continue
      if [ "$tier" = MANUAL ]; then
        state="MANUAL"
      elif requirement_met "${SC_REQ[$id]}"; then
        state="WILL RUN"
      else
        state="SKIP (needs $(requirement_english "${SC_REQ[$id]}"))"
      fi
      printf '\n  %-26s %s\n' "$id" "$state"
      printf '    what : %s\n' "${SC_TITLE[$id]}"
      printf '    fails: %s\n' "${SC_CF[$id]}" | fold -s -w 92 | sed '2,$s/^/           /'
    done
    echo
  done
  exit 0
fi

# ---------------------------------------------------------------------------
# Real run
# ---------------------------------------------------------------------------
if [ -z "$A1" ]; then
  echo "no Android on the cable — nothing in this battery can run." >&2
  echo "check: adb devices" >&2
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
RUN_DIR="$BENCH_DIR/runs/$STAMP"
mkdir -p "$RUN_DIR"

prepare_device "$A1"
[ -n "$A2" ] && prepare_device "$A2"

echo
echo "PLAYA PAL p2p COMMS BATTERY — run $STAMP"
echo "  A1     : ${A1_MODEL:-?}  [$(redact "$A1")]"
[ -n "$A2" ] && echo "  A2     : ${A2_MODEL:-?}  [$(redact "$A2")]"
[ -n "$IPH" ] && echo "  iPhone : ${IPH_MODEL:-?}  [$(redact "$IPH")]"
echo "  tree   : $(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null)"
echo "  out    : $RUN_DIR"
echo

app_launch "$A1" >/dev/null 2>&1 || echo "  (warning: could not confirm the app came up on A1)"
[ -n "$A2" ] && { app_launch "$A2" >/dev/null 2>&1 || true; }

RESULTS_JSON="$RUN_DIR/scorecard.json"
: > "$RUN_DIR/.rows"

for id in "${SCENARIOS[@]}"; do
  selected "$id" || continue
  tier="${SC_TIER[$id]}"
  verdict=""
  sc_reset
  SC_HUMAN_MISSING=0
  SC_ID="$id"

  if [ "$tier" = MANUAL ]; then
    verdict="MANUAL"
    sc_note "Named on purpose. No evidence this laptop can gather would settle it."
  elif ! requirement_met "${SC_REQ[$id]}"; then
    verdict="SKIP"
    sc_note "needs $(requirement_english "${SC_REQ[$id]}") — not cabled for this run"
  else
    # NOTE: TIER-SEMI is NOT blanket-gated on --with-human. Some SEMI rows
    # (PTT Android->iPhone) drive the Android half automatically and need no
    # gesture at all; gating the whole tier would have thrown away free
    # coverage. The gate lives in human_gesture instead, so it fires exactly
    # on the rows that genuinely need a thumb.
    printf '  %-26s ' "$id"
    fn="run_$(printf '%s' "$id" | tr '-' '_')"
    if ! declare -F "$fn" >/dev/null; then
      verdict="ERROR"; sc_fail "no runner function $fn"
    else
      "$fn"
      if [ "${SC_HUMAN_MISSING:-0}" -eq 1 ]; then
        verdict="SKIP"
      elif [[ "$id" == neg-* ]]; then
        # Inverted by construction: this row exists to prove the assertion can
        # go red. Inner failure IS the pass.
        if [ "$SC_OK" -eq 0 ]; then
          verdict="PASS"
          sc_note "INVERTED: the discovery assertion correctly went red with the radio off."
          sc_note "          Every green discovery row in this run is therefore non-vacuous."
        else
          verdict="FAIL"
          sc_note "INVERTED: the assertion PASSED with the radio off. It proves nothing."
        fi
      else
        [ "$SC_OK" -eq 1 ] && verdict="PASS" || verdict="FAIL"
      fi
    fi
    if [ "$verdict" = FAIL ]; then
      screenshot "$A1" "$id-a1-fail"
      [ -n "$A2" ] && screenshot "$A2" "$id-a2-fail"
    fi
    case "$verdict" in
      PASS) printf '\033[32mPASS\033[0m\n' ;;
      FAIL) printf '\033[31mFAIL\033[0m\n' ;;
      *)    printf '%s\n' "$verdict" ;;
    esac
    for e in "${SC_EVIDENCE[@]}"; do printf '      %s\n' "$e"; done
  fi

  if [ "$verdict" = SKIP ] || [ "$verdict" = MANUAL ]; then
    printf '  %-26s %s\n' "$id" "$verdict"
    for e in "${SC_EVIDENCE[@]}"; do printf '      %s\n' "$e"; done
  fi

  {
    printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$id" "$tier" "${SC_REQ[$id]}" "$verdict" \
      "$(printf '%s' "${SC_TITLE[$id]}" | tr '\t\n' '  ')" \
      "$(printf '%s' "${SC_CF[$id]}" | tr '\t\n' '  ')"
    for e in "${SC_EVIDENCE[@]}"; do printf '\tEVIDENCE\t%s\n' "$(printf '%s' "$e" | tr '\t\n' '  ')"; done
  } >> "$RUN_DIR/.rows"
done

# Leave the phones in a sane state rather than mid-experiment.
[ -n "$A2" ] && bt_set "$A2" enable >/dev/null 2>&1
bt_set "$A1" enable >/dev/null 2>&1
airplane_set "$A1" disable >/dev/null 2>&1

node "$BENCH_DIR/scorecard.js" \
  --rows "$RUN_DIR/.rows" \
  --out "$RESULTS_JSON" \
  --stamp "$STAMP" \
  --tree "$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null)" \
  --a1 "${A1_MODEL:-none}" --a2 "${A2_MODEL:-none}" --iphone "${IPH_MODEL:-none}"

echo
node "$BENCH_DIR/scorecard.js" --print "$RESULTS_JSON"
echo
echo "  scorecard : $RESULTS_JSON"
echo "  artifacts : $RUN_DIR"
echo "  fold into the matrix with:  tools/p2p-bench/bench.sh --patch-matrix"
echo
