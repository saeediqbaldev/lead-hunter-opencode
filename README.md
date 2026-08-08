# Lead Hunter — combined deployment

This folder contains **both services** the app needs, wired together with
one `docker-compose.yml` at this top level:

```
lead-hunter/
├── docker-compose.yml   <- deploy THIS as one Coolify "Docker Compose" resource
├── leadgen-app/         <- the Node app (has its own Dockerfile)
└── scraper-service/     <- the Python contact-scraper (has its own Dockerfile)
```

Deploying both as one Compose stack (instead of two separate Coolify
resources) is what makes `http://scraper:8000` reliably resolve from the
Node app on every redeploy — no more chasing random container names.

## Deploy on Coolify

1. Push this whole folder to a fresh GitHub repo (see below).
2. Coolify → **+ New Resource → Docker Compose** → point it at this repo, branch `main`.
3. **Base Directory**: `/`
4. **Docker Compose Location**: `/docker-compose.yml`
5. **Domains**: set your public domain on the `leadgen-app` service only —
   leave the `scraper` service's domain field empty (it should never be
   public).
6. **Environment Variables** tab, add:
   - `SESSION_SECRET` — any long random string
   - `SCRAPER_API_SECRET` — any long random string (different from the above)
   - `GOOGLE_PLACES_API_KEY` — optional; only used as a fallback if a user
     hasn't added their own key inside the app yet
7. **Deploy.**

## Push to a fresh repo

```bash
cd lead-hunter
git init
git add .
git commit -m "Combined leadgen-app + scraper-service deployment"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/lead-hunter.git
git push -u origin main
```

## Verify it worked

From the `leadgen-app` service's Terminal in Coolify:
```bash
node -e "require('http').get('http://scraper:8000/health', r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>console.log('STATUS',r.statusCode,d)); }).on('error', e => console.log('ERROR:', e.message));"
```
Should print `STATUS 200 {"ok":true}`.

Then visit your domain, log in with `Saeeddev` / `Saeed@@2026&&` (this
creates a fresh admin account on first boot), and try **Add Scrape** on a
catch log with some businesses that have websites.

## Full documentation

- App features, exports, dedup logic, multi-user setup, theming, etc:
  `leadgen-app/README.md`
- Scraper internals, what it does/doesn't find, standalone run instructions:
  `scraper-service/README.md`
