"""Fetch Wikipedia thumbnail/lead-image URLs for every entity that has a wikipedia_url.

Hits the Wikipedia REST API page/summary endpoint (no auth required, anonymous
rate limits are generous). Caches results to data/portraits.json so subsequent
runs are instant.

Run:
  python3 data/fetch_portraits.py
  python3 data/fetch_portraits.py --refresh   # ignore cache, re-fetch all
"""

import argparse
import json
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).parent
ENTITIES_PATH = ROOT / "entities.json"
CACHE_PATH = ROOT / "portraits.json"

USER_AGENT = (
    "ByzantineRulersInteractive/0.1 (https://github.com/aharbick/byzantine_rulers; "
    "contact: andy@bidwrangler.com)"
)
API_TEMPLATE = "https://en.wikipedia.org/api/rest_v1/page/summary/{title}"


def title_from_url(url: str) -> str | None:
    """Extract the page title from an en.wikipedia.org/wiki/X URL."""
    if not url:
        return None
    parsed = urllib.parse.urlparse(url)
    if not parsed.netloc.endswith("wikipedia.org"):
        return None
    parts = parsed.path.split("/wiki/", 1)
    if len(parts) != 2 or not parts[1]:
        return None
    return urllib.parse.unquote(parts[1])


def fetch_summary(title: str, max_retries: int = 3) -> dict | None:
    """Fetch a single page summary. Returns {thumbnail, image, description, extract} or None.

    Retries on 429 with exponential backoff. Returns None for 404 / other errors.
    """
    encoded = urllib.parse.quote(title.replace(" ", "_"), safe="")
    url = API_TEMPLATE.format(title=encoded)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})

    backoff = 1.0
    for attempt in range(max_retries):
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.load(resp)
            break
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(backoff)
                backoff *= 2
                continue
            if e.code == 404:
                return None
            return None
        except Exception:
            return None
    else:
        return None  # exhausted retries

    out: dict = {}
    thumb = data.get("thumbnail") or {}
    orig = data.get("originalimage") or {}
    if thumb.get("source"):
        out["thumbnail"] = thumb["source"]
    if orig.get("source"):
        out["image"] = orig["source"]
    if data.get("description"):
        out["wiki_description"] = data["description"]
    if data.get("extract"):
        out["wiki_extract"] = data["extract"]
    return out or None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--refresh", action="store_true", help="ignore cache, refetch all")
    parser.add_argument(
        "--workers", type=int, default=3, help="concurrent fetch workers (default 3, polite)"
    )
    parser.add_argument(
        "--delay", type=float, default=0.15, help="per-request delay seconds (default 0.15)"
    )
    args = parser.parse_args()

    entities = json.load(open(ENTITIES_PATH))
    cache: dict = {}
    if CACHE_PATH.exists() and not args.refresh:
        cache = json.load(open(CACHE_PATH))

    # Collect (id, wikipedia_url) for every entity, across all kinds.
    targets: list[tuple[str, str]] = []
    for kind in ("people", "places", "events"):
        for e in entities[kind]:
            if cache.get(e["id"]):
                continue  # already cached
            if not e.get("wikipedia_url"):
                continue
            targets.append((e["id"], e["wikipedia_url"]))

    if not targets:
        print(f"All {sum(1 for v in cache.values() if v)} entities already cached. Use --refresh to re-fetch.")
        return

    print(f"Fetching {len(targets)} new entries (cache has {len(cache)})...")

    successes = 0
    misses = 0

    def work(id_url):
        eid, url = id_url
        title = title_from_url(url)
        if not title:
            return eid, None
        result = fetch_summary(title)
        time.sleep(args.delay)
        return eid, result

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = [ex.submit(work, t) for t in targets]
        for i, fut in enumerate(as_completed(futures)):
            eid, result = fut.result()
            cache[eid] = result  # may be None — record the miss so we don't refetch
            if result:
                successes += 1
            else:
                misses += 1
            if (i + 1) % 25 == 0 or (i + 1) == len(targets):
                print(f"  {i + 1}/{len(targets)}  hits={successes}  misses={misses}")
                # Periodically write cache so progress isn't lost on Ctrl-C
                with open(CACHE_PATH, "w") as f:
                    json.dump(cache, f, indent=2, sort_keys=True, ensure_ascii=False)
                time.sleep(0.05)

    with open(CACHE_PATH, "w") as f:
        json.dump(cache, f, indent=2, sort_keys=True, ensure_ascii=False)

    print(f"\nDone. {successes} portraits, {misses} misses, cache at {CACHE_PATH}")


if __name__ == "__main__":
    main()
