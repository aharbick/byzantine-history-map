"""Audit place coordinates against Wikipedia.

For each place in entities.json with a wikipedia_url, hit the page summary
endpoint and extract the `coordinates` field. Compare to ours and report
discrepancies > THRESHOLD degrees.

Caches Wikipedia coords in data/wikipedia_coords.json so re-runs are fast.

Run:
  python3 data/validate_coords.py
  python3 data/validate_coords.py --refresh   # ignore cache
  python3 data/validate_coords.py --apply     # write the corrected coords back
                                              # to per-episode JSONs
"""

import argparse
import json
import math
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).parent
ENTITIES_PATH = ROOT / "entities.json"
CACHE_PATH = ROOT / "wikipedia_coords.json"

USER_AGENT = (
    "ByzantineRulersInteractive/0.1 (https://github.com/aharbick/byzantine_rulers; "
    "contact: andy@bidwrangler.com)"
)
API_TEMPLATE = "https://en.wikipedia.org/api/rest_v1/page/summary/{title}"

# Discrepancies above this in degrees of (lat or lng) are flagged
THRESHOLD_DEG = 0.5


def title_from_url(url: str) -> str | None:
    if not url:
        return None
    parsed = urllib.parse.urlparse(url)
    if not parsed.netloc.endswith("wikipedia.org"):
        return None
    parts = parsed.path.split("/wiki/", 1)
    if len(parts) != 2 or not parts[1]:
        return None
    return urllib.parse.unquote(parts[1])


def fetch_coords(title: str, max_retries: int = 3) -> dict | None:
    encoded = urllib.parse.quote(title.replace(" ", "_"), safe="")
    url = API_TEMPLATE.format(title=encoded)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})

    backoff = 1.0
    for _ in range(max_retries):
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.load(resp)
            break
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(backoff)
                backoff *= 2
                continue
            return None
        except Exception:
            return None
    else:
        return None

    coords = data.get("coordinates")
    if coords and "lat" in coords and "lon" in coords:
        return {"lat": coords["lat"], "lng": coords["lon"], "title": title}
    return None


def haversine_km(a, b):
    R = 6371.0
    lat1, lng1 = math.radians(a["lat"]), math.radians(a["lng"])
    lat2, lng2 = math.radians(b["lat"]), math.radians(b["lng"])
    dlat = lat2 - lat1
    dlng = lng2 - lng1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--delay", type=float, default=0.15)
    parser.add_argument(
        "--threshold-km",
        type=float,
        default=80.0,
        help="Flag any place where Wikipedia coords differ from ours by > N km",
    )
    args = parser.parse_args()

    entities = json.load(open(ENTITIES_PATH))
    cache = json.load(open(CACHE_PATH)) if (CACHE_PATH.exists() and not args.refresh) else {}

    targets = []
    for p in entities["places"]:
        if not p.get("wikipedia_url"):
            continue
        if p.get("lat") is None or p.get("lng") is None:
            continue
        if p["id"] in cache:
            continue
        targets.append(p)

    if targets:
        print(f"Fetching Wikipedia coords for {len(targets)} places (cache has {len(cache)})...")

        def work(p):
            title = title_from_url(p["wikipedia_url"])
            if not title:
                return p["id"], None
            r = fetch_coords(title)
            time.sleep(args.delay)
            return p["id"], r

        with ThreadPoolExecutor(max_workers=args.workers) as ex:
            futures = [ex.submit(work, p) for p in targets]
            for i, fut in enumerate(as_completed(futures)):
                pid, coords = fut.result()
                cache[pid] = coords
                if (i + 1) % 25 == 0 or (i + 1) == len(targets):
                    print(f"  {i + 1}/{len(targets)}")
                    with open(CACHE_PATH, "w") as f:
                        json.dump(cache, f, indent=2, sort_keys=True, ensure_ascii=False)

        with open(CACHE_PATH, "w") as f:
            json.dump(cache, f, indent=2, sort_keys=True, ensure_ascii=False)
    else:
        print(f"All places cached ({sum(1 for v in cache.values() if v)} hits).")

    # Compare
    print("\n=== Discrepancies ===")
    flagged = []
    for p in entities["places"]:
        wiki = cache.get(p["id"])
        if not wiki:
            continue
        if p.get("lat") is None or p.get("lng") is None:
            continue
        ours = {"lat": p["lat"], "lng": p["lng"]}
        dist = haversine_km(ours, wiki)
        if dist >= args.threshold_km:
            flagged.append((dist, p, wiki))

    flagged.sort(reverse=True)
    print(f"\n{len(flagged)} places differ by >= {args.threshold_km} km:\n")
    for dist, p, wiki in flagged:
        ours = (p["lat"], p["lng"])
        wikic = (wiki["lat"], wiki["lng"])
        print(f"  {dist:7.0f} km   {p['name']:35} ours={ours}  wiki={wikic}  ({p['id']})")

    if flagged:
        # Write a JSON file with proposed corrections
        out_path = ROOT / "coord_corrections.json"
        corrections = {
            p["id"]: {"name": p["name"], "old": {"lat": p["lat"], "lng": p["lng"]}, "new": {"lat": wiki["lat"], "lng": wiki["lng"]}, "diff_km": round(dist, 1)}
            for dist, p, wiki in flagged
        }
        with open(out_path, "w") as f:
            json.dump(corrections, f, indent=2, ensure_ascii=False)
        print(f"\nProposed corrections written to {out_path}")


if __name__ == "__main__":
    main()
