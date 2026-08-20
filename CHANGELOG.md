# Changelog

Playa Pal was built in one seven-day sprint before Burning Man 2026, and its
versions map to the real eras of that history: each tenth is a thing the
app couldn't do the day before. 1.0 is earned when Black Rock City itself
has field-tested it.

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
