"""Fetch + filter Byzantine territory GeoJSON keyframes for the in-app
empire-territory overlay.

Source: aourednik/historical-basemaps on GitHub. Free, CC-BY licensed,
hand-curated political boundaries at century intervals. Each `world_<year>`
file contains every polity at that snapshot — we strip everything except
the Eastern Roman / Byzantine Empire feature(s) so the file we ship to
the browser is ~25KB instead of ~1MB.

For 300 AD (Diocletian's tetrarchy) the source has no single eastern
empire — the empire was split into four tetrarchic prefectures. We
combine the Diocletianus (East: Egypt, Syria, Asia Minor) and Galerius
(Balkans) territories so the early Byzantine narrative still has a
visible "this is the empire" overlay.

Run:
    python3 data/build_empire.py

Writes one slim GeoJSON Feature file per year to `web/public/empire/`.
The slim files contain just `{type, geometry, properties: {year, name}}`
— no `ABBREVN`, no `SUBJECTO`, no `BORDERPRECISION` chatter. Re-run any
time the upstream data set is refreshed; the keyframe years are static.
"""

from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
REPO = ROOT.parent
OUT_DIR = REPO / "web" / "public" / "empire"

UA = "ByzantineRulersInteractive/2.0 (https://github.com/aharbick/byzantine-history-map)"
SRC_BASE = "https://raw.githubusercontent.com/aourednik/historical-basemaps/master/geojson"

# Keyframes spanning the Byzantine narrative (Diocletian -> Constantine XI).
# Every century is enough resolution for a smooth crossfade — the
# territory only changes substantially at ~100-year scales.
KEYFRAMES = [300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400]


def fetch_world(year: int) -> dict:
    url = f"{SRC_BASE}/world_{year}.geojson"
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def feature_name(f: dict) -> str:
    return (f.get("properties") or {}).get("NAME") or ""


def is_eastern_roman(name: str) -> bool:
    n = name.lower()
    if "byz" in n:
        return True
    # "Eastern Roman Empire" — only the eastern half, not Western Rome.
    return "roman" in n and "east" in n


def is_tetrarchic_east(name: str) -> bool:
    """For 300 AD: pre-formal-split tetrarchy. Diocletian held the
    eastern dioceses (Aegypt, Oriens, Pontica, Asiana); Galerius held
    the Balkan dioceses (Moesia, Thracia). Together they're a fair
    visual stand-in for the territory that becomes the Eastern Roman
    Empire after 395."""
    return name in ("Rome (Diocletianus)", "Rome (Galerius)")


def merge_geometries(features: list[dict]) -> dict:
    """Combine multiple Polygon/MultiPolygon features into a single
    MultiPolygon. We don't try to dissolve overlapping borders — the
    upstream data already partitions cleanly by polity, so just
    concatenating the constituent polygon rings is enough for a fill
    layer to render correctly."""
    polys: list[list] = []
    for f in features:
        g = f.get("geometry") or {}
        t = g.get("type")
        coords = g.get("coordinates") or []
        if t == "Polygon":
            polys.append(coords)
        elif t == "MultiPolygon":
            polys.extend(coords)
        else:
            print(f"  warn: skipping unsupported geometry {t}", file=sys.stderr)
    return {"type": "MultiPolygon", "coordinates": polys}


def build_year(year: int) -> dict | None:
    print(f"[{year}] fetching...", end=" ", flush=True)
    data = fetch_world(year)
    if year == 300:
        feats = [f for f in data["features"] if is_tetrarchic_east(feature_name(f))]
        label = "Tetrarchic East (Diocletian + Galerius)"
    else:
        feats = [f for f in data["features"] if is_eastern_roman(feature_name(f))]
        label = (
            "Byzantine Empire" if any("byz" in feature_name(f).lower() for f in feats)
            else "Eastern Roman Empire"
        )
    if not feats:
        print("no eastern feature found — skipping")
        return None
    geom = merge_geometries(feats) if len(feats) > 1 else feats[0]["geometry"]
    print(f"merged {len(feats)} feature(s) -> {label}")
    return {
        "type": "Feature",
        "properties": {"year": year, "name": label},
        "geometry": geom,
    }


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    written: list[tuple[int, int]] = []
    for y in KEYFRAMES:
        feat = build_year(y)
        if feat is None:
            continue
        out_path = OUT_DIR / f"{y}.json"
        # No indent — these are static assets fetched at runtime, never
        # human-read. Compact JSON saves bandwidth on the marginal MB.
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(feat, f, ensure_ascii=False, separators=(",", ":"))
        written.append((y, out_path.stat().st_size))
    # Manifest so the client knows what years are available without a
    # separate fetch round-trip.
    manifest = {
        "keyframes": [{"year": y, "path": f"/empire/{y}.json", "size": sz}
                      for y, sz in written],
    }
    with open(OUT_DIR / "manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
    total = sum(sz for _, sz in written)
    print(f"\nWrote {len(written)} keyframe(s), {total // 1024} KB total to {OUT_DIR}")


if __name__ == "__main__":
    main()
