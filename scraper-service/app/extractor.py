"""
Pulls emails, phone numbers, and social profile links out of raw HTML.
Pure regex + BeautifulSoup - no external calls here, so it's cheap to
run against every page you fetch.
"""
import re
from bs4 import BeautifulSoup
from urllib.parse import urljoin

EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")

# Filters out obvious junk matches (image files misread as emails, tracking
# pixels, placeholder addresses that template builders leave behind, etc.)
EMAIL_JUNK_SUBSTRINGS = (
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp",
    "sentry.io", "wixpress.com", "example.com", "yourdomain",
    "godaddy.com", "schema.org", "@2x", "no-reply@google",
)

PHONE_RE = re.compile(
    r"(\+?\d[\d\s().\-]{7,}\d)"
)

SOCIAL_PATTERNS = {
    "linkedin": re.compile(r"https?://(?:www\.)?linkedin\.com/[^\s\"'<>]+", re.I),
    "facebook": re.compile(r"https?://(?:www\.)?facebook\.com/[^\s\"'<>]+", re.I),
    "instagram": re.compile(r"https?://(?:www\.)?instagram\.com/[^\s\"'<>]+", re.I),
    "tiktok": re.compile(r"https?://(?:www\.)?tiktok\.com/[^\s\"'<>]+", re.I),
    "twitter_x": re.compile(r"https?://(?:www\.)?(?:twitter|x)\.com/[^\s\"'<>]+", re.I),
}

# Generic share-widget / login links that aren't the business's own profile
SOCIAL_JUNK_SUBSTRINGS = (
    "facebook.com/sharer", "facebook.com/plugins", "facebook.com/tr",
    "instagram.com/accounts/login", "twitter.com/intent", "twitter.com/share",
    "linkedin.com/shareArticle", "linkedin.com/sharing",
)


def clean_url(url: str) -> str:
    return url.rstrip(").,;\"'").strip()


def extract_emails(html: str) -> list[str]:
    found = set()
    for m in EMAIL_RE.findall(html):
        email = m.strip().lower().rstrip(".")
        if any(junk in email for junk in EMAIL_JUNK_SUBSTRINGS):
            continue
        found.add(email)
    return sorted(found)


def extract_socials(html: str) -> dict:
    result = {}
    for key, pattern in SOCIAL_PATTERNS.items():
        for m in pattern.findall(html):
            url = clean_url(m)
            if any(junk in url for junk in SOCIAL_JUNK_SUBSTRINGS):
                continue
            result.setdefault(key, url)  # keep first (usually header/footer) match
            break
    return result


def extract_phones_from_tel_links(html: str) -> list[str]:
    soup = BeautifulSoup(html, "html.parser")
    phones = set()
    for a in soup.find_all("a", href=True):
        if a["href"].startswith("tel:"):
            phones.add(a["href"].replace("tel:", "").strip())
    return sorted(phones)


def find_internal_links(html: str, base_url: str, keywords: list[str]) -> list[str]:
    """Find same-site links whose href or link text matches one of the
    given keywords (e.g. impressum, kontakt, contact)."""
    soup = BeautifulSoup(html, "html.parser")
    matches = []
    for a in soup.find_all("a", href=True):
        href = a["href"]
        text = (a.get_text() or "").strip().lower()
        haystack = f"{href.lower()} {text}"
        if any(kw in haystack for kw in keywords):
            full_url = urljoin(base_url, href)
            if full_url.startswith(("http://", "https://")):
                matches.append(full_url)
    # de-dupe, preserve order
    seen = set()
    ordered = []
    for u in matches:
        if u not in seen:
            seen.add(u)
            ordered.append(u)
    return ordered[:4]  # don't chase more than a few subpages per site


def page_text_length(html: str) -> int:
    soup = BeautifulSoup(html, "html.parser")
    return len(soup.get_text(strip=True))


def merge_contacts(*dicts_or_lists) -> dict:
    """Merge extraction results from multiple pages, first non-empty value wins."""
    merged = {"email": None, "linkedin": None, "facebook": None,
              "instagram": None, "tiktok": None, "twitter_x": None, "phone_tel": None}
    for item in dicts_or_lists:
        if not item:
            continue
        for k, v in item.items():
            if v and not merged.get(k):
                merged[k] = v
    return merged
