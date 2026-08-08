import asyncio
import httpx
from . import config, extractor, db

# In-memory, per-run stats and controls. Single-process app, so a module-level
# dict is enough - no need for a database table for ephemeral "this run"
# numbers like the live request counter.
stats = {"requests_made": 0}
stop_event = asyncio.Event()


def reset_stats():
    stats["requests_made"] = 0
    stop_event.clear()


def request_stop():
    stop_event.set()


async def fetch_html(client: httpx.AsyncClient, url: str) -> str | None:
    stats["requests_made"] += 1
    try:
        resp = await client.get(url, timeout=config.REQUEST_TIMEOUT, follow_redirects=True)
        if resp.status_code >= 400:
            return None
        content_type = resp.headers.get("content-type", "")
        if "text/html" not in content_type and "text" not in content_type:
            return None
        return resp.text
    except (httpx.HTTPError, httpx.TimeoutException):
        return None


def extract_all(html: str) -> dict:
    emails = extractor.extract_emails(html)
    socials = extractor.extract_socials(html)
    tel_phones = extractor.extract_phones_from_tel_links(html)
    return {
        "email": emails[0] if emails else None,
        "phone_tel": tel_phones[0] if tel_phones else None,
        **socials,
    }


async def scrape_one_business(client: httpx.AsyncClient, business: dict) -> dict:
    url = business["website"]
    homepage_html = await fetch_html(client, url)
    await asyncio.sleep(config.DELAY_SECONDS)  # minimal gap, easy on the target site

    results = []
    if homepage_html:
        results.append(extract_all(homepage_html))

        subpages = extractor.find_internal_links(homepage_html, url, config.SUBPAGE_KEYWORDS)
        for sub_url in subpages:
            if stop_event.is_set():
                break
            sub_html = await fetch_html(client, sub_url)
            await asyncio.sleep(config.DELAY_SECONDS)
            if sub_html:
                results.append(extract_all(sub_html))

    merged = extractor.merge_contacts(*results)
    return merged, False  # second value kept for db.save_scrape_result's signature


async def run_batch(limit: int | None = None):
    businesses = db.get_pending_businesses(limit=limit)
    if not businesses:
        return {"processed": 0, "stopped": False}

    reset_stats()
    queue: asyncio.Queue = asyncio.Queue()
    for b in businesses:
        queue.put_nowait(b)

    processed = 0

    async with httpx.AsyncClient(headers={"User-Agent": config.USER_AGENT}) as client:
        async def worker():
            nonlocal processed
            while True:
                if stop_event.is_set():
                    return
                try:
                    biz = queue.get_nowait()
                except asyncio.QueueEmpty:
                    return
                db.mark_scraping(biz["id"])
                try:
                    contacts, used_pw = await scrape_one_business(client, biz)
                    db.save_scrape_result(biz["id"], contacts, used_pw)
                except Exception as e:
                    db.save_scrape_result(biz["id"], {}, False, error=str(e))
                processed += 1

        # CONCURRENCY workers pulling from the same queue - this both caps
        # how many requests are in flight at once AND gives us a clean point
        # (the top of each worker's loop) to honor a stop request between
        # businesses, without yanking a request out mid-flight.
        workers = [asyncio.create_task(worker()) for _ in range(config.CONCURRENCY)]
        await asyncio.gather(*workers)

    stopped = stop_event.is_set()
    stop_event.clear()
    return {"processed": processed, "stopped": stopped}
