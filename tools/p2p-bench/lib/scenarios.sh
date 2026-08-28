# shellcheck shell=bash
#
# scenarios.sh — the catalog.
#
# The owner's ask was "test everything in the p2p comms layer for both android
# and iphone and all combinations AS IF i was testing it manually". This file
# is the honest answer to that, tiered so nobody has to guess which rows are
# real:
#
#   TIER-AUTO    the laptop drives it end to end and reads the verdict off the
#                phones. Nobody touches a screen.
#   TIER-SEMI    the laptop drives the Android half and reads the Android
#                verdict automatically; ONE human gesture on the iPhone is
#                required and the bench prints it and waits. iOS has no adb.
#   TIER-MANUAL  named here so the catalog is complete, and deliberately never
#                run, because no evidence this laptop can gather would settle
#                it. Faking a verdict for these rows would be worse than
#                leaving them empty.
#
# EVERY scenario declares a COUNTERFACTUAL: the thing the phones say instead
# when the feature is broken. A scenario that cannot fail is not a test, and
# bench.sh refuses to register one with an empty counterfactual. Most of the
# counterfactuals here are not hypothetical — they are the log faces of bugs
# this project actually hit, cited in docs/TEST-MATRIX.md.

# scenario <id> <tier> <requires> <timeout-s> <title> <counterfactual>
SCENARIOS=()
declare -A SC_TIER=() SC_REQ=() SC_TIMEOUT=() SC_TITLE=() SC_CF=()

scenario() {
  local id="$1" tier="$2" req="$3" to="$4" title="$5" cf="$6"
  if [ -z "$cf" ]; then
    echo "catalog error: $id has no counterfactual — a scenario that cannot fail is not a test" >&2
    exit 2
  fi
  SCENARIOS+=("$id")
  SC_TIER[$id]="$tier"; SC_REQ[$id]="$req"; SC_TIMEOUT[$id]="$to"
  SC_TITLE[$id]="$title"; SC_CF[$id]="$cf"
}

# ===========================================================================
# TIER-AUTO — single Android. These are the radio's own vital signs: if they
# are red, every pair row below is meaningless, so they run first.
# ===========================================================================

scenario radios-up AUTO a1 60 \
  "Walkie ON brings up every rung's radio (BLE advertiser, Aware publish+subscribe)" \
  "voice//no-permission (the rung contributes no peers), voice//advertise-failed code=N, voice//start-failed, or simply no voice//up at all — the 0.8.4 'walkie starts silent' anomaly."

run_radios_up() {
  local s="$A1" lf
  ensure_walkie_pane "$s" || { sc_fail "could not reach the walkie pane"; return; }
  logcap_start "$s" "$SC_ID-a1"; lf="$(logcap_file "$SC_ID-a1")"
  walkie_set "$s" off >/dev/null 2>&1
  sleep 3
  if ! walkie_set "$s" on; then sc_fail "could not turn the walkie switch on"; fi
  wait_for_match "$lf" 'voice//up' 30
  sleep 8
  logcap_stop "$SC_ID-a1"

  expect_match "$lf" 'voice//up' "BLE voice layer came up"
  expect_match "$lf" 'voice//advertise-started' "this phone is advertising itself to podmates"
  expect_match "$lf" 'aware//publish-started' "Wi-Fi Aware publisher started"
  expect_match "$lf" 'aware//subscribe-started' "Wi-Fi Aware subscriber started"
  expect_match "$lf" 'aware//responder-listening port=' "Aware datapath responder is listening"
  expect_absent "$lf" 'voice//no-permission|voice//advertise-failed|voice//start-failed' \
    "no rung refused to start"
  # The switch's own answer, not ours.
  if walkie_is_on "$s"; then sc_note "OK   the Walkie switch reads checked=true"
  else sc_fail "the Walkie switch does not read checked=true after turning it on"; fi
}

scenario ptt-capture AUTO a1 60 \
  "A PTT hold really opens the microphone (capture path alive)" \
  "no com.playapal VOICE_COMMUNICATION row in AudioService's Recording Activity for the hold window — which is what a dead capture engine looks like (the iOS cached-engine corpse class), and equally what a PTT button that moved out from under the tap looks like. Both must read red."

run_ptt_capture() {
  local s="$A1" since dur rows
  ensure_walkie_pane "$s" || { sc_fail "could not reach the walkie pane"; return; }
  walkie_set "$s" on || { sc_fail "walkie would not turn on"; return; }
  pane_walkie "$s" >/dev/null 2>&1
  sleep 2
  since="$(sc_window "$s")" || return
  ptt_hold "$s" 3000 || { sc_fail "could not find or press HOLD TO TALK"; return; }
  sleep 5
  rows="$(mic_sessions_since "$s" "$since")"
  # "not silenced" is part of the assertion, not decoration. Android will hand
  # an app a mic session that returns pure silence when the appop is set to
  # ignore — the recorder opens, the row appears, and the camper transmits
  # nothing. VERIFIED by planting exactly that mutation (appops set --uid
  # com.playapal RECORD_AUDIO ignore) and watching this check go red where the
  # looser pattern had stayed green.
  expect_str "$rows" 'rec (start|update).*src:VOICE_COMMUNICATION not silenced.*pack:com\.playapal' \
    "the microphone opened for the walkie during the hold, and was not silenced"
  expect_str "$rows" 'rec stop.*pack:com\.playapal' \
    "and closed again when the hold ended (no orphaned mic)"
  # A hold that opens and shuts inside a blink is the min-hold gate refusing,
  # not a transmission. Measure it rather than assume it.
  dur="$(printf '%s\n' "$rows" | awk '
    /rec (start|update)/ { split($2,a,":"); t0=a[1]*3600+a[2]*60+a[3] }
    /rec stop/ { split($2,a,":"); t1=a[1]*3600+a[2]*60+a[3]; if (t0) print t1-t0 }' | tail -1)"
  if [ -n "$dur" ] && [ "$dur" -ge 2 ] 2>/dev/null; then
    sc_note "OK   the mic stayed open ${dur}s for a 3s hold"
  else
    sc_fail "the mic session was ${dur:-0}s for a 3s hold — the press did not register as a hold"
  fi
}

scenario look-again AUTO a1 45 \
  "'Look again' really re-asks every radio" \
  "no walkie//look-again line — the control is inert and the button is decoration. This is the control the owner called out as the thing that finally made three phones connect, so an inert one is a serious regression."

run_look_again() {
  local s="$A1" lf
  ensure_walkie_pane "$s" || { sc_fail "could not reach the walkie pane"; return; }
  walkie_set "$s" on || { sc_fail "walkie would not turn on"; return; }
  pane_walkie "$s" >/dev/null 2>&1
  logcap_start "$s" "$SC_ID-a1"; lf="$(logcap_file "$SC_ID-a1")"
  look_again "$s" || { logcap_stop "$SC_ID-a1"; sc_fail "could not find the Look again button"; return; }
  wait_for_match "$lf" 'walkie//look-again peers=|voice//look-again peers=' 15
  sleep 3
  logcap_stop "$SC_ID-a1"
  expect_match "$lf" 'look-again peers=' "the radios were re-asked, and reported their peer count"
}

scenario radio-cycle AUTO a1 150 \
  "Bluetooth down then up: the walkie notices, and comes back (the reconnect law)" \
  "voice//adapter-off never appears (the app never noticed the radio died — it keeps a lying peer row, the exact 2026-08-25 failure), or no second voice//advertise-started after the radio returns (bind-once-to-a-dead-network: works once, then deaf forever)."

run_radio_cycle() {
  local s="$A1" lf
  ensure_walkie_pane "$s" || { sc_fail "could not reach the walkie pane"; return; }
  walkie_set "$s" on || { sc_fail "walkie would not turn on"; return; }
  logcap_start "$s" "$SC_ID-a1"; lf="$(logcap_file "$SC_ID-a1")"
  if ! bt_set "$s" disable; then
    sc_fail "UNDRIVABLE: could not take Bluetooth down via cmd bluetooth_manager"
    logcap_stop "$SC_ID-a1"; return
  fi
  sc_note "OK   drove Bluetooth down (adapter state: $(bt_state "$s"))"
  sleep 12
  if ! bt_set "$s" enable; then
    sc_fail "UNDRIVABLE: could not bring Bluetooth back up"
    logcap_stop "$SC_ID-a1"; return
  fi
  sc_note "OK   drove Bluetooth back up (adapter state: $(bt_state "$s"))"
  wait_for_match "$lf" 'voice//advertise-started' 45
  sleep 10
  logcap_stop "$SC_ID-a1"
  expect_match "$lf" 'voice//adapter-off' "the walkie NOTICED the radio go away"
  local restarts
  restarts="$(grep -ac 'voice//advertise-started' "$lf" 2>/dev/null || echo 0)"
  if [ "$restarts" -ge 1 ]; then
    sc_note "OK   the advertiser came back after the radio returned ($restarts start(s) in window)"
  else
    sc_fail "the advertiser never restarted after the radio returned — deaf until app restart"
  fi
}

# ---------------------------------------------------------------------------
# NEGATIVE CONTROL. A guard is unproven until it has FAILED.
# ---------------------------------------------------------------------------
# The discovery assertion below (peer-ready with a non-zero hash) is the load
# bearing check for every pair row in this catalog. If it can report PASS with
# the radio switched off, then every green row it ever prints is worthless.
# This scenario deliberately breaks the radio and demands that the assertion go
# red. It is registered INVERTED: bench.sh scores it PASS when the inner
# assertions FAIL, and screams if they pass.
scenario neg-discovery-radio-off AUTO a1 90 \
  "NEGATIVE CONTROL — with Bluetooth off, the discovery assertion must go red" \
  "the inner assertion reporting a proven peer while the radio is down, which would mean every green discovery row in this suite is vacuous."

run_neg_discovery_radio_off() {
  local s="$A1" lf
  ensure_walkie_pane "$s" >/dev/null 2>&1
  walkie_set "$s" on || true
  logcap_start "$s" "$SC_ID-a1"; lf="$(logcap_file "$SC_ID-a1")"
  bt_set "$s" disable || { sc_fail "UNDRIVABLE: cannot take the radio down"; logcap_stop "$SC_ID-a1"; return; }
  sleep 20
  logcap_stop "$SC_ID-a1"
  # The same expression every real discovery row uses. It MUST NOT match.
  expect_match "$lf" 'voice//peer-ready hash=[0-9a-f]+' \
    "(inverted) a peer proved itself with the radio off"
  bt_set "$s" enable || true
}

# ===========================================================================
# TIER-AUTO — Android to Android. The full-fat rows. These need both Pixels
# on the cable; with one they SKIP loudly rather than passing on nothing.
# ===========================================================================

scenario aa-discovery AUTO a1+a2 180 \
  "Discovery both directions after the walkie comes on (A1 sees A2, A2 sees A1)" \
  "voice//peer-ready never appears on one side (one-way discovery — the measured cross-OS asymmetry, here between two Androids); or voice//connect hash=0 followed by voice//scan-drop reason=already-reached with no peer-ready, which is the 'unproven-identity zombie' that made a row look alive while carrying no voice; or voice//ident-reject."

run_aa_discovery() {
  ensure_walkie_pane "$A1" || { sc_fail "could not reach the walkie pane on $A1_MODEL"; return; }
  ensure_walkie_pane "$A2" || { sc_fail "could not reach the walkie pane on $A2_MODEL"; return; }
  local lf1 lf2
  logcap_start "$A1" "$SC_ID-a1"; lf1="$(logcap_file "$SC_ID-a1")"
  logcap_start "$A2" "$SC_ID-a2"; lf2="$(logcap_file "$SC_ID-a2")"
  walkie_set "$A1" on || sc_fail "A1 walkie would not turn on"
  walkie_set "$A2" on || sc_fail "A2 walkie would not turn on"
  wait_for_match "$lf1" 'voice//peer-ready hash=' 90
  wait_for_match "$lf2" 'voice//peer-ready hash=' 60
  sleep 5
  logcap_stop "$SC_ID-a1"; logcap_stop "$SC_ID-a2"

  expect_match "$lf1" 'voice//peer-ready hash=[0-9a-f]+' "$A1_MODEL proved a peer"
  expect_match "$lf2" 'voice//peer-ready hash=[0-9a-f]+' "$A2_MODEL proved a peer (the other direction)"
  expect_absent "$lf1" 'voice//ident-reject' "$A1_MODEL rejected nobody's identity"
  expect_absent "$lf2" 'voice//ident-reject' "$A2_MODEL rejected nobody's identity"
  # The zombie: connected with hash=0 and then declined to re-scan.
  if grep -aq 'voice//connect hash=0' "$lf1" && ! grep -aq 'voice//peer-ready' "$lf1"; then
    sc_fail "$A1_MODEL shows the unproven-identity zombie (connect hash=0, never proven)"
  fi
  # Scan drops are diagnostic rather than fatal, but the bench must show them.
  local drops; drops="$(grep -ah 'voice//scan-drop' "$lf1" "$lf2" 2>/dev/null | head -4)"
  [ -n "$drops" ] && while IFS= read -r l; do sc_note "note | $l"; done <<<"$drops"
}

scenario aa-ptt AUTO a1+a2 150 \
  "PTT A1 to A2 is actually delivered (mic opens on the sender, speaker runs on the receiver)" \
  "the sender shows a VOICE_COMMUNICATION mic session but the receiver's AudioService logs NO com.playapal AudioTrack activity in the window. That combination is the exact 2026-08-27 bug: 'pugmi's PTT reached P7 SILENTLY — no audio, and no error anywhere'. It had no log face at all before this check; AudioService is where it shows."

run_aa_ptt() {
  ensure_walkie_pane "$A1" || { sc_fail "could not reach the walkie pane on $A1_MODEL"; return; }
  ensure_walkie_pane "$A2" || { sc_fail "could not reach the walkie pane on $A2_MODEL"; return; }
  local since1 since2 tx rx
  walkie_set "$A1" on || { sc_fail "A1 walkie off"; return; }
  walkie_set "$A2" on || { sc_fail "A2 walkie off"; return; }
  pane_walkie "$A1" >/dev/null 2>&1
  pane_walkie "$A2" >/dev/null 2>&1
  # Give discovery a chance; a PTT into an empty roster transmits to nobody
  # BY DESIGN, so asserting delivery without a peer would be testing the
  # wrong thing.
  sleep 25
  since1="$(sc_window "$A1")" || return
  since2="$(sc_window "$A2")" || return
  ptt_hold "$A1" 4000 || { sc_fail "could not press HOLD TO TALK on $A1_MODEL"; return; }
  sleep 8

  tx="$(mic_sessions_since "$A1" "$since1")"
  expect_str "$tx" 'src:VOICE_COMMUNICATION.*pack:com\.playapal' \
    "$A1_MODEL opened its microphone (TX)"

  rx="$(speaker_events_since "$A2" "$since2")"
  expect_str "$rx" 'piid:[0-9]+' \
    "$A2_MODEL ran its walkie AudioTrack while $A1_MODEL was talking (RX — audio really played)"
}

scenario aa-liveness AUTO a1+a2 240 \
  "Walk away and come back: the row goes honest within ~26s, then rediscovers" \
  "no voice//liveness-lost and no walkie//row-demoted after the peer's radio dies — the phone keeps a LYING row wearing a plain name and a Call button over a dead link, which is the failure measured on two Pixels on 2026-08-25 (callbacks are not proof; inbound frames are). Or the row never comes back after the radio returns."

run_aa_liveness() {
  ensure_walkie_pane "$A1" || { sc_fail "could not reach the walkie pane on $A1_MODEL"; return; }
  ensure_walkie_pane "$A2" || { sc_fail "could not reach the walkie pane on $A2_MODEL"; return; }
  local lf1
  walkie_set "$A1" on || { sc_fail "A1 walkie off"; return; }
  walkie_set "$A2" on || { sc_fail "A2 walkie off"; return; }
  sleep 25
  logcap_start "$A1" "$SC_ID-a1"; lf1="$(logcap_file "$SC_ID-a1")"
  # A2 "walks away": its radio goes down. Bluetooth rather than airplane mode,
  # because airplane mode measurably leaves bluetooth_on=1 on these Pixels.
  if ! bt_set "$A2" disable; then
    sc_fail "UNDRIVABLE: cannot take $A2_MODEL's radio down"
    logcap_stop "$SC_ID-a1"; return
  fi
  local t0=$SECONDS
  if wait_for_match "$lf1" 'voice//liveness-lost|walkie//row-demoted' 40; then
    sc_note "OK   $A1_MODEL called it honest after $((SECONDS - t0))s (budget ~26s: STALE_MS 10s + probe 4.5s + sweep 2s, two probe rounds)"
  else
    sc_fail "$A1_MODEL still shows a live row 40s after the peer's radio died"
  fi
  bt_set "$A2" enable || sc_fail "could not bring $A2_MODEL's radio back"
  if wait_for_match "$lf1" 'voice//peer-ready|walkie//row-proven' 90; then
    sc_note "OK   the row came back after the peer returned"
  else
    sc_fail "the peer never reappeared after its radio returned"
  fi
  logcap_stop "$SC_ID-a1"
  expect_match "$lf1" 'voice//liveness-lost|walkie//row-demoted' "the demotion is in the log, named"
}

scenario aa-stale-flush AUTO a1+a2 180 \
  "Congestion: a backed-up channel is flushed from the front, not allowed to lag" \
  "no walkie//stale-flush line while the channel is visibly behind, meaning the lateness guard is not running and the channel will sit ~400ms behind forever — 'a live channel has to sound like NOW'. Absence with no congestion is NOT a failure, so this row reports NO-CONGESTION rather than a false red."

run_aa_stale_flush() {
  ensure_walkie_pane "$A1" || { sc_fail "could not reach the walkie pane on $A1_MODEL"; return; }
  ensure_walkie_pane "$A2" || { sc_fail "could not reach the walkie pane on $A2_MODEL"; return; }
  local lf2 i
  walkie_set "$A1" on || { sc_fail "A1 walkie off"; return; }
  walkie_set "$A2" on || { sc_fail "A2 walkie off"; return; }
  sleep 25
  logcap_start "$A2" "$SC_ID-a2"; lf2="$(logcap_file "$SC_ID-a2")"
  # Back-to-back holds with no gap are the cheapest congestion this bench can
  # manufacture without a second talker.
  for i in 1 2 3 4; do ptt_hold "$A1" 5000; sleep 5; done
  sleep 5
  logcap_stop "$SC_ID-a2"
  if grep -aq 'walkie//stale-flush' "$lf2"; then
    expect_match "$lf2" 'walkie//stale-flush count=[0-9]+ lead=[0-9]+' \
      "the lateness guard evicted a stale tail and named the lead"
  else
    sc_note "NOTE no congestion reached the receiver in this window — the guard was not needed."
    sc_note "     This is not a pass for the guard. It is a pass for the link being fast enough."
    sc_note "     The guard's own proof needs a saturated rung; see TIER-MANUAL."
  fi
}

scenario aa-mail AUTO a1+a2 300 \
  "A pod text crosses A1 to A2, the mention buzzes the pocket, and the tap lands on Mail" \
  "the text never appears in A2's inbox inside the TTL window (mesh gossip dead — every [mesh] cycle logging accepted=0, the measured cross-OS starvation face); or it arrives with no notification on the pod-mentions channel, meaning a camper's name went by unfelt in a pocket."

run_aa_mail() {
  local lf2 body notes
  body="bench $(date +%H%M%S)"
  walkie_set "$A1" off >/dev/null 2>&1
  walkie_set "$A2" off >/dev/null 2>&1
  logcap_start "$A2" "$SC_ID-a2"; lf2="$(logcap_file "$SC_ID-a2")"
  go_pods "$A1" >/dev/null 2>&1
  mail_send "$A1" "$body" || { sc_fail "could not compose and send the message"; logcap_stop "$SC_ID-a2"; return; }
  sc_note "OK   sent \"$body\" from $A1_MODEL"
  # Store-and-forward: delivery rides sightings, not a live link, so the
  # window is generous by design.
  if wait_for_match "$lf2" '\[mesh\] dial-ok .* accepted=[1-9]' 180; then
    sc_note "OK   $A2_MODEL accepted records off the mesh"
  else
    sc_fail "no [mesh] dial-ok with accepted>=1 on $A2_MODEL inside 180s"
  fi
  logcap_stop "$SC_ID-a2"
  expect_match "$lf2" '\[mesh\] (served|dial-ok)' "the mesh ran a sync cycle at all"
  # The body itself, on screen, in the receiver's inbox.
  go_pods "$A2" >/dev/null 2>&1
  pane_mail "$A2" >/dev/null 2>&1
  if ui_texts "$A2" | grep -qF "$body"; then
    sc_note "OK   the message body is on $A2_MODEL's screen"
  else
    sc_fail "the message body never appeared in $A2_MODEL's inbox"
  fi
  notes="$(notifications_for_playapal "$A2")"
  expect_str "$notes" 'pkg=com.playapal' "a notification was posted on $A2_MODEL"
}

scenario aa-mail-mention AUTO a1+a2 300 \
  "An @-mention posts on the loud channel and its tap opens the pod's Mail pane" \
  "the notification lands on pod-messages instead of pod-mentions (the two-firm-taps vibration a camper is meant to feel through a coat pocket never fires), or tapping it does not land on Mail."

run_aa_mail_mention() {
  local body notes
  body="@$(ui_texts "$A2" | grep -m1 -E '^[A-Z][a-z]+ ?[A-Za-z]*$' || echo Kupo) bench $(date +%H%M%S)"
  go_pods "$A1" >/dev/null 2>&1
  mail_send "$A1" "$body" || { sc_fail "could not send the mention"; return; }
  sleep 120
  notes="$(notifications_for_playapal "$A2")"
  expect_str "$notes" 'pod-mentions' \
    "the mention landed on the HIGH-importance pod-mentions channel"
  # Drive the notification's own intent rather than guessing a shade
  # coordinate, then read where the app ended up.
  adb -s "$A2" shell cmd statusbar expand-notifications >/dev/null 2>&1
  sleep 2
  ui_tap "$A2" "bench" >/dev/null 2>&1 || adb -s "$A2" shell cmd statusbar collapse >/dev/null 2>&1
  sleep 3
  if ui_exists "$A2" "The answering machine"; then
    sc_note "OK   the tap landed inside the pod, on the Mail pane"
  else
    sc_fail "the notification tap did not land on the pod's Mail pane"
  fi
}

scenario aa-look-again-collects AUTO a1+a2 180 \
  "'Look again' collects a podmate that had gone quiet" \
  "walkie//look-again peers=0 forever after a real peer is back in range — the button reports but collects nothing, which is the inert-control failure wearing a green log line."

run_aa_look_again_collects() {
  ensure_walkie_pane "$A1" || { sc_fail "could not reach the walkie pane on $A1_MODEL"; return; }
  ensure_walkie_pane "$A2" || { sc_fail "could not reach the walkie pane on $A2_MODEL"; return; }
  local lf1 before after
  walkie_set "$A1" on || { sc_fail "A1 walkie off"; return; }
  walkie_set "$A2" on || { sc_fail "A2 walkie off"; return; }
  bt_set "$A2" disable || { sc_fail "UNDRIVABLE: cannot drop A2's radio"; return; }
  sleep 30
  logcap_start "$A1" "$SC_ID-a1"; lf1="$(logcap_file "$SC_ID-a1")"
  look_again "$A1" >/dev/null 2>&1
  sleep 6
  before="$(grep -ao 'look-again peers=[0-9]*' "$lf1" | tail -1 | grep -o '[0-9]*$')"
  bt_set "$A2" enable || sc_fail "could not restore A2's radio"
  sleep 25
  look_again "$A1" >/dev/null 2>&1
  wait_for_match "$lf1" 'voice//peer-ready|walkie//row-proven' 60
  sleep 5
  logcap_stop "$SC_ID-a1"
  after="$(grep -ao 'look-again peers=[0-9]*' "$lf1" | tail -1 | grep -o '[0-9]*$')"
  sc_note "note peers reported: ${before:-?} while away, ${after:-?} after return"
  expect_match "$lf1" 'voice//peer-ready|walkie//row-proven' \
    "the podmate was collected again after Look again"
}

# ===========================================================================
# TIER-SEMI — Android plus a cabled iPhone.
#
# The asymmetry is structural, not laziness: there is no adb for iOS. Without
# a Mac running WebDriverAgent this laptop cannot tap an iPhone at all. So the
# Android half is fully automated and the iPhone contributes either a burst
# syslog window or one printed human gesture.
# ===========================================================================

scenario ai-discovery-a-sees-i SEMI a1+i 180 \
  "The Android sees the iPhone (cross-OS BLE discovery, the historically one-sided half)" \
  "no voice//peer-ready on the Android while the iPhone's walkie is on — the measured 2026-08-26 break where two CoreBluetooth advertisers overflowed the iOS ad packet and Android's UUID-filtered scan never matched. voice//scan-drop reason= names which gate refused."

run_ai_discovery_a_sees_i() {
  local s="$A1" lf
  ensure_walkie_pane "$s" || { sc_fail "could not reach the walkie pane"; return; }
  walkie_set "$s" on || { sc_fail "walkie would not turn on"; return; }
  human_gesture "On the iPhone: open Playa Pal, go to Pods > Walkie, and turn the walkie ON." 45
  logcap_start "$s" "$SC_ID-a1"; lf="$(logcap_file "$SC_ID-a1")"
  look_again "$s" >/dev/null 2>&1
  wait_for_match "$lf" 'voice//peer-ready hash=' 90
  sleep 5
  logcap_stop "$SC_ID-a1"
  expect_match "$lf" 'voice//peer-ready hash=[0-9a-f]+' \
    "$A1_MODEL proved a cross-OS peer"
  # The mesh half is observable even when the walkie half is not, and its
  # signature identifies an Apple peripheral: iOS cannot carry manufacturer
  # data in an advertisement, so its sightings always arrive via the GATT
  # fallback. INFERRED, not measured: nothing in the payload names the OS.
  if grep -aq 'scan//no-inline .*reason=no-manufacturer-data' "$lf"; then
    sc_note "note an advertiser with no manufacturer data is being read via GATT fallback"
    sc_note "     (INFERRED iPhone: iOS peripherals cannot carry manufacturer data)"
  fi
  local drops; drops="$(grep -ah 'voice//scan-drop' "$lf" | head -4)"
  [ -n "$drops" ] && while IFS= read -r l; do sc_note "note | $l"; done <<<"$drops"
}

scenario ai-ptt-a-to-i SEMI a1+i 150 \
  "PTT Android to iPhone" \
  "the Android opens its mic and the iPhone's burst syslog shows no CoreBluetooth traffic in the same window. NOTE the iPhone half of this row is WEAK ON PURPOSE — see the ceiling note in the report: iOS os_log redacts the app's own strings to <private>, so the phone cannot currently confirm that a frame was played. Audibility stays TIER-MANUAL."

run_ai_ptt_a_to_i() {
  local since tx sl
  ensure_walkie_pane "$A1" || { sc_fail "could not reach the walkie pane"; return; }
  walkie_set "$A1" on || { sc_fail "walkie off"; return; }
  pane_walkie "$A1" >/dev/null 2>&1
  since="$(sc_window "$A1")" || return
  ( sleep 2; ptt_hold "$A1" 5000 ) &
  sl="$(burst_syslog "$IPH" 14 "$SC_ID")"
  wait
  tx="$(mic_sessions_since "$A1" "$since")"
  expect_str "$tx" 'src:VOICE_COMMUNICATION.*pack:com\.playapal' \
    "$A1_MODEL opened its microphone (TX half, fully automated)"
  if [ -n "$sl" ] && [ -s "$sl" ]; then
    sc_note "OK   captured a bounded iPhone syslog burst ($(wc -l <"$sl") lines) -> $(basename "$sl")"
    if grep -aq 'CoreBluetooth' "$sl"; then
      sc_note "OK   the iPhone's CoreBluetooth stack was active during the hold"
    else
      sc_note "NOTE no CoreBluetooth line in the burst — weak evidence either way"
    fi
  else
    sc_note "NOTE the iPhone syslog burst was empty (app-level lines are <private> on iOS)"
  fi
  sc_note "CEILING audibility on the iPhone is NOT asserted here and cannot be from this laptop."
}

scenario ai-ptt-i-to-a SEMI a1+i 180 \
  "PTT iPhone to Android — one human hold, fully automatic verdict" \
  "the Android's AudioService shows no com.playapal AudioTrack activity while the iPhone was transmitting. That IS the measured one-way silence of 2026-08-27 (voice//connect hash=0 then scan-drop reason=already-reached: the row never re-proves an identity it never had) — a failure that produced no error anywhere on either phone."

run_ai_ptt_i_to_a() {
  local s="$A1" since lf rx
  ensure_walkie_pane "$s" || { sc_fail "could not reach the walkie pane"; return; }
  walkie_set "$s" on || { sc_fail "walkie off"; return; }
  pane_walkie "$s" >/dev/null 2>&1
  sleep 5
  since="$(sc_window "$s")" || return
  logcap_start "$s" "$SC_ID-a1"; lf="$(logcap_file "$SC_ID-a1")"
  human_gesture "On the iPhone: HOLD the walkie's talk button and say something for about 5 seconds." 30
  sleep 6
  logcap_stop "$SC_ID-a1"
  rx="$(speaker_events_since "$s" "$since")"
  expect_str "$rx" 'piid:[0-9]+' \
    "$A1_MODEL ran its walkie AudioTrack while the iPhone was talking (audio really played)"
  # The zombie's own signature, checked explicitly because it is the shape
  # this exact direction failed in.
  if grep -aq 'voice//connect hash=0' "$lf"; then
    sc_fail "the unproven-identity zombie is present: voice//connect hash=0"
  fi
  expect_absent "$lf" 'voice//scan-drop reason=already-reached' \
    "the scanner did not skip an unproven peer as already-reached"
}

scenario ai-mail SEMI a1+i 420 \
  "A pod text crosses Android to iPhone and back while the walkie is on" \
  "cycles of '[mesh] dial-ok ... accepted=0' in both directions for minutes, with 'PlayaMesh advertise//skip reason=walkie-airtime' every 15s on the iPhone — the measured 2026-08-27 starvation where the walkie's beacon hold blocked mail visibility and a one-foot delivery took ~8 minutes."

run_ai_mail() {
  local lf body
  body="bench-x $(date +%H%M%S)"
  walkie_set "$A1" on || true
  logcap_start "$A1" "$SC_ID-a1"; lf="$(logcap_file "$SC_ID-a1")"
  go_pods "$A1" >/dev/null 2>&1
  mail_send "$A1" "$body" || { sc_fail "could not send"; logcap_stop "$SC_ID-a1"; return; }
  human_gesture "On the iPhone: open Playa Pal to the pod's Mail pane and leave it in the FOREGROUND (iPhones only carry mail while foregrounded)." 20
  local t0=$SECONDS
  if wait_for_match "$lf" '\[mesh\] dial-ok .* accepted=[1-9]' 300; then
    sc_note "OK   a transfer landed after $((SECONDS - t0))s"
  else
    sc_fail "no accepted transfer in 300s — the starvation face"
  fi
  logcap_stop "$SC_ID-a1"
  local zeros; zeros="$(grep -ac 'accepted=0' "$lf" 2>/dev/null || echo 0)"
  sc_note "note $zeros empty mesh cycles (accepted=0) before the transfer"
  expect_absent "$lf" 'advertise//skip reason=walkie-airtime' \
    "the walkie's airtime hold did not starve the mail beacon on the Android side"
}

# ===========================================================================
# TIER-MANUAL — named, never faked.
# ===========================================================================
# These are in the catalog so the owner can see the whole battery in one list
# and so nobody mistakes the automated set for the complete one. bench.sh
# prints them and marks them MANUAL. It never invents a verdict for them.

scenario ii-everything MANUAL none 0 \
  "Every iPhone-to-iPhone pair row (discovery, PTT, mail, Aware pairing ceremony)" \
  "n/a — this laptop cannot drive two iPhones. Two humans and two phones, or a Mac running WebDriverAgent on each."

scenario audio-quality MANUAL none 0 \
  "Audio QUALITY: is the voice intelligible, is the lo-fi rung good enough, does double-talk garble" \
  "n/a — AudioService proves a track RAN. Whether it sounded like a person is a judgement no dumpsys makes."

scenario video-calls MANUAL none 0 \
  "1:1 video calls (any pair), including the honest no-path sentence over Aware" \
  "n/a — needs two faces, two cameras, and a human to say whether the picture arrived and whether the failure sentence was honest or a hang."

scenario range-and-dust MANUAL none 0 \
  "Real range, real bodies, real dust: the walk-away that is actually a walk" \
  "n/a — bt_set disable simulates a radio death, not distance. Attenuation, obstruction and the 10-person pod are field work."

scenario hotspot-host MANUAL none 0 \
  "Camp hotspot hosting and joining" \
  "n/a — LocalOnlyHotspot needs a human to join from another phone and confirm the QR scanned."
