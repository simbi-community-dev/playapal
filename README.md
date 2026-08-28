# Playa Pal

**A companion for Black Rock City that works with the network switched off,
going to its first burn as an experimental beta.**

There is no signal on the playa, and there is no server behind this app.
Playa Pal is one React Native app that runs entirely on the phone in your
hand: the 2026 event guide, a survival manual you can read straight through,
the city map, a whiteout compass, your camp's board, your friends, and a
**pod** of phones that find each other, carry mail, and talk out loud with
no network between them.

Ask it anything and the **Playa Angel**, a small open model fine-tuned on
these same guides and living on the phone, answers from what is stored there
and shows you the rows she read. Everything above worked before she was
installed and works if you never install her.

**Version 0.9.0 is an experimental beta.** The first commit landed on
Aug 13, 2026, and the app is driving to Black Rock City two weeks later with
more features than certainties. Pods, live voice between phones with every
network switched off, video calls, mail that hops from pocket to pocket,
mentions that buzz, an Angel who answers out of the guide in your hand: all
of it works on a workbench, and some of it has never left one. A workbench
cannot tell you what happens at 4am with dust in the ports and ten thousand
phones in the same square mile. Campers are the field test. Take it out
there, use it hard, and tell us what survived.

> This app is not affiliated with, endorsed by, or verified by Burning Man Project.

> **Get it:** Android, [playapal.apk](https://github.com/simbi-community-dev/playapal/releases/latest/download/playapal.apk),
> a stable link that always serves the newest release. iPhone,
> [TestFlight](https://testflight.apple.com/join/V3fD1rSd). The walk-through
> for both, including the two dialogs Android will throw at you, is in
> [*Getting it on your phone*](#getting-it-on-your-phone) below.

---

## What to try, and what to tell us

The parts of this app we know least about are the parts that need two
phones, a camp, and a week of dust. If you can spend an hour on it, these
are the reports that would teach us the most:

1. **Start a pod with the people in your tent** and leave the app open for
   an afternoon. Do the roster rows agree with where everyone actually is?
2. **Hold the walkie button** from one end of camp to the other, then from
   deep playa back. Where does the voice stop carrying, and what did the row
   say the link was when it stopped?
3. **Leave pod mail for someone who is asleep**, then find out how long it
   took to reach them once you both moved around.
4. **Type `@theirname`** and check whether their pocket actually buzzed.
5. **Ask the Angel what you would ask a veteran**, then read the guide
   passage she cites. A wrong answer you can show us is worth more than ten
   right ones.
6. **Drop a Home pin the hour you arrive** and use **Take me home** in the
   dark. That is the one feature nobody should be debugging at 4am.

Send what happened to
[GitHub issues](https://github.com/simbi-community-dev/playapal/issues) when
you have signal again, or hand it to whoever at your camp installed this.
The phone, what the screen said, and what you expected instead is plenty.
Please never attach chat logs, camp beams, or passphrases.

## The Angel knows the whole city, in airplane mode

Open the 🪽 Angel from any tab and ask in plain words. "Any pancake
breakfasts tomorrow?" "How much water per person?" "Where's the Temple?"
Every word of the answer is generated on the phone, and nothing you ask
leaves your hand.

She is not the database, and that distinction is the whole design. When a
question needs a fact, she calls a local search tool; the answer comes back
as **structured cards built from database rows**, with the guide passages
she retrieved shown underneath. If a card and a sentence disagree, the card
is the one that was checked.

What she can read, all of it stored on the phone and installed on first run:

- **The 2026 event listings:** 6,500+ of them, with dates, times, camps,
  locations and descriptions. Repeating listings say so ("Daily ·
  14:00–16:00") instead of masquerading as one-day events.
- **The survival guide:** safety, logistics, principles and practical
  field information, split into searchable passages.
- **A veteran-technique layer** summarized from **Burn.Life** and credited
  to **Dr. Yes**, kept separate from official Survival Guide text.
- **Playa lore:** our own credited summaries of public talks,
  documentaries and camp histories: the Temple, Rangers, art cars,
  gifting, how the city actually works. Each one names the video it came
  from and points you at the original.
- **The camp register and art directory:** all 1,184 placed camps, and
  every registered 2026 piece in the artists' own words. Art *locations*
  stay sealed until the gate-time embargo lifts.
- **Your own camp's docs**, if you bring them. See [*Add your own camp
  data*](#add-your-own-camp-data).
- **Your plans.** Faves and saved pins are a document she can search, so
  "when's that talk I saved" has an answer. It never leaves the phone.

Answers can be read out loud through your phone's own offline voice, which
keeps your eyes on the dust instead of the screen. **Do the voice setup at
home**, which [*Spoken replies*](#spoken-replies) walks through; some device voices are
cloud voices and go silent exactly when you need them.

## Your pod, and phones that make their own networks

A **pod** is your people. Start one, or join by its four-digit code or its
QR. No signal is involved at any point, and it works with Bluetooth off,
Wi-Fi off, in a hangar, in a dust storm. Flip on sharing and podmates' rows
go live: which way, how far, live when you're near, last-known otherwise.

**The pod page has four rooms**, on the same chip strip the Camp tab already
taught your thumb: **People · Mail · Walkie · Setup**. One concern per
screenful: the roster, the answering machine, live voice and calls, and the
invite codes plus camp gear. It opens on **Mail** when mail is waiting, with
the unread count riding the chip, and on **People** otherwise. It used to be
one long scroll, and everything below a busy mailbox was effectively
unreachable.

Then the phones start talking to each other.

**Hold the button and the pod hears you.** The walkie is live voice with no
network at all. Two Androids build their own direct phone-to-phone link and
sound clean with every network off, measured both ways on two phones
joined to nothing at all. Where that link isn't available the voice still
carries over Bluetooth, rougher, marked **lo-fi** on the row so your ears
aren't surprised. Any shared Wi-Fi lifts every pair at once, a hotspot with
no internet behind it included. Incoming voice is amplified and comes out of
the loudspeaker on the volume rocker you already use, and the microphone is
open only while your thumb is down.

**A 1:1 video call, over two different roads.** Put both phones on any
shared Wi-Fi and the call carries, an iPhone and an Android included,
measured between the two. Or, for two iPhones that have done **Link iPhones
directly** (a one-time six-digit pairing in the walkie), the call carries at
full quality **with no Wi-Fi at all**, because the linked phones talk
straight to each other. There is no server and no internet anywhere in it: the media
layer is WebRTC with an empty ICE server list, so the only candidates that
can exist are host candidates on interfaces the two phones share. There is
no relay, and no configuration in which a call could acquire one.

**And when there's no Wi-Fi to be had, one Android makes it.** Flip on
**Camp hotspot** in your pod's **Setup** and one phone hosts a no-internet Wi-Fi that
everyone else joins by pointing a camera at the code on screen, and an
iPhone offers to join straight from the stock Camera app. Fourteen distinct things
can go wrong when a phone tries to host a network, and each one says its own
honest sentence instead of a shrug.

You are never asked to pick a radio. The app starts with what always works,
climbs the moment a better link proves itself, and drops back quietly when
it goes away.

### How the pod stays connected

Positions, mail, live voice and video all ride **one wire format over
several radios**, so a missing radio costs fidelity and never costs
membership. The rungs, cheapest first:

| Rung | Carries | Radio | Needs |
|---|---|---|---|
| 0 | An invite, or a card | none: a QR held up, or one scanned | a camera |
| 1 | Presence (a 21-byte signed beacon) | Bluetooth LE advertisement | nothing |
| 2 | Pod mail: text and voice notes, store-and-forward | Bluetooth LE | nothing |
| 3 | Live voice, lo-fi | Bluetooth LE | nothing |
| 4 | Live voice, hi-fi, and video calls | the phones' own direct Wi-Fi link, or any shared Wi-Fi | Wi-Fi Aware, or a router/hotspot |

Two rules keep it honest. A phone announcing that it *has* a radio proves
nothing, so a peer starts at the floor and only moves up after a round trip
on the higher rung is observed, and falls back immediately, with no
ceremony, when that link goes quiet. And a rung that carries less is not a
worse citizen: pod mail is a peer of live voice, not its fallback, because
most of the time the person you are messaging is asleep or across the city.

The wire format does not change per rung. What changes is the codec of the
payload and the socket it rides. A receiver that does not recognise a version or a
codec id drops the frame, which is why an older build is simply blind to a
newer feature rather than noisy about it. Video signalling uses that same
extension point.

**Reach is per-phone, and the app says so.** Two podmates can see different
lists and both are right, because mail hops phone to phone. Every one of
these radios carries across a camp rather than across a city: Bluetooth
reaches the least, the phones' own direct link maybe three to five times
further, and a crowd of bodies between two campers costs more than either.
Those are link budgets read off the radios' own published numbers, not
measurements we made, which is why the app ranks a podmate by what has
actually answered rather than by what a radio is supposed to do.

## Mail that waits for people

Not everything is a conversation you are both awake for. The pod's
**answering machine** carries typed notes and held-mic voice notes from
phone to phone whenever podmates pass in range, the way notes used to wait
on the machine at home.

- **Seconds** when two phones are near with both apps open. **Minutes**
  when one is pocketed. **However long it takes to walk past each other**
  otherwise. The app tells you which of those you are living in rather
  than implying the fastest.
- **Nothing is lost while you wait.** A message sits on your phone until it
  has somewhere to go, and any pod phone that passes by physically carries
  other people's mail onward without ever showing it.
- **A spare phone plugged in at camp keeps the mailbox.** No special mode:
  it just never leaves.
- The thread reads oldest-to-newest with the newest at the bottom, opens
  there, follows new arrivals, and keeps your place if you have scrolled
  back into the history.

**Type "@kupo" and Kupo's phone buzzes.** A message naming someone earns
the loud surface on their phone: the sender's name, their words, and its
own line in that phone's notification settings, so a camper who lets
mentions through Do Not Disturb gets the one buzz they meant to allow
rather than "a message came in". There is no push
server out there: the buzz is minted by the *receiving* phone the moment
the message comes off the mesh, so it lands when the mesh reaches them,
which is seconds if you are standing together and the next radio meeting if
you are not. Typing `@` offers the pod's roster to pick from. One buzz per
arrival, never a rattle. Notifications live in one Settings row that opens
your phone's own per-app page, because the OS already has the switches and
a second set in here could only drift out of agreement with the first.

**A call rings wherever you are in the app.** Leave the walkie on, go read
the camp board or walk the map, and a podmate calling you rings right
there, with their name and a way to answer. A bar along the bottom shows
the walkie is on, names who is on the channel, and turns it off in one tap,
because a radio quietly eating your battery where you cannot see it is not
something this app will do.

## The city in your pocket

- **What's happening now, and all week.** Browse or search by date, time,
  camp, location and description. Tap the ♡ on any event card, while
  browsing, in search results, or on one of the Angel's answers, and it
  lands in **♥
  Faves**: your lineup in time order, grouped by day, with walk and bike
  times to each. Hearts key to the event itself, so they survive every data
  update.
- **The whiteout compass.** Every located event links to one giant arrow,
  the distance, and clock-address directions from wherever you stand. Drop
  a pin at your camp, or at anything else, and **Take me home** works
  through a 3am whiteout with zero connectivity. The ✎ pin manager lists
  every pin you have saved, Home first.
- **The whole city, drawn offline.** The 🗺 map renders Black Rock City from
  measured geometry: streets, Center Camp, the Man, the Temple and toilet
  banks, drawn with your blue dot, your pins, the active waypoint and your
  friends' camps. It is a few kilobytes of math, so there is nothing to
  download. Tap to aim, long-press to place, pinch and pan; pins and
  landmarks answer back.
- **Your friends.** Share a **friend card** (playa name, camp, address, a
  find-me note) as a QR anyone's camera can read, or as a file over
  AirDrop or Quick Share. The payload lives inside the link itself, so it
  never touches a server. Take someone's card by scanning their code
  **inside the app**: one photo, decoded on the phone. Friends' camps link
  to the compass, show walk times, plot on the map, and export as a
  printable paper list.
- **The camp board.** An offline board for gifts, needs, replies and
  completion updates, shared as a file through the system share sheet
  ("Beam the board") and imported through the same door.
- **Person cards and camp knowledge.** Ask about a person and the Angel
  resolves the identity first, then retrieves the card linked to it, so
  you never get a guess dressed as a fact. In-app notes (memory, event, fix,
  resource) ride the sealed beam with the board.
- **Set things aside.** Long-press a person card, event card or source
  passage to tell the Angel "Don't use this"; restore anything from
  Settings › Hidden.
- **A first hour that explains itself.** First launch is a 30-second
  welcome that asks your name (optional) and your camp, picked from the
  real 2026 placement directory, and then a five-card tour. Skip any of it; replay all
  of it from Settings.
- **Light, dark, or match the phone**, every surface carrying both palettes
  and a build test that fails if a future colour forgets one. Plus a
  **text size** dial in four steps for sun-blind eyes, and a circled **?**
  on every screen that keeps the tiny print one tap away instead of in
  your way.

## Honest by design

This is the app's character, not a disclaimer at the bottom of it. Out
there, a tool that overstates itself is worse than one that does less.

- **The roster never lists a phone it cannot reach.** A peer appears only
  after a round trip on that link is actually observed. A podmate whose
  link goes quiet reads **(quiet)** rather than "lo-fi", which would
  promise live audio over a link that has none, and one sentence says your
  voice may not be reaching them while messages still go.
- **A button that could never work is not drawn.** A podmate reachable only
  over Bluetooth has **no call button**, on purpose, and the reason is
  named where you can read it.
- **Failures say their reason.** A call whose invites never left your phone
  says it couldn't get through, because their link went quiet, instead of
  "No answer", and it names the thing that *does* still work: hold the talk
  button. "Nobody in range" is an answer, not an error. A beam from the
  wrong camp says "wrong passphrase", not "delete a campmate". Fourteen
  ways a hotspot can refuse to start have fourteen sentences.
- **Damage is named rather than played.** A voice note whose save failed
  (the right size, real bytes, no index, unplayable by anything) is refused
  at the moment of recording. One that arrives damaged from an older phone
  wears "Voice note · won't play" and the reason, and tapping
  it says *ask them to send it again* instead of playing silence.
- **Speed is never promised.** Mail says which of seconds, minutes, or
  next-time-you-pass you are living in. The mention copy says the buzz
  lands "when the message reaches it", and the words *instantly*, *right
  away* and *immediately* are banned by a test.
- **Downloads are verified before they are used.** Every model file is
  checked against its published SHA-256 before it is ever loaded, so a
  torn or tampered file is refused rather than half-used.
- **The limits are written down twice**, in the two registers that need
  them: [*Project status*](#project-status) for whoever ships this, and
  [*The same limits, in camper words*](#the-same-limits-in-camper-words)
  for a person standing in dust. That second list is also in the app, at
  Settings › Help & about › **How Playa Pal works**. A test holds the two lists in
  step.
- **Nothing is reported anywhere.** Not usage, not questions, not even
  crashes. There is no account and nothing to mine.

The model, event search, guide retrieval, and camp data operate on device.
User-initiated sharing and the device's selected speech engine are separate
platform features; some system voices may require a downloaded or
network-backed voice pack.

## Getting it on your phone

**Android.** The newest release-signed APK is always at
[playapal.apk](https://github.com/simbi-community-dev/playapal/releases/latest/download/playapal.apk),
a stable link that follows the latest release. Every version stays on the
[releases page](https://github.com/simbi-community-dev/playapal/releases).
Android challenges any sideload twice: **"Allow from this source"**, then
Play Protect's **"Install anyway"**, hidden behind **More details** while
the big filled button cancels. The plain-language walk-through lives at
[playapal.lol/#get](https://playapal.lol/#get).

**Updates, without a store.** Settings carries a **Check for update** row:
it asks the release page, and if a newer build exists it downloads it and
hands it to Android's installer. Nothing happens until you tap it, because
a phone with no signal must not spend its battery on a lookup nobody asked
for.
[Obtainium](https://github.com/ImranR98/Obtainium) pointed at this repo
delivers updates the way a store would, if you would rather it be automatic.

**iPhone.** Playa Pal ships to testers through TestFlight: join the public
beta at [testflight.apple.com/join/V3fD1rSd](https://testflight.apple.com/join/V3fD1rSd).
TestFlight updates testers on its own.

**From the phone next to you, with no internet at all.** Any Android that
has Playa Pal can hand over the whole app: **Settings › Share Playa Pal**
copies its own installer and passes it through the share sheet. On the
receiving phone, skip the transfer popup's own "Open", which sometimes
launches the wrong app, and open the file from **Files › Downloads**
instead.

In-app model downloads use public, checksum-pinned files from the Playa
Angel model repository, and need a network exactly once (see [*Get a
model*](#get-a-model)).

---

## How answers stay grounded

Playa Pal does not use the language model as the event database.

1. The app stores events and guide passages in SQLite on the device.
2. The Angel chooses a local search tool when a question needs factual data.
3. Date and time constraints are parsed from the user's original message.
4. Structured event cards come from database rows, not generated prose.
5. Retrieved guide passages are shown alongside the answer.

Search uses SQLite FTS5 with BM25 ranking when available and falls back to ordinary SQLite queries when FTS5 cannot be initialized.

A local model can still misunderstand a question, skip retrieval, or generate an unsupported detail. Treat structured event cards and quoted pack passages as the grounding sources, and verify safety-critical information against official materials.

## Spoken replies

With **Speak answers out loud** on (Settings tab), the Angel reads replies
through the selected device speech backend; no cloud service or extra model
is involved. Recognized greetings may speak sentence by sentence as they
generate; document-backed answers stay buffered until completion confirms no
retry is needed, then are released for speech. Tool-selection rounds stay
silent; markdown and emoji are stripped before synthesis, and event cards
are spoken in a fixed shape: "Title, day, date, time, at location". Every
assistant bubble also carries a speaker button that works regardless of the
toggle. Speech stops when you send a new question or leave the chat.

**Do this on wifi before you leave for the event.** Some device voices are
CLOUD voices: they simply fall silent once there is no signal, which is
exactly when this app is meant to be useful. In Settings, pick a voice badged
**offline** (the picker lists those first). If none are badged offline, tap
**Get offline voice data…** to open the system voice-data installer and
download your language's offline pack (on a Pixel: Settings → System →
Keyboard → Text-to-speech → Google engine → Install voice data). Then prove it
by turning on airplane mode and tapping **Hear a sample**. A voice that works
at home and not on the playa is the failure this step exists to prevent.

## Get a model

Playa Pal does not bundle model weights. The app offers two ways to get one:

**1. In-app download (the normal path).** The chooser ("Choose or download a
model", in Settings and in the Angel conversation's model bar) lists the model catalog, measures your
phone's memory and free space, and marks what fits with one recommended entry.
Downloads are digest-verified before they are ever loaded, so a torn or
tampered file is refused rather than half-used. A network connection is
needed once, at download time; everything runs offline afterward.

| Tier | File | Size | SHA-256 |
|---|---|---|---|
| **Playa Angel Max** (deepest answers, 10 GB+ RAM phones) | `angel-max.gguf` | 5.2 GB | `5a6b4d85cb8da811f04496498c3302772339e20914adebff4d4718b348f73c53` |
| **Playa Angel** (best answers) | `angel-smart.gguf` | 1.6 GB | `653c7ee3e7e95468516574350b0cfacbadb4609bf56d8789e452f9b1297e0bb4` |
| **Playa Angel Light** (fastest) | `angel-light.gguf` | 1.4 GB | `f5fb59a0db7039f4c485f82f6d448e2126d3923b5bee1ac411b5aea67c85de31` |

All three are project fine-tunes, hosted at
[huggingface.co/davidryalpug/playa-angel](https://huggingface.co/davidryalpug/playa-angel)
(public at release), and they do **not** share one base model:

- **Playa Angel** and **Playa Angel Light** are the same fine-tune of
  LiquidAI's LFM2.5-2.6B at two quantizations: Q4_0 for the smart tier and
  Q3_K_M for the light one. They carry the **LFM Open License v1.0**
  inherited from that base model. Note its annual-revenue condition on
  commercial use, which applies to these derivatives too.
- **Playa Angel Max** is a fine-tune of Google's **Gemma 4 E4B** (Q4_0),
  which Google releases under the **Apache License 2.0**, so that tier
  carries Apache 2.0, with the modified-file notices Apache §4 requires for
  weights changed by fine-tuning and quantization. (Earlier Gemma
  generations ship under the Gemma Terms of Use; those terms scope
  themselves to those generations by their own appendix, and reading them
  onto Gemma 4 was an error corrected on 2026-08-24. The per-file detail
  is in [`NOTICE`](NOTICE).)

Each model's card, LICENSE, NOTICE, and `SHA256SUMS` ship in that
repository. The catalog in `src/llm/modelCatalog.ts` is the single source of
truth for what the app offers, and adding a community model is one object
literal (see the file's header).

**2. A file on this phone.** The same chooser accepts any local `.gguf` via
the system document picker (or `adb push` to the app's files directory as
`model.gguf` for development). The picker checks the extension; the runtime
decides whether architecture, quantization, chat template, and memory actually
work, so do not assume arbitrary GGUF models will.

The app remembers the model across launches. The model is a conversational
and tool-routing layer, not the authoritative source: event times, locations,
and safety facts come from the local data packs when retrieval succeeds, and
answers cite what they retrieved.

The app also sizes the model's memory footprint to the phone it is on: below
roughly 6 GB of total RAM it halves the context window and leaves the
weights pageable, and it never pins them on iOS, where the Metal backend
keeps its own resident copy. A phone whose RAM it cannot read is treated as
the constrained case, since the safe direction is a smaller footprint and
never a crash. This is what stopped 4 GB iPhones being killed by the OS mid-session.

## Built-in data

Playa Pal installs these local packs on first run:

- **Black Rock City 2026 events:** dates, times, titles, descriptions, camps, and locations for local browsing and search.
- **Survival guide:** safety, logistics, principles, and practical field information split into searchable passages.
- **Playa lore:** the project's own summaries of public talks, documentaries and camp histories, covering the Temple, Rangers, art cars, gifting and how the city works, each crediting its source video by uploader, title, URL and date, and pointing the reader at the original. These are summaries *about* what a talk says, never its words; the transcripts themselves are neither shipped nor redistributed. Provenance in [`NOTICE`](NOTICE).
- **Camp register and art directory:** the placed camps of the city, and every registered 2026 piece in the artists' own words. Art *locations* stay sealed until the gate-time embargo lifts.

Built-in (public) packs are managed under **Settings › Public packs**; camp and private packs live on the **Camp** tab. Searches include enabled packs only.

## Add your own camp data

**[`PACK-FORMAT.md`](PACK-FORMAT.md) is the authoritative authoring spec**, and
`tools/check_pack.py` (the "pack doctor", stdlib-only Python) validates a pack
folder before anyone imports it:

```sh
python3 tools/check_pack.py my-camp-pack/
```

Optionally, `tools/build_pack_embeddings.py` adds semantic-search vectors to a
built pack; it chunks documents exactly as the app will.

The short version: a data pack is a manifest plus one or more event or document files:

```text
my-camp-pack/
  pack.json
  events.json
  schedule.csv
  handbook.md
  notes.txt
```

Only `pack.json` and the files you want to import are required.

### Manifest

```json
{
  "id": "my-camp-pack",
  "name": "My Camp 2026",
  "description": "Our schedule and handbook.",
  "version": 1
}
```

Manifest rules:

- `id` uses lowercase kebab case and is 2–64 characters long.
- `name` is required.
- `version` is an integer.
- Re-importing the same pack ID replaces that pack's events and document passages while preserving whether the pack is enabled.

### Event JSON

Event JSON files contain an array of objects:

```json
[
  {
    "title": "Pancake Gift",
    "desc": "Bring a plate and cup.",
    "date": "2026-08-31",
    "time_start": "09:00",
    "time_end": "11:00",
    "camp": "My Camp",
    "location": "4:30 & Esplanade"
  }
]
```

Each event requires `title` and an ISO `YYYY-MM-DD` `date`. Optional fields are `desc`, `time_start`, `time_end`, `camp`, and `location`. Playa Pal derives the weekday from the date.

### Event CSV

CSV files require a header row and at least one data row. Use the same field names as the JSON format:

```csv
title,desc,date,time_start,time_end,camp,location
Pancake Gift,Bring a plate and cup.,2026-08-31,09:00,11:00,My Camp,4:30 & Esplanade
```

### Documents

Markdown and plain-text files become local searchable passages. Headings are preserved as context so an answer can identify where a passage came from.

### Import a pack

1. Open the **Camp** tab.
2. Tap **Import a pack…** (under "Camp & private packs").
3. Select `pack.json` and all content files together.
4. Review any validation warnings.
5. Camp and private packs are managed right there; public packs under Settings › Public packs.

Zip import is not implemented. Multi-file import through the system document picker still requires release verification on physical Android and iOS devices.

## Camp gifts and needs

The **Camp** tab is an offline board for gifts, needs, replies, and completion or retraction updates. Camp boards are shared as files through the system share sheet ("Beam the board") and imported through the same **Import a pack…** button on the Camp tab.

Camp beams use HMAC-SHA256 with a shared camp passphrase to detect modification and separate one camp's board from another. This is a pilot integrity mechanism, not secure messaging:

- beams are not encrypted;
- anyone with the passphrase can read the board and claim any display name;
- a captured beam can be used for offline passphrase guessing;
- there is no membership service, device revocation, or per-device public-key identity;
- conflicting copies may require manual cleanup.

Do not post information that would be dangerous if a beam file, passphrase, or phone were lost or shared.

## Friends on playa

The Camp tab carries your **friend card** (playa name, camp, address, note)
and the cards you've collected. Sharing is strictly phone-to-phone: a QR code,
the share sheet, or "Beam friends", which re-exports the cards
you hold so one organized camper can assemble a crew's map at a pre-party and
pass it on. Each card carries its author's edit counter; re-imports keep the
newest and report older copies as stale.

Codes go both ways. **"Scan their code"** takes one photo inside Playa Pal
and decodes it on the phone. No native scanner was added: the picture goes
through the same picker art photos already use, and the decode is plain
JavaScript, which is also why it can be tested off a device. The scanned
text reaches the same single URL handler a tapped link does, so a card
installs through the one importer and a pod invite still asks before it
joins. The **system camera** path is untouched and remains the door for a
phone that does not have Playa Pal yet; both work in airplane mode. In a
pod, **"We're together — swap cards"** puts both halves in one panel: your
card as a code to hold up, and "Scan theirs" to take one. What a device
still owns is optics: focus, glare, dust, a phone held at an angle.

Sharing a card asks the author one question: **"just for them" or "pass it
on"?** "Pass it on" cards ride "Beam friends" onward; "just for them" cards
stay between you and the person you handed them to: the app skips them in
gossip exports and badges them in your list ("shared just with you"). The
pick is remembered as your next default. Like the camp beam, this is an
honor system, not cryptography: the receiving app respects the bit, but
anyone can retype a card by hand, so share what you'd write on a note board.
Cards are not signed or encrypted; the trust model is that you accepted the
file from the person who handed it to you (the camp beam's posture; see its
pilot notes above). Cards made before this choice existed behave as "pass it
on", exactly as they always did.

## Privacy and local data

Playa Pal does not require an account. App data stays in local application storage unless you explicitly import, export, or share a file.

The app stores full conversation records locally, including user messages, assistant responses, tool calls, tool results, and timing metadata. Automatic retention is limited to approximately 90 days or 20 MB, pruning older records first.

The Settings screen can export conversation JSON through the system share sheet. Treat those exports as private: they can contain complete conversation text, camp information, model metadata, and diagnostic timing data.

One thing goes out by itself, and only to your pod: while the app is open,
your phone says *someone in this pod is nearby, ask me for messages* over
Bluetooth. That is how mail moves without anyone tapping anything. It
carries no position, and where you are goes out only while you have position
sharing switched on for a pod.

Pre-release builds may also write search queries and model tool arguments to platform diagnostic logs. Do not enter sensitive information in development builds, and remove or redact detailed production logging before distributing a release build.

Android application backup is disabled. Lost-device behavior, iOS backup behavior, exports, platform logs, and manually shared files remain part of the user's security boundary.

## Data provenance

The application source, event listings, guide text, technique summaries, and model weights are separate works and may have different licenses or redistribution terms.

### Burning Man event listings

The 2026 event pack is derived from publicly available event listings published by Burning Man Project (BMorg). The current checked-in pack was generated from the public Playa Events website on **2026-08-13**.

The pack is provided for offline search and schedule browsing. It does not imply endorsement, verification, or affiliation. Before public redistribution, the project must confirm and document the applicable event-data terms, required attribution, disclaimer language, retrieval date, source URL, and generated-pack checksum.

Future pack releases may use a different published source, such as a yearly machine-readable dataset. Each generated pack must identify its actual source rather than inheriting provenance language from an earlier release.

### Official survival and principles material

The survival pack includes material derived from Burning Man Project's public survival, logistics, safety, and principles resources. That source material remains subject to its own copyright, trademark, attribution, and redistribution terms.

A public release must include exact source links, retrieval dates, transformation notes, and any required notices. The Playa Pal source-code license will not relicense this material.

### Burn.Life technique layer

The survival pack contains a separately identified veteran-technique layer summarized from **Burn.Life** and credited to **Dr. Yes**. This material is not presented as official Survival Guide text. The generated corpus preserves source links, creator attribution, and a **2026-08-14** retrieval date.

Attribution is not a license. Public redistribution requires confirmation of the terms that apply to the summaries and their source material.

### Angel model

Angel is a set of project-specific fine-tunes tested with Playa Pal, over two different base models: Gemma 4 E4B for the Max tier, LFM2.5-2.6B for the other two. They therefore carry two different licenses, per file; see [`NOTICE`](NOTICE) and the tier table above. Model weights are not stored in this repository. The model download, checksum, model card, base-model license, fine-tune license, and training-data provenance must be published alongside any public weight release.

---

## Build it yourself

### Requirements

#### Common

- Git
- Node.js **22.23+, excluding 23 and 25** (React Native 0.87 does not support them; the `engines` field enforces this). 22.23.2 and 24.3 are the tested versions; 22.13–22.22 ship a `node:sqlite` without FTS5 and fail 98 tests.
- npm
- A phone or emulator with enough storage and memory for React Native and a roughly 1.7 GB quantized model

The project does not yet publish a minimum-RAM device matrix. A `.gguf` extension alone does not guarantee that a model is compatible or that a device can load it.

#### Android

- JDK 21
- Android Studio or command-line Android SDK tools
- Android compile SDK 37
- Android Build Tools 37.0.0
- Android NDK 27.1.12297006
- An Android device or emulator running API 24 or newer

The app targets Android API 36. Hermes and the React Native New Architecture are enabled.

#### iOS

- macOS
- Xcode 16.1 or newer
- Ruby 2.6.10 or newer
- Bundler
- CocoaPods 1.13 or newer, excluding 1.15.0 and 1.15.1
- An iOS 15.1 or newer simulator or device

iOS builds are cut in the cloud (EAS) and delivered to testers through
TestFlight, and the app has been run on a physical iPhone from that
channel. What is *not* verified is this repository built on a clean local
Mac: dependency installation, compilation, archiving and signing from a
fresh checkout have not been walked through end to end, so the commands in
*Run on iOS* below are the expected development workflow rather than a
guaranteed procedure. The iOS simulator cannot validate the Angel at all,
since Metal inference needs real hardware.

### Install dependencies and run checks

```sh
git clone https://github.com/simbi-community-dev/playapal.git
cd playapal
npm ci
npm run lint
npm run typecheck
npm test
```

`npm ci` also applies the repository's tracked compatibility patches through the `postinstall` step.

### Run on Android

Start Metro in one terminal:

```sh
npm start
```

In another terminal, with a device or emulator available:

```sh
npm run android
```

To build an on-device test APK directly, use the release variant signed with
the public debug key (see the warning below); debug-variant builds require a
running Metro server and crash-recover badly in the field:

```sh
cd android
./gradlew assembleRelease -PallowDebugSigning=true
```

The APK is written to:

```text
android/app/build/outputs/apk/release/app-release.apk
```

Install it on a connected device with:

```sh
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

#### Android release warning

`android/app/debug.keystore` is committed to this repository, as it is in
every React Native project, so its private key is public. A release build
therefore **refuses to run** unless it is given real signing credentials, or
told in as many words to use the debug key anyway:

```sh
# distributable build: reads four properties from ~/.gradle/gradle.properties
#   PLAYAPAL_UPLOAD_STORE_FILE / _STORE_PASSWORD / _KEY_ALIAS / _KEY_PASSWORD
./gradlew assembleRelease

# on-device test build, signed with the PUBLIC debug key, never distributable
./gradlew assembleRelease -PallowDebugSigning=true
```

This matters beyond the usual advice: if an artifact signed with the debug key
is ever uploaded to Play, that public key becomes the app's **permanent update
identity**, and no build signed with a real key will be accepted as an update
afterward. Clean-clone Android CI, the default multi-ABI build, production
signing, and Play-ready AAB generation must be verified before a public
binary release.

### Run on iOS

Install Ruby and CocoaPods dependencies:

```sh
bundle install
cd ios
bundle exec pod install
cd ..
```

Then start the app:

> The iOS simulator is **UI-only**: Metal-backed Angel inference requires a
> physical device. Treat the iOS path as unverified for the Angel itself until
> a device build is confirmed. Right Now, packs, and the camp board work in
> the simulator.

```sh
npm run ios
```

This is the expected development workflow, not a verified release procedure. The repository must add tested Ruby and CocoaPods lockfiles and pass a macOS clean-build lane before publishing iOS installation or archive guarantees.

## How this was built: an honest disclosure

This whole project is, in the current vernacular, **completely vibe-coded**:
every line of application code, test, tool, and documentation in this
repository was written by AI, specifically Claude (Anthropic) and Codex
(OpenAI), working under the direction of a non-coding human product lead
who designed the experience, tested every build on real phones in the
field, and made every judgment call. The Angel models were fine-tuned the
same way, on second-hand GPUs in a home closet.

The code you are reading was cross-reviewed between model families (each
substantial change was adversarially reviewed by a different model than the
one that wrote it) and carries the test suite this README told you to run.
Both Codex and Claude Fable think all of this code is good and useful. You
are welcome to help improve it; the humans and the models will both read
your pull request.

## Project status

Playa Pal goes to Black Rock City 2026 as an experimental beta, two weeks
old, shipping release-signed Android builds from the releases page and iOS
builds to TestFlight testers. Android release signing, the production
application ID, icons and store metadata, source and model licensing
([`LICENSE`](LICENSE) and [`NOTICE`](NOTICE)), and per-file model and pack
checksums are all in place. Verification runs through `tools/gate.sh`, which
is lint, typecheck, the full Jest suite, and optionally a test APK with its
SHA-256 in the log, running on the project's own build hosts rather than
through a hosted CI service. That is a deliberate choice rather than an omission, and
contributors run the same script locally.

Still open, and named rather than implied:

- **A supported-device and memory matrix.** The app adapts its footprint to
  the phone, but the project publishes no tested-device table.
- **Bundled-data redistribution terms.** Attribution is in place for the
  event, survival, technique and lore material; written permission is a
  separate, legal question that is not settled. See *Data provenance* above.
- **The iOS build path end to end.** Clean pod install, archive, signing,
  and physical-device inference each still want confirmation on a clean
  machine.
- **Device proof, rung by rung.** `docs/TEST-MATRIX.md` is the grid that
  says which pair, on which radio, has actually carried which feature. As
  of 0.8.5 the direct Android-to-Android link carries live voice both ways
  with every network off; a video call has carried a real conversation
  between a Pixel and an iPhone on a shared Wi-Fi; and lo-fi voice has
  crossed from an iPhone to a Pixel over Bluetooth alone. The known broken
  half of that last one is the reverse direction: Androids do not yet
  discover a nearby iPhone over Bluetooth, which is diagnosed and being
  fixed.
  Camp hotspot hosting, the iPhone-to-iPhone pairing ceremony, and the
  camp board over the mesh are built and unit-covered with no two-device
  run recorded. Treat anything the grid does not mark PROVEN as
  working-on-paper until a phone says otherwise. That is the difference
  this section exists to keep.

Do not treat a development APK, unsigned archive, or debug-signed build as an official release.

### The same limits, in camper words

The list above is for whoever builds and ships this. The list below is the
one a person standing in dust needs, and it is also **in the app**:
Settings › Help & about › **How Playa Pal works**. `src/help/helpContent.ts`
is the single source of that screen, and a test holds these two lists in
step by their shared phrases.

- **On an iPhone, keep Playa Pal open** to send and receive pod mail. A
  pocketed iPhone can still be spotted by other iPhones, but not by
  Androids, and nothing new arrives until the app is on screen again.
  Android phones carry on pocketed. Pocketed delivery on iPhone is next.
- **A podmate reachable only over Bluetooth has no call button.** A video
  call needs the room a shared Wi-Fi gives it: a camp router, or a hotspot
  with no internet behind it, including the Camp hotspot one Android in the
  pod can turn on. Two iPhones that have been linked directly to each other
  carry a call with no Wi-Fi at all. Any
  pair carries it on a shared Wi-Fi, an iPhone and an Android included.
  The button returns with the roomier link. Messages and lo-fi voice are
  unaffected.
- **A call rings while the app is open.** Leave the walkie on and a call
  reaches you anywhere in the app, on the camp board or the map, with the
  caller's name and a way to answer; a bar along the bottom shows the
  walkie is on, names who is on the channel, and turns it off in one tap.
  Away from the app a call still buzzes your pocket like any message; what
  it cannot yet do is take over a locked screen with a full ring.
  Expecting a call? Leave Playa Pal on screen. Missed one? A voice note keeps.
- **Phones trade mail one pair at a time**, over a radio that reaches
  across a camp rather than a city. A pod of about ten is comfortable;
  much past that, live voice strains and messages simply need more
  passing-by. Big camps want several pods, not one enormous one.
- **On a phone with little memory, the Angel rests** when the app opens, so
  the deterministic half stays quick. Wake her in Settings › Angel & voice,
  above the model list; a stored choice outranks the measurement in both
  directions.
- **The pod code is short and boards are not encrypted.**
  This is playa trust, not bank trust. Four digits joins a pod; camp boards
  and friend cards travel unsealed, stamped only well enough to separate one
  camp's board from another and to notice tampering. Post what you would
  write on the camp whiteboard.

## License

The binding terms are in `LICENSE` and `NOTICE`:

- **Source code:** [Apache License 2.0](LICENSE). Attribution notices live in
  [`NOTICE`](NOTICE).
- **Model weights** (downloaded, not part of this repository): two regimes,
  by file. **Playa Angel Max** is a Gemma 4 E4B derivative under the
  [Apache License 2.0](https://ai.google.dev/gemma/apache_2), the license
  Google releases Gemma 4 under, and ships with the modified-file notices
  Apache §4 asks for. **Playa Angel** and **Playa Angel Light** are LFM2.5
  derivatives under the LFM Open License v1.0, including its annual-revenue
  condition on commercial use. No single license covers all three; the
  per-file detail is in [`NOTICE`](NOTICE).
- **Bundled data packs:** third-party content under its own terms: Burning
  Man Project material summarized/quoted with attribution, public event data,
  and Burn.Life techniques summarized with per-article credit. The Apache
  code license does not relicense any of it. Provenance per pack is in
  `NOTICE`; this project is not affiliated with or endorsed by Burning Man
  Project.

## Angel voice (experimental)

Settings offers a tier-2 neural "Angel voice" (Kokoro via sherpa-onnx) beside
the device's own text-to-speech. There is **no supported in-app download for
it yet**: today it loads only from a developer-placed model file (adb push),
and absent that the app falls back to device TTS cleanly. A supported
download/import path with source, size, license, and checksum is future work;
until then treat Angel voice as a developer preview.

## Versions

The first commit landed on Aug 13 and 0.8.0 shipped on Aug 24, so this
whole app is twelve days of building plus the days since. Each tenth is an
era: **0.1** the on-device Angel, **0.2** the
camp board and credited survival guide, **0.3** the fact graph and the
training program, **0.4** the whiteout compass and the trained Angel,
**0.5** friends, the city map, and this public release. **0.5.1** then added
share-time consent on friend cards, an offline reader for pack sources, and
the Playa Angel Max tier. **0.6** brought camp knowledge and a map you can
touch, **0.7** beams that open with a tap, the real 2026 city and Faves, and
**0.8** the camp mesh, meaning pods, the answering machine, the walkie, and
dark mode. Then the eighth decimal earned four more. **0.8.2** gave the pod
its own face, with 1:1 video calls, a plain answer to "am I connected", and
codes scanned inside the app; **0.8.3** the link that holds in the dust;
**0.8.4** the phones that make their own network, meaning Camp hotspot,
iPhone-to-iPhone pairing, and the iPhone microphone cured at three roots;
**0.8.5**, where the talk button proves the microphone is alive and heals it
when it isn't; **0.8.6**, say a name and buzz a pocket; and **0.8.7**, the
pod page finding its rooms. **0.9.0**, the current release, is one long
lesson in ownership, which is who owns a radio, who owns a link, and who is
allowed to end one, and it is the week the iPhone stopped strangling its own
replacements. It is also the release that drives to the playa as an
experimental beta, carrying more features than any of us have proof for. The
full story is in [CHANGELOG.md](CHANGELOG.md), and 1.0 is earned on playa.

## About the publisher

Playa Pal is published by [Simbi Community Development](https://github.com/simbi-community-dev),
a 501(c)(3) whose mission is volunteership and community development. This
repo is the first of a growing family of community open-source projects from
that org, anchored by the [Simbi community](https://simbi.com) and its
mutual-credit clockchain work. If this app is useful to you,
[donations to the nonprofit](https://simbi.com/donate) keep the lights on.

## Support

Questions and bug reports: [GitHub issues](https://github.com/simbi-community-dev/playapal/issues)
(templates included; please never attach chat logs, camp beams, or
passphrases). Security reports: see [SECURITY.md](SECURITY.md). This is a
volunteer community project; on-playa support is the person at
your camp who read this file.

## Acknowledgments

Playa Pal builds on React Native, Hermes, `llama.rn`, SQLite, and the work of the open-source projects listed in the package manifests.

Thanks to the people who publish Black Rock City event and safety information, and to Burn.Life and Dr. Yes for the separately credited field-technique material summarized in the survival pack.
