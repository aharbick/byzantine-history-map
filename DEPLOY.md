# Deploy playbook — GitHub → Vercel → byzantinehistorymap.com

A walkthrough for getting this app live on your custom domain. Roughly
**20 minutes** of clicking, plus DNS propagation time.

---

## Step 1 — Push to GitHub

The git repo is already initialized locally. Create a GitHub repo and push:

```bash
# In the project root (/Users/aharbick/Sites/byzantine_rulers)
gh repo create byzantine-history-map --public --source=. --remote=origin
git push -u origin main
```

If you don't have the `gh` CLI:

1. Go to https://github.com/new
2. Name it `byzantine-history-map`, leave it **empty** (no README/license/etc).
3. Then in the project root:

```bash
git remote add origin https://github.com/<your-username>/byzantine-history-map.git
git push -u origin main
```

> **Note on transcripts:** `transcripts/*.txt` are committed for the data
> pipeline. They're Lars Brownworth's content. If you want to be cautious,
> make the repo **private** (Vercel can still build from a private repo) or
> add `transcripts/` to `.gitignore` before your first push.

---

## Step 2 — Connect Vercel

1. Go to https://vercel.com/new
2. Click **Import** next to your `byzantine-history-map` repo.
3. **Project Settings** to configure before clicking Deploy:
   - **Root Directory** → `web` ← *important, this is the Next.js app*
     (Click "Edit" next to Root Directory to change from the default of `.`)
   - **Framework Preset** → Next.js (auto-detected once root is set)
   - **Build Command** → leave default (`npm run build`)
   - **Install Command** → leave default (`npm install`)
   - **Output Directory** → leave default
4. Click **Deploy**.

The first deploy will take ~3 minutes (npm install + Next build). When it
finishes you'll get a `*.vercel.app` URL — verify the app loads, you can
scrub time, click markers, see cards, etc. Audio chips will 404 until you
finish step 4.

---

## Step 3 — Add the custom domain

You said the domain is `byzantinehistorymap.com`.

1. In your Vercel project → **Settings → Domains**
2. Add `byzantinehistorymap.com` and `www.byzantinehistorymap.com`.
3. Vercel will show you DNS records to add at your registrar. Typically:

| Type  | Name | Value                       |
| ----- | ---- | --------------------------- |
| A     | @    | `76.76.21.21`               |
| CNAME | www  | `cname.vercel-dns.com`      |

(Vercel may show different exact values — use **theirs**, not these.)

4. Add the records at your registrar's DNS settings.
5. DNS propagation: usually minutes, can be up to a few hours. Vercel will
   auto-issue an SSL certificate via Let's Encrypt once DNS resolves.

When the domain dashboard shows ✓ (green check) for both `byzantinehistorymap.com`
and `www.byzantinehistorymap.com`, the site is live on your domain.

---

## Step 4 — Host the audio externally

The 17 mp3s total ~370 MB and **cannot be in the GitHub repo** (GitHub's per-file
limit is 100 MB and per-repo soft limit is ~1 GB). You need to host them
elsewhere and point the app at the new URL.

### Recommended option: Cloudflare R2

R2 has a generous free tier (10 GB storage, free egress to Cloudflare's edge),
no per-request charges below 1 M/month, and is the cheapest mature option.

1. Sign up at https://dash.cloudflare.com/sign-up (if you don't have an
   account).
2. **R2 → Create bucket**, name it `byzantinehistorymap-audio` (or whatever).
3. Bucket → **Settings → Public access → Allow Access** and copy the public
   bucket URL (looks like `https://pub-xxxxxxxx.r2.dev`).
4. Upload the 17 mp3s with the same filenames as in `audio/` (the app
   expects exact filenames like `01 - Episode 1 - Introduction.mp3`).
   You can use `wrangler` CLI:

   ```bash
   npm install -g wrangler
   wrangler login
   for f in audio/*.mp3; do
     wrangler r2 object put byzantinehistorymap-audio/"$(basename "$f")" --file="$f" --remote
   done
   ```

   Or upload via the Cloudflare dashboard.
5. Verify: in browser, hit
   `https://pub-xxxxxxxx.r2.dev/01 - Episode 1 - Introduction.mp3`
   (URL-encode the spaces: `%20`). You should see audio play / download.

### Alternatives

- **GitHub Releases** — free, no bandwidth limits, simple. Create a Release
  on the repo and attach the mp3s. URLs look like
  `https://github.com/<user>/byzantine-history-map/releases/download/v1.0/01...mp3`.
  Set `AUDIO_BASE_URL` to the release base path. Slight downside: GitHub
  may rate-limit downloads at very high traffic.
- **AWS S3** / **Backblaze B2** — both work, both have egress fees.
- **Lars Brownworth's own audio URLs** (hotlinking from
  https://12byzantinerulers.com/) — *don't*. It's rude and likely to break
  if he changes hosting.

### Wire the URL into Vercel

In your Vercel project → **Settings → Environment Variables**:

| Name             | Value                                | Environments |
| ---------------- | ------------------------------------ | ------------ |
| `AUDIO_BASE_URL` | `https://pub-xxxxxxxx.r2.dev`        | Production, Preview |

(No trailing slash. The app concatenates `/<filename>.mp3`.)

Then **Redeploy** (Deployments tab → ⋯ → Redeploy → with cache cleared).
Episode chips should now play in production.

---

## Step 5 — Verify

- [ ] `https://byzantinehistorymap.com` resolves and shows the map
- [ ] `https://www.byzantinehistorymap.com` redirects to the apex (Vercel
      handles this automatically once both are added)
- [ ] HTTPS green padlock (Let's Encrypt cert active)
- [ ] Map renders, scrubbing works, clicking dots opens cards
- [ ] Episode chip on a card plays audio without errors
- [ ] Deep-link works: paste `?year=1095&id=urban-ii` after the domain and
      get straight to Pope Urban II's card at the year of Clermont

---

## Continuous deploy

Every `git push` to `main` triggers a Vercel production deploy. Pull requests
get preview URLs automatically. To disable previews or change the production
branch, see Vercel project settings → Git.

## Troubleshooting

**"Build failed: python3: command not found"**
The repo includes a committed `web/src/data/entities.json` and the prebuild
hook is wrapped in `|| echo "..."` so this should be a non-issue. If it
still fails, remove `prebuild` from `web/package.json` — the build will use
the committed file directly.

**"My audio 404s in production"**
Check `AUDIO_BASE_URL` is set in Vercel env vars and redeploy. Check the URL
in browser DevTools → Network tab when you click a chip.

**"Domain shows 'Invalid Configuration' in Vercel"**
DNS hasn't propagated yet. Wait a few hours and refresh, or use
`dig byzantinehistorymap.com` to verify DNS resolution before checking
Vercel's status.
