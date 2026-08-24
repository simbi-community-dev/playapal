# Changelog

Playa Pal was built in one seven-day sprint before Burning Man 2026, and its
versions map to the real eras of that history: each tenth is a thing the
app couldn't do the day before. 1.0 is earned when Black Rock City itself
has field-tested it.

## 0.7.3: Welcome home (Aug 24)

**A first hour that explains itself.** First launch now opens with a
30-second welcome: your name (optional) and your camp — picked from the
real 2026 placement directory or typed freehand. Pick a placed camp and
Home lands on the map, "Take me home" works from night one, and your
shareable friend card starts pre-filled: nothing typed twice, nothing
required, nothing you type leaves the phone. Then a five-card tour shows
the whole app in under a minute. Skip any of it; replay all of it from
Settings whenever.

**The way home, on every screen.** The header's map door becomes a live
arrow the moment the app knows where home is, pointing at your camp from
every tab. No home yet, no GPS fix, no compass? It stays the plain map
door — never a dead affordance.

**Pins you can keep.** The compass's new ✎ pin manager lists every saved
pin — Home first, then newest — each with its clock address and a visible
Remove. Long-press on a pin chip still works; now there's a way you can
find.

## 0.7.2: Faves (Aug 24)

**Heart it, plan it.** Requested by a campmate who plans her burn days
around workshops and food: tap the ♡ on any event card — browsing, in
search results, even on the Angel's chat answers — and it lands in
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
address — 5,300+ events with real clock addresses joined from the official
placement data, walk and bike times computed to the actual spot. No more
last-year's-address labels.

**The art of 2026, on board.** All 332 registered pieces ride along in the
app — the artists' own descriptions, searchable and citable by the Angel.
Locations stay hidden until Gate opens, exactly as Burning Man requires;
events hosted at art name the piece, never the spot.

**Search knows names.** Typing the exact name of a thing — "Man Burn" —
puts that thing first, above every party riffing on its name.

**Field lessons from two real phones.** The beam screens now say the two
things receivers actually need (make yourself visible in Quick Share; open
the file from Files), and sharing the app warns about the scary
Play Protect screen and names the small "Install anyway" escape.

## 0.7.0: Tap the file, it opens (Aug 27)

Beaming a camp board to a campmate used to end in a file they had to find.
Accept the file, open Playa Pal, go to Camp, tap "Import a pack…", hunt for
it in a picker. Five steps, and the picker was the worst of them. Now a
beam is a `.playapal` file and **tapping it opens Playa Pal and imports it**
— from Files, Downloads, Quick Share, AirDrop, a share sheet, a Signal
attachment. One receipt tells you what landed. If the app was killed
between the file arriving and you opening it, the beam is still there on the
next launch; nothing vanishes silently.

**Small boards are a QR code.** One button — "Beam the board" — shows a QR
when the board fits in one; your campmate points their normal camera at
it and Playa Pal opens with the board. No pairing, no permissions, no
signal, nothing the two phones have to agree on. A board too big for one
code goes out as the file instead, and the button says so.

**Hand the app itself to a phone that has none.** Settings → "Share Playa
Pal" sends the installed app over Quick Share to a campmate whose phone is
empty — byte-identical to the copy you are running. On playa nobody can
download anything; now they don't have to. (iPhones can't sideload; that
side is a TestFlight link once it is published.)

**The release is a third smaller.** 132 MB instead of 292 — the APK
carried emulator and 2015-era builds nobody on playa has. Less to push
through dust on a battery.

**Art has a photo now.** Logging a piece of art snaps a small picture —
enough to recognise it, small enough that fifty of them still beam as one
file. The full-size photo stays on the phone that took it.

**iPhone ↔ Android, finally honest.** The two ecosystems will never agree
on a radio protocol. They do agree on files and on QR codes, and that is
what the beam rides. Any path that carries a file ends in a tap that
imports.

## 0.6.1: The map answers back (Aug 20)

The map arrived in 0.5.2 and it just sat there. You could look at Black Rock
City, but you couldn't tell it anything. Now you can touch it.

**Tap anywhere to aim.** Touch a spot on the map and the compass points at
it, named by its real address — "Map spot — 4:36 & G". Tap it again from the
arrow view and walk there.

**Hold and drag to place exactly.** A tap is fast but coarse. Press and hold
for a third of a second and the target lifts off your fingertip so your own
hand stops hiding the thing you're placing; drag until the address reads
right, then let go. That is how you put a pin on your camp's actual corner
instead of near it.

**Pinch and pan.** Two fingers zoom to 4x, one drags the city under you. The
map stays inside its own frame at every zoom.

**Your camp is a waypoint now.** Set your camp address on your card and Home
appears on the map without dropping a pin — "the app should already know
where my home camp is."

**Tap a pin to pick it.** Your saved pins, your friends' camps, the Man and
the Temple answer a tap on the map itself — no more hunting the row of chips
below, and no more accidentally dropping a rival pin next to your own.

### Fixed

- A tap while zoomed in landed centimeters from where you touched. The
  gesture layer already corrects for zoom; the app was correcting for it a
  second time.
- A press held between 0.22s and 0.35s did nothing at all — too slow for a
  tap, too fast for a hold. Every press now lands as one or the other.
- The map flickered while zoomed, and again every five seconds while
  standing still: the whole city was being rebuilt on every gesture frame,
  and again on every GPS reading. It is now drawn once and moved.
- Long-pressing the map crashed the app on some phones.

## 0.6.0: Camp knowledge (Aug 20)

A camper asked whether their own knowledge could go into the app — the
events the guide missed, the lore only campmates hold. Now it can, typed
right in the app by anyone who knows the camp passphrase.

- **Add to camp knowledge**: a memory, an event the guide missed, a fix to
  a wrong fact, or a camp resource — typed in the app, no files, no
  formats to learn. Your own notes can be edited and removed, and a
  half-typed note survives closing the sheet.
- **Notes travel with the camp beam**: beam the board and the campmate
  boards and notes this phone carries ride along, integrity-checked with the shared camp
  passphrase (not encrypted, and the author name is a label rather than a
  verified identity — the passphrase is the membership) and carried
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
  wired underneath and gets its fact-picker UI in a coming release —
  today a fix note reads like any other note.
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
