# Twelve Byzantine Rulers — Interactive History

An interactive map + timeline website built from the transcripts of Lars
Brownworth's [*12 Byzantine Rulers*](https://12byzantinerulers.com/) podcast.
All 17 episodes (Diocletian → Constantine XI) are extracted into the
**12 named rulers** plus the supporting cast of people, places, and events
that fill the Byzantine world, each cross-linked, scored for episode
importance, and synced to Whisper-segmented audio for moment-precise
playback.

## What's here

```
audio/                       raw mp3s (370 MB total — gitignored, hosted externally in production)
transcripts/                 text transcripts of each episode
transcripts_segments/        Whisper segment JSONs (timestamps for audio sync)
data/
├── episodes/                per-episode LLM extractions (the seed inputs)
├── cache/                   persistent caches (committed)
│   ├── wikipedia.json       Wikipedia REST summary results
│   └── synthesized_summaries.json   Claude cross-episode summaries
├── build.py                 single-shot pipeline → entities.json
├── entities.json            canonical unified dataset
└── SCHEMA.md                schema reference
web/                         Next.js 16 app (the website itself)
mise.toml                    pinned Node 22
.claude/launch.json          Claude Code preview config
```

## Running locally

```bash
# Once: install pinned Node version
mise install

# Install deps + start the dev server
cd web
npm install
npm run dev   # http://localhost:3000
```

`npm run dev` runs `data/build.py` first (via the `predev` hook) so the app
always loads the latest extraction from `data/episodes/`.

The audio player streams from `web/public/audio/`, which is a symlink to
`../../audio/`. If you re-clone the repo, recreate that symlink:

```bash
cd web/public && ln -s ../../audio audio
```

## Data pipeline

`data/build.py` is the single entry point. It reads the per-episode
extractions, validates each entity against Wikipedia, scans the Whisper
segment JSONs for moment-precise mentions, scores per-episode importance,
and (optionally) calls Claude to synthesize unified cross-episode summaries.

```bash
python3 data/build.py                  # cached run (no API calls)
python3 data/build.py --synthesize     # re-run Claude synthesis (needs ANTHROPIC_API_KEY)
python3 data/build.py --refresh-wiki   # ignore Wikipedia cache, refetch all
```

The pipeline rewrites both `data/entities.json` (canonical) and
`web/src/data/entities.json` (consumed by the Next.js app). Both files plus
the caches in `data/cache/` are **committed** so production builds work
without Python or any external API calls.

See [data/SCHEMA.md](data/SCHEMA.md) for the full output shape.

## Architecture notes

- **Vertical scroll → horizontal time** — the `Timeline` component listens for
  `wheel` events on the window and translates `deltaY` into year movement.
  Touch scrubbing handled via Pointer Events. Wheels inside the entity card
  scroll the card instead.
- **Map** — MapLibre GL JS with the free CARTO Voyager (no labels) basemap, so
  modern country borders/names are stripped and our own period place markers
  carry the geography.
- **Markers** — every kind uses a unified disc: gold ring for people, blue for
  places, red for events. Wikipedia thumbnail (grayscaled) inside if available;
  small colored dot if not. Hover/select restores full color.
- **Clusters** — when 5+ entities share a coord, a "+N" badge shows instead of
  fanning them out individually. Tinted by the most-represented kind in the
  group. Click to expand into a wide spider; click anywhere else to collapse.
- **Cards** — built with Framer Motion. Color-coded left border matches the
  selected dot. Per-episode summary breakdown, related-entity chips,
  Wikipedia link, episode chips that play the mp3, and a Share button that
  copies a deep-link URL.
- **URL state** — `?year=X&id=Y` round-trips through the URL so deep links
  (e.g. `?year=1095&id=urban-ii`) restore the exact view.

## Production / Vercel deploy

See [DEPLOY.md](DEPLOY.md) for the full step-by-step playbook (GitHub →
Vercel → byzantinehistorymap.com → audio hosting).

**The short version:**

1. Push this repo to GitHub.
2. In Vercel, "Add New… → Project" and import the repo.
3. Set **Root Directory** to `web/`.
4. Add custom domain `byzantinehistorymap.com` in the project's Domains
   settings; Vercel will tell you the DNS records to add at your registrar.
5. **Audio**: host the `audio/` directory externally (Cloudflare R2, S3, or
   GitHub Releases). Set `AUDIO_BASE_URL` to its public URL in Vercel's
   Environment Variables. Without this, episode play buttons will 404 in
   production. Local dev keeps using `/audio` via the symlink.

## Known gaps / future work

- **Border overlays** — the Byzantine empire's shifting territory by century
  isn't visualized. Hand-drawn GeoJSON keyframes could fix this.
- **Card-game mode** — the data model already separates entities cleanly;
  adding stats (charisma / military / piety per ruler) is a small extension.
- **Score-driven UX** — every entity now carries a per-episode importance
  score (0-100) and a global `max_score`. The map could optionally hide
  low-importance people/places below a threshold while always keeping events
  visible. The hooks are in the data; the UI is the call.
