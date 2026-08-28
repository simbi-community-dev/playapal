# Changelog

Playa Pal was built in twelve days before Burning Man 2026. The first commit
landed on Aug 13 and 0.8.0 shipped on Aug 24, and the versions map to the real
eras of that history: each tenth is a thing the app couldn't do the day before.
1.0 is earned when Black Rock City itself has field-tested it.

## 0.9.0: The links learn to let go (Aug 27)

This is the release that drives to Black Rock City, and it goes as an
experimental beta. Two weeks of building put more into this app than a
workbench can prove: pods, live voice with every network switched off, video
calls, mail that hops from pocket to pocket, and an Angel who answers out of
the guide in your hand. How much of that holds up at 4am, in real dust and at
real range, is the one thing nobody here can tell you. That is what this week
is for, and what the proof grid at the bottom of this entry exists to record.

The work itself is one long lesson in ownership: who owns a radio, who owns a
link, and who is allowed to end one. Almost every fix below is that same
question answered in a different place.

**iPhone links no longer strangle their replacements.** (iPhone) Tap the
walkie off and on, or let a flaky link retire itself, and the *old* link's
shutdown could reach across and close the radio the *new* one was already
using, so the replacement died of the thing it replaced. It took four rounds
to get right, and the shape that finally held is simple to say: a
retirement leases the object it is retiring, and does not let go until its
cancel has actually taken EFFECT, not merely been issued. The same rule now
governs the advertiser: an advert ends when the stop lands, never when the
stop is asked for. Each dial also gets its own CoreBluetooth stack, so two
links can never share the thing one of them is about to close.

**Your iPhone finds Androids much faster when the walkie is open.** The
discovery asymmetry finally has a root cause rather than a shrug: an iPhone
scanning while its own radio is talking was giving the air away between
looks. The scan now holds its airtime, and a link that is ready keeps
proving it on the link's own clock rather than on a guess, so **Look
again** collects what is really there instead of what was there a minute
ago.

**A link says its name before it carries a voice.** The dialing phone now
introduces itself, so the phone being dialled stops waiting on a stranger
to explain itself, and the proof memo is written by success rather than by
hope. Two earlier attempts at this were built, measured, and **taken back
out**: the ready-link watchdog after four binding rounds, and the dialer's
self-introduction after two. A fix that needs that many rounds to bind is
telling you the shape is wrong. Both came back later in a form that
holds. Reverting good intentions is part of the work.

**The voice queue stops dropping the wrong end.** A full receive queue used
to lose whatever arrived next; it now drops its oldest frame and keeps the
newest, which is the only choice that makes sense for live voice. One lock
now decides both that the queue is full and what goes into it, so two
threads can't disagree about it, and a queue at the ceiling really flushes
and stays flushed. (Android) The AudioTrack write and its release finally
share one monitor, which was the crash that could take the app down
mid-sentence.

**The pod page keeps its place.** Come back to a pod and the mail-first
default re-reads the unread count instead of trusting a stale one, and a
pane you chose yourself outranks the default. The title moved up into the
picker row, the feature tour learned this week's verbs, and a hot radio
always has something on screen admitting it, so nobody has to wonder whether
the walkie is still on.

**Tap a mention and land where it happened.** A notification for someone
naming you now opens that pod's mail, not a home screen you have to
navigate out of.

**The mesh forgets what is gone and remembers who it met.** Stale routes
are retired instead of lingering, a manual check prunes them, and the phone
that just pulled from us is now known to be a phone we can reach. Mentions
survive a rename: naming yourself, and being named late, both keep hold of
the right person.

**Settings becomes the gear, and the Angel takes the fourth slot.** The
shell's five tabs were one more than a thumb wants; Settings is now the
gear where every phone already looks for it.

**The proof grid is a grid.** The evidence page grew an at-a-glance matrix
of which pair, on which radio, has actually carried which feature, plus a
manual-bench section for the six checks automation cannot replace, and an
automated peer-to-peer battery that reads *evidence* rather than its own
actions. If a row is not marked proven, no phone has said so yet.

**One radio, one truth.** (iPhone) The scan and the advert now report the
level the radio itself says, not the level the app last asked for. Every
road that turns Bluetooth off, resets it, or has it denied ends its promises
with the truth instead of leaving them waiting, and a stale radio event can
no longer write over the state of a radio it never owned.

**Recovery is a transaction with three legs.** Toggling Bluetooth off and
on used to tell the pod page "recovered" the moment the radio was back,
before the pod's own mailbox offer had been republished, so a phone could
show a healthy switch over a mesh that wasn't serving anyone. The
interruption banner now clears only when the scan, the advert, and the
mesh's own republish have all come back for the same outage. An
acknowledgment from before the outage, or from a session that already
ended, clears nothing.

**A crash cannot ride the handshake.** (iPhone) Apple frameworks raise
rather than return, and two bare radio writes could take the whole app down
mid-introduction. Both now fail the way everything else here fails: caught,
logged, retired. And the field log finally says so out loud, because the
logs a phone keeps redact anything they were not told is public.

**A refusal at the door costs three seconds, not thirty.** A phone turned
away before anything went on the air (its object claimed, retiring, or
gone) was punished like a phone that failed on the air, and the retry
backoff could stretch to half a minute of deafness. Turned away is cheap
now; failing on the air stays expensive.

**Late work signs its name.** A completion that arrives after its world
ended (an acknowledgment for a session that was replaced, a callback for a
radio that reset, a debt owed by a link that already retired) now carries
the identity of the world that minted it, and a dead world's mail moves
nothing in the live one.

**Two roads to the store.** The Play build and the sideload build are now
two different binaries. The Play one has no self-updater and asks for no
install permission, because the store owns delivery there; the GitHub one
keeps the built-in "Update to latest". Same app, each road honest about who
hands it to you.

## 0.8.7: The pod page finds its rooms (Aug 27)

**Four panes, one strip.** The pod page had grown into a single long
scroll: the mailbox, the walkie, the QR codes, the roster, all stacked,
with everything below a busy mailbox effectively unreachable. A UX
designer in the pod called it what it was. Now the page has rooms:
**People · Mail · Walkie · Setup**, one concern per screenful, on the
same chip strip the Camp tab already taught your thumb. It opens on Mail
when mail is waiting, with the unread count riding the chip, and on People
otherwise.

**A fast toggle can't undo itself.** Flip the walkie off and on quickly
enough and the off's slow native teardown used to finish *after* the on
which silently stopped the radio you had just started and handed its
advertising slot back mid-broadcast. Walkie lifecycle now runs
single-file: each operation waits out the one before it, while the
mini-bar still drops its claim the instant you tap, not when the
machinery catches up.

**The volume stopped pumping.** (iPhone) The walkie re-asserted its
audio session on a timer even when nothing was wrong, and every
re-assert briefly ducked whatever was playing, a once-a-second breathing of
the volume that was heard in the field. The session is now re-asserted only
when it is measurably wrong, and the same gate learned to notice a lost
loudspeaker route, since the mystery of old messages playing quietly out of
the earpiece was the same bug wearing a different coat.

## 0.8.6: Say a name, buzz a pocket (Aug 26)

**Type `@kupo` and Kupo's pocket buzzes.** Mentions arrived: the compose
box offers your podmates' names at `@`, and a message that names someone
raises a real notification on their phone the moment the mesh reaches it,
on its own high-priority channel, on by default, with one Settings row that
jumps straight to the phone's own notification controls. No servers
were involved; the buzz rides the same radios everything else does.

**Nothing arrives late anymore.** A live walkie that fell behind used to
save your words and play them ten seconds later, quietly, like a haunted
answering machine. Now a frame that would play more than a moment behind
the channel is dropped, on both platforms, and the counters say so. That is
a lo-fi rung being honest about its bandwidth instead of lying about time.

**Every phone can find every phone.** The morning's field bench caught
iOS truncating its own Bluetooth name in the packets other phones
actually receive, so iPhones were invisible to Androids, and then (one
fix later) to each other. Both decoders now accept what iOS really
sends, prove identity over the wire as always, and stop redialling
phones they already reached. A **Look again** control re-asks every
radio by hand, and the scan log names every advertisement it declines.

**The call grew up.** The self-view is a mirror and the far side is a
window (panning no longer goes backwards), mute is a gold-filled state
with a pill you can read at arm's length in sunlight, the controls fade
until you tap, and a call timer keeps honest time. Two iPhones that have
linked directly carry these calls with no Wi-Fi at all, field-measured this
week and reported back as "super high quality", and the help now says so.

**The talk button earns its complaints.** Repeated pressing could crash
the app outright (fixed, with the crash report to prove the cause), and
a quick dab that outran the microphone's spin-up earned a scolding
notification for a press that was already over (now it doesn't, though a
held press with a silent mic is still told the truth). The Android updater
row from this train, **Check for update** in Settings, downloads and
installs the newest release with one tap and refuses politely on
developer-keyed phones. And the public TestFlight invite now rides the
share row, so an iPhone can be invited from the playa with one bar of
signal.

## 0.8.5: The talk button proves it (Aug 26)

**The iPhone talk button now proves the microphone is alive, and heals it
when it isn't.** 0.8.4 cured how the audio engine is *born*; the last
holdout was how it *ages*: a video call rebuilds the phone's shared audio
session behind the walkie's back, and the engine the walkie keeps warm
survives that looking healthy while its microphone half is quietly dead, so
every press after that read "no-audio" even though a fresh engine worked
perfectly. Now the walkie checks the microphone's pulse every time it
reuses the warm engine (a dead one has a readable tell), rebuilds it on
the spot when a call ends, and, if a press still hears nothing for one
second, throws the warm engine away and re-arms a fresh one before ever
bothering you. The morning's diagnosis came from the Settings microphone
check plus the phone's own system log, each holding half the answer.

## 0.8.4: The phones that make their own network (Aug 26)

**One Android makes the Wi-Fi.** Video calls need a shared Wi-Fi, and the
playa does not have one, so now the pod does. Flip on **Camp hotspot**
under your pod and one Android hosts a no-internet Wi-Fi that every other
phone joins by pointing its camera at the code on screen (an iPhone
offers to join straight from the stock Camera app). Fourteen distinct
things can go wrong when a phone tries to host a network, and each one
now says its own honest sentence instead of a shrug.

**Two iPhones link directly.** New and being field-tested: **Link
iPhones directly** in the walkie pairs two iPhones once (a six-digit
code on both screens), after which they can find each other and talk at
full quality with no Wi-Fi at all, the same no-network trick the Androids
already do together. Cross-platform without Wi-Fi stays
lo-fi-and-messages; that half waits on Apple.

**The talk button hears again.** The iPhone microphone bug came apart
into three root causes, each found by research and fixed at the root:
the audio engine was born without its input half (started output-only,
the microphone element never enabled), the session mode engaged a
voice-processing unit that delivered nothing, and a stray double-catch
swallowed every error so the button could not even complain. On top of
that, a project-file collision meant one whole iOS module pair had been
silently left out of every build to date. That is found, fixed, and pinned
so it can never happen quietly again.

**Curiosity gets a tap.** The paragraphs of tiny print that sat on every
screen moved behind a calm circled **?**, so one tap opens the full
explanation and the screen keeps its ink for what changes. Status and
diagnosis lines stay inline, because those are the app telling you
something is happening now. And Settings grew a **text size** dial in four
steps, applied everywhere instantly, for sun-blind eyes and left-in-the-tent
reading glasses.

**Voice notes grow up.** A graze of the record button no longer mints an
empty voicemail. A note needs a full second of holding, and a shorter press
says so and discards cleanly. Received notes became a full-width
play control you can hit with gloves on, with a bright playing state.

**The radio keeps its cool.** The reviewer pass over the night's radio
surgery closed four race conditions before they could bite, including one
that could have rotated a healthy connection out from under a podmate on a
false reading, and one crash reachable from network input.

**The walkie stops flapping.** With no Wi-Fi anywhere, which is the playa's
normal, the direct phone-to-phone link used to come up, go deaf, and
re-dial in an endless 30-second loop, and a name on the channel could
look fine while nothing got through. One night of two-sided field logs
found both root causes: a re-dialed phone now re-learns where its
podmate answers from instead of latching the first address forever, and
an answering phone abandons a link the system quietly killed instead of
staying bound to its corpse. Measured before and after: the loop is
gone: one blip in five minutes, healed in two seconds.

**The status surfaces stop lying.** A podmate whose link went quiet now
reads **(quiet)** rather than (lo-fi), which promised live audio over a link
that had none, and one sentence says your voice may not be reaching them
while messages still go. Names dropping off the channel and coming
back gets called what it is: the dust, not a fault. A call whose invites
never left your phone says it couldn't get through, because their link went
quiet, instead of blaming the person ("No answer"), and when they still
carry lo-fi voice it says the working alternative out loud: hold the
talk button. The walkie hint now leads with what to expect, which is that
some pairs of phones link at full quality and some always come through
rougher, and both carry your voice. A podmate you can talk to but not
video-call gets
that ceiling named instead of a silently missing button. The pod list
says reach is per-phone: two podmates can see different lists, and both
are right, because messages hop phone to phone.

**Video's honest limit, measured.** With no Wi-Fi anywhere, a video call
rings, tries, and says it couldn't get through: the video stream needs a
shared Wi-Fi (a hotspot with no internet behind it counts), and every
surface says so: README, site, in-app help, and the call's own ending,
instead of implying the walkie's no-network trick covers video too. Live
voice and voice notes are the no-network tools; carrying video over the
direct phone-to-phone link is the next frontier.

**iPhone: the talk button comes back.** A video call could leave the
iPhone's audio engine dead in a way it never noticed, so press-to-talk read
"no audio" and incoming voice played nothing while the
who's-talking chip showed. The engine now rebuilds itself the moment it
is found dead. And Settings grew a **microphone check**: one tap tries
every way the app can listen and reports which of them works, so a mic
bug gets diagnosed from a screenshot instead of a guess.

## 0.8.2: The pod gets a face (Aug 25)

**The walkie works without Wi-Fi.** Live voice used to need a shared
network, a camp router or somebody's hotspot, and on the playa that is the
thing you most often don't have. Now the pod finds its own way
through. Two phones with every network off talk to each other directly
(proven on two phones with no Wi-Fi at all), and where that path isn't
available the walkie drops to a rougher voice carried over Bluetooth
alone, marked **lo-fi** on the row so you know why it sounds like that.
Nothing about this is a setting: the app climbs to the best link it can
prove and falls back the moment that link goes quiet, and you stay in the
pod either way. The walkie is also much louder: incoming voice is boosted
on the way in, and it comes out of the **loudspeaker** on the volume rocker
you actually use, instead of whispering out of the earpiece.
The Bluetooth fallback is both-platform: an iPhone with no Wi-Fi
carries the same lo-fi voice beside Bluetooth-only Androids.


**Call a podmate, face to face.** A 📹 button beside each person in the
walkie places a **1:1 video call** over the pod's own link (signaling
rides the walkie's own frames, codec 0x6, which older builds drop silently).
Ring, answer or decline, hang up from either side, mute the camera, flip
it. There is
no server and no internet anywhere in it, and the picture quality climbs
on its own to whatever the link between your two phones can carry. If the
other person walks out of range the call ends with a sentence that says
so, instead of freezing. Hold-to-talk reads **ON A CALL** while a call has
the microphone; voice notes and pod messages are untouched.

**A call no longer says "no answer" when it was the link that dropped.**
Two phones can share more than one path, the camp Wi-Fi and a direct
phone-to-phone link at the same time, and when one of those quietly dies,
nothing announces it: the phone keeps handing packets to a road that is no
longer there. A call placed in those first seconds spent every one of its
attempts on the dead road and gave up, while the other phone never rang at
all. Now the app only offers a call over a link that has answered
recently, and if a call has to try again it takes the *other* road as well
as another turn. The person you are calling gets the ring on whichever
path is actually alive. Ordinary calls send exactly what they always did;
the second road is only for a try that already failed.

**Calls ring wherever you are.** A call used to reach you only if you
happened to be looking at the walkie. Now the walkie is on for the whole
app, not just for that one card: leave it on, go read the camp board or
walk the map, and a podmate calling you rings right there, with their name,
Answer, and Not now. Answering opens the call where you stand. Closing the
walkie's stage no longer hangs up the channel; the pod card's walkie row
is the honest on/off, and a small bar along the bottom tells you the radio
is on, who is on the channel with you, and turns it off in one tap, because
a walkie quietly eating your battery where you can't see it is not something
this app will do. Hold-to-talk still lives on the walkie's own stage, so
the mic is never a button you could lean on by accident. (A call still
needs the app open; ringing from a locked pocket is next.)

**Am I connected, and to whom.** The pod card now answers that in one
line, and tapping it opens the list: who is in reach, and what that
reach is actually good for: *voice*, *lo-fi voice*, *messages now*, *when
you pass by*, *notes keep*. It speaks in what you can do, never in
radio names, and a quiet podmate reads as a member who is quiet, not as
an error.

**Your pod's messages no longer wait for you to share your position.**
The only thing that ever switched the radio on was *Share my position*, so
two phones sitting a foot apart, both apps open, with that switch off, said
nothing to each other at all. Not slowly: not at all. Messages and
voice notes only move when phones notice each other, and with the switch
off no phone ever noticed anything. Now, whenever Playa Pal is open and
you are in a pod, your phone quietly carries the pod's mail. It says *a
podmate is here, ask me for messages* and **nothing about where you are**.
The switch does exactly what it always said it did, and only that: it adds
your position. Turn it off and your notes keep flowing; turn it on and
your pod sees which way and how far, unchanged. "You're quiet" now means
nobody can see where you are, rather than that your message is going
nowhere.
Waiting for a GPS fix no longer takes the mail down with it either. Mail
carrying is only while the app is open, so nothing new runs in your
pocket.

**And it arrives in seconds.** With the radio awake on both sides, a
message that used to take half a minute between adjacent phones now goes
straight over: the app was already dialling as fast as it could, while the
layer underneath it still made every phone wait out a thirty-second pause
between looks. Both halves now hold the same, much shorter pause, with the
same guard against a crowded camp turning that into a storm.

**Messages read the way messages read.** Pod mail was newest-at-the-top,
unlike every messaging app anyone has ever used. The thread now runs
oldest to newest with the newest at the bottom, opens there, and follows
new arrivals, unless you have scrolled up into the history, in which
case your place is kept and a **New messages** chip offers one tap back
down. Sending or recording always takes you back to the bottom. The
Angel's transcript had the same fault and got the same rule.

**A voice note that cannot play now says so.** A recording whose save
failed left behind a file with sound in it and no index: non-empty, the
right size, and unplayable by anything, which is how it passed every gate
and travelled across camp anyway ("prepare failed"). Recording now checks
the file itself rather than its size and refuses a broken take at the
moment it happens, with wording you can act on. One that arrives damaged
from an older phone is labelled honestly, with no play button, no duration,
and the reason on the row and read aloud with it. Tapping it says *ask them
to send it again* instead of playing silence.

**Swap cards by pointing a camera.** "We're together — swap cards" used
to open a share sheet full of nothing useful. It opens a swap panel now:
your card as a code to hold up, **Scan theirs** to take one, and **Send my
card** for someone who isn't standing there. And the app can finally
*read* a code: one photo, inside Playa Pal, with no trip out to the camera
app and back. A scanned card installs through the same importer a tapped link
uses, and a scanned pod invite still asks before it joins. Your phone's
own camera still works as before for anyone who doesn't have the app yet.

**Camp lore the Angel can actually cite.** A new bundled pack carries our
own credited summaries of veteran-burner talks, documentaries and camp
histories, covering the Temple, Rangers, art cars, gifting and how Black
Rock City really works, each one crediting the video it came from and
pointing you at the original. Culture and history questions had nowhere to land
before, so the Angel reached for near-misses; and it can no longer quote
the survival guide's own worked *example* as though it were a real event.

**4 GB iPhones stop crashing.** The Angel was wiring its whole model into
memory where iOS could never move it, and on a 4 GB phone the walkie's
audio buffers were the last straw, with crashes through setup and hard at
hold-to-talk. The app now reads the phone it is on and sizes the model's
footprint to it, taking the smaller footprint whenever it cannot tell.
Phones with memory to spare are unaffected.

**The Angel batch, composed** (first released here; see 0.8.1 below for
the detail). Two independent builds of the Angel's deterministic
answering merged into one and repaired under three rounds of adversarial
review.

Not yet proven on a phone, and stated plainly because the difference
matters: video calls, the Bluetooth voice rung, and photo-scanning a code
have unit coverage and have been read line by line, but no two devices
have carried a call, a lo-fi conversation, or a dusty scan between them
yet. Live voice over the phones' own direct link *has* been measured, both
ways, on two phones with every network off.

## 0.8.1: The Angel learns its own strength (Aug 25, rolled into 0.8.2)

Cut and version-stamped, but never released on its own: under the
one-train rule it rides to campers inside 0.8.2 above.

**The Angel batch, composed.** Two independent builds of the Angel's
deterministic answering, covering event authority, exact-title routing,
temporal clarification and camp history, merged into one, then repaired under
three
rounds of adversarial review (nine codex blocker batches, a 17-finding
Opus binding review, and a live device battery on both phones).

**Events answer like a schedule, not a search box.** Naming an event by
its exact title answers instantly and deterministically ("When is Morning
Coffee?", every occurrence, cards first); titles keep their own words
("Morning" is part of the name, never a time filter, and a title
containing "and" is never split in half); a time in your question is
honored ("yoga around 8pm?" finds the 8pm story, and answering "Tuesday"
to a follow-up keeps the yoga and the evening). A question about Burning
Man history goes to the guide rather than the schedule, and an imperative
"show me the bike rules" was never an event query.

**The camp board survives its own history.** A phone restored from backup
rejoins as itself instead of duplicating its board; conflicted copies keep
their notes readable but never leak them into camp fact or across camps;
replies survive any number of reinstalls.

**Honesty fixes.** A failed model import says so instead of going quiet; a
beam from the wrong camp says "wrong passphrase," not "delete a
campmate"; and the Angel never dresses a search hiccup as an
authoritative "nothing found."

## 0.8.0: Camp Mesh, consolidated (Aug 24)

**Pods.** Pick your people and your phones keep track of each other, with no
signal and no server behind any of it. Start a pod or join one with its code.
New codes are 4-digit PINs ("4207", typeable in gloves), and pods
made before this release keep their word codes, which still join. Flip
on sharing and podmates' rows go live when you're near: which way, how
far. It runs on Bluetooth between phones: an Android keeps sharing from
your pocket, an iPhone while the app is open. One switch in Settings
kills all of it.

**The pod is a shared thing now.** It used to be a private per-phone
object that happened to share a code: the name never travelled, and "0
people" counted a local pick-list while a podmate beaconed from two feet
away. Now the pod's name and its member roster gossip over the mesh, so you
join by code and both arrive as podmates pass in range, and while the
roster is still converging the app says so instead of asserting a total.
Joining the same code twice no longer mints a twin pod, and twins the
old bug already minted merge themselves.

**The answering machine.** Leave the pod a message, typed or held down on
the mic and spoken. It rides from phone to phone whenever podmates pass in
range, the way notes used to wait on the machine at home. Minutes to
hours, not instant, and the app says so instead of pretending. A spare
phone plugged in at camp becomes the mailbox that's always home.

**A pod you can hand over.** A pod used to be four digits read aloud, the
only shareable thing in the app you couldn't hand over by pointing a camera
at a screen. Now it has a QR and a link, and both carry the pod's
name and your card, so a joiner arrives knowing who they joined instead
of seeing a group named after a number. Scanning one asks before it
joins. No radio involved: it works with Bluetooth off, Wi-Fi off and no
signal.

**Mail that only went one way.** Playa phones have no cell and no NTP, so
two of them drift apart, and the mesh had been built as though they
wouldn't: a message was judged against the receiver's clock, which quietly
shortened every message that arrived and, past about a day of drift,
refused them all. A pod would sync in one direction with nothing on
screen able to explain it. Mail now travels as how long the sender said it
should live, not as a deadline two phones have to agree on.

**Walkie.** Hold to talk, live, to everyone in the pod on the camp's
Wi-Fi, and a hotspot with zero internet is enough. The mic runs only while
your thumb is down. And an empty channel now diagnoses itself: after ten
quiet seconds the walkie shows the subnet this phone is on, so when a
podmate's shows a different number you know the truth, which is two routers
sharing one Wi-Fi name, instead of "nobody else on the channel yet".
Live talk carries ten people; a bigger pod is pointed at voice notes
rather than having someone dropped without being told.

**Pods got their own tab.** The pod card sat two screens deep in Camp,
under the board feed. The bottom bar is now Now / Pods / Camp /
Settings, which puts the pod one tap from anywhere, with an unread badge
that counts only mail that actually arrived. Camp regrouped behind four
labelled panes, Board, Share, Knowledge and Friends, on a strip that
never scrolls away, and the tour grew a sixth card for the new tab.

**Dark mode.** System-matched or pinned, from Settings. Every label,
chip, scrim and map ink got both palettes, and a test now fails the build if
a future color forgets to.

**The Angel knows your plans now.** "When's that talk I saved" used to
get silence: the Angel could search events, camps, art and the guide, and
was blind to your own hearts and pins. Your faves and saved pins are now
a document it can find, rewritten on the phone whenever you heart
something, and it never leaves the phone. The survival guide, the art
directory and the camp register also carry precomputed search vectors for
the first time. That is groundwork, honestly labelled: the matching
embedder
model isn't in the app's download list yet, so today's answers still come
from the keyword search that already reads all of it.

**Sharing, sorted out.** A full audit of every share button found the
scatter was mostly right, since a share control belongs beside the thing it
shares, and almost everything stayed where it was. What changed is the
one place it was wrong. The door that takes things IN sat under "Camp &
private packs" with a pack-only name, though friend cards, camp beams and
camp notes all arrive through it; it now sits in a "Share & receive"
section that says so. "Share Playa Pal" appears there too,
rendered by the same component as the Settings row rather than a second
copy of it.

**Accessibility, most of the way.** Tap targets, labels, roles, color
contrast and the Settings layout got a sweep, and the states that spoke
only in color, the consent chips and the QR mode picker, now carry a mark
that reads aloud. Two known gaps ride into this release: the walkie's
HOLD TO TALK and the composer's mic are press-and-hold controls, which a
screen reader cannot work, and neither says that recording started.

**Under it all**: positions ride a 21-byte beacon carrying a keyed check
and the sender's own timestamp, so a captured one can't be altered
without the pod's code and can't be replayed as if it were live. What the
code is worth, plainly: it is four digits, and someone who captures a
beacon can recover it and read the pod. It is a code read aloud across a
table, not a password. None of this touches the internet. iPhones share while
the app is open, and a plugged-in Android carries the quiet hours.

## 0.7.5 (unreleased, rolled into 0.8.0)

Cancelled before it shipped; everything it carried rides in 0.8.0 above.

## 0.7.4: Every camp counts (Aug 24)

**The whole roster in the picker.** The setup camp picker drew from the
events list, so a placed, registered camp that hosts no public events, one
of which was spotted in the field within the hour, wasn't offered. The picker now
carries the full official register: all 1,184 placed camps with their
placements, unioned with every event-hosting camp, one row per camp,
alphabetical. Same data the camp guide documents already shipped; now the
picker reads it too.

## 0.7.3: Welcome home (Aug 24)

**A first hour that explains itself.** First launch now opens with a
30-second welcome: your name (optional) and your camp, picked from the real
2026 placement directory or typed freehand. Pick a placed camp and
Home lands on the map, "Take me home" works from night one, and your
shareable friend card starts pre-filled. Every field is optional, you never
type the same thing twice, and what you type stays on the phone. Then a five-card tour shows
the whole app in under a minute. Skip any of it; replay all of it from
Settings whenever.

**The way home, on every screen.** The header's map door becomes a live
arrow the moment the app knows where home is, pointing at your camp from
every tab. Without a home, a GPS fix or a compass it stays the plain map
door, and never a dead affordance.

**Pins you can keep.** The compass's new ✎ pin manager lists every saved
pin, Home first and then newest, each with its clock address and a visible
Remove. Long-press on a pin chip still works; now there's a way you can
find.

## 0.7.2: Faves (Aug 24)

**Heart it, plan it.** Requested by a campmate who plans her burn days
around workshops and food. Tap the ♡ on any event card, while browsing, in
search results, or on one of the Angel's chat answers, and it lands in
**♥ Faves**, one tap away on the Now tab: your lineup in time order,
grouped by day, with walk and bike times to each. Hearts are keyed to the
event itself, not the data file, so they survive every data update.

**The settled city.** Event submissions closed Aug 22 and the weekend's
approvals are in: 6,500+ event listings (about 800 more than 0.7.1),
every camp placement current, and the art register as it stands today.
Art locations still unlock in the guide automatically at Gate.

## 0.7.1: The real city (Aug 21)

The API key arrived, and with it the city as it will actually stand.

**Real 2026 placements.** Every event card now carries its camp's true
address: 5,300+ events with real clock addresses joined from the official
placement data, walk and bike times computed to the actual spot. No more
last-year's-address labels.

**The art of 2026, on board.** All 332 registered pieces ride along in the
app, with the artists' own descriptions, searchable and citable by the
Angel.
Locations stay hidden until Gate opens, exactly as Burning Man requires;
events hosted at art name the piece, never the spot.

**Search knows names.** Typing the exact name of a thing, "Man Burn" for
one, puts that thing first, above every party riffing on its name.

**Field lessons from two real phones.** The beam screens now say the two
things receivers actually need (make yourself visible in Quick Share; open
the file from Files), and sharing the app warns about the scary
Play Protect screen and names the small "Install anyway" escape.

## 0.7.0: Tap the file, it opens (Aug 20)

Beaming a camp board to a campmate used to end in a file they had to find.
Accept the file, open Playa Pal, go to Camp, tap "Import a pack…", hunt for
it in a picker. Five steps, and the picker was the worst of them. Now a
beam is a `.playapal` file and **tapping it opens Playa Pal and imports it**
from Files, Downloads, Quick Share, AirDrop, a share sheet, or a Signal
attachment. One receipt tells you what landed. If the app was killed
between the file arriving and you opening it, the beam is still there on the
next launch; nothing vanishes silently.

**Small boards are a QR code.** One button, "Beam the board", shows a QR
when the board fits in one; your campmate points their normal camera at
it and Playa Pal opens with the board. Neither phone has to pair, ask
permission, or agree on anything beforehand. A board too big for one
code goes out as the file instead, and the button says so.

**Hand the app itself to a phone that has none.** Settings → "Share Playa
Pal" sends the installed app over Quick Share to a campmate whose phone is
empty, byte-identical to the copy you are running. On playa nobody can
download anything; now they don't have to. (iPhones can't sideload; that
side is a TestFlight link once it is published.)

**The release is a third smaller.** 132 MB instead of 292, because the APK
carried emulator and 2015-era builds nobody on playa has. Less to push
through dust on a battery.

**Art has a photo now.** Logging a piece of art snaps a small picture, big
enough to recognise it and small enough that fifty of them still beam as one
file. The full-size photo stays on the phone that took it.

**iPhone ↔ Android, finally honest.** The two ecosystems will never agree
on a radio protocol. They do agree on files and on QR codes, and that is
what the beam rides. Any path that carries a file ends in a tap that
imports.

## 0.6.1: The map answers back (Aug 20)

The map arrived in 0.5.2 and it just sat there. You could look at Black Rock
City, but you couldn't tell it anything. Now you can touch it.

**Tap anywhere to aim.** Touch a spot on the map and the compass points at
it, named by its real address, as in "Map spot · 4:36 & G". Tap it again from the
arrow view and walk there.

**Hold and drag to place exactly.** A tap is fast but coarse. Press and hold
for a third of a second and the target lifts off your fingertip so your own
hand stops hiding the thing you're placing; drag until the address reads
right, then let go. That is how you put a pin on your camp's actual corner
instead of near it.

**Pinch and pan.** Two fingers zoom to 4x, one drags the city under you. The
map stays inside its own frame at every zoom.

**Your camp is a waypoint now.** Set your camp address on your card and Home
appears on the map without dropping a pin, as one camper put it: "the app should already know
where my home camp is."

**Tap a pin to pick it.** Your saved pins, your friends' camps, the Man and
the Temple answer a tap on the map itself, so there is no more hunting the
row of chips below and no more accidentally dropping a rival pin next to your
own.

### Fixed

- A tap while zoomed in landed centimeters from where you touched. The
  gesture layer already corrects for zoom; the app was correcting for it a
  second time.
- A press held between 0.22s and 0.35s did nothing at all, being too slow
  for a tap and too fast for a hold. Every press now lands as one or the other.
- The map flickered while zoomed, and again every five seconds while
  standing still: the whole city was being rebuilt on every gesture frame,
  and again on every GPS reading. It is now drawn once and moved.
- Long-pressing the map crashed the app on some phones.

## 0.6.0: Camp knowledge (Aug 20)

A camper asked whether their own knowledge could go into the app: the events
the guide missed, the lore only campmates hold. Now it can, typed
right in the app by anyone who knows the camp passphrase.

- **Add to camp knowledge**: a memory, an event the guide missed, a fix to
  a wrong fact, or a camp resource, typed in the app with no files and no
  formats to learn. Your own notes can be edited and removed, and a
  half-typed note survives closing the sheet.
- **Notes travel with the camp beam**: beam the board and the campmate
  boards and notes this phone carries ride along, integrity-checked with the shared camp
  passphrase (not encrypted, and the author name is a label rather than a
  verified identity, since the passphrase is the membership) and carried
  verbatim across hops, so one camper's notes reach a third phone through
  a second. The loop was driven end-to-end on two devices, in both
  directions, before this shipped.
- **The beam is a real file now**: sharing hands `camp-beam-<date>.json`
  to the system share sheet instead of pasting raw text (which most share
  targets refused), and a copy stays on the phone for re-sending later.
- **Notes are first-class knowledge**: they show up in search, in the
  reader as a live "Camp notes" document (a campmate's beam lands
  mid-read), and on the Now tab under their day when they carry a date.
  Search and reader passages carry the honest line "recorded by X;
  camp-passphrase verified, not authenticated"; event cards name who
  added them. Citing a fix right beside the exact fact it corrects is
  wired underneath and gets its fact-picker UI in a coming release; today a
  fix note reads like any other note.
- **The rough edges the two-tester loop caught, fixed**: profile saves
  speak ("You're set: Dusty · camp passphrase saved") and warn loudly when
  a changed passphrase would move you to a different camp; import dialogs
  name what the beam carried; hardware back walks the reader back to its
  contents instead of leaving the app; Save works on the first tap while
  the keyboard is open.

## 0.5.2: Listening to the first users (Aug 19)

The evening the app met its audience: two Pixels, a TestFlight cohort, and
a veteran playa builder's honest read.

- **Typing to the Angel works like a messenger**: the input and Send stay
  visible above the keyboard. They used to hide behind it, and the geometry
  was measured and fixed twice until it admitted no double-counting.
- **Downloads show themselves**: an in-flight model pull now reads
  "Downloading… 2.1 of 5.2 GB", then "Checking the download…", right on the
  model list. A 5 GB pull is no longer seven silent minutes.
- **The Boards heading tells the truth** (your own board is not a
  "campmate's"), and an unnamed board no longer titles itself
  "this phone (this phone)".
- **App-first framing everywhere**: the site and README now say plainly
  that every tool works with no AI installed and the Angel is the optional
  layer. The copy was de-flourished after real-user feedback.
- Playa Angel Max verified on both bench phones: resident on 16 GB
  (Pixel 9 Pro, instant replies), a documented squeeze on 8 GB.

## 0.5.1: Consent, the reader, and the Max Angel (Aug 19)

- **Friend cards carry their author's consent**: sharing asks "just for
  them" or "pass it on" at the moment of sharing (the pick is remembered
  and travels inside the card); only pass-it-on cards ride "Beam friends",
  and direct cards wear a "shared just with you" badge. This is honored by
  the app rather than enforced by cryptography, and the app says so itself.
- **The pack reader**: read the saved source materials straight through,
  from the contents page to the full document with credited section
  breadcrumbs, fully offline. No question is needed first.
- **Playa Angel Max**: the first zero-contradiction Angel on our
  31-question corpus battery (v4.4g, a Gemma 4 E4B fine-tune) joins the
  catalog as a new top tier for high-memory phones. The phone-fit
  recommendation stays measured and honest, verified by squeezing the
  5.15 GB model onto an 8 GB Pixel 7 (it answers, slowly, as warned).

## 0.5.0: The social city (Aug 19, first public release)

The release candidate that rides to the playa.

- **Friends on playa**: share a friend card (playa name, camp, address,
  find-me note) as a QR any normal camera scans, a share-sheet file, or
  "Beam friends", which re-exports every card you hold so one organized
  camper can assemble a whole crew's map at a pre-party. The card travels
  inside the link itself; there is no server, address book, or account
  behind it. A printable paper list is included, in BurnerMap's honored
  tradition.
- **The offline city map**: Black Rock City drawn from measured geometry,
  with streets (Center Camp keyhole and all), plazas, toilet banks, your
  pins, your friends, and your blue dot, plus a compass mode. It needs no
  tiles and no network.
- **One coherent app**: three tabs (Now · Camp · Settings); the Angel became
  a full-screen conversation opened from anywhere; packs found their homes.
- The real **2026 city geometry** went live (GIS-confirmed radii, real
  street names, per-number provenance); daily events say "Daily" instead of
  masquerading as one-day listings; "Don't use this" curation with restore;
  an About section; the contributor doorway finalized (authoring spec +
  stdlib pack doctor + embeddings builder); and an honest disclosure: the
  whole app is AI-written under human direction.

## 0.4.0: The trained Angel and the field kit (Aug 17–18)

- The **whiteout compass**: offline GPS to a Black-Rock-City address, one
  giant arrow with clock-phrase directions, dropped pins, "Take me home",
  nearest-toilets, and rough walk times on every event card.
- The Angel got schooled: an open **model catalog** with a device-aware
  chooser (memory-fit measurement, digest-pinned downloads), retrieval
  ranking rungs, disciplined tool-round thinking budgets, and an evaluation
  instrument carrying the owner's own scoring bar.
- iOS cracked: React Native 0.87's removed-bridge era survived via upstream
  patterns; the app runs on a 4 GB iPhone 13 mini.

## 0.3.0: Facts over vibes (Aug 15–16)

- A **fact graph** under the packs (transactional node/edge storage, a query
  engine, provenance-carrying edges), the roots of the lineage view.
- Engine hardening (FTS5 everywhere, durable storage paths) and the
  training program stood up: three audits over every fact in the corpus
  before any fine-tune was allowed to touch the model.

## 0.2.0: Camp life, on day two (Aug 14)

- The **camp board**: gifts and needs shared phone-to-phone as sealed beams
  (HMAC over a shared camp passphrase, per-writer versioning, conflict
  copies preserved, multi-hop gossip), designed, built, and
  device-verified in a day.
- The survival guide grew its credited layers (official material summarized
  with sources; the Burn.Life veteran-technique layer credited per-article),
  and pack import tooling landed.

## 0.1.0: An Angel in your pocket (Aug 13)

- Day one: a React Native app with a fully local LLM (llama.rn + GGUF),
  SQLite with FTS5, data packs, the Right Now event surface, the
  conversation loop with local search tools, and spoken replies through
  the phone's own offline voice, because hands are for bikes.
