# Changelog

Playa Pal was built in one seven-day sprint before Burning Man 2026, and its
versions map to the real eras of that history — each tenth is a thing the
app couldn't do the day before. 1.0 is earned when Black Rock City itself
has field-tested it.

## 0.5.1 — Consent, the reader, and the Max Angel (Aug 19)

- **Friend cards carry their author's consent**: sharing asks "just for
  them" or "pass it on" at the moment of sharing (the pick is remembered
  and travels inside the card); only pass-it-on cards ride "Beam friends",
  and direct cards wear a "shared just with you" badge. Honored by the
  app, not enforced by cryptography — the app says so itself.
- **The pack reader**: read the saved source materials straight through —
  contents to full document with credited section breadcrumbs, fully
  offline, no question needed.
- **Playa Angel Max**: the first zero-contradiction Angel on our
  31-question corpus battery (v4.4g, a Gemma 4 E4B fine-tune) joins the
  catalog as a new top tier for high-memory phones. The phone-fit
  recommendation stays measured and honest — verified by squeezing the
  5.15 GB model onto an 8 GB Pixel 7 (it answers; slowly, as warned).

## 0.5.0 — The social city (Aug 19, first public release)

The release candidate that rides to the playa.

- **Friends on playa**: share a friend card — playa name, camp, address,
  find-me note — as a QR any normal camera scans (the card travels inside
  the link itself: no server, no address book, no account), a share-sheet
  file, or "Beam friends", which re-exports every card you hold so one
  organized camper can assemble a whole crew's map at a pre-party.
  Printable paper list included, in BurnerMap's honored tradition.
- **The offline city map**: Black Rock City drawn from measured geometry —
  streets (Center Camp keyhole and all), plazas, toilet banks, your pins,
  your friends, your blue dot. A compass mode; no tiles, no network.
- **One coherent app**: three tabs (Now · Camp · Settings); the Angel became
  a full-screen conversation opened from anywhere; packs found their homes.
- The real **2026 city geometry** went live (GIS-confirmed radii, real
  street names, per-number provenance); daily events say "Daily" instead of
  masquerading as one-day listings; "Don't use this" curation with restore;
  an About section; the contributor doorway finalized (authoring spec +
  stdlib pack doctor + embeddings builder); and an honest disclosure: the
  whole app is AI-written under human direction.

## 0.4.0 — The trained Angel and the field kit (Aug 17–18)

- The **whiteout compass**: offline GPS to a Black-Rock-City address, one
  giant arrow with clock-phrase directions, dropped pins, "Take me home",
  nearest-toilets, and rough walk times on every event card.
- The Angel got schooled: an open **model catalog** with a device-aware
  chooser (memory-fit measurement, digest-pinned downloads), retrieval
  ranking rungs, disciplined tool-round thinking budgets, and an evaluation
  instrument carrying the owner's own scoring bar.
- iOS cracked: React Native 0.87's removed-bridge era survived via upstream
  patterns; the app runs on a 4 GB iPhone 13 mini.

## 0.3.0 — Facts over vibes (Aug 15–16)

- A **fact graph** under the packs (transactional node/edge storage, a query
  engine, provenance-carrying edges) — the roots of the lineage view.
- Engine hardening (FTS5 everywhere, durable storage paths) and the
  training program stood up: three audits over every fact in the corpus
  before any fine-tune was allowed to touch the model.

## 0.2.0 — Camp life, on day two (Aug 14)

- The **camp board**: gifts and needs shared phone-to-phone as sealed beams
  (HMAC over a shared camp passphrase, per-writer versioning, conflict
  copies preserved, multi-hop gossip) — designed, built, and
  device-verified in a day.
- The survival guide grew its credited layers (official material summarized
  with sources; the Burn.Life veteran-technique layer credited per-article),
  and pack import tooling landed.

## 0.1.0 — An Angel in your pocket (Aug 13)

- Day one: a React Native app with a fully local LLM (llama.rn + GGUF),
  SQLite with FTS5, data packs, the Right Now event surface, the
  conversation loop with local search tools — and spoken replies through
  the phone's own offline voice, because hands are for bikes.
