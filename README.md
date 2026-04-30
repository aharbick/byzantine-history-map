# Twelve Byzantine Rulers — Interactive History

An interactive map + timeline website built from the transcripts of Lars
Brownworth's [*12 Byzantine Rulers*](https://12byzantinerulers.com/) podcast.
All 17 episodes (Diocletian → Constantine XI) are extracted into
**216 people, 155 places, 285 events**, each cross-linked and shown on a map
of the Byzantine world.

## What's here

```
audio/                  raw mp3s (370 MB total — gitignored, hosted externally in production)
transcripts/            text transcripts of each episode
data/
├── episodes/           per-episode JSON extractions (the sources of truth)
├── merge.py            merges + dedupes into entities.json
├── fetch_portraits.py  Wikipedia thumbnail fetcher (cached in portraits.json)
├── validate_coords.py  audits place coords against Wikipedia
├── entities.json       canonical merged dataset
├── portraits.json      Wikipedia portrait/image cache
├── wikipedia_coords.json  Wikipedia coord cache (audit reference)
└── SCHEMA.md           shape of the per-episode JSONs
web/                    Next.js 16 app (the website itself)
mise.toml               pinned Node 22
.claude/launch.json     Claude Code preview config
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

`npm run dev` runs `data/merge.py` first (via the `predev` hook) so the app
always loads the latest extraction from `data/episodes/`.

The audio player streams from `web/public/audio/`, which is a symlink to
`../../audio/`. If you re-clone the repo, recreate that symlink:

```bash
cd web/public && ln -s ../../audio audio
```

## Data pipeline

To change/add data, edit `data/episodes/epNN.json` and re-merge:

```bash
python3 data/merge.py
```

This rewrites both `data/entities.json` (canonical) and
`web/src/data/entities.json` (consumed by the Next.js app). Both files are
**committed** so production builds work even if Python is unavailable.

To refresh Wikipedia portraits/coords:

```bash
python3 data/fetch_portraits.py     # ~5 min, polite rate limit, cached
python3 data/validate_coords.py     # audits place lat/lng vs Wikipedia
```

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

- **Episode timestamp deep-linking** — chips play from t=0. Re-transcribing
  with whisper word-level timestamps would let cards jump to the exact
  moment a person/place/event is mentioned.
- **Border overlays** — the Byzantine empire's shifting territory by century
  isn't visualized. Hand-drawn GeoJSON keyframes could fix this.
- **Card-game mode** — the data model already separates entities cleanly;
  adding stats (charisma / military / piety per ruler) is a small extension.
