"""
Imports a CSV of businesses into the database.

Handles two things that would otherwise break a naive importer:
1. Metadata/preamble lines before the real header row (e.g. exports that
   start with "Niche: ..." or "Catch Log: ..." before the actual table).
2. Column headers that don't exactly match what we expect - matched
   case-insensitively against a list of common aliases, and matched by
   NAME not position, so reordering, renaming (within reason), or adding
   extra columns won't break the import.

If the sheet has no column we can confidently read as the business name,
import fails loudly with a clear message naming what it found instead -
never silently imports zero rows.
"""
import csv
import io
import re
from . import db


def _norm(s: str) -> str:
    """Normalize a header for comparison: lowercase, strip punctuation/spaces."""
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


# canonical field -> header names people commonly use for it.
# Matched after normalization, so "Business Name", "business_name", and
# "BUSINESS-NAME" all match the same alias automatically.
COLUMN_ALIASES = {
    "sn": ["s/n", "sn", "no", "no.", "#", "serial", "id", "sl no"],
    "business_name": [
        "business name", "company name", "company", "business", "name",
        "shop name", "brand name", "organisation", "organization",
    ],
    "address": ["address", "location", "full address"],
    "maps_link": ["maps link", "google maps link", "map link", "gmaps link", "maps url", "map url"],
    "phone": ["phone", "phone number", "contact number", "tel", "telephone", "mobile", "mobile number"],
    "whatsapp_link": ["whatsapp link", "whatsapp", "wa link", "wa.me"],
    "website": ["website", "site", "url", "web", "web site", "homepage"],
    "rating": ["rating", "stars", "google rating"],
    "reviews": ["reviews", "review count", "num reviews", "number of reviews"],
    "needs": ["needs", "need"],
    "status": ["status", "stage"],
    "notes": ["notes", "note", "comment", "comments", "remarks"],
}

# Fields we require to consider a row worth importing.
REQUIRED_FIELDS = ["business_name"]


def _build_field_map(header_cells: list[str]) -> dict:
    """Map canonical field name -> actual header text found in this CSV."""
    normalized_headers = {_norm(h): h for h in header_cells}
    field_map = {}
    for field, aliases in COLUMN_ALIASES.items():
        for alias in aliases:
            key = _norm(alias)
            if key in normalized_headers:
                field_map[field] = normalized_headers[key]
                break
    return field_map


def _find_header_row(lines: list[str]) -> tuple[int, list[str]]:
    """
    Scan the first ~30 lines for the one that looks like the real table
    header - i.e. contains a cell matching a business-name alias. This
    lets us skip any number of metadata/preamble lines regardless of
    their content, without assuming a fixed marker like 'S/N,'.
    """
    business_name_keys = {_norm(a) for a in COLUMN_ALIASES["business_name"]}
    for i, line in enumerate(lines[:30]):
        if not line.strip():
            continue
        cells = next(csv.reader([line]))
        normalized_cells = {_norm(c) for c in cells}
        if normalized_cells & business_name_keys:
            return i, cells
    raise ValueError(
        "Couldn't find a business name column in this file. Looked at the "
        f"first {min(30, len(lines))} lines for a header containing something "
        "like 'Business Name', 'Company', or 'Name'. Check that the file has "
        "a header row naming that column."
    )


def import_csv_text(raw_text: str) -> dict:
    lines = raw_text.splitlines()
    header_idx, header_cells = _find_header_row(lines)
    field_map = _build_field_map(header_cells)

    missing_required = [f for f in REQUIRED_FIELDS if f not in field_map]
    if missing_required:
        raise ValueError(
            f"Found a header row ({header_cells}) but couldn't confidently "
            f"match: {', '.join(missing_required)}."
        )

    table_text = "\n".join(lines[header_idx:])
    reader = csv.DictReader(io.StringIO(table_text))

    imported, skipped = 0, 0
    for row in reader:
        canonical = {field: row.get(actual_header) for field, actual_header in field_map.items()}
        if not (canonical.get("business_name") or "").strip():
            skipped += 1
            continue
        db.insert_business(canonical)
        imported += 1

    return {
        "imported": imported,
        "skipped": skipped,
        "matched_columns": field_map,
    }


def import_csv_file(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return import_csv_text(f.read())
