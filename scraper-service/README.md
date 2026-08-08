# Contact Deep Scraper — microservice

Separate Python/FastAPI service used by `../leadgen-app`'s "Add Scrape"
button on a catch log. Full details, deployment steps (Docker Compose /
Coolify), and known limitations are documented in
`../leadgen-app/README.md`, section 7 ("Deploying the Contact Scraper
microservice").

## Quick local run (without Docker)
```bash
pip install -r requirements.txt
export DATABASE_PATH=$(pwd)/data/scraper.db
uvicorn app.main:app --host 0.0.0.0 --port 8000
```
Then open http://localhost:8000 for the standalone manual dashboard, or
point `leadgen-app`'s `SCRAPER_SERVICE_URL` env var at
`http://localhost:8000`.

## Via Docker Compose (recommended for production)
```bash
docker compose up -d --build
```
See `docker-compose.yml` - by default this does **not** expose a public
port, since it's meant to be called only by `leadgen-app` over the internal
Docker network. Uncomment the `ports:` line there if you want to open the
manual dashboard directly in your own browser (and set `SCRAPER_API_SECRET`
in that case, since it would otherwise be wide open).

## What this does, in one line
Given a business name + website (sent by `leadgen-app` as a generated CSV),
it visits the homepage and a few likely subpages (contact/about/imprint,
matched in 8 languages) and extracts: email, phone (from `tel:` links),
LinkedIn, Facebook, Instagram, and TikTok — plain HTTP requests only, no
headless browser, no JS rendering.
