import os

# HTTP scraping
CONCURRENCY = int(os.getenv("CONCURRENCY", "5"))
REQUEST_TIMEOUT = float(os.getenv("REQUEST_TIMEOUT", "15"))
DELAY_SECONDS = float(os.getenv("DELAY_SECONDS", "1.0"))

# Storage
DATABASE_PATH = os.getenv("DATABASE_PATH", "/app/data/scraper.db")

# Identify the bot honestly - good practice, some sites allow-list known UAs
USER_AGENT = os.getenv(
    "USER_AGENT",
    "Mozilla/5.0 (compatible; LeadContactBot/1.0; +mailto:youremail@example.com)",
)

SUBPAGE_KEYWORDS = [
    # English
    "contact", "about", "imprint", "legal", "team", "reach-us", "get-in-touch",
    # German
    "impressum", "kontakt", "uber-uns", "über-uns", "ueber-uns",
    # French
    "contactez", "a-propos", "à-propos", "nous-contacter", "qui-sommes-nous",
    # Spanish
    "contacto", "sobre-nosotros", "quienes-somos", "quiénes-somos",
    # Portuguese
    "contato", "sobre-nos", "quem-somos",
    # Italian
    "contatti", "chi-siamo",
    # Dutch
    "over-ons", "neem-contact",
    # Turkish
    "iletisim", "iletişim", "hakkimizda", "hakkımızda",
]
