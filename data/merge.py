"""Merge per-episode JSON extractions into a single canonical entities.json.

Reads:  data/episodes/ep*.json
Writes: data/entities.json

Per-entity merge rules:
- `episodes`: union (which episodes mention this entity)
- `summaries_by_episode`: dict {ep: summary} — preserves what each episode said
- `summary`: the longest summary (used as the card's default text)
- `transcript_lines_by_episode`: dict {ep: [[start,end],...]} for podcast deep-linking
- scalar fields (years, lat/lng, wikipedia_url, role, ...): first non-null wins
- list fields (alt_names, related): unioned/deduped
"""

import json
import glob
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).parent

# Canonicalization map for known id mismatches across episodes.
# Maps "alias id" -> "canonical id". Add entries as you discover more.
ID_ALIASES = {
    # people
    "gibbon-edward": "edward-gibbon",
    "zeno": "zeno-emperor",
    "augustus-caesar": "augustus",
    # places
    "hippodrome": "hippodrome-of-constantinople",
    "hippodrome-constantinople": "hippodrome-of-constantinople",
    "church-of-holy-apostles": "church-of-the-holy-apostles",
    "church-of-saint-irene": "church-of-hagia-irene",
}

# Hand-corrected place coordinates that override the agent extractions when
# they were clearly wrong (verified by validate_coords.py against Wikipedia).
PLACE_COORD_OVERRIDES: dict[str, tuple[float, float]] = {
    # ancient Atropatene was in NW Iran, not modern Baku
    "azerbaijan": (37.6, 47.0),
    # Tigris River — pick a Mesopotamian midpoint (Baghdad area) rather than
    # the upstream Turkish source so the marker reads as Mesopotamia
    "tigris-river": (33.3, 44.4),
}


def canonical(eid: str) -> str:
    return ID_ALIASES.get(eid, eid)


def merge_scalar(existing, incoming):
    """First non-null wins."""
    if existing is None or existing == "":
        return incoming
    return existing


def merge_list(existing, incoming):
    """Union, preserving order; dedupe by str repr for dicts."""
    if existing is None:
        existing = []
    if incoming is None:
        incoming = []
    seen = set()
    out = []
    for item in existing + incoming:
        key = json.dumps(item, sort_keys=True) if isinstance(item, dict) else item
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out


def merge_entity(existing, incoming, ep):
    """Merge an entity from a new episode into the canonical record."""
    if existing is None:
        # First time we see this entity
        merged = {
            "id": canonical(incoming["id"]),
            "name": incoming["name"],
            "alt_names": list(incoming.get("alt_names") or []),
            "summary": incoming.get("summary") or "",
            "summaries_by_episode": {str(ep): incoming.get("summary") or ""},
            "transcript_lines_by_episode": {str(ep): incoming.get("transcript_lines") or []},
            "episodes": [ep],
            "wikipedia_url": incoming.get("wikipedia_url"),
            "related": [
                {"type": r["type"], "id": canonical(r["id"])}
                for r in (incoming.get("related") or [])
            ],
        }
        # Type-specific scalars
        for k in (
            "role", "birth_year", "death_year", "reign_start", "reign_end",
            "modern_name", "modern_country", "lat", "lng", "first_year",
            "year", "end_year", "category", "location_id",
            "portrait_url", "image_url",
        ):
            if k in incoming:
                merged[k] = incoming[k]
        if "location_id" in merged and merged["location_id"]:
            merged["location_id"] = canonical(merged["location_id"])
        return merged

    # Update existing
    existing["alt_names"] = merge_list(existing["alt_names"], incoming.get("alt_names") or [])
    existing["summaries_by_episode"][str(ep)] = incoming.get("summary") or ""
    existing["transcript_lines_by_episode"][str(ep)] = incoming.get("transcript_lines") or []
    if ep not in existing["episodes"]:
        existing["episodes"].append(ep)
    # Pick the longest summary as canonical
    if len(incoming.get("summary") or "") > len(existing["summary"] or ""):
        existing["summary"] = incoming["summary"]
    existing["wikipedia_url"] = merge_scalar(existing.get("wikipedia_url"), incoming.get("wikipedia_url"))
    incoming_related = [
        {"type": r["type"], "id": canonical(r["id"])}
        for r in (incoming.get("related") or [])
    ]
    existing["related"] = merge_list(existing["related"], incoming_related)
    for k in (
        "role", "birth_year", "death_year", "reign_start", "reign_end",
        "modern_name", "modern_country", "lat", "lng", "first_year",
        "year", "end_year", "category", "location_id",
        "portrait_url", "image_url",
    ):
        if k in incoming and incoming[k] is not None:
            existing[k] = merge_scalar(existing.get(k), incoming[k])
    if existing.get("location_id"):
        existing["location_id"] = canonical(existing["location_id"])
    return existing


def _load_portraits() -> dict:
    """Load Wikipedia thumbnail/image cache produced by fetch_portraits.py.
    Maps entity id -> {thumbnail, image, wiki_description, wiki_extract} or None."""
    p = ROOT / "portraits.json"
    if not p.exists():
        return {}
    return json.load(open(p))


def _load_synthesized() -> dict:
    """Load LLM-synthesized unified summaries produced by synthesize_summaries.py.
    Maps entity id -> {text, hash, model}. Re-injected on every build so a
    re-run of merge.py preserves the synthesis."""
    p = ROOT / "synthesized_summaries.json"
    if not p.exists():
        return {}
    return json.load(open(p))


def _is_pre_or_post_byzantine_person(p: dict) -> bool:
    """True if this person is clearly outside the Byzantine era window — modern
    scholars (Gibbon, Norwich, Bury, Ostrogorski), Founding Fathers,
    pre-imperial ancients (Solomon, Hannibal, Pompey, Caesar). Brownworth
    references them as analogies; they don't deserve their own card.
    """
    by = p.get("birth_year")
    dy = p.get("death_year")
    rs = p.get("reign_start")
    re_ = p.get("reign_end")

    # Modern figures (born after the fall of Constantinople)
    if isinstance(by, int) and by > 1500:
        return True
    if isinstance(rs, int) and rs > 1500:
        return True

    # Pre-imperial / pre-Byzantine ancients (died before 100 AD)
    # Threshold of 100 AD includes Roman emperors of Crisis (235+), Severans (193+),
    # Marcus Aurelius (d. 180) — Brownworth's reach-back examples — by being
    # generous; excludes Augustus, Caesar, Hannibal, Solomon, Jesus.
    if isinstance(dy, int) and dy < 100:
        # If they reigned into the Byzantine window despite dying early, keep
        if isinstance(re_, int) and re_ >= 100:
            return False
        return True

    return False


def _is_pre_or_post_byzantine_event(e: dict) -> bool:
    y = e.get("year")
    if y is None:
        return False  # no date — keep, can't judge
    return y < 100 or y > 1500


def main():
    people_by_id = {}
    places_by_id = {}
    events_by_id = {}
    skipped_ids: set[str] = set()  # ids dropped as out-of-era

    episodes_meta = []
    portraits = _load_portraits()
    synthesized = _load_synthesized()

    for path in sorted(glob.glob(str(ROOT / "episodes" / "ep*.json"))):
        data = json.load(open(path))
        ep = data["episode"]
        # Count transcript lines so the frontend can compute "seek to roughly
        # where this entity is mentioned" as (first_mention_line / total_lines)
        # × audio.duration. Constant-pace narration approximation; accurate to
        # ~30s for Brownworth's measured delivery.
        tpath = ROOT.parent / "transcripts" / _transcript_filename(ep)
        total_lines = sum(1 for _ in open(tpath, encoding="utf-8")) if tpath.exists() else 0
        episodes_meta.append({
            "episode": ep,
            "title": data["title"],
            "audio_file": _audio_filename(ep),
            "transcript_file": _transcript_filename(ep),
            "total_transcript_lines": total_lines,
        })
        for person in data.get("people", []):
            cid = canonical(person["id"])
            if _is_pre_or_post_byzantine_person(person):
                skipped_ids.add(cid)
                continue
            people_by_id[cid] = merge_entity(people_by_id.get(cid), person, ep)
        for place in data.get("places", []):
            cid = canonical(place["id"])
            places_by_id[cid] = merge_entity(places_by_id.get(cid), place, ep)
        for event in data.get("events", []):
            cid = canonical(event["id"])
            if _is_pre_or_post_byzantine_event(event):
                skipped_ids.add(cid)
                continue
            events_by_id[cid] = merge_entity(events_by_id.get(cid), event, ep)

    # Sort entities (people by birth_year then name; places alpha; events by year)
    people = sorted(
        people_by_id.values(),
        key=lambda p: (p.get("birth_year") or p.get("reign_start") or 9999, p["name"]),
    )
    places = sorted(places_by_id.values(), key=lambda p: p["name"])
    events = sorted(events_by_id.values(), key=lambda e: (e.get("year") or 9999, e["name"]))

    # Apply hand-curated place coord overrides.
    for place_id, (lat, lng) in PLACE_COORD_OVERRIDES.items():
        if place_id in places_by_id:
            places_by_id[place_id]["lat"] = lat
            places_by_id[place_id]["lng"] = lng

    # Strip related references to entities we dropped as out-of-era.
    if skipped_ids:
        for entities_list in (people_by_id.values(), places_by_id.values(), events_by_id.values()):
            for ent in entities_list:
                ent["related"] = [r for r in (ent.get("related") or []) if r["id"] not in skipped_ids]

    # Inject portraits from cache.
    portrait_hits = 0
    for p in people:
        info = portraits.get(p["id"])
        if info:
            if info.get("thumbnail"):
                p["portrait_url"] = info["thumbnail"]
                portrait_hits += 1
            if info.get("image"):
                p["portrait_full_url"] = info["image"]
            if info.get("wiki_description") and not p.get("role"):
                p["role"] = info["wiki_description"]
    image_hits = 0
    for entities_list in (places, events):
        for e in entities_list:
            info = portraits.get(e["id"])
            if info:
                if info.get("thumbnail"):
                    e["image_url"] = info["thumbnail"]
                    image_hits += 1
                if info.get("image"):
                    e["image_full_url"] = info["image"]

    # Inject synthesized summaries from cache. The frontend prefers
    # `summary_synthesized` over `summary` on the card, so this is what
    # most users will see when an entity has 2+ episode mentions.
    synth_hits = 0
    for entities_list in (people, places, events):
        for ent in entities_list:
            info = synthesized.get(ent["id"])
            if info and info.get("text"):
                ent["summary_synthesized"] = info["text"]
                synth_hits += 1

    out = {
        "episodes": sorted(episodes_meta, key=lambda e: e["episode"]),
        "people": people,
        "places": places,
        "events": events,
        "stats": {
            "people": len(people),
            "places": len(places),
            "events": len(events),
            "portraits": portrait_hits,
            "images": image_hits,
            "synthesized_summaries": synth_hits,
        },
    }

    out_paths = [
        ROOT / "entities.json",                          # canonical (repo source of truth)
        ROOT.parent / "web" / "src" / "data" / "entities.json",  # consumed by Next.js app
    ]
    for out_path in out_paths:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with open(out_path, "w") as f:
            json.dump(out, f, indent=2, ensure_ascii=False)
        print(f"wrote {out_path}")
    print(f"  episodes: {len(episodes_meta)}")
    print(f"  people:   {len(people)}")
    print(f"  places:   {len(places)}")
    print(f"  events:   {len(events)}")

    # Validation: warn on dangling related references
    all_ids = {p["id"] for p in people} | {p["id"] for p in places} | {e["id"] for e in events}
    dangling = []
    for entities in (people, places, events):
        for e in entities:
            for r in e.get("related") or []:
                if r["id"] not in all_ids:
                    dangling.append((e["id"], r))
            loc = e.get("location_id")
            if loc and loc not in all_ids:
                dangling.append((e["id"], {"type": "location", "id": loc}))
    if dangling:
        print(f"\n  WARNING: {len(dangling)} dangling references (related ids that don't exist as canonical entities):")
        for src, ref in dangling[:20]:
            print(f"    {src} -> {ref}")
        if len(dangling) > 20:
            print(f"    ... and {len(dangling) - 20} more")


# audio/transcript filename mapping for all 17 episodes
_TITLES = {
    1: "Episode 1 - Introduction",
    2: "Episode 2 - Diocletian",
    3: "Episode 3 - Constantine - Part 1",
    4: "Episode 4 - Constantine - Part 2",
    5: "Episode 5 - Julian",
    6: "Episode 6 - Zeno",
    7: "Episode 7 - Justinian - Part 1",
    8: "Episode 8 - Justinian - Part 2",
    9: "Episode 9 - Justinian - Part 3",
    10: "Episode 10 - Heraclius",
    11: "Episode 11 - Irene",
    12: "Episode 12 - Basil I",
    13: "Episode 13 - Basil II",
    14: "Episode 14 - Alexius",
    15: "Episode 15 - Isaac",
    16: "Episode 16 - Constantine XI",
    17: "Episode 17 - Conclusion",
}


def _audio_filename(ep: int) -> str:
    return f"{ep:02d} - {_TITLES[ep]}.mp3"


def _transcript_filename(ep: int) -> str:
    return f"{ep:02d} - {_TITLES[ep]}.txt"


if __name__ == "__main__":
    main()
