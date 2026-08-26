# Playa Pal

**An offline, on-device companion for Black Rock City 2026.**

> **Get it:** the newest release-signed Android APK is always at
> [playapal.apk](https://github.com/simbi-community-dev/playapal/releases/latest/download/playapal.apk)
> — a stable link that follows the latest release. Every version stays on the
> [releases page](https://github.com/simbi-community-dev/playapal/releases), and
> [Obtainium](https://github.com/ImranR98/Obtainium) pointed at this repo delivers
> updates like a store would. Android challenges any sideload twice ("Allow from
> this source", then Play Protect's "Install anyway" behind More details) — the
> plain-language walk-through lives at [playapal.lol/#get](https://playapal.lol/#get).
> iOS ships to testers via TestFlight; ask for an invite.
> In-app model downloads use public, checksum-pinned files from the
> Playa Angel model repository.

Playa Pal is the 2026 event guide, a searchable-and-readable survival
manual, a camp gifts-and-needs board, a whiteout compass, the city map, a
serverless friend finder, and a **camp mesh** — a small group of phones that
keep track of each other, carry mail and talk live with no network between
them — and place a video call over any shared Wi-Fi (a hotspot with no
internet behind it counts). All of it is one React Native app that runs
entirely on the phone. There is no server behind it, and it never needs a
cloud account or a network connection.
**Every one of those tools works before any AI model is installed.** The
Playa Angel, a small open model fine-tuned on the same guides, is the
optional conversational layer on top.

> This app is not affiliated with, endorsed by, or verified by Burning Man Project.

## What you can do

- **Ask the Angel:** a full-screen conversation with an on-device guide backed by a local GGUF model. Open it with the 🪽 Angel button or by asking a question anywhere the app offers one.
- **Find events:** browse what is happening now or search by date, time, camp, location, and description; listings that repeat every day say so ("Daily · 14:00–16:00") instead of masquerading as one-day events.
- **Walk there:** every located event card links to a whiteout-proof compass: one giant arrow, distance, and clock-address directions from wherever you stand, plus rough walk times on the cards themselves. Drop a pin at your camp (or anything else) and "Take me home" works with zero connectivity.
- **Search the guide:** retrieve safety, logistics, principles, and practical field information from local document packs.
- **Bring camp knowledge:** import your own schedules, handbooks, and notes as data packs.
- **Share gifts and needs:** post offers, requests, replies, and completion updates on an offline camp board.
- **Find your friends:** share a friend card (playa name, camp, address, a find-me note) as a QR, or as a file over AirDrop/Quick Share; the payload lives in the link itself and never touches a server, so no signal is needed. Take someone's card by scanning their code **inside the app** — one photo, decoded on the phone — or with the system camera as before. Friends' camps link to the compass, show walk times, plot on the offline city map, and export as a printable paper list.
- **Run a pod (Camp Mesh):** pick your people, or join a pod by its 4-digit code or its QR, and phones keep track of each other over Bluetooth — live direction and distance when you're near, last-known otherwise. Sharing is a switch you flip, with a master off in Settings, and the beacons are signed so only your pod can mint them.
- **See who is in reach:** one line on the pod card says whether you are connected and to how many people; tapping it lists each podmate with what that connection is actually good for — voice, lo-fi voice, messages now, when you pass by, notes keep. It never names a radio.
- **Leave messages that wait:** the pod's answering machine carries typed notes and held-mic voice notes from phone to phone whenever podmates pass in range — seconds when two phones are near with the app open, minutes when one is pocketed, and however long it takes to walk past each other otherwise. The app says which of those you are in rather than implying the fastest. A spare phone plugged in at camp keeps the mailbox. The thread reads oldest-to-newest and keeps your place when you scroll back.
- **Talk live, with or without a network:** hold the walkie button and the pod hears you. Any shared Wi-Fi works for any pair, including a hotspot with no internet behind it; two Android phones form their own direct link and use that instead; and with no Wi-Fi at all the voice still carries over Bluetooth, rougher, marked *lo-fi*. Incoming voice is amplified and plays through the loudspeaker, on the volume rocker you already use. The microphone runs only while the button is held.
- **Call one podmate:** a 1:1 video call over any shared Wi-Fi — no server and no internet, and proven cross-platform (a Pixel to an iPhone, 2026-08-26). A camp router does it, and so does the Camp hotspot one Android in the pod can turn on. Hold-to-talk stands down while a call has the microphone.
- **Pick your light:** dark mode, light mode, or match the phone — every surface carries both palettes, enforced by a build test.
- **Use speech:** listen through the device text-to-speech engine when a suitable local voice is installed.
- **Curate what the Angel sees:** long-press a person card, event card, or source passage to set it aside ("Don't use this"); restore anything from Settings › Hidden.

The model, event search, guide retrieval, and camp data operate on device. User-initiated sharing and the device's selected speech engine are separate platform features; some system voices may require a downloaded or network-backed voice pack.

## How the pod stays connected

Every pod feature — positions, mail, live voice, video — rides **one wire
format over several radios**, so a missing radio costs fidelity and never
costs membership. The rungs, cheapest first:

| Rung | Carries | Radio | Needs |
|---|---|---|---|
| 0 | An invite, or a card | none — a QR held up, or one scanned | a camera |
| 1 | Presence (a 21-byte signed beacon) | Bluetooth LE advertisement | nothing |
| 2 | Pod mail: text and voice notes, store-and-forward | Bluetooth LE | nothing |
| 3 | Live voice, lo-fi | Bluetooth LE | nothing |
| 4 | Live voice, hi-fi, and video calls | the phones' own direct Wi-Fi link, or any shared Wi-Fi | Wi-Fi Aware, or a router/hotspot |

Two rules keep it honest. A phone announcing that it *has* a radio proves
nothing, so a peer starts at the floor and only moves up after a round
trip on the higher rung is observed — and falls back immediately, with no
ceremony, when that link goes quiet. And a rung that carries less is not a
worse citizen: pod mail is a peer of live voice, not its fallback, because
most of the time the person you are messaging is asleep or across the
city.

The wire format does not change per rung — only the codec of the payload
and the socket it rides. A receiver that does not recognise a version or a
codec id drops the frame, which is why an older build is simply blind to a
newer feature rather than noisy about it. Video calls use that same
extension point for their signalling; the media itself is WebRTC with an
empty ICE server list, so the only candidates that can exist are host
candidates on interfaces the two phones share. There is no relay, and no
configuration in which a call could acquire one.

Measured, and not: the direct Wi-Fi link (rung 4) has carried live voice
both ways between two Android phones with every network off, and the video
call layer has carried a real cross-platform call — a Pixel to an iPhone
over a shared Wi-Fi, 2026-08-26. Rung 3, the Bluetooth voice path, is built
and unit-covered but has not yet run between two devices. Rung 4 over Wi-Fi Aware is
Android-vendor-dependent and iOS 26-and-later, and the iOS variant links
only to other Apple devices already paired at the OS level; every phone
keeps rungs 0–2 regardless.

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

## Requirements

### Common

- Git
- Node.js **22.23+, excluding 23 and 25** (React Native 0.87 does not support them; the `engines` field enforces this). 22.23.2 and 24.3 are the tested versions; 22.13–22.22 ship a `node:sqlite` without FTS5 and fail 98 tests.
- npm
- A phone or emulator with enough storage and memory for React Native and a roughly 1.7 GB quantized model

The project does not yet publish a minimum-RAM device matrix. A `.gguf` extension alone does not guarantee that a model is compatible or that a device can load it.

The app sizes the model's memory footprint to the phone it is on: below
roughly 6 GB of total RAM it halves the context window and leaves the
weights pageable, and it never pins them on iOS, where the Metal backend
keeps its own resident copy. A phone whose RAM it cannot read is treated as
the constrained case — the safe direction is a smaller footprint, never a
crash. This is what stopped 4 GB iPhones being killed by the OS mid-session.

### Android

- JDK 21
- Android Studio or command-line Android SDK tools
- Android compile SDK 37
- Android Build Tools 37.0.0
- Android NDK 27.1.12297006
- An Android device or emulator running API 24 or newer

The app targets Android API 36. Hermes and the React Native New Architecture are enabled.

### iOS

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
guaranteed procedure. The iOS simulator cannot validate the Angel at all —
Metal inference needs real hardware.

## Install dependencies and run checks

```sh
git clone https://github.com/simbi-community-dev/playapal.git
cd playapal
npm ci
npm run lint
npm run typecheck
npm test
```

`npm ci` also applies the repository's tracked compatibility patches through the `postinstall` step.

## Run on Android

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

### Android release warning

`android/app/debug.keystore` is committed to this repository, as it is in
every React Native project, so its private key is public. A release build
therefore **refuses to run** unless it is given real signing credentials, or
told in as many words to use the debug key anyway:

```sh
# distributable build — reads four properties from ~/.gradle/gradle.properties
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

## Run on iOS

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
  LiquidAI's LFM2.5-2.6B at two quantizations — Q4_0 for the smart tier,
  Q3_K_M for the light one. They carry the **LFM Open License v1.0**
  inherited from that base model. Note its annual-revenue condition on
  commercial use, which applies to these derivatives too.
- **Playa Angel Max** is a fine-tune of Google's **Gemma 4 E4B** (Q4_0),
  which Google releases under the **Apache License 2.0** — so that tier
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

## Built-in data

Playa Pal installs these local packs on first run:

- **Black Rock City 2026 events:** dates, times, titles, descriptions, camps, and locations for local browsing and search.
- **Survival guide:** safety, logistics, principles, and practical field information split into searchable passages.
- **Playa lore:** the project's own summaries of public talks, documentaries and camp histories — the Temple, Rangers, art cars, gifting, how the city works — each crediting its source video by uploader, title, URL and date, and pointing the reader at the original. These are summaries *about* what a talk says, never its words — the transcripts themselves are neither shipped nor redistributed. Provenance in [`NOTICE`](NOTICE).
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
and decodes it on the phone — no native scanner was added; the picture goes
through the same picker art photos already use, and the decode is plain
JavaScript, which is also why it can be tested off a device. The scanned
text reaches the same single URL handler a tapped link does, so a card
installs through the one importer and a pod invite still asks before it
joins. The **system camera** path is untouched and remains the door for a
phone that does not have Playa Pal yet; both work in airplane mode. In a
pod, **"We're together — swap cards"** puts both halves in one panel: your
card as a code to hold up, and "Scan theirs" to take one. What a device
still owns is optics — focus, glare, dust, a phone held at an angle.

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

The **city map** (🗺 on the compass) draws Black Rock City offline from the
measured geometry (streets, Center Camp, the Man, the Temple, toilet banks)
with your blue dot, your pins, the active waypoint, and your friends' camps.

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

Angel is a set of project-specific fine-tunes tested with Playa Pal, over two different base models: Gemma 4 E4B for the Max tier, LFM2.5-2.6B for the other two. They therefore carry two different licenses, per file — see [`NOTICE`](NOTICE) and the tier table above. Model weights are not stored in this repository. The model download, checksum, model card, base-model license, fine-tune license, and training-data provenance must be published alongside any public weight release.

## Privacy and local data

Playa Pal does not require an account. App data stays in local application storage unless you explicitly import, export, or share a file.

The app stores full conversation records locally, including user messages, assistant responses, tool calls, tool results, and timing metadata. Automatic retention is limited to approximately 90 days or 20 MB, pruning older records first.

The Settings screen can export conversation JSON through the system share sheet. Treat those exports as private: they can contain complete conversation text, camp information, model metadata, and diagnostic timing data.

Pre-release builds may also write search queries and model tool arguments to platform diagnostic logs. Do not enter sensitive information in development builds, and remove or redact detailed production logging before distributing a release build.

Android application backup is disabled. Lost-device behavior, iOS backup behavior, exports, platform logs, and manually shared files remain part of the user's security boundary.

## How this was built: an honest disclosure

This whole project is, in the current vernacular, **completely vibe-coded**:
every line of application code, test, tool, and documentation in this
repository was written by AI, specifically Claude (Anthropic) and Codex
(OpenAI), working under the direction of a non-coding human product lead
who designed the experience, tested every build on real phones in the
field, and made every judgment call. The Angel models were fine-tuned the
same way, on the second-hand GPUs described above.

The code you are reading was cross-reviewed between model families (each
substantial change was adversarially reviewed by a different model than the
one that wrote it) and carries the test suite this README told you to run.
Both Codex and Claude Fable think all of this code is good and useful. You
are welcome to help improve it; the humans and the models will both read
your pull request.

## Project status

Playa Pal ships release-signed Android builds from the releases page and
iOS builds to TestFlight testers. Android release signing, the production
application ID, icons and store metadata, source and model licensing
([`LICENSE`](LICENSE) and [`NOTICE`](NOTICE)), and per-file model and pack
checksums are all in place. Verification runs through `tools/gate.sh` —
lint, typecheck, the full Jest suite, and optionally a test APK with its
SHA-256 in the log — on the project's own build hosts rather than through a
hosted CI service. That is a deliberate choice rather than an omission, and
contributors run the same script locally.

Still open, and named rather than implied:

- **A supported-device and memory matrix.** The app adapts its footprint to
  the phone, but the project publishes no tested-device table.
- **Bundled-data redistribution terms.** Attribution is in place for the
  event, survival, technique and lore material; written permission is a
  separate, legal question that is not settled. See *Data provenance* above.
- **The iOS build path end to end** — clean pod install, archive, signing,
  and physical-device inference each still want confirmation on a clean
  machine.
- **Device proof for the newest pod features.** As of 0.8.2, 1:1 video
  calls, live voice over Bluetooth (rung 3), and photo-decoding a QR have
  unit coverage and no two-device run. Live voice over the phones' own
  direct Wi-Fi link *has* been measured on two Android phones with every
  network off. Treat the unproven three as working-on-paper until a phone
  says otherwise — that is the difference this section exists to keep.

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
  call needs a shared Wi-Fi — a camp router, or a hotspot with no internet
  behind it, including the Camp hotspot one Android in the pod can turn on.
  Any pair carries it there, an iPhone and an Android included. The button
  returns with the roomier link. Messages and lo-fi voice are unaffected.
- **A call rings while the app is open.** Leave the walkie on and a call
  reaches you anywhere in the app — the camp board, the map — with the
  caller's name and a way to answer; a bar along the bottom shows the
  walkie is on, names who is on the channel, and turns it off in one tap.
  What it cannot yet do is ring from a locked pocket. Expecting a call?
  Leave Playa Pal on screen. Missed one? A voice note keeps.
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

Built in twelve days before the 2026 burn — first commit Aug 13, 0.8.0 on
Aug 24 — and each tenth is an era: **0.1** the on-device Angel, **0.2** the
camp board and credited survival guide, **0.3** the fact graph and the
training program, **0.4** the whiteout compass and the trained Angel,
**0.5** friends, the city map, and this public release. **0.5.1** then added
share-time consent on friend cards, an offline reader for pack sources, and
the Playa Angel Max tier. **0.6** brought camp knowledge and a map you can
touch, **0.7** beams that open with a tap, the real 2026 city and Faves, and
**0.8** the camp mesh — pods, the answering machine, the walkie, and dark
mode. **0.8.2** is the current release: the walkie stops needing a network,
the pod gains 1:1 video calls and a plain answer to "am I connected", codes
can be scanned inside the app, and the Angel gains camp lore it can cite.
The full story is in [CHANGELOG.md](CHANGELOG.md); 1.0 is earned on playa.

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
