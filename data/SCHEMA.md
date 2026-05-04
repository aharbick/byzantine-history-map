# Data schema (v2)

The build pipeline emits a single `data/entities.json` consumed by the web app
(also copied to `web/src/data/entities.json`). It unifies people / places /
events into a common format with segment-level audio anchors and per-episode
importance scores derived from the Whisper-segmented transcripts.

## Top-level

```json
{
  "version": 2,
  "episodes": [EpisodeMeta],
  "twelve_rulers": ["diocletian", "constantine-the-great", ...],
  "people": [Entity (kind=person)],
  "places": [Entity (kind=place)],
  "events": [Entity (kind=event)],
  "stats": {
    "people": 200,
    "places": 150,
    "events": 280,
    "with_wikipedia": 630,
    "with_image": 600,
    "with_synthesized_summary": 200
  }
}
```

### EpisodeMeta

```json
{
  "episode": 2,
  "title": "Episode 2 - Diocletian",
  "audio_file": "02 - Episode 2 - Diocletian.mp3",
  "transcript_file": "02 - Episode 2 - Diocletian.txt",
  "segments_file": "02 - Episode 2 - Diocletian.json",
  "duration_seconds": 1204.26,
  "ruler_id": "diocletian"
}
```

`ruler_id` is set on the 12 episodes that focus on a Byzantine ruler
(episodes 2–16 except 4 / 8 / 9 which are continuations of an earlier ruler;
those instead get the same `ruler_id` as the part-1 episode). Episodes 1 and
17 are intro / conclusion: `ruler_id` is `null`.

## Entity (common fields, all kinds)

```json
{
  "id": "diocletian",
  "kind": "person",
  "name": "Diocletian",
  "alt_names": ["Diocles", "Gaius Aurelius Valerius Diocletianus"],
  "wikipedia_url": "https://en.wikipedia.org/wiki/Diocletian",
  "wikipedia_extract": "Diocletian (born Diocles; ...)",
  "image_url": "https://upload.wikimedia.org/.../thumb.jpg",
  "image_full_url": "https://upload.wikimedia.org/.../full.jpg",

  "summary": "Cross-episode synthesized summary (or longest podcast summary if not synthesized).",
  "summaries_by_episode": {
    "2": {
      "summary": "Per-episode portrait from the LLM extraction.",
      "score": 95,
      "first_mention_seconds": 32.4,
      "mention_count": 47
    }
  },
  "excerpts_by_episode": {
    "2": [
      {"start": 32.4, "end": 35.8, "segment_idx": 5, "text": "verbatim transcript text..."}
    ]
  },
  "mentions_by_episode": {
    "2": [
      {"segment_idx": 5, "start": 32.4, "end": 35.8, "matched": "Diocletian"}
    ]
  },

  "episodes": [2, 3, 4],
  "max_score": 95,
  "related": [{"type": "person", "id": "maximian"}]
}
```

`score`: integer 0-100. Computed per episode as the share of audio time covered
by segments that mention this entity (matched_count_of_segments_with_mention ×
avg_duration / episode_duration), normalized to 0-100 with a square-root curve
so that even a few mentions register meaningfully but a few mentions are
clearly distinguishable from a dominant ruler-episode protagonist.

`max_score`: the highest per-episode score; useful for global filtering
(e.g., "only show entities scoring 30+ in any episode").

## Person-only fields

```json
{
  "is_twelve_ruler": true,
  "ruler_episode": 2,
  "role": "Roman Emperor",
  "birth_year": 244,
  "death_year": 311,
  "reign_start": 284,
  "reign_end": 305
}
```

## Place-only fields

```json
{
  "modern_name": "İzmit",
  "modern_country": "Turkey",
  "lat": 40.7656,
  "lng": 29.9408,
  "first_year": 284
}
```

## Event-only fields

```json
{
  "year": 293,
  "end_year": null,
  "category": "political | battle | religious | cultural | economic | natural | dynastic",
  "location_id": "nicomedia"
}
```

## Pipeline

`data/build.py` is the single entry point. It runs four stages:

1. **Validate Wikipedia.** Each entity's `wikipedia_url` is resolved against
   the Wikipedia REST `page/summary` endpoint (cached in
   `data/cache/wikipedia.json`). Entities with a 404 / unresolvable URL are
   dropped. The summary's `extract`, `thumbnail`, `originalimage`, and
   `coordinates` are stored in the cache.

2. **Find segment-level mentions.** Each entity's `name` + `alt_names` are
   matched (case-insensitive, whole-word) against every segment of every
   episode's `transcripts_segments/*.json`. The per-episode
   `mentions_by_episode` records each hit with its segment index and start /
   end seconds. Disambiguation: when a segment matches multiple entities,
   the longest match wins; ties go to the episode's protagonist (the
   `ruler_id`).

3. **Score and excerpt.** Per-episode `score` is the share of episode duration
   covered by mentioning segments, scaled with a square root curve to 0-100.
   `excerpts_by_episode` are the 1-3 longest mentioning segments verbatim.

4. **Synthesize.** If `ANTHROPIC_API_KEY` is set, a Claude pass produces a
   single 2-3-sentence cross-episode `summary` for each entity that has 2+
   episode mentions, combining the per-episode summaries with the Wikipedia
   extract. Cached in `data/cache/synthesized_summaries.json`.

`web/predev` runs `data/build.py` so the dev server always sees the latest
extraction. The cache files are committed so cold builds don't re-fetch
Wikipedia or re-call the LLM.
