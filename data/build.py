"""Build the unified entities.json from per-episode LLM extractions + Whisper segment transcripts.

Pipeline stages (see data/SCHEMA.md):
  1. Validate Wikipedia URLs and enrich (extract, image, coords).
  2. Find segment-level mentions in transcripts_segments/*.json.
  3. Score per-episode importance + extract verbatim quotes.
  4. (optional, Claude API) Synthesize unified cross-episode summaries.
  5. Emit data/entities.json + web/src/data/entities.json.

Run:
  python3 data/build.py                    # everything except synthesis
  python3 data/build.py --synthesize       # also run Claude pass (needs ANTHROPIC_API_KEY)
  python3 data/build.py --refresh-wiki     # ignore wiki cache, refetch all
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Iterable

ROOT = Path(__file__).parent
REPO = ROOT.parent
EPISODES_DIR = ROOT / "episodes"
SEGMENTS_DIR = REPO / "transcripts_segments"
TRANSCRIPTS_DIR = REPO / "transcripts"
CACHE_DIR = ROOT / "cache"
CACHE_DIR.mkdir(exist_ok=True)
WIKI_CACHE_PATH = CACHE_DIR / "wikipedia.json"
SYNTH_CACHE_PATH = CACHE_DIR / "synthesized_summaries.json"
ENTITIES_OUT = ROOT / "entities.json"
WEB_OUT = REPO / "web" / "src" / "data" / "entities.json"

# Single User-Agent for Wikipedia API politeness.
USER_AGENT = (
    "ByzantineRulersInteractive/2.0 (https://github.com/aharbick/byzantine_rulers; "
    "contact: andy@bidwrangler.com)"
)
WIKI_SUMMARY = "https://en.wikipedia.org/api/rest_v1/page/summary/{title}"

# Episode -> ruler entity id for the 12 ruler episodes.
# Eps 4, 8, 9 are continuations of eps 3, 7, 7 respectively (Constantine pt 2,
# Justinian pts 2 & 3) so they share the same ruler_id.
RULER_BY_EPISODE: dict[int, str | None] = {
    1: None,
    2: "diocletian",
    3: "constantine-the-great",
    4: "constantine-the-great",
    5: "julian-the-apostate",
    6: "zeno-emperor",
    7: "justinian-i",
    8: "justinian-i",
    9: "justinian-i",
    10: "heraclius",
    11: "irene-of-athens",
    12: "basil-i",
    13: "basil-ii",
    14: "alexios-i-komnenos",
    15: "isaac-ii-angelos",
    16: "constantine-xi-palaiologos",
    17: None,
}

# Narrative year anchor per episode: the year the episode is "set in" within
# Brownworth's chronology — used to anchor places/events that the LLM
# otherwise pinned to their pre-Byzantine founding date (Carthage at 814 BC,
# Rome at 753 BC, etc.). Tracks the protagonist's accession year, with
# continuation episodes nudged forward to the marquee event of that part.
EPISODE_NARRATIVE_YEAR: dict[int, int] = {
    1: 284,   # Intro: framed around Diocletian's accession
    2: 284,
    3: 306,
    4: 312,
    5: 361,
    6: 474,
    7: 527,
    8: 532,   # Nika revolt
    9: 540,
    10: 610,
    11: 797,
    12: 867,
    13: 976,
    14: 1081,
    15: 1185,
    16: 1449,
    17: 1453,  # Fall of Constantinople
}

# Ordered list of the 12 rulers (by episode).
TWELVE_RULERS_ORDERED = [
    "diocletian",
    "constantine-the-great",
    "julian-the-apostate",
    "zeno-emperor",
    "justinian-i",
    "heraclius",
    "irene-of-athens",
    "basil-i",
    "basil-ii",
    "alexios-i-komnenos",
    "isaac-ii-angelos",
    "constantine-xi-palaiologos",
]

# Episode title lookup matches the existing audio/transcript filenames.
EPISODE_TITLES: dict[int, str] = {
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

# Canonicalize ids that drift across episodes (the LLM sometimes emits both
# `alexios-i-komnenos` and `alexius-i-komnenos`, etc.). Old ID -> canonical.
ID_ALIASES: dict[str, str] = {
    # people
    "gibbon-edward": "edward-gibbon",
    "zeno": "zeno-emperor",
    "augustus-caesar": "augustus",
    "alexius-i-komnenos": "alexios-i-komnenos",
    "irene": "irene-of-athens",
    "julian": "julian-the-apostate",
    "constantine-xi": "constantine-xi-palaiologos",
    # places
    "hippodrome": "hippodrome-of-constantinople",
    "hippodrome-constantinople": "hippodrome-of-constantinople",
    "church-of-holy-apostles": "church-of-the-holy-apostles",
    "church-of-saint-irene": "church-of-hagia-irene",
}


def canonical_id(eid: str) -> str:
    return ID_ALIASES.get(eid, eid)


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


def url_from_title(title: str) -> str:
    return "https://en.wikipedia.org/wiki/" + urllib.parse.quote(title.replace(" ", "_"), safe="")


# ---------------------------------------------------------------------------
# Stage 1: load + canonicalize per-episode extractions
# ---------------------------------------------------------------------------


def load_episodes() -> tuple[list[dict], dict[str, dict]]:
    """Load every per-episode JSON. Returns (episodes_meta, entities_by_id).

    `entities_by_id` is keyed by canonical id. Each value carries `kind`,
    common fields, and the per-episode summary block under
    `summaries_by_episode`.
    """
    episodes_meta: list[dict] = []
    entities: dict[str, dict] = {}

    for ep_num in sorted(EPISODE_TITLES):
        ep_path = EPISODES_DIR / f"ep{ep_num:02d}.json"
        if not ep_path.exists():
            continue
        ep_data = json.load(open(ep_path, encoding="utf-8"))

        seg_path = SEGMENTS_DIR / f"{ep_num:02d} - {EPISODE_TITLES[ep_num]}.json"
        duration = 0.0
        if seg_path.exists():
            seg_data = json.load(open(seg_path, encoding="utf-8"))
            segs = seg_data.get("segments") or []
            if segs:
                duration = float(segs[-1].get("end") or 0.0)

        episodes_meta.append({
            "episode": ep_num,
            "title": EPISODE_TITLES[ep_num],
            "audio_file": f"{ep_num:02d} - {EPISODE_TITLES[ep_num]}.mp3",
            "transcript_file": f"{ep_num:02d} - {EPISODE_TITLES[ep_num]}.txt",
            "segments_file": f"{ep_num:02d} - {EPISODE_TITLES[ep_num]}.json",
            "duration_seconds": duration,
            "ruler_id": RULER_BY_EPISODE.get(ep_num),
        })

        for plural, kind in (("people", "person"), ("places", "place"), ("events", "event")):
            for raw in ep_data.get(plural, []):
                cid = canonical_id(raw["id"])
                ent = entities.get(cid)
                if ent is None:
                    ent = _new_entity(cid, kind, raw)
                    entities[cid] = ent
                _absorb_episode_data(ent, raw, ep_num)

    return episodes_meta, entities


def _new_entity(cid: str, kind: str, raw: dict) -> dict:
    ent: dict = {
        "id": cid,
        "kind": kind,
        "name": raw["name"],
        "alt_names": list(raw.get("alt_names") or []),
        "wikipedia_url": raw.get("wikipedia_url"),
        "summary": raw.get("summary") or "",
        "summaries_by_episode": {},
        "episodes": [],
        "related": [],
    }
    if kind == "person":
        for k in ("role", "birth_year", "death_year", "reign_start", "reign_end"):
            ent[k] = raw.get(k)
    elif kind == "place":
        for k in ("modern_name", "modern_country", "lat", "lng", "first_year"):
            ent[k] = raw.get(k)
    elif kind == "event":
        for k in ("year", "end_year", "category"):
            ent[k] = raw.get(k)
        loc = raw.get("location_id")
        ent["location_id"] = canonical_id(loc) if loc else None
    return ent


def _absorb_episode_data(ent: dict, raw: dict, ep: int) -> None:
    # Capture the LLM's transcript-line evidence so Stage 3.5 can derive
    # an audio anchor when Whisper's regex scan finds zero hits (the entity
    # was referenced only by pronoun / paraphrase / spelling Whisper missed).
    # Stripped from the final output in `finalize`.
    raw_lines = raw.get("transcript_lines")
    if raw_lines:
        ent.setdefault("transcript_lines_by_episode", {})[str(ep)] = [
            list(r) for r in raw_lines
        ]

    # Merge alt_names (dedupe order-preserving)
    seen = {n.lower() for n in ent["alt_names"]}
    seen.add(ent["name"].lower())
    for n in raw.get("alt_names") or []:
        if n.lower() not in seen:
            ent["alt_names"].append(n)
            seen.add(n.lower())

    # Track which episodes mention this entity
    if ep not in ent["episodes"]:
        ent["episodes"].append(ep)
        ent["episodes"].sort()

    # Per-episode summary stored in nested object so we can also attach score
    # and timing info later in stage 3.
    summary = (raw.get("summary") or "").strip()
    block = ent["summaries_by_episode"].setdefault(str(ep), {})
    if summary and len(summary) > len(block.get("summary") or ""):
        block["summary"] = summary

    # Top-level "canonical" summary keeps the longest per-episode text as a
    # readable fallback; stage 4 may overwrite with a synthesized version.
    if len(summary) > len(ent["summary"]):
        ent["summary"] = summary

    # Wikipedia URL: first non-null wins
    if not ent.get("wikipedia_url") and raw.get("wikipedia_url"):
        ent["wikipedia_url"] = raw["wikipedia_url"]

    # Type-specific scalars: first non-null wins (preserves earliest episode's
    # framing — usually the one where the entity is introduced).
    if ent["kind"] == "person":
        for k in ("role", "birth_year", "death_year", "reign_start", "reign_end"):
            if ent.get(k) is None and raw.get(k) is not None:
                ent[k] = raw[k]
    elif ent["kind"] == "place":
        for k in ("modern_name", "modern_country", "lat", "lng", "first_year"):
            if ent.get(k) is None and raw.get(k) is not None:
                ent[k] = raw[k]
    elif ent["kind"] == "event":
        for k in ("year", "end_year", "category"):
            if ent.get(k) is None and raw.get(k) is not None:
                ent[k] = raw[k]
        if not ent.get("location_id") and raw.get("location_id"):
            ent["location_id"] = canonical_id(raw["location_id"])

    # Related: dedupe by (type, canonical_id) tuple
    have = {(r["type"], r["id"]) for r in ent["related"]}
    for r in raw.get("related") or []:
        cid = canonical_id(r["id"])
        key = (r["type"], cid)
        if key not in have:
            ent["related"].append({"type": r["type"], "id": cid})
            have.add(key)


# ---------------------------------------------------------------------------
# Stage 1.5: derive alt_names so the segment scan picks up bare-noun mentions
# ("True Cross" referring to "True Cross Returned to Jerusalem", etc.)
# ---------------------------------------------------------------------------


# Leading "X of" prefixes that strip down to the noun phrase on the right —
# e.g. "Battle of Manzikert" → "Manzikert", "Discovery of the True Cross" →
# "True Cross". Verb-of-the-protagonist patterns ("Death of Julian") aren't
# useful as aliases since the name on the right is already a different
# entity, but the resulting candidate is filtered out below if it collides.
EVENT_LEAD_PREFIXES = [
    "Battle of",
    "Siege of",
    "Sack of",
    "Fall of",
    "Death of",
    "Discovery of",
    "Assassination of",
    "Coronation of",
    "Founding of",
    "Marriage of",
    "Murder of",
    "Execution of",
    "Defeat of",
    "Overthrow of",
    "Deposition of",
    "Establishment of",
    "Restoration of",
    "Construction of",
    "Dedication of",
    "Abdication of",
    "Council of",
    "Publication of",
    "Persian Conquest of",
    "Byzantine Reconquest of",
    "Crusader Siege of",
]

# Trailing patterns of the form "X Returned to Y" / "X Captured by Y" — the
# noun on the LEFT is the artifact (e.g., "True Cross"). Compiled lazily.
EVENT_TRAIL_PATTERNS = [
    re.compile(r"^(.+?)\s+(?:Returned|Restored|Captured|Sent|Brought)\s+(?:to|from|by)\s+.+$"),
]

# Leading articles to strip from extracted candidates ("the True Cross" → "True Cross").
# Case-insensitive — many event names are "Discovery of the True Cross" with
# lowercase "the" after "of".
LEADING_ARTICLES = ("The ", "A ", "An ")


def _strip_leading_article(s: str) -> str:
    """Lower-case-aware leading-article strip."""
    for art in LEADING_ARTICLES:
        if s[: len(art)].lower() == art.lower():
            return s[len(art):]
    return s


def _candidate_alt_names(name: str, kind: str) -> list[str]:
    """Generate plausible alt-name strings from an entity's canonical name.

    The candidates are filtered globally (via `_apply_derived_alt_names`)
    against every other entity's name + alt_names so we never introduce a
    cross-entity collision.
    """
    out: list[str] = []
    if kind != "event":
        return out

    for prefix in EVENT_LEAD_PREFIXES:
        if name.startswith(prefix + " "):
            tail = _strip_leading_article(name[len(prefix) + 1:].strip())
            if tail and tail.lower() != name.lower():
                out.append(tail)
            break  # only one prefix can match a given name

    for pat in EVENT_TRAIL_PATTERNS:
        m = pat.match(name)
        if m:
            head = _strip_leading_article(m.group(1).strip())
            if head and head.lower() != name.lower():
                out.append(head)

    return out


def stage_derive_alt_names(entities: dict[str, dict]) -> int:
    """Walk every entity, propose alt_names from name patterns, accept only
    those that don't collide with any other entity's name or existing alt.
    Returns the count of new alt_names added.

    Why this matters: the segment scan uses each entity's name + alt_names
    as the regex sources. The LLM's per-episode JSONs sometimes record
    "True Cross Returned to Jerusalem" as the canonical name without
    listing "True Cross" as an alias — Brownworth's bare mentions never
    matched the event. This stage closes that gap mechanically so we don't
    have to hand-edit every episode JSON.
    """
    # Block list = every other entity's CANONICAL name and ORIGINAL (LLM-set)
    # alt_name. Computed up-front so it doesn't grow as we add derivations:
    # multiple events can legitimately share a derived alt ("True Cross" on
    # both the discovery and the restoration), and the per-episode
    # contested-tokens guard in stage 3 sorts out any in-episode collisions.
    name_to_owner: dict[str, str] = {}
    for ent in entities.values():
        for n in [ent["name"]] + list(ent.get("alt_names") or []):
            name_to_owner.setdefault(n.lower().strip(), ent["id"])

    added = 0
    for ent in entities.values():
        candidates = _candidate_alt_names(ent["name"], ent["kind"])
        if not candidates:
            continue
        existing = {n.lower() for n in [ent["name"]] + list(ent.get("alt_names") or [])}
        for cand in candidates:
            key = cand.lower().strip()
            if not key or key in existing:
                continue
            owner = name_to_owner.get(key)
            if owner is not None and owner != ent["id"]:
                continue  # belongs to another entity's canonical name set
            ent.setdefault("alt_names", []).append(cand)
            existing.add(key)
            added += 1
    return added


# ---------------------------------------------------------------------------
# Stage 2: validate Wikipedia + enrich
# ---------------------------------------------------------------------------


def fetch_wiki_summary(title: str, timeout: int = 15) -> dict | None:
    encoded = urllib.parse.quote(title.replace(" ", "_"), safe="")
    url = WIKI_SUMMARY.format(title=encoded)
    req = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"}
    )
    backoff = 1.0
    for _ in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
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

    out: dict = {}
    if data.get("title"):
        out["title"] = data["title"]
    if data.get("description"):
        out["description"] = data["description"]
    if data.get("extract"):
        out["extract"] = data["extract"]
    thumb = data.get("thumbnail") or {}
    orig = data.get("originalimage") or {}
    if thumb.get("source"):
        out["thumbnail"] = thumb["source"]
    if orig.get("source"):
        out["image"] = orig["source"]
    coords = data.get("coordinates") or {}
    if coords.get("lat") is not None and coords.get("lon") is not None:
        out["lat"] = coords["lat"]
        out["lng"] = coords["lon"]
    # Canonicalize URL from response
    content_url = (data.get("content_urls") or {}).get("desktop", {}).get("page")
    if content_url:
        out["url"] = content_url
    return out


def stage_validate_wikipedia(
    entities: dict[str, dict],
    refresh: bool = False,
    workers: int = 3,
) -> dict:
    """Validate every entity's wikipedia_url and enrich. Drop unresolvable.

    Returns the wiki cache (keyed by entity id).
    """
    cache: dict[str, dict | None] = {}
    if WIKI_CACHE_PATH.exists() and not refresh:
        cache = json.load(open(WIKI_CACHE_PATH, encoding="utf-8"))

    # Migrate from old portraits.json shape if cache is empty (one-time).
    legacy = ROOT / "portraits.json"
    if not cache and legacy.exists():
        legacy_data = json.load(open(legacy, encoding="utf-8"))
        for k, v in legacy_data.items():
            if not v:
                cache[k] = None
                continue
            entry: dict = {}
            if v.get("thumbnail"):
                entry["thumbnail"] = v["thumbnail"]
            if v.get("image"):
                entry["image"] = v["image"]
            if v.get("wiki_extract"):
                entry["extract"] = v["wiki_extract"]
            if v.get("wiki_description"):
                entry["description"] = v["wiki_description"]
            cache[k] = entry or None

    targets: list[tuple[str, str]] = []
    for eid, ent in entities.items():
        if cache.get(eid) is not None:
            continue  # already cached (success or recorded miss)
        if cache.get(eid) is None and eid in cache:
            continue  # recorded miss (None) — don't refetch unless --refresh
        url = ent.get("wikipedia_url")
        if not url:
            cache[eid] = None
            continue
        title = title_from_url(url)
        if not title:
            cache[eid] = None
            continue
        targets.append((eid, title))

    if targets:
        print(f"  Wikipedia: fetching {len(targets)} (cached: {sum(1 for v in cache.values() if v)})")

        def work(item):
            eid, title = item
            res = fetch_wiki_summary(title)
            time.sleep(0.15)
            return eid, res

        with ThreadPoolExecutor(max_workers=workers) as ex:
            futs = [ex.submit(work, t) for t in targets]
            for i, fut in enumerate(as_completed(futs), 1):
                eid, res = fut.result()
                cache[eid] = res
                if i % 25 == 0 or i == len(targets):
                    print(f"    {i}/{len(targets)}")
                    with open(WIKI_CACHE_PATH, "w", encoding="utf-8") as f:
                        json.dump(cache, f, indent=2, sort_keys=True, ensure_ascii=False)

        with open(WIKI_CACHE_PATH, "w", encoding="utf-8") as f:
            json.dump(cache, f, indent=2, sort_keys=True, ensure_ascii=False)
    else:
        print(f"  Wikipedia: all {sum(1 for v in cache.values() if v)} entities cached.")

    # Inject cache fields onto entities; drop entities without a resolved Wikipedia entry.
    drop: list[str] = []
    for eid, ent in entities.items():
        info = cache.get(eid)
        if not info:
            drop.append(eid)
            continue
        if info.get("extract"):
            ent["wikipedia_extract"] = info["extract"]
        if info.get("thumbnail"):
            ent["image_url"] = info["thumbnail"]
        if info.get("image"):
            ent["image_full_url"] = info["image"]
        # Use Wikipedia's canonical title in the URL (handles redirects)
        if info.get("url"):
            ent["wikipedia_url"] = info["url"]
        # Use Wikipedia coords for places that don't have them yet.
        if ent["kind"] == "place":
            if (ent.get("lat") is None or ent.get("lng") is None) and info.get("lat") is not None:
                ent["lat"] = info["lat"]
                ent["lng"] = info["lng"]
        # Auto-fill role for people if missing
        if ent["kind"] == "person" and not ent.get("role") and info.get("description"):
            ent["role"] = info["description"]

    for eid in drop:
        del entities[eid]
    print(f"  Wikipedia: kept {len(entities)} entities, dropped {len(drop)} without resolvable Wikipedia.")
    return cache


# ---------------------------------------------------------------------------
# Stage 3: scan transcripts_segments for mentions and score
# ---------------------------------------------------------------------------


# Honorifics / pure descriptors that should never be treated as a name token.
DROP_FIRST_TOKEN = {
    "emperor", "empress", "king", "queen", "prince", "princess",
    "saint", "st", "pope", "patriarch", "general", "duke", "lord",
    "lady", "the", "a", "an",
}


def _alts_for_match(
    ent: dict,
    episode_protagonist_id: str | None,
    contested_tokens: set[str],
) -> list[str]:
    """Return the set of strings to match against transcript text for this
    entity in a given episode.

    Strategy:
    - Always include the full canonical name + every multi-word alt name.
    - For the episode's protagonist, expand: extract first-tokens from every
      multi-word alt (e.g., "Alexius Comnenus" → "Alexius") so the bare-name
      mentions Brownworth uses ("Alexius did this") still register.
    - For non-protagonists, drop a single-word alt only if it's `contested`
      — i.e., another entity in this episode also has that token in their
      name. Solo names ("Theodora", "Maxentius") are always kept; only
      colliding ones ("Constantine" with both Constantine the Great and
      Constantine XI in scope) get suppressed.
    """
    name = ent["name"]
    is_protagonist = ent["id"] == episode_protagonist_id

    base = [name] + list(ent.get("alt_names") or [])

    filtered: list[str] = []
    for n in base:
        n = n.strip()
        if not n:
            continue
        if " " in n:
            filtered.append(n)
            continue
        token = n.lower()
        # Only drop a bare-name alt if it actually collides in this episode
        # AND we aren't the protagonist who claims it.
        if token in contested_tokens and not is_protagonist:
            continue
        filtered.append(n)

    if is_protagonist:
        # Add first-token of every alt_name (and the canonical name) so
        # Latinized / vernacular short-forms ("Alexius" for "Alexius Comnenus",
        # "Justinian" for "Justinian I") all match.
        first_tokens: set[str] = set()
        for n in [name] + list(ent.get("alt_names") or []):
            parts = n.strip().split()
            if not parts:
                continue
            t = parts[0].rstrip(",.;:")
            if not t:
                continue
            if t.lower() in DROP_FIRST_TOKEN:
                if len(parts) > 1:
                    t = parts[1].rstrip(",.;:")
                else:
                    continue
            if not t or t.lower() in DROP_FIRST_TOKEN:
                continue
            first_tokens.add(t)
        for t in first_tokens:
            if t.lower() not in {x.lower() for x in filtered}:
                filtered.append(t)

    # Dedupe (case-insensitive) preserving order, then longest-first so multi-
    # word phrases win over bare tokens during regex matching.
    seen: set[str] = set()
    out: list[str] = []
    for n in filtered:
        key = n.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(n)
    out.sort(key=lambda x: -len(x))
    return out


def _contested_tokens_for_episode(ep_entities: list[dict]) -> set[str]:
    """Return the set of single-word name tokens that two or more entities
    in this episode lay claim to (via their canonical name or first-token of
    a multi-word alt). These are the only tokens we filter to avoid
    cross-entity attribution mistakes."""
    counts: dict[str, int] = defaultdict(int)
    for ent in ep_entities:
        tokens: set[str] = set()
        for n in [ent["name"]] + list(ent.get("alt_names") or []):
            parts = n.strip().split()
            if not parts:
                continue
            t = parts[0].rstrip(",.;:").lower()
            if not t or t in DROP_FIRST_TOKEN:
                if len(parts) > 1:
                    t = parts[1].rstrip(",.;:").lower()
                else:
                    continue
            if t and t not in DROP_FIRST_TOKEN:
                tokens.add(t)
        for t in tokens:
            counts[t] += 1
    return {t for t, n in counts.items() if n >= 2}


def _compile_patterns(alts: list[str]) -> re.Pattern:
    parts = [re.escape(a) for a in alts]
    return re.compile(r"(?<![A-Za-z])(" + "|".join(parts) + r")(?![A-Za-z])", re.IGNORECASE)


# Stock intro / boilerplate phrasing — segments matching this are the show's
# title card, not actual discussion of the entity. We filter them OUT of the
# excerpt selection (so verbatim quotes are real Brownworth content) but
# leave them in the mention count (the entity name *is* in fact spoken).
INTRO_PHRASE_RE = re.compile(
    r"\b(byzantine\s+rulers|br[oa]m?nworth|bramworth|"
    r"^\s*episode\s+\d+|^\s*welcome\s+back\b|"
    r"^\s*in\s+the\s+last\s+lecture\b|"
    r"^\s*last\s+time\b)",
    re.IGNORECASE | re.MULTILINE,
)


def _is_boilerplate(text: str, segment_idx: int) -> bool:
    """True for episode-intro / outro segments we don't want to surface as
    representative quotes. Two heuristics combined to avoid false positives
    on real content that happens to mention the show title in passing."""
    if segment_idx <= 4 and INTRO_PHRASE_RE.search(text):
        return True
    if "byzantine rulers" in text.lower() and "lars" in text.lower():
        return True
    if "brownworth" in text.lower() or "bramworth" in text.lower():
        # Whisper sometimes mishears the host's name; either way, it's the
        # bumper, not a quote we want to display.
        return True
    return False


def stage_find_mentions(
    entities: dict[str, dict],
    episodes_meta: list[dict],
) -> None:
    """Scan each segments JSON; populate `mentions_by_episode` and
    `excerpts_by_episode` and per-episode `score`.
    """
    # Pre-bucket entities by id for episode-protagonist lookups.
    for ep_meta in episodes_meta:
        ep_num = ep_meta["episode"]
        seg_path = SEGMENTS_DIR / ep_meta["segments_file"]
        if not seg_path.exists():
            continue
        seg_data = json.load(open(seg_path, encoding="utf-8"))
        segments = seg_data.get("segments") or []
        if not segments:
            continue
        ep_duration = float(segments[-1].get("end") or 0.0)
        protagonist = ep_meta.get("ruler_id")

        # Build per-entity compiled patterns (only entities that the LLM
        # already said appear in this episode get scanned for it; cuts noise).
        ep_key = str(ep_num)
        ep_entities: list[dict] = [e for e in entities.values() if ep_num in e["episodes"]]
        contested = _contested_tokens_for_episode(ep_entities)

        # Pre-compile patterns and a single combined alts -> entity lookup.
        # If a segment matches multiple entities, the longest match wins.
        cache_alts: list[tuple[dict, list[str]]] = []
        for ent in ep_entities:
            alts = _alts_for_match(ent, protagonist, contested)
            cache_alts.append((ent, alts))

        # Master pattern: all alt strings across all entities for this
        # episode. We attribute each hit to the entity whose alt matched
        # (longest first).
        all_alt_to_entity: list[tuple[str, dict]] = []
        for ent, alts in cache_alts:
            for a in alts:
                all_alt_to_entity.append((a, ent))
        all_alt_to_entity.sort(key=lambda kv: -len(kv[0]))
        # Dedupe: keep the first occurrence (longest match) for each lowercased alt.
        seen_alt: set[str] = set()
        ordered_alts: list[tuple[str, dict]] = []
        for a, ent in all_alt_to_entity:
            k = a.lower()
            if k in seen_alt:
                continue
            seen_alt.add(k)
            ordered_alts.append((a, ent))

        if not ordered_alts:
            continue

        master = _compile_patterns([a for a, _ in ordered_alts])
        alt_to_ent = {a.lower(): ent for a, ent in ordered_alts}

        # First pass: per segment, find all distinct entities mentioned.
        per_entity_segments: dict[str, list[dict]] = defaultdict(list)
        for idx, seg in enumerate(segments):
            text = (seg.get("text") or "").strip()
            if not text:
                continue
            seen_in_seg: set[str] = set()
            for m in master.finditer(text):
                matched = m.group(1)
                ent = alt_to_ent.get(matched.lower())
                if ent is None:
                    continue
                if ent["id"] in seen_in_seg:
                    continue
                seen_in_seg.add(ent["id"])
                per_entity_segments[ent["id"]].append({
                    "segment_idx": idx,
                    "start": float(seg["start"]),
                    "end": float(seg["end"]),
                    "matched": matched,
                    "text": text,
                })

        for ent_id, hits in per_entity_segments.items():
            ent = entities[ent_id]
            # Mentions list (kept lean — no `text`)
            mentions = [
                {
                    "segment_idx": h["segment_idx"],
                    "start": round(h["start"], 2),
                    "end": round(h["end"], 2),
                    "matched": h["matched"],
                }
                for h in hits
            ]
            ent.setdefault("mentions_by_episode", {})[ep_key] = mentions

            # Score: cumulative duration of mentioning segments / episode_duration,
            # passed through sqrt so a few mentions register without dwarfing
            # the protagonist. Capped at 100.
            covered = sum(h["end"] - h["start"] for h in hits)
            ratio = covered / ep_duration if ep_duration else 0.0
            score = round(min(100.0, math.sqrt(ratio) * 120.0))
            block = ent["summaries_by_episode"].setdefault(ep_key, {"summary": ""})
            block["score"] = int(score)
            block["mention_count"] = len(hits)
            block["first_mention_seconds"] = round(hits[0]["start"], 2)

            # Excerpts: pick up to 3 representative segments. Prefer the
            # longest matching segment, then ones spaced through the episode.
            # Filter out the show-title bumper and "welcome back" recaps so
            # verbatim quotes always carry actual narrative content.
            content_hits = [h for h in hits if not _is_boilerplate(h["text"], h["segment_idx"])]
            sorted_hits = sorted(content_hits, key=lambda h: (h["end"] - h["start"]), reverse=True)
            excerpts: list[dict] = []
            chosen_idxs: set[int] = set()
            for h in sorted_hits:
                if len(excerpts) >= 3:
                    break
                if any(abs(h["segment_idx"] - i) < 3 for i in chosen_idxs):
                    continue  # avoid clustered excerpts
                chosen_idxs.add(h["segment_idx"])
                excerpts.append({
                    "segment_idx": h["segment_idx"],
                    "start": round(h["start"], 2),
                    "end": round(h["end"], 2),
                    "text": h["text"],
                })
            excerpts.sort(key=lambda x: x["segment_idx"])
            ent.setdefault("excerpts_by_episode", {})[ep_key] = excerpts


# ---------------------------------------------------------------------------
# Stage 3.5: derive audio anchors for entities the regex scan missed
# ---------------------------------------------------------------------------
#
# The per-episode LLM extractions record `transcript_lines: [[start, end], ...]`
# pointing at the lines that justified tagging an entity to that episode. When
# Stage 3's name-regex finds zero hits (entity referenced via pronoun, fuzzy
# spelling, or paraphrase), we still know roughly *where* in the transcript
# the discussion is — so we can map a line number to a Whisper segment via
# token-overlap and produce a synthetic mention there. The chip seek lands on
# the right neighborhood, the audio-focus pulse fires at the right moment.
#
# Marked `inferred=True` on the per-episode block so downstream consumers can
# distinguish from regex-anchored mentions if they choose to.

# Stopwords stripped before token-overlap scoring — they're shared across
# every segment and contribute pure noise. Kept short on purpose: rare-but-
# functional words like "Maximian", "Diocletian", "Persia" are exactly what
# we WANT to weight, so we stop only at obvious closed-class tokens.
_ALIGNMENT_STOPWORDS = {
    "the", "a", "an", "of", "and", "to", "in", "at", "on", "for", "with",
    "was", "were", "is", "are", "by", "this", "that", "these", "those",
    "his", "her", "him", "she", "he", "they", "them", "their", "its",
    "but", "or", "as", "be", "not", "had", "have", "has", "been", "would",
    "could", "should", "will", "did", "do", "does", "from", "into", "than",
    "then", "when", "where", "while", "who", "whom", "which", "what",
    "after", "before", "over", "under", "about", "any", "all", "no",
    "if", "so", "it", "we", "us", "you", "your", "i", "my", "me",
}


def _tokens_for_alignment(text: str) -> list[str]:
    """Lowercase content tokens, stopwords removed. Used to score Whisper
    segments against a transcript line by overlap count."""
    raw = re.findall(r"[A-Za-z']+", text.lower())
    return [t for t in raw if len(t) > 2 and t not in _ALIGNMENT_STOPWORDS]


def _find_segment_for_line(
    transcript_lines: list[str],
    segments: list[dict],
    line_num: int,
) -> tuple[int, dict] | None:
    """Locate the Whisper segment that most likely covers `line_num` of the
    plain-text transcript. Pure heuristic: token-overlap with positional
    proximity as a tiebreaker.

    `line_num` is 1-indexed (matching the LLM extraction's convention).
    Returns (segment_idx, segment_dict) or None if alignment fails.
    """
    if not segments or line_num < 1 or line_num > len(transcript_lines):
        return None

    # Build a context window: target line + a few neighbors to compensate for
    # short single-clause lines like "stunning decision." that wouldn't carry
    # enough distinctive tokens on their own.
    lo = max(0, line_num - 2)
    hi = min(len(transcript_lines), line_num + 2)
    window_text = " ".join(transcript_lines[lo:hi])
    target_tokens = _tokens_for_alignment(window_text)
    if len(target_tokens) < 3:
        return None
    target_set = set(target_tokens)

    # Expected segment position by linear interpolation (line N of L lines
    # ≈ segment N·S/L). Used as a tiebreaker: among segments with equal
    # token overlap, prefer the one closest to the expected position. Saves
    # us from picking a distant segment that happens to share common tokens.
    expected_idx = (line_num / max(len(transcript_lines), 1)) * len(segments)

    best_idx = -1
    best_score = -1.0
    for idx, seg in enumerate(segments):
        seg_tokens = set(_tokens_for_alignment(seg.get("text") or ""))
        if not seg_tokens:
            continue
        overlap = len(target_set & seg_tokens)
        if overlap == 0:
            continue
        # Tiebreaker: subtract 1% of positional distance per index. Two
        # segments with overlap=3 and abs(idx - expected) differing by 50
        # shift by 0.5 — only matters when token scores are tied.
        score = overlap - 0.01 * abs(idx - expected_idx)
        if score > best_score:
            best_score = score
            best_idx = idx

    if best_idx < 0:
        return None
    # Require at least 2 distinctive token matches, otherwise we've probably
    # latched onto a noise segment with one shared filler word.
    seg = segments[best_idx]
    raw_overlap = len(target_set & set(_tokens_for_alignment(seg.get("text") or "")))
    if raw_overlap < 2:
        return None
    return best_idx, seg


def stage_fill_inferred_anchors(
    entities: dict[str, dict],
    episodes_meta: list[dict],
) -> int:
    """For every (entity, episode) where `transcript_lines` is recorded but
    the segment scan found zero mentions, synthesize a single mention
    pointing at the Whisper segment most likely covering the first line.

    Returns the count of blocks anchored. Cheap by design — only touches
    blocks that truly need it; episodes with no work to do don't load
    transcripts or segments.
    """
    # Index episodes by number for quick lookups.
    ep_by_num = {ep["episode"]: ep for ep in episodes_meta}
    # Lazy per-episode caches: only loaded when a candidate exists.
    seg_cache: dict[int, list[dict] | None] = {}
    line_cache: dict[int, list[str] | None] = {}

    def load_segments(ep_num: int) -> list[dict] | None:
        if ep_num in seg_cache:
            return seg_cache[ep_num]
        meta = ep_by_num.get(ep_num)
        path = SEGMENTS_DIR / meta["segments_file"] if meta else None
        if not path or not path.exists():
            seg_cache[ep_num] = None
            return None
        try:
            data = json.load(open(path, encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            seg_cache[ep_num] = None
            return None
        seg_cache[ep_num] = data.get("segments") or None
        return seg_cache[ep_num]

    def load_lines(ep_num: int) -> list[str] | None:
        if ep_num in line_cache:
            return line_cache[ep_num]
        meta = ep_by_num.get(ep_num)
        path = TRANSCRIPTS_DIR / meta["transcript_file"] if meta else None
        if not path or not path.exists():
            line_cache[ep_num] = None
            return None
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            line_cache[ep_num] = None
            return None
        line_cache[ep_num] = text.splitlines()
        return line_cache[ep_num]

    anchored = 0
    failed = 0
    for ent in entities.values():
        lines_by_ep = ent.get("transcript_lines_by_episode") or {}
        if not lines_by_ep:
            continue
        for ep_key, ranges in lines_by_ep.items():
            block = ent["summaries_by_episode"].setdefault(ep_key, {"summary": ""})
            if (block.get("mention_count") or 0) > 0:
                continue  # regex already gave us a real anchor
            if not ranges:
                continue
            ep_num = int(ep_key)
            segments = load_segments(ep_num)
            transcript_lines = load_lines(ep_num)
            if not segments or not transcript_lines:
                continue
            # Use the first range's start line as the anchor reference.
            first_line = int(ranges[0][0]) if ranges and ranges[0] else None
            if first_line is None:
                continue
            found = _find_segment_for_line(transcript_lines, segments, first_line)
            if not found:
                failed += 1
                continue
            seg_idx, seg = found
            mention = {
                "segment_idx": seg_idx,
                "start": round(float(seg["start"]), 2),
                "end": round(float(seg["end"]), 2),
                "matched": "[inferred]",
            }
            ent.setdefault("mentions_by_episode", {}).setdefault(ep_key, []).append(mention)
            block["mention_count"] = sum(
                (int(r[1]) - int(r[0]) + 1) for r in ranges if len(r) >= 2
            ) or 1
            block["first_mention_seconds"] = mention["start"]
            # Conservative score: enough to surface the chip but well below
            # any real regex-matched score (which max out near 100).
            block["score"] = max(int(block.get("score") or 0), 5)
            block["inferred"] = True
            anchored += 1

    if failed:
        print(f"      ({failed} block(s) had transcript_lines but no segment alignment)")
    return anchored


# ---------------------------------------------------------------------------
# Stage 4: synthesize unified summaries with Claude (optional)
# ---------------------------------------------------------------------------


SYNTH_SYSTEM_PROMPT = """\
You are an encyclopedia editor synthesizing entries about figures, places, \
and events from Lars Brownworth's "12 Byzantine Rulers" podcast lectures, \
cross-referenced with Wikipedia.

For each entity you receive:
  - the entity's name and kind (person / place / event)
  - per-episode summaries from the podcast lectures
  - the Wikipedia extract for the entity

Your task: produce a single unified summary, 2-3 sentences, in a neutral \
encyclopedia tone.

Constraints:
- 2-3 sentences. Not one. Not four.
- Neutral third-person tone. Do NOT include phrases like "Brownworth \
describes...", "the host explains...", "the podcast notes...", "according \
to Wikipedia...", etc.
- Synthesize across all sources — combine the podcast's narrative framing \
with Wikipedia's factual scaffolding. The podcast is your authoritative \
voice; use Wikipedia to add precision, dates, and modern context.
- Lead with the most defining fact: their role / where the place is / when \
the event happened.
- Don't repeat the entity's name in every sentence.
- Don't editorialize. No adjectives like "remarkable" or "tragic" unless \
the source material plainly supports them.
- Don't invent facts not present in the supplied summaries or Wikipedia.

Return ONLY the summary text. No preamble, no bullet points, no quotation \
marks, no labels.
"""


def _stable_hash(payload: dict) -> str:
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def stage_synthesize(entities: dict[str, dict]) -> None:
    try:
        import anthropic  # type: ignore
    except ImportError:
        print("  --synthesize: anthropic SDK not installed (`pip install anthropic`). Skipping.")
        return
    import os
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("  --synthesize: ANTHROPIC_API_KEY not set. Skipping.")
        return

    cache: dict = json.load(open(SYNTH_CACHE_PATH, encoding="utf-8")) if SYNTH_CACHE_PATH.exists() else {}

    # Migrate from old data/synthesized_summaries.json if cache empty
    legacy = ROOT / "synthesized_summaries.json"
    if not cache and legacy.exists():
        legacy_data = json.load(open(legacy, encoding="utf-8"))
        cache = legacy_data

    todo: list[tuple[dict, str]] = []
    for ent in entities.values():
        per_ep = {ep: blk.get("summary", "") for ep, blk in ent["summaries_by_episode"].items() if blk.get("summary")}
        if len(per_ep) < 2 and not ent.get("wikipedia_extract"):
            continue
        payload = {
            "kind": ent["kind"],
            "name": ent["name"],
            "summaries": per_ep,
            "wiki": ent.get("wikipedia_extract", "")[:1500],
            "model": "claude-sonnet-4-6",
        }
        h = _stable_hash(payload)
        cached = cache.get(ent["id"])
        if cached and cached.get("hash") == h and cached.get("text"):
            ent["summary"] = cached["text"]
            continue
        todo.append((ent, h))

    print(f"  Synthesize: {len(todo)} entities to (re)synthesize ({len(cache)} cached).")
    if not todo:
        return

    client = anthropic.Anthropic()
    for i, (ent, h) in enumerate(todo, 1):
        per_ep = {ep: blk.get("summary", "") for ep, blk in ent["summaries_by_episode"].items() if blk.get("summary")}
        body = ""
        for ep, txt in sorted(per_ep.items(), key=lambda kv: int(kv[0])):
            body += f"\nEpisode {ep}: {txt}"
        if ent.get("wikipedia_extract"):
            body += f"\n\nWikipedia: {ent['wikipedia_extract'][:1500]}"
        user = f"Entity: {ent['name']}\nKind: {ent['kind']}\n{body}"
        try:
            resp = client.messages.create(
                model="claude-sonnet-4-6",
                max_tokens=400,
                system=[{
                    "type": "text",
                    "text": SYNTH_SYSTEM_PROMPT,
                    "cache_control": {"type": "ephemeral"},
                }],
                messages=[{"role": "user", "content": user}],
            )
            text = next((b.text for b in resp.content if b.type == "text"), "").strip()
            if (text.startswith('"') and text.endswith('"')) or (text.startswith("'") and text.endswith("'")):
                text = text[1:-1].strip()
        except Exception as e:
            print(f"    [{i}/{len(todo)}] {ent['name']}: API error — {e}")
            continue
        cache[ent["id"]] = {"text": text, "hash": h, "model": "claude-sonnet-4-6"}
        ent["summary"] = text
        if i % 10 == 0 or i == len(todo):
            with open(SYNTH_CACHE_PATH, "w", encoding="utf-8") as f:
                json.dump(cache, f, indent=2, sort_keys=True, ensure_ascii=False)
            print(f"    {i}/{len(todo)}")

    with open(SYNTH_CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(cache, f, indent=2, sort_keys=True, ensure_ascii=False)


def stage_apply_synth_cache(entities: dict[str, dict]) -> int:
    """If synthesis cache exists, attach text to entities (no API calls)."""
    if not SYNTH_CACHE_PATH.exists():
        legacy = ROOT / "synthesized_summaries.json"
        if not legacy.exists():
            return 0
        cache = json.load(open(legacy, encoding="utf-8"))
    else:
        cache = json.load(open(SYNTH_CACHE_PATH, encoding="utf-8"))

    n = 0
    for ent in entities.values():
        info = cache.get(ent["id"])
        if info and info.get("text"):
            ent["summary"] = info["text"]
            n += 1
    return n


# ---------------------------------------------------------------------------
# Stage 5: post-process + emit
# ---------------------------------------------------------------------------


# Hand-curated coordinate overrides where the LLM and Wikipedia disagreed.
PLACE_COORD_OVERRIDES: dict[str, tuple[float, float]] = {
    # ancient Atropatene was in NW Iran, not modern Baku
    "azerbaijan": (37.6, 47.0),
    # Tigris River — pick a Mesopotamian midpoint (Baghdad area) rather than
    # the upstream Turkish source so the marker reads as Mesopotamia
    "tigris-river": (33.3, 44.4),
}


def filter_out_of_era(entities: dict[str, dict]) -> set[str]:
    """Drop people clearly outside the Byzantine window (modern scholars,
    Founding Fathers, pre-imperial ancients), and events outside ~100-1500.
    """
    drop: set[str] = set()
    for eid, ent in list(entities.items()):
        if ent["kind"] == "person":
            by = ent.get("birth_year")
            re_ = ent.get("reign_end")
            rs = ent.get("reign_start")
            dy = ent.get("death_year")
            if isinstance(by, int) and by > 1500:
                drop.add(eid)
                continue
            if isinstance(rs, int) and rs > 1500:
                drop.add(eid)
                continue
            if isinstance(dy, int) and dy < 100:
                if isinstance(re_, int) and re_ >= 100:
                    pass
                else:
                    drop.add(eid)
                    continue
        elif ent["kind"] == "event":
            y = ent.get("year")
            if isinstance(y, int) and (y < 100 or y > 1500):
                drop.add(eid)
                continue
    for eid in drop:
        del entities[eid]
    return drop


def finalize(entities: dict[str, dict], episodes_meta: list[dict]) -> dict:
    # Apply curated coord overrides
    for pid, (lat, lng) in PLACE_COORD_OVERRIDES.items():
        if pid in entities and entities[pid]["kind"] == "place":
            entities[pid]["lat"] = lat
            entities[pid]["lng"] = lng

    # Pin places to the narrative year of the earliest mentioning episode.
    # The LLM often picked a place's pre-Byzantine founding date (Rome=753 BC,
    # Carthage=814 BC) which has nothing to do with when the podcast actually
    # discusses it. Override unless the LLM's date is already within the
    # narrative window of the earliest episode (e.g., Hagia Sophia at 537 is
    # right when Justinian built it — keep that).
    for ent in entities.values():
        if ent["kind"] != "place":
            continue
        eps = ent.get("episodes") or []
        if not eps:
            continue
        narrative = min(
            (EPISODE_NARRATIVE_YEAR[e] for e in eps if e in EPISODE_NARRATIVE_YEAR),
            default=None,
        )
        if narrative is None:
            continue
        fy = ent.get("first_year")
        if fy is None or fy < narrative:
            ent["first_year"] = narrative

    # Drop out-of-era figures
    dropped = filter_out_of_era(entities)
    if dropped:
        print(f"  Filter: dropped {len(dropped)} out-of-era entities.")

    # Strip related references to dropped entities (or non-existent)
    all_ids = set(entities.keys())
    for ent in entities.values():
        ent["related"] = [r for r in (ent.get("related") or []) if r["id"] in all_ids]
        if ent.get("location_id") and ent["location_id"] not in all_ids:
            ent["location_id"] = None

    # Compute is_twelve_ruler + ruler_episode for people
    for ent in entities.values():
        if ent["kind"] != "person":
            continue
        ent["is_twelve_ruler"] = ent["id"] in TWELVE_RULERS_ORDERED
        if ent["is_twelve_ruler"]:
            for ep_num, ruler_id in RULER_BY_EPISODE.items():
                if ruler_id == ent["id"]:
                    ent["ruler_episode"] = ep_num
                    break

    # Default per-episode score to 0 where the LLM listed the entity in an
    # episode but the segment scan found no matches (mostly happens when an
    # entity is referenced only by pronoun, or the LLM extracted a passing
    # mention we don't count). Also normalize the block shape so the web app
    # can rely on `score` always being present.
    for ent in entities.values():
        for ep, blk in ent["summaries_by_episode"].items():
            if not isinstance(blk, dict):
                continue
            blk.setdefault("summary", "")
            if blk.get("score") is None:
                blk["score"] = 0
            blk.setdefault("mention_count", 0)
            blk.setdefault("first_mention_seconds", None)

    # Compute max_score
    for ent in entities.values():
        scores = [blk.get("score", 0) for blk in ent["summaries_by_episode"].values() if isinstance(blk, dict)]
        ent["max_score"] = max(scores) if scores else 0

    # Strip the LLM-line-evidence field — it was a build-time helper for
    # Stage 3.5 and isn't part of the public schema.
    for ent in entities.values():
        ent.pop("transcript_lines_by_episode", None)

    # Sort lists
    people = sorted(
        (e for e in entities.values() if e["kind"] == "person"),
        key=lambda p: (p.get("birth_year") or p.get("reign_start") or 9999, p["name"]),
    )
    places = sorted(
        (e for e in entities.values() if e["kind"] == "place"),
        key=lambda p: p["name"],
    )
    events = sorted(
        (e for e in entities.values() if e["kind"] == "event"),
        key=lambda e: (e.get("year") or 9999, e["name"]),
    )

    out = {
        "version": 2,
        "episodes": episodes_meta,
        "twelve_rulers": TWELVE_RULERS_ORDERED,
        "people": people,
        "places": places,
        "events": events,
        "stats": {
            "people": len(people),
            "places": len(places),
            "events": len(events),
            "with_wikipedia": sum(1 for e in entities.values() if e.get("wikipedia_url")),
            "with_image": sum(1 for e in entities.values() if e.get("image_url")),
            "with_synthesized_summary": sum(
                1 for e in entities.values() if e.get("summary") and len(e.get("summary", "")) > 0
            ),
        },
    }
    return out


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh-wiki", action="store_true", help="ignore Wikipedia cache, refetch all")
    ap.add_argument("--synthesize", action="store_true", help="run Claude synthesis (needs ANTHROPIC_API_KEY)")
    ap.add_argument("--no-mentions", action="store_true", help="skip segment scan (testing)")
    args = ap.parse_args()

    print("[1/5] Loading per-episode extractions...")
    episodes_meta, entities = load_episodes()
    print(f"      Loaded {len(episodes_meta)} episodes, {len(entities)} unique entities.")
    derived = stage_derive_alt_names(entities)
    print(f"      Derived {derived} alt_name(s) from canonical name patterns.")

    print("[2/5] Validating Wikipedia URLs and enriching...")
    stage_validate_wikipedia(entities, refresh=args.refresh_wiki)

    if not args.no_mentions:
        print("[3/5] Scanning Whisper segment transcripts for mentions...")
        stage_find_mentions(entities, episodes_meta)
        anchored = stage_fill_inferred_anchors(entities, episodes_meta)
        if anchored:
            print(f"      Inferred audio anchors for {anchored} block(s) via transcript_lines.")
    else:
        print("[3/5] (skipped — --no-mentions)")

    print("[4/5] Synthesizing unified summaries...")
    if args.synthesize:
        stage_synthesize(entities)
    else:
        n = stage_apply_synth_cache(entities)
        print(f"      Applied {n} cached synthesized summaries (use --synthesize to refresh).")

    print("[5/5] Finalizing and writing entities.json...")
    out = finalize(entities, episodes_meta)
    for path in (ENTITIES_OUT, WEB_OUT):
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(out, f, indent=2, ensure_ascii=False)
        print(f"      wrote {path}")
    print(
        f"      stats: {out['stats']['people']} people, "
        f"{out['stats']['places']} places, "
        f"{out['stats']['events']} events"
    )


if __name__ == "__main__":
    main()
