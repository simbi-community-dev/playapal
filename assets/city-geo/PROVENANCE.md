# 2026 city geometry — data provenance

`geometry.json` (year 2026, no fixture marker) was built on **2026-08-19** by
`tools/build_city_geo.py` from `tools/data/layout2026.json` (our construction,
every number sourced below) plus the official 2026 toilets GeoJSON. This file
records every input number, its source, license, and retrieval date. It feeds
`THIRD_PARTY_NOTICES.md` (data provenance section).

Build command (reproducible):

```sh
curl -sO https://raw.githubusercontent.com/burningmantech/innovate-GIS-data/master/2026/GeoJSON/toilets.geojson
python3 tools/build_city_geo.py tools/data/layout2026.json toilets.geojson
```

## Sources

All retrieved **2026-08-19**.

1. **"BURNING MAN 2026 LOCATION DATA AND MEASUREMENTS" (2.25.2026)** — PDF,
   Burning Man Project.
   <https://bm-innovate.s3.amazonaws.com/2026/2026%20BRC%20Measurements.pdf>
   (linked from <https://innovate.burningman.org/dataset/2026-golden-spike-and-general-city-map-data/>)
   sha256 `b5bd940d10e7f3f01d16f655114362f117a122732814f9b4456fffe3388b1070`
2. **2026 GIS Map Data** — Burning Man Project official survey export
   (released 2026-07-13), repo `burningmantech/innovate-GIS-data`, path
   `2026/GeoJSON/` at master retrieved 2026-08-19.
   <https://github.com/burningmantech/innovate-GIS-data>
   - `toilets.geojson` sha256 `c86cfa7fe3d6960aeec8af2aa70fc1431d0424aabe0cddb61a62db48c51ef1eb`
     (45 Polygon banks — the direct build input)
   - `street_lines.geojson` sha256 `fb50361c74e598f361d28932aa19c9c85d39aef779e07c4d115e093f00e2d6ac`
     (cross-check + segment derivation)
   - `plazas.geojson` sha256 `d7b683738eae3435f0ae52f159f043d80f17407203395b154d74c5ae9d0af881`
   - `trash_fence.geojson` sha256 `652f0b7a8035cbb4c23267cf06c26be6ae60797fe5c5dafd87bf2346da8a8d0a`
3. **"The Streets of Black Rock City – 2026 Edition"** — Burning Man Journal
   (street names A–K).
   <https://journal.burningman.org/2026/04/black-rock-city/building-brc/streets-of-brc-2026/>
   Cross-checked against the 2026 BRC Plan page:
   <https://burningman.org/black-rock-city/black-rock-city-2026/2026-black-rock-city-plan/>
4. **2026 City Plan — Survival Guide** (plaza portals, The Canopy "stretches
   across an acre", walk-in camping, double-wide blocks).
   <https://survival.burningman.org/city-infrastructure/2026-city-plan/>
5. **NOAA NCEI geomagnetic calculator** (WMM-2025 model) — declination at the
   2026 Man site (40.7832, −119.2079) for 2026-08-30: **12.85° E**
   (±0.36°, `declination_sv` −0.096°/yr).
   <https://www.ngdc.noaa.gov/geomag-web/calculators/calculateDeclination>

**License/terms**: sources 1, 2, 3, 4 are Burning Man Project publications
governed by the Terms of Service for Burning Man APIs and Datasets
(<https://innovate.burningman.org/terms-of-service-for-burning-man-apis-and-datasets/>;
participant projects, non-commercial — Playa Pal is a free participant
companion app). The GIS repo's LICENSE.md defers to those same terms. NOAA
data is US-government public domain.

## Every number in layout2026.json / geometry.json

| Field | Value | Source |
|---|---|---|
| `center` (golden spike / the Man) | 40.783242, −119.207871 | PDF (1); GIS fence + street data georegister to it within ~0.3 ft |
| `bearingDeg` (true bearing of 12:00 axis) | 45 | PDF (1): "True North/South follows the 4:30 axis" ⇒ 12:00 axis = 45° true; verified against GIS (2) radial centerlines: 2:00 → 104.99°, 4:30 → 180.05°, 7:30 → 270.02°, 10:00 → 344.95° (each = 45 + h·30 within 0.1°) |
| `fenceDistanceFt` | 8287 | PDF (1): "Man to outer fence pentagon points: 8287'"; GIS (2) trash-fence vertices measure 8283–8285 ft, and match the PDF's five fence-point coordinates |
| Esplanade | 2500 | PDF (1): "center of the first road, 'Esplanade,' is 2,500' from the Man"; GIS centerline mean 2500.4 ft |
| A (Ararat) | 2935 | PDF block depths (Esplanade→A block 400' deep + half-widths: 2500+20+400+15); GIS mean 2935.5 |
| B (Bodhi) | 3215 | PDF (1): B plazas "centered 3215' from the Man"; GIS mean 3215.5 |
| C (Ceiba) | 3495 | PDF depth chain (A–E blocks 250' deep); GIS mean 3495.5 |
| D (Delphi) | 3775 | same chain; GIS mean 3775.5 |
| E (Eternal) | 4060 | same chain (E is 40' wide); GIS mean 4060.5 |
| F (Fulcrum) | 4545 | PDF "mid-city double blocks between E and F are 450' deep"; GIS mean 4545.5 |
| G (Great Oak) | 4825 | PDF (1): mid-city plazas "at Gibson [sic], centered 4,825' from the Man" (the PDF, dated 2.25.2026, still carries 2025 street names; the 2026 names come from source 3); GIS mean 4825.5 |
| H (Heiau) | 5105 | depth chain; GIS mean 5105.5 |
| I (Iroko) | 5385 | depth chain; GIS mean 5385.5 |
| J (Jiba) | 5565 | depth chain (I–K blocks 150' deep); GIS mean 5565.6 |
| K (Kundalini) | 5755 | PDF (1): "the outer road K is 11,510' in diameter" ⇒ r = 5755; GIS mean 5755.5 |
| Ring `segments` | Esplanade [2:00–5:35, 6:25–10:00]; A–I, K [2:00–10:00]; J [2:30–9:30] | derived from GIS (2) street_lines per-feature endpoints. The Esplanade gap is the Center Camp keyhole; J's short span matches the plan's double-wide blocks at 2:00–2:30 and 9:30–10:00 (3, plan page) |
| Street names A–K | Ararat, Bodhi, Ceiba, Delphi, Eternal, Fulcrum, Great Oak, Heiau, Iroko, Jiba, Kundalini | Journal (3), confirmed on the 2026 BRC Plan page |
| `centerCamp.distanceFt` | 2999 | PDF (1): "Man to the center of The Canopy = 2,999'"; GIS Center Camp Plaza centroid measures 2999.6 ft at exactly 6:00 |
| `centerCamp.plazaRadiusFt` | 260 | GIS (2) plazas.geojson "Center Camp Plaza" circle radius 260.0 ft |
| `centerCamp.cafeRadiusFt` | 118 | Survival Guide (4): The Canopy "stretches across an acre" ⇒ circular-acre radius √(43560/π) ≈ 117.75 ft (display-only field; unused by the address math) |
| `radials` | 2:00–10:00 every :15, plus 12:00 | GIS (2) radial centerlines (:45/:15 spokes between F and K are the 20'-wide Community Paths, PDF 1); 12:00 promenade present in GIS + CPN data |
| `declinationDeg` | 12.85 | NOAA (5) |
| `toilets` (45 banks) | polygon vertex-average centroids | GIS (2) toilets.geojson, 45 Polygon features → 45 deduped banks |

Not encoded (documented divergences): the 2026 plazas at B and G
(3:00/4:30/7:30/9:00 at B; 3:00/4:30/6:00/7:30/9:00 at G, radius 100 ft in
GIS) and the 2:00/10:00 B plazas have no slot in the geometry schema — same
fidelity as the 2025 build, addresses there resolve to the ring street. The
fence stays a circle of `fenceDistanceFt` (real pentagon sides 9,742';
corner behavior documented in `src/geo/brcGeo.ts`).

## Camp placement data (event-card → compass join): NOT PUBLIC YET

Checked 2026-08-19 for a camp-name → address dataset:

- `iburnapp/iBurn-Data` has **no `data/2026/`** (years end at 2025; the 2025
  placement data landed **2025-08-23/24**, i.e. at gate opening).
- Burning Man Public API (<https://api.burningman.org>) `camp` endpoint
  returns 401 without a key. Per the official APIs page
  (<https://innovate.burningman.org/apis-page/>): 2026 **Camp Location
  Fields** were "Released to developers – August 9th 12am PDT" and go
  "Public to users – **August 23th [sic] 12am PDT**" (art locations:
  public Aug 30).
- The 2025-pattern "Public Camps Map" S3 drops do not exist yet for 2026
  (`https://bm-innovate.s3.amazonaws.com/2026/camp_outlines_2026.geojson`
  and `camp_names_2026.geojson` → 403;
  `https://innovate.burningman.org/dataset/2026-public-camps-map/` → 404 as
  of 2026-08-19). In 2025 these landed 2025-08-24.
- playaevents.burningman.org event pages still show camp names only (our
  2026 crawl: 5,276 events, zero playa addresses).

**Watch points** (expected ~2026-08-23, before the app-freeze):
`innovate.burningman.org/dataset/2026-public-camps-map/`, the two S3
GeoJSON URLs above, `iburnapp/iBurn-Data` gaining `data/2026/`, and the
Public API camp endpoint (a free API key gets location fields now, but
under the developer embargo those may not be shipped to users before
Aug 23). `tools/load_events.py --iburn-camps camp.json` already consumes
the iBurn camp format (`location_string` / `location.intersection`), so the
join is a rerun, not new code.
