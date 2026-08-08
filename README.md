# Lead Hunter — combined deployment

This folder contains **both services** the app needs, wired together with
one `docker-compose.yml` at this top level (plus an optional OpenCode agent
server as a 4th AI provider):

```
lead-hunter/
├── docker-compose.yml   <- deploy THIS as one Coolify "Docker Compose" resource
├── leadgen-app/         <- the Node app (has its own Dockerfile)
└── scraper-service/     <- the Python contact-scraper (has its own Dockerfile)
```

Deploying all as one Compose stack (instead of two separate Coolify
resources) is what makes `http://scraper:8000` reliably resolve from the
Node app on every redeploy — no more chasing random container names.

## Deploy on Coolify

1. Push this whole folder to a fresh GitHub repo (see below).
2. Coolify → **+ New Resource → Docker Compose** → point it at this repo, branch `main`.
3. **Base Directory**: `/`
4. **Docker Compose Location**: `/docker-compose.yml`
5. **Domains**: set your public domain on the `leadgen-app` service only —
   leave the `scraper` and `opencode` services' domain fields empty (they
   should never be public).
6. **Environment Variables** tab, add:
   - `SESSION_SECRET` — any long random string
   - `SCRAPER_API_SECRET` — any long random string (different from the above)
   - `GOOGLE_PLACES_API_KEY` — optional; only used as a fallback if a user
     hasn't added their own key inside the app yet
   - `GROQ_API_KEY`, `DEEPSEEK_API_KEY` — **optional**; only needed if you
     want OpenCode as a provider. Passed to the `opencode` container so it
     can run models. (If you leave them empty, OpenCode is skipped and the
     app works exactly as before.)
   - `OPENCODE_SERVER_PASSWORD` — any long random string; must be set on
     both `leadgen-app` and `opencode` (the compose file wires it to both).
   - `OPENCODE_MODEL` — optional; `provider/model` the opencode server runs
     for app requests (default `groq/openai/gpt-oss-120b`).
7. **Deploy.**

### About the OpenCode agent (optional)

- OpenCode is free open-source software — it does **not** provide "API
  keys" of its own. It consumes the LLM keys you already have
  (`GROQ_API_KEY`, `DEEPSEEK_API_KEY`, …) which you pass to its container
  via environment variables.
- The app uses it through `opencode serve`'s HTTP API. Requests use the
  model named by `OPENCODE_MODEL` with agent tools disabled, so it behaves
  like a plain text/JSON engine — matching how the app already calls Groq
  and DeepSeek directly.
- You can verify it's working from the app: **Settings → OpenCode Agent**
  shows server status and the model in use.
- First boot may take a moment while the opencode container downloads its
  runtime. `docker compose logs opencode` shows its startup output.

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
