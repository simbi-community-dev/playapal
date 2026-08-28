# p2p-bench — the comms battery

The owner's ask, 2026-08-27: *"can you make a testing suite that tests
everything in the p2p comms layer for both android and iphone and all
combinations AS IF i was testing it manually? how close can you get for a real
automated testing suite about it?"*

This is how close. The short answer is: **the whole Android side, honestly;
the iPhone's half of a cross-OS pair, partly; and nothing at all of the
iPhone-to-iPhone pairs or of whether the audio sounded good.** The rest of this
file says why, so nobody has to re-derive it.

## Run it

```sh
tools/p2p-bench/bench.sh --dry-run     # the whole plan, no device touched
tools/p2p-bench/bench.sh               # everything the cabled devices support
tools/p2p-bench/bench.sh --tier AUTO   # only the hands-off rows
tools/p2p-bench/bench.sh --with-human  # also the rows needing an iPhone gesture
tools/p2p-bench/bench.sh --only aa-ptt # one row
tools/p2p-bench/bench.sh --patch-matrix  # fold the newest run into docs/TEST-MATRIX.md
```

Artifacts land in `runs/<timestamp>/`: a JSON scorecard, the streamed logcat
from each phone, any iPhone syslog bursts, and a screenshot of every phone at
the moment anything went red. `runs/` is gitignored — it holds pictures of the
owner's real pod.

## The three tiers, and why they are three

**TIER-AUTO.** The laptop drives it and reads the verdict off the phones.
Nobody touches a screen. Everything single-Android and everything
Android-to-Android lives here.

**TIER-SEMI.** iOS has no adb. Without a Mac running WebDriverAgent this
laptop cannot tap an iPhone at all, so cross-OS rows drive the Android half
automatically and either take a bounded iPhone syslog burst or print one
instruction and wait with a countdown. The Android-side verdict is still fully
automatic — which is the good half, because for `iPhone -> Android` the
Android side is exactly where the interesting failure showed up.

**TIER-MANUAL.** Named in the catalog so the battery is visibly complete, and
never given a verdict. iPhone-to-iPhone pairs, audio quality judgements, video
calls, real range in real dust. No evidence this laptop can gather would settle
any of them, and inventing a verdict would be worse than an empty cell.

## What the bench treats as proof

It does not believe its own actions, and it does not believe callbacks. That
rule is inherited from the app's own hard-won comment: *"Callbacks are not
proof. Inbound frames are."*

| Question | Evidence |
|---|---|
| Is the walkie on? | the Switch's own `checked` attribute in the accessibility tree |
| Did the radios come up? | `voice//up`, `voice//advertise-started`, `aware//publish-started`, `aware//subscribe-started`, `aware//responder-listening` |
| Did a peer prove itself? | `voice//peer-ready hash=<h>` |
| Did the app notice a peer die? | `voice//liveness-lost`, `walkie//row-demoted` |
| Did a PTT open the mic? | AudioService `### Recording Activity`: `rec start ... src:VOICE_COMMUNICATION not silenced ... pack:com.playapal` |
| **Did audio actually play on the receiver?** | AudioService `### Playback activity`: a `com.playapal` `android.media.AudioTrack` with `CONTENT_TYPE_SPEECH` |
| Did mail cross? | `[mesh] dial-ok ... accepted=N`, plus the body on the receiver's screen |
| Did a mention buzz? | `dumpsys notification` showing the `pod-mentions` channel |

The last two rows of that table are the ones worth arguing about, so:

### Why `dumpsys audio` and not a log line

The brief for this work assumed log lines named `voice//frames-written` and a
"playback advanced" marker. **They do not exist in this tree.** `git grep`
finds no per-frame logging anywhere in the walkie: `framesWritten` and
`staleFlushes` are `AtomicInteger`s, and the only one that ever reaches the log
does so through `walkie//stale-flush`, which fires under lateness alone.

Worse, the obvious substitute is a trap. `walkie//row-proven` looks like an
inbound-frame marker, and it is — but WalkieModule emits it **on change only**,
and the 4.5 s `CODEC_PROBE` keep-alive holds a healthy row proven
continuously. So a PTT across a working link logs *nothing at all*. An
assertion built on `row-proven` would be green when the link is healthy and
green when the link is idle.

AudioService keeps two timestamped audit logs that answer the question
directly, survive logcat rotation entirely, and need no root. They are the
bench's ears. Both were validated against the owner's own PTT presses from the
00:19–00:40 bench earlier the same night, which were still in the buffer.

This matters most for the bug the owner hit on 2026-08-27: *"pugmi's PTT
reached P7 SILENTLY — no audio, and no error anywhere."* That failure had **no
log face at all**. It has one now: mic session on the sender, nothing in
Playback activity on the receiver.

## Things that bit, written down so they do not bite again

**The logcat ring is 256 KiB and PlayaMesh fills it in under a minute.**
Measured: 8663 lines covering a couple of minutes. A scenario that waits 30 s
and then reads `logcat -d` can be reading a buffer that already threw its own
evidence away. The bench raises the ring to 16 MiB *and* streams to a file for
the whole window.

**`adb shell date '+%m-%d %H:%M:%S'` returns nothing.** The local shell eats
the quotes, adb forwards two words, and toybox `date` refuses with "Max 1
argument". This produced the single worst bug in this suite's own development:
the time window came back empty, an empty window matched every row AudioService
had ever recorded, and `ptt-capture` reported **PASS** on the owner's presses
from eight hours earlier. It was testing nothing and saying so in green. The
fix is a one-word format and a guard that makes an unusable window a hard
error, never a permissive filter.

**Coordinates are not addresses.** Every hardcoded tap in the old bench notes
was true for one phone at one text size in one app state. The P7 and P9
disagree; the text-size dial moves everything; the walkie stage grows a peer
row and pushes HOLD TO TALK down the page. Nothing here types a coordinate —
`uinode.js` resolves the accessibility label the app already ships to whatever
rectangle currently carries it.

**Scenarios must navigate, not assume.** A scenario that assumed the walkie
pane was already showing passed only when the previous scenario happened to
leave it there, and reported "the walkie switch would not turn on" the moment
anything relaunched the app. A false red about the app, caused by the bench.
Caught by the screenshot-on-failure, which showed the Now tab.
`ensure_walkie_pane` is the fix and every walkie row calls it.

**Airplane mode is the wrong lever for a walk-away test.** It toggles fine
non-root, but `settings global bluetooth_on` stays `1` across it on these
Pixels — Android remembers a per-user "keep BT on in airplane mode"
preference. A walk-away driven by airplane mode is a drive step that ran and
proved nothing. `cmd bluetooth_manager enable|disable` is the lever, and
`dumpsys bluetooth_manager` (`ON` / `BLE_ON`) verifies it landed.

**The iPhone syslog is a much weaker witness than logcat, and a loaded gun.**
A standing `idevicesyslog` wedges the whole laptop, so every capture is a
bounded burst under `timeout`. Beyond that: PlayaPal's CoreMotion magnetometer
stream emits ~10 lines a second and drowns everything (`-M CoreMotion` is
mandatory), and iOS `os_log` replaces every dynamic string with `<private>`
unless the format specifier says `%{public}`. A filtered 15 s burst produced
**zero** usable app-level rows. The iPhone can currently tell us the process is
alive and that CoreBluetooth is busy. It cannot tell us a frame arrived.

## The negative control

`neg-discovery-radio-off` exists because a guard is unproven until it has
failed. It runs the *same* expression every discovery row depends on, with the
Bluetooth radio deliberately down, and the bench scores it PASS only when that
assertion goes **red**. If it ever reports FAIL, the discovery assertion is
vacuous and every green pair row in the suite is worthless.

The PTT assertion was proven the same way, by planting real violations:
revoking `RECORD_AUDIO`, and setting `appops set --uid com.playapal
RECORD_AUDIO ignore`. Both drove the row red. The second mutation also exposed
a genuine gap — Android will hand an app a *silenced* mic session, where the
recorder opens and the camper transmits nothing — which is why the assertion
now requires `not silenced` rather than merely a session.
