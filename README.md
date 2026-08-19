# Playa Pal

**An offline, on-device guide for Black Rock City 2026.**

> **Pre-release.** There are no official binaries yet; build from source.
> In-app model downloads use public, checksum-pinned model files from the
> Playa Angel model repository.

Playa Pal combines a local language model, the 2026 event schedule, a searchable survival guide, and a camp gifts-and-needs board in one React Native app. After you load the model and data, its core features run on the phone without a server, cloud account, or network connection.

> This app is not affiliated with, endorsed by, or verified by Burning Man Project.

## What you can do

- **Ask the Angel:** a full-screen conversation with an on-device guide backed by a local GGUF model — open it with the 🪽 Angel button or by asking a question anywhere the app offers one.
- **Find events:** browse what is happening now or search by date, time, camp, location, and description; listings that repeat every day say so ("Daily · 14:00–16:00") instead of masquerading as one-day events.
- **Walk there:** every located event card links to a whiteout-proof compass — one giant arrow, distance, and clock-address directions from wherever you stand, plus rough walk times on the cards themselves. Drop a pin at your camp (or anything else) and "Take me home" works with zero connectivity.
- **Search the guide:** retrieve safety, logistics, principles, and practical field information from local document packs.
- **Bring camp knowledge:** import your own schedules, handbooks, and notes as data packs.
- **Share gifts and needs:** post offers, requests, replies, and completion updates on an offline camp board.
- **Find your friends:** share a friend card — playa name, camp, address, a find-me note — as a QR your friend's normal camera scans (no signal needed; the payload lives in the link itself and never touches a server), or as a file over AirDrop/Quick Share. Friends' camps link to the compass, show walk times, plot on the offline city map, and export as a printable paper list.
- **Use speech:** listen through the device text-to-speech engine when a suitable local voice is installed.
- **Curate what the Angel sees:** long-press a person card, event card, or source passage to set it aside ("Don't use this"); restore anything from Settings › Hidden.

The model, event search, guide retrieval, and camp data operate on device. User-initiated sharing and the device's selected speech engine are separate platform features; some system voices may require a downloaded or network-backed voice pack.

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

With **Speak answers out loud** on (Settings tab), the Angel reads each
finished reply through the device's own text-to-speech voices — no cloud, no
extra model. Only the final answer is spoken, never the thinking indicator or
tool status; markdown and emoji are stripped before synthesis, and event cards
are spoken in a fixed shape: "Title, day, time, at location". Every assistant
bubble also carries a speaker button that works regardless of the toggle.
Speech stops when you send a new question, switch persona, or leave the chat.

**Do this on wifi before you leave for the event.** Some device voices are
CLOUD voices: they simply fall silent once there is no signal, which is
exactly when this app is meant to be useful. In Settings, pick a voice badged
**offline** — the picker lists those first. If none are badged offline, tap
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

The iOS build path is pre-release: dependency installation, compilation, Metal inference, model and pack import, signing, archiving, and distribution still need clean-machine verification.

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

To build an on-device test APK directly (release variant, signed with the
public debug key — see the warning below; debug-variant builds require a
running Metro server and crash-recover badly in the field):

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
every React Native project — its private key is public. A release build
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
> a device build is confirmed — Right Now, packs, and the camp board work in
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
Downloads are digest-verified before they are ever loaded — a torn or tampered
file is refused, never half-used. A network connection is needed once, at
download time; everything runs offline afterward.

| Tier | File | Size | SHA-256 |
|---|---|---|---|
| **Playa Angel** — best answers | `angel-smart.gguf` | 1.6 GB | `653c7ee3e7e95468516574350b0cfacbadb4609bf56d8789e452f9b1297e0bb4` |
| **Playa Angel Light** — fastest | `angel-light.gguf` | 1.4 GB | `f5fb59a0db7039f4c485f82f6d448e2126d3923b5bee1ac411b5aea67c85de31` |

Both are project fine-tunes of LiquidAI's LFM2.5-2.6B, hosted at
[huggingface.co/davidryalpug/playa-angel](https://huggingface.co/davidryalpug/playa-angel)
(public at release) under the **LFM Open License v1.0** inherited from the base
model — note its annual-revenue condition on commercial use, which applies to
these derivatives too. The model card, LICENSE, NOTICE, and `SHA256SUMS` ship
in that repository. Additional tiers for larger phones are being evaluated;
the catalog in `src/llm/modelCatalog.ts` is the single source of truth, and
adding a community model is one object literal (see the file's header).

**2. A file on this phone.** The same chooser accepts any local `.gguf` via
the system document picker (or `adb push` to the app's files directory as
`model.gguf` for development). The picker checks the extension; the runtime
decides whether architecture, quantization, chat template, and memory actually
work — do not assume arbitrary GGUF models will.

The app remembers the model across launches. The model is a conversational
and tool-routing layer, not the authoritative source: event times, locations,
and safety facts come from the local data packs when retrieval succeeds, and
answers cite what they retrieved.

## Built-in data

Playa Pal installs two local packs on first run:

- **Black Rock City 2026 events:** dates, times, titles, descriptions, camps, and locations for local browsing and search.
- **Survival guide:** safety, logistics, principles, and practical field information split into searchable passages.

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
and the cards you've collected. Sharing is strictly phone-to-phone: a QR code
(scanned by the system camera — Playa Pal opens and imports it, in airplane
mode too), the share sheet, or "Beam friends", which re-exports every card
you hold so one organized camper can assemble a crew's map at a pre-party and
pass it on. Each card carries its author's edit counter; re-imports keep the
newest and report older copies as stale. Cards are not signed or encrypted —
the trust model is that you accepted the file from the person who handed it
to you (the camp beam's posture; see its pilot notes above).

The **city map** (🗺 on the compass) draws Black Rock City offline from the
measured geometry — streets, Center Camp, the Man, the Temple, toilet banks —
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

Angel is a project-specific LFM2.5-2.6B fine-tune tested with Playa Pal. Model weights are not stored in this repository. The model download, checksum, model card, base-model license, fine-tune license, and training-data provenance must be published alongside any public weight release.

## Privacy and local data

Playa Pal does not require an account. App data stays in local application storage unless you explicitly import, export, or share a file.

The app stores full conversation records locally, including user messages, assistant responses, tool calls, tool results, and timing metadata. Automatic retention is limited to approximately 90 days or 20 MB, pruning older records first.

The Settings screen can export conversation JSON through the system share sheet. Treat those exports as private: they can contain complete conversation text, camp information, model metadata, and diagnostic timing data.

Pre-release builds may also write search queries and model tool arguments to platform diagnostic logs. Do not enter sensitive information in development builds, and remove or redact detailed production logging before distributing a release build.

Android application backup is disabled. Lost-device behavior, iOS backup behavior, exports, platform logs, and manually shared files remain part of the user's security boundary.

## How this was built — an honest disclosure

This whole project is, in the current vernacular, **completely vibe-coded**:
every line of application code, test, tool, and documentation in this
repository was written by AI — Claude (Anthropic) and Codex (OpenAI),
working under the direction of a non-coding human product lead who designed
the experience, tested every build on real phones in the field, and made
every judgment call. The Angel models were fine-tuned the same way, on the
second-hand GPUs described above.

The code you are reading was cross-reviewed between model families — each
substantial change adversarially reviewed by a different model than the one
that wrote it — and carries the test suite this README told you to run.
Both Codex and Claude Fable think all of this code is good and useful. You
are welcome to help improve it; the humans and the models will both read
your pull request.

## Project status

The application and its local data paths are under active release preparation. Before a public binary release, the project must complete:

- clean-clone Android and iOS CI;
- production application IDs, signing, icons, and store metadata;
- physical-device verification of model and pack import;
- a supported-device and memory matrix;
- source, dataset, guide, technique-layer, and model licensing;
- final public model and data-pack checksums.

Do not treat a development APK, unsigned archive, or debug-signed build as an official release.

## License

The binding terms are in `LICENSE` and `NOTICE`:

- **Source code:** [Apache License 2.0](LICENSE). Attribution notices live in
  [`NOTICE`](NOTICE).
- **Model weights** (downloaded, not part of this repository): LFM Open
  License v1.0, inherited from the LiquidAI base model — including its
  annual-revenue condition on commercial use. See the model repository.
- **Bundled data packs:** third-party content under its own terms — Burning
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

Built in a seven-day sprint before the 2026 burn; each tenth is an era —
**0.1** the on-device Angel, **0.2** the camp board and credited survival
guide, **0.3** the fact graph and the training program, **0.4** the whiteout
compass and the trained Angel, **0.5** friends, the city map, and this
public release. The full story is in [CHANGELOG.md](CHANGELOG.md); 1.0 is
earned on playa.

## About the publisher

Playa Pal is published by [Simbi Community Development](https://github.com/simbi-community-dev),
a 501(c)(3) whose mission is volunteership and community development. This
repo is the first of a growing family of community open-source projects from
that org — anchored by the [Simbi community](https://simbi.com) and its
mutual-credit clockchain work. If this app is useful to you,
[donations to the nonprofit](https://simbi.com/donate) keep the lights on.

## Support

Questions and bug reports: [GitHub issues](https://github.com/simbi-community-dev/playapal/issues)
(templates included — please never attach chat logs, camp beams, or
passphrases). Security reports: see [SECURITY.md](SECURITY.md). This is a
volunteer community project; on-playa support is, of course, the person at
your camp who read this file.

## Acknowledgments

Playa Pal builds on React Native, Hermes, `llama.rn`, SQLite, and the work of the open-source projects listed in the package manifests.

Thanks to the people who publish Black Rock City event and safety information, and to Burn.Life and Dr. Yes for the separately credited field-technique material summarized in the survival pack.
