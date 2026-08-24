#!/usr/bin/env python3
"""
build_city_geo.py — iBurn city layout + toilets -> assets/city-geo/geometry.json

Converts the yearly iBurn-published Black Rock City geometry (layout.json:
golden-spike center, 12:00-axis bearing, ring/radial streets in FEET from the
Man) plus the toilet-bank GeoJSON into the single bundled asset the app's
src/geo/brcGeo.ts math consumes. Stdlib only; runs fully offline.

    python3 tools/build_city_geo.py <layout.json> <toilets.geojson> \
        [--out assets/city-geo/geometry.json] [--year 2026] [--declination 12.8]

THE 2026 BUILD LANDED 2026-08-19 (assets/city-geo/PROVENANCE.md has every
number's source). iBurn had not published a 2026 layout yet, so the layout
input is tools/data/layout2026.json — our construction in the same shape,
from Burning Man's official 2026 measurements PDF + innovate GIS centerlines
— and the toilets input is the official innovate-GIS-data 2026 toilets
GeoJSON (Polygon-only; the Point-dedupe path below is iBurn-specific).
Everything downstream is parameterized on this one JSON — no code changes.

Field notes:
- layout.json `bearing` is the TRUE bearing of the city's 12:00 axis
  (45 deg = the Temple/deep-playa promenade points northeast in 2025).
- Ring `distance` values are feet from the golden spike to the street
  centerline; `segments` are the clock spans the street actually exists on
  (the Esplanade's 5:45-6:14 gap is the Center Camp keyhole).
- The toilets file carries each bank twice: a Polygon outline AND a Point
  that is exactly the polygon's vertex-average centroid (verified on the
  2025 data: max point-to-centroid distance 0.0 ft). We dedupe to one
  [lon, lat] per bank.
- `declinationDeg` (magnetic -> true correction, east positive) is per-year:
  NOAA NCEI magnetic-declination calculator (WMM2025 model) for Black Rock
  City (40.79 N, 119.20 W) gives ~12.9 E for Aug 2025, drifting down ~0.1
  deg/year. Compass-arrow use only; +/-1 deg is invisible at that scale.
"""

import argparse
import json
import re
import sys
from pathlib import Path

# NOAA NCEI (WMM2025), Black Rock City, late August of each year.
# 2026: NOAA geomag API (calculateDeclination, 40.7832/-119.2079, 2026-08-30)
# returned 12.85066 deg E (±0.36), retrieved 2026-08-19.
DECLINATION_BY_YEAR = {2025: 12.9, 2026: 12.85}
FIXTURE_YEARS_BEFORE = 2026  # any build older than the target year is a fixture


def clock_to_minutes(clock: str) -> int:
    h, m = clock.split(":")
    return int(h) * 60 + int(m)


def vertex_average(polygon_coords):
    """Centroid convention of the upstream data: plain vertex average of the
    outer ring, closing vertex dropped. Matches the file's own Points."""
    ring = polygon_coords[0]
    if ring[0] == ring[-1]:
        ring = ring[:-1]
    lon = sum(c[0] for c in ring) / len(ring)
    lat = sum(c[1] for c in ring) / len(ring)
    return [round(lon, 6), round(lat, 6)]  # 1e-6 deg ~ 0.3 ft


def build(layout_path: Path, toilets_path: Path, year: int, declination: float):
    layout = json.loads(layout_path.read_text())
    toilets_geo = json.loads(toilets_path.read_text())

    center_lon, center_lat = layout["center"]["geometry"]["coordinates"]

    rings = [
        {
            "ref": s["ref"],
            "name": s["name"],
            "distanceFt": s["distance"],
            "segments": s["segments"],
        }
        for s in layout["cStreets"]
    ]
    rings.sort(key=lambda r: r["distanceFt"])

    radials = sorted(
        {ref for street in layout["tStreets"] for ref in street["refs"]},
        key=clock_to_minutes,
    )

    cc = layout["center_camp"]
    center_camp = {
        # The layout file never states it, but Center Camp sits on the 6:00
        # axis by construction of the city (iBurn hardcodes the same).
        "clock": "6:00",
        "distanceFt": cc["distance"],
        "plazaRadiusFt": cc["cafe_plaza_radius"],
        "cafeRadiusFt": cc["cafe_radius"],
    }

    banks = []
    seen = set()
    for feature in toilets_geo["features"]:
        geom = feature["geometry"]
        if geom["type"] == "Polygon":
            pt = vertex_average(geom["coordinates"])
        elif geom["type"] == "Point":
            pt = [round(geom["coordinates"][0], 6), round(geom["coordinates"][1], 6)]
        else:
            continue
        key = (pt[0], pt[1])
        if key not in seen:
            seen.add(key)
            banks.append(pt)
    # Stable order for diffable rebuilds: north-to-south, then west-to-east.
    banks.sort(key=lambda p: (-p[1], p[0]))

    out = {
        "year": year,
        "generator": "tools/build_city_geo.py",
        "center": {"lat": center_lat, "lon": center_lon},
        "bearingDeg": layout["bearing"],
        "declinationDeg": declination,
        "fenceDistanceFt": layout["fence_distance"],
        "centerCamp": center_camp,
        "rings": rings,
        "radials": radials,
        "toilets": banks,
    }
    if year < FIXTURE_YEARS_BEFORE:
        out["fixture"] = f"{year} DEV FIXTURE — replace on the {FIXTURE_YEARS_BEFORE} drop"
    return out, len(toilets_geo["features"])


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("layout", type=Path, help="iBurn layout.json")
    ap.add_argument("toilets", type=Path, help="iBurn toilets .geojson")
    ap.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "assets/city-geo/geometry.json",
    )
    ap.add_argument(
        "--year",
        type=int,
        default=None,
        help="City year; default: first 20xx in the layout filename",
    )
    ap.add_argument(
        "--declination",
        type=float,
        default=None,
        help="Magnetic declination deg (east positive); default: built-in NOAA table",
    )
    args = ap.parse_args()

    year = args.year
    if year is None:
        m = re.search(r"(20\d\d)", args.layout.name)
        if not m:
            sys.exit("Cannot infer --year from the layout filename; pass --year.")
        year = int(m.group(1))

    declination = args.declination
    if declination is None:
        declination = DECLINATION_BY_YEAR.get(year)
        if declination is None:
            sys.exit(
                f"No declination on file for {year}; pass --declination "
                "(NOAA NCEI calculator, Black Rock City, late August)."
            )

    out, toilet_features = build(args.layout, args.toilets, year, declination)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, indent=1) + "\n")

    print(f"wrote {args.out}")
    print(f"  year {out['year']}" + ("  (DEV FIXTURE)" if "fixture" in out else ""))
    print(f"  center {out['center']['lat']}, {out['center']['lon']}  bearing {out['bearingDeg']} deg")
    print(f"  rings {len(out['rings'])}  radials {len(out['radials'])}")
    print(f"  toilets: {toilet_features} features -> {len(out['toilets'])} banks")
    print(f"  declination {out['declinationDeg']} deg E  fence {out['fenceDistanceFt']} ft")


if __name__ == "__main__":
    main()
