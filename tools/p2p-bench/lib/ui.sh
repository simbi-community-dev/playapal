# shellcheck shell=bash
#
# ui.sh — drive the app the way a thumb does, and read back what the screen
# actually says.
#
# The ritual this replaces is a list of coordinates. Those numbers were true
# for one phone at one text size on one screen, and the bench needs to survive
# the P7 and the P9 disagreeing, the owner's text-size dial, and the walkie
# stage growing a peer row that pushes HOLD TO TALK down the page. So nothing
# here types a coordinate: every action names an accessibility label and asks
# the live dump where that label currently is.

UI_NODE="$BENCH_DIR/uinode.js"

# uiautomator refuses while the UI is animating ("could not get idle state"),
# and it also happily hands back a dump taken a moment before the tap landed —
# the overlay-merge trap that cost three failures in one pass on this project.
# Both are handled by retrying and by always re-dumping after acting rather
# than reusing the dump that chose the tap.
ui_dump() {
  local s="$1" out="$2" try
  for try in 1 2 3 4; do
    if adb -s "$s" shell uiautomator dump /sdcard/p2pbench.xml >/dev/null 2>&1; then
      adb -s "$s" shell cat /sdcard/p2pbench.xml 2>/dev/null > "$out"
      if [ -s "$out" ] && grep -q '<node' "$out"; then
        return 0
      fi
    fi
    sleep 2
  done
  return 1
}

# The dump can lag the screen. Poll until the label we are about to act on is
# really there, so a tap is never fired into the previous screen.
ui_wait_for() {
  local s="$1" needle="$2" secs="${3:-15}" tmp deadline
  tmp="$RUN_DIR/.ui.$$.xml"
  deadline=$((SECONDS + secs))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if ui_dump "$s" "$tmp" && node "$UI_NODE" exists "$tmp" "$needle" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

ui_tap() {
  local s="$1" needle="$2" tmp xy
  tmp="$RUN_DIR/.ui.$$.xml"
  ui_dump "$s" "$tmp" || return 1
  xy="$(node "$UI_NODE" center "$tmp" "$needle" 2>/dev/null)" || return 1
  [ -z "$xy" ] && return 1
  # shellcheck disable=SC2086
  adb -s "$s" shell input tap $xy >/dev/null 2>&1
  sleep 2
  return 0
}

ui_attr() {
  local s="$1" needle="$2" attr="${3:-checked}" tmp
  tmp="$RUN_DIR/.ui.$$.xml"
  ui_dump "$s" "$tmp" || { echo ""; return 1; }
  node "$UI_NODE" attr "$tmp" "$needle" "$attr" 2>/dev/null || echo ""
}

ui_exists() {
  local s="$1" needle="$2" tmp
  tmp="$RUN_DIR/.ui.$$.xml"
  ui_dump "$s" "$tmp" || return 1
  node "$UI_NODE" exists "$tmp" "$needle"
}

ui_texts() {
  local s="$1" tmp
  tmp="$RUN_DIR/.ui.$$.xml"
  ui_dump "$s" "$tmp" || { echo ""; return 1; }
  node "$UI_NODE" texts "$tmp" 2>/dev/null
}

# ---------------------------------------------------------------------------
# App navigation
# ---------------------------------------------------------------------------
app_launch() {
  local s="$1"
  adb -s "$s" shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1
  adb -s "$s" shell am start -n com.playapal/.MainActivity >/dev/null 2>&1
  # The first launch after a cold start is slow enough that a dump taken
  # straight away catches the splash. Wait for a landmark instead of a clock.
  ui_wait_for "$s" "Pods" 60
}

app_foreground() {
  adb -s "$1" shell dumpsys activity activities 2>/dev/null |
    grep -q 'topResumedActivity.*com.playapal'
}

go_pods() {
  local s="$1"
  ui_tap "$s" "Pods" || return 1
  ui_wait_for "$s" "Live talk and calls" 20
}

# The pane strip inside Pods. Descs are stable; the visible words are not
# (Mail carries an unread count). Walkie's desc gains ", on the air" when the
# channel is up, so the match is on the stable prefix.
pane_people() { ui_tap "$1" "Who is in this pod"; }
pane_mail()   { ui_tap "$1" "The answering machine"; }
pane_walkie() { ui_tap "$1" "Live talk and calls"; }
pane_setup()  { ui_tap "$1" "Invite people, and camp gear"; }

# Put a phone on the walkie stage, from wherever it happens to be.
#
# NOT optional, and not paranoia. A scenario that assumes the walkie pane is
# already showing passes only when the previous scenario happened to leave it
# there — and reports "the walkie switch would not turn on" the moment anything
# relaunches the app, because the Switch is not on screen to tap. That is a
# FALSE RED about the feature, blamed on the app, caused by the bench. It was
# caught by the screenshot-on-failure: the picture showed the Now tab.
ensure_walkie_pane() {
  local s="$1" try
  for try in 1 2 3; do
    if ui_exists "$s" "Walkie — live talk with this pod"; then return 0; fi
    app_foreground "$s" || app_launch "$s" >/dev/null 2>&1
    go_pods "$s" >/dev/null 2>&1
    pane_walkie "$s" >/dev/null 2>&1
    sleep 2
  done
  ui_exists "$s" "Walkie — live talk with this pod"
}

# ---------------------------------------------------------------------------
# The walkie switch
# ---------------------------------------------------------------------------
# checked="true|false" on the Switch is the app's own answer to "is the walkie
# on", which is why the bench sets state rather than blindly toggling: a run
# that starts with the walkie already on must not turn it off and then assert
# discovery against a dead radio.
walkie_is_on() {
  [ "$(ui_attr "$1" "Walkie — live talk with this pod" checked)" = "true" ]
}

walkie_set() {
  local s="$1" want="$2" try
  for try in 1 2 3; do
    if [ "$want" = on ] && walkie_is_on "$s"; then return 0; fi
    if [ "$want" = off ] && ! walkie_is_on "$s"; then return 0; fi
    ui_tap "$s" "Walkie — live talk with this pod" || return 1
    sleep 3
  done
  [ "$want" = on ] && walkie_is_on "$s" && return 0
  [ "$want" = off ] && ! walkie_is_on "$s" && return 0
  return 1
}

# PTT. `input swipe x y x y <ms>` with identical endpoints is a genuine
# press-and-hold — VERIFIED 2026-08-27 against dumpsys audio, which recorded a
# 4.09 s VOICE_COMMUNICATION session for a 4000 ms swipe and a 3.12 s session
# for the motionevent DOWN/sleep/UP equivalent. The swipe form is used because
# it is one call and cannot leave a finger stuck down if the bench is killed
# mid-scenario.
ptt_hold() {
  local s="$1" ms="$2" tmp xy
  tmp="$RUN_DIR/.ui.$$.xml"
  ui_dump "$s" "$tmp" || return 1
  xy="$(node "$UI_NODE" center "$tmp" "Hold to talk" 2>/dev/null)" || return 1
  [ -z "$xy" ] && return 1
  # shellcheck disable=SC2086
  adb -s "$s" shell input swipe $xy $xy "$ms" >/dev/null 2>&1
  return 0
}

look_again() { ui_tap "$1" "Look again for podmates"; }

# ---------------------------------------------------------------------------
# Mail
# ---------------------------------------------------------------------------
# One text field, so tap-then-type is safe here. The re-dump before Send is
# not optional: the IME resizes the layout the moment the field takes focus,
# and the Send button that was at one place in the pre-tap dump has moved.
mail_send() {
  local s="$1" body="$2" tmp xy
  pane_mail "$s" || return 1
  tmp="$RUN_DIR/.ui.$$.xml"
  ui_dump "$s" "$tmp" || return 1
  xy="$(node "$UI_NODE" center "$tmp" "Message the pod" 2>/dev/null)" || return 1
  # shellcheck disable=SC2086
  adb -s "$s" shell input tap $xy >/dev/null 2>&1
  sleep 1
  adb -s "$s" shell input text "$(printf '%s' "$body" | sed 's/ /%s/g')" >/dev/null 2>&1
  sleep 1
  ui_tap "$s" "Send message" || return 1
  adb -s "$s" shell input keyevent KEYCODE_BACK >/dev/null 2>&1
  return 0
}

# Notifications are readable without root. A posted mention lands on the
# pod-mentions channel (PocketAlertsModule.CH_MENTIONS), which is what makes
# "the mention buzzed, the plain message did not" an assertable difference
# rather than a claim.
notifications_for_playapal() {
  adb -s "$1" shell dumpsys notification --noredact 2>/dev/null |
    grep -a -A18 'pkg=com.playapal' | tr -d '\r'
}
