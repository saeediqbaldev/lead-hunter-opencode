import csv
import io
import os
import pathlib
from contextlib import asynccontextmanager

from fastapi import FastAPI, UploadFile, File, BackgroundTasks, HTTPException, Body, Request
from fastapi.responses import StreamingResponse, HTMLResponse

from . import config, db, importer, scraper, pdf_export

DASHBOARD_PATH = pathlib.Path(__file__).parent / "dashboard.html"

# The original spec deliberately ships with no authentication. Since this
# service now sits on the open internet (called by the Node lead-gen app
# over HTTP, and its own dashboard is reachable directly too), a minimal
# shared-secret check is added here - NOT full auth, just a single header
# the Node app (and you, if you open the dashboard directly) must send.
# Leave SCRAPER_API_SECRET unset to keep the original fully-open behavior.
SCRAPER_API_SECRET = os.getenv("SCRAPER_API_SECRET", "")


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    yield


app = FastAPI(title="Contact Deep Scraper", lifespan=lifespan)

_job_state = {"running": False, "last_result": None}


@app.middleware("http")
async def check_secret(request: Request, call_next):
    if SCRAPER_API_SECRET and request.url.path not in ("/health",):
        provided = request.headers.get("x-scraper-secret", "")
        if provided != SCRAPER_API_SECRET:
            return HTMLResponse("Unauthorized - missing or wrong X-Scraper-Secret header", status_code=401)
    return await call_next(request)


def _csv_response(rows: list[dict], filename: str) -> StreamingResponse:
    buf = io.StringIO()
    if rows:
        writer = csv.DictWriter(buf, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


def _pdf_response(rows: list[dict], filename: str, title: str, subtitle: str | None = None) -> StreamingResponse:
    pdf_bytes = pdf_export.build_pdf(rows, title=title, subtitle=subtitle)
    return StreamingResponse(
        iter([pdf_bytes]),
        media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


# ---------- import / scrape / reset ----------

@app.post("/import-csv")
async def import_csv(file: UploadFile = File(...)):
    raw = (await file.read()).decode("utf-8")
    try:
        result = importer.import_csv_text(raw)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return result


@app.post("/scrape/start")
async def start_scrape(background_tasks: BackgroundTasks, limit: int | None = None):
    if _job_state["running"]:
        return {"status": "already_running"}

    async def job():
        _job_state["running"] = True
        try:
            result = await scraper.run_batch(limit=limit)
            _job_state["last_result"] = result
        finally:
            _job_state["running"] = False

    background_tasks.add_task(job)
    return {"status": "started"}


@app.post("/scrape/stop")
async def stop_scrape():
    if not _job_state["running"]:
        return {"status": "not_running"}
    scraper.request_stop()
    return {"status": "stopping"}


@app.get("/scrape/status")
async def scrape_status():
    counts = db.get_status_counts()
    return {
        "job_running": _job_state["running"],
        "stop_requested": scraper.stop_event.is_set(),
        "last_result": _job_state["last_result"],
        "counts": counts,
        "requests_made": scraper.stats["requests_made"],
        "concurrency": config.CONCURRENCY,
        "delay_seconds": config.DELAY_SECONDS,
    }


@app.post("/reset")
async def reset():
    if _job_state["running"]:
        raise HTTPException(status_code=409, detail="Stop the running scrape before resetting.")
    db.reset_businesses()
    _job_state["last_result"] = None
    scraper.reset_stats()
    return {"status": "reset"}


# ---------- current working list ----------

@app.get("/businesses")
async def list_businesses():
    return db.get_all_businesses()


@app.get("/export")
async def export_current(format: str = "csv"):
    rows = db.get_all_businesses()
    if format == "pdf":
        return _pdf_response(rows, "scraped_contacts.pdf", title="Scraped Contacts")
    return _csv_response(rows, "scraped_contacts.csv")


# ---------- saved lists (CRUD) ----------

@app.post("/lists")
async def save_list(payload: dict = Body(...)):
    name = (payload.get("name") or "").strip()
    niche = (payload.get("niche") or "").strip() or None
    if not name:
        raise HTTPException(status_code=400, detail="A name is required to save this list.")
    return db.create_saved_list(name, niche)


@app.get("/lists")
async def list_saved_lists():
    return db.get_saved_lists()


@app.get("/lists/{list_id}")
async def get_saved_list(list_id: int):
    meta = db.get_saved_list_meta(list_id)
    if not meta:
        raise HTTPException(status_code=404, detail="No saved list with that id.")
    return {"meta": meta, "items": db.get_saved_list_items(list_id)}


@app.put("/lists/{list_id}")
async def rename_saved_list(list_id: int, payload: dict = Body(...)):
    if not db.get_saved_list_meta(list_id):
        raise HTTPException(status_code=404, detail="No saved list with that id.")
    name = payload.get("name")
    niche = payload.get("niche")
    db.update_saved_list(list_id, name=name, niche=niche)
    return {"status": "updated"}


@app.delete("/lists/{list_id}")
async def remove_saved_list(list_id: int):
    if not db.get_saved_list_meta(list_id):
        raise HTTPException(status_code=404, detail="No saved list with that id.")
    db.delete_saved_list(list_id)
    return {"status": "deleted"}


@app.get("/lists/{list_id}/export")
async def export_saved_list(list_id: int, format: str = "csv"):
    meta = db.get_saved_list_meta(list_id)
    if not meta:
        raise HTTPException(status_code=404, detail="No saved list with that id.")
    items = db.get_saved_list_items(list_id)
    safe_name = "".join(c if c.isalnum() or c in "-_ " else "_" for c in meta["name"]).strip() or f"list_{list_id}"
    if format == "pdf":
        return _pdf_response(items, f"{safe_name}.pdf", title=meta["name"], subtitle=meta.get("niche"))
    return _csv_response(items, f"{safe_name}.csv")


# ---------- dashboard / health ----------

@app.get("/", response_class=HTMLResponse)
async def dashboard():
    return DASHBOARD_PATH.read_text(encoding="utf-8")


@app.get("/health")
async def health():
    return {"ok": True}
