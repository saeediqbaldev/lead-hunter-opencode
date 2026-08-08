import sqlite3
import os
from contextlib import contextmanager
from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS businesses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sn TEXT,
    business_name TEXT,
    address TEXT,
    maps_link TEXT,
    phone TEXT,
    whatsapp_link TEXT,
    website TEXT,
    rating TEXT,
    reviews TEXT,
    needs TEXT,
    status TEXT,
    notes TEXT,
    -- scraped fields
    email TEXT,
    linkedin TEXT,
    facebook TEXT,
    instagram TEXT,
    tiktok TEXT,
    twitter_x TEXT,
    phone_scraped TEXT,
    scrape_status TEXT DEFAULT 'pending',   -- pending | scraping | done | failed | skipped
    scrape_error TEXT,
    used_playwright INTEGER DEFAULT 0,
    scraped_at TEXT,
    UNIQUE(business_name, website)
);

CREATE TABLE IF NOT EXISTS saved_lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    niche TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS saved_list_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    saved_list_id INTEGER NOT NULL,
    sn TEXT, business_name TEXT, address TEXT, maps_link TEXT, phone TEXT,
    whatsapp_link TEXT, website TEXT, rating TEXT, reviews TEXT, needs TEXT,
    status TEXT, notes TEXT, email TEXT, linkedin TEXT, facebook TEXT,
    instagram TEXT, tiktok TEXT, twitter_x TEXT, phone_scraped TEXT,
    scrape_status TEXT, scraped_at TEXT
);
"""


def get_conn():
    os.makedirs(os.path.dirname(config.DATABASE_PATH), exist_ok=True)
    conn = sqlite3.connect(config.DATABASE_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_conn() as conn:
        conn.executescript(SCHEMA)


def insert_business(row: dict):
    with get_conn() as conn:
        try:
            conn.execute(
                """INSERT INTO businesses
                (sn, business_name, address, maps_link, phone, whatsapp_link,
                 website, rating, reviews, needs, status, notes)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (row.get("sn"), row.get("business_name"), row.get("address"),
                 row.get("maps_link"), row.get("phone"), row.get("whatsapp_link"),
                 row.get("website") or None, row.get("rating"), row.get("reviews"),
                 row.get("needs"), row.get("status"), row.get("notes")),
            )
        except sqlite3.IntegrityError:
            pass  # already imported, skip


def get_pending_businesses(limit: int | None = None):
    q = "SELECT * FROM businesses WHERE website IS NOT NULL AND website != '' AND scrape_status = 'pending'"
    if limit:
        q += f" LIMIT {int(limit)}"
    with get_conn() as conn:
        return [dict(r) for r in conn.execute(q).fetchall()]


def mark_scraping(business_id: int):
    with get_conn() as conn:
        conn.execute("UPDATE businesses SET scrape_status='scraping' WHERE id=?", (business_id,))


def save_scrape_result(business_id: int, contacts: dict, used_playwright: bool, error: str | None = None):
    with get_conn() as conn:
        conn.execute(
            """UPDATE businesses SET
                email=?, linkedin=?, facebook=?, instagram=?, tiktok=?, twitter_x=?,
                phone_scraped=?, scrape_status=?, scrape_error=?, used_playwright=?,
                scraped_at=datetime('now')
               WHERE id=?""",
            (contacts.get("email"), contacts.get("linkedin"), contacts.get("facebook"),
             contacts.get("instagram"), contacts.get("tiktok"), contacts.get("twitter_x"),
             contacts.get("phone_tel"), "failed" if error else "done", error,
             int(used_playwright), business_id),
        )


def get_status_counts():
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT scrape_status, COUNT(*) as c FROM businesses GROUP BY scrape_status"
        ).fetchall()
        total = conn.execute("SELECT COUNT(*) as c FROM businesses").fetchone()["c"]
    counts = {r["scrape_status"]: r["c"] for r in rows}
    counts["total"] = total
    return counts


def get_all_businesses():
    with get_conn() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM businesses").fetchall()]


def reset_businesses():
    """Clears the working table only. Saved lists are untouched."""
    with get_conn() as conn:
        conn.execute("DELETE FROM businesses")


ITEM_COLUMNS = [
    "sn", "business_name", "address", "maps_link", "phone", "whatsapp_link",
    "website", "rating", "reviews", "needs", "status", "notes", "email",
    "linkedin", "facebook", "instagram", "tiktok", "twitter_x",
    "phone_scraped", "scrape_status", "scraped_at",
]


def create_saved_list(name: str, niche: str | None) -> dict:
    """Snapshots the current businesses table into a new named, saved list."""
    with get_conn() as conn:
        cur = conn.execute("INSERT INTO saved_lists (name, niche) VALUES (?, ?)", (name, niche))
        list_id = cur.lastrowid
        rows = conn.execute("SELECT * FROM businesses").fetchall()
        cols = ", ".join(ITEM_COLUMNS)
        placeholders = ", ".join("?" for _ in ITEM_COLUMNS)
        for r in rows:
            values = [list_id] + [r[c] for c in ITEM_COLUMNS]
            conn.execute(
                f"INSERT INTO saved_list_items (saved_list_id, {cols}) VALUES (?, {placeholders})",
                values,
            )
        created_at = conn.execute(
            "SELECT created_at FROM saved_lists WHERE id=?", (list_id,)
        ).fetchone()["created_at"]
    return {"id": list_id, "name": name, "niche": niche, "count": len(rows), "created_at": created_at}


def get_saved_lists():
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT l.id, l.name, l.niche, l.created_at, COUNT(i.id) as count
               FROM saved_lists l LEFT JOIN saved_list_items i ON i.saved_list_id = l.id
               GROUP BY l.id ORDER BY l.created_at DESC"""
        ).fetchall()
    return [dict(r) for r in rows]


def get_saved_list_meta(list_id: int):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM saved_lists WHERE id=?", (list_id,)).fetchone()
    return dict(row) if row else None


def get_saved_list_items(list_id: int):
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM saved_list_items WHERE saved_list_id=?", (list_id,)
        ).fetchall()
    return [dict(r) for r in rows]


def update_saved_list(list_id: int, name: str | None = None, niche: str | None = None):
    with get_conn() as conn:
        if name is not None:
            conn.execute("UPDATE saved_lists SET name=? WHERE id=?", (name, list_id))
        if niche is not None:
            conn.execute("UPDATE saved_lists SET niche=? WHERE id=?", (niche, list_id))


def delete_saved_list(list_id: int):
    with get_conn() as conn:
        conn.execute("DELETE FROM saved_list_items WHERE saved_list_id=?", (list_id,))
        conn.execute("DELETE FROM saved_lists WHERE id=?", (list_id,))
