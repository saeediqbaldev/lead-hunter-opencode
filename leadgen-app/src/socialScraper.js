const fetch = require("node-fetch");

// Best-effort: visit a business's own website and look for links out to its
// social profiles + a public email address. There's no official API for
// this - it's just scanning the homepage HTML. Only works if the site
// actually links to its profiles/email, loads fast enough, and doesn't
// block automated requests.

const TIMEOUT_MS = 6000;
const MAX_HTML_BYTES = 500_000; // don't bother parsing huge pages, homepage only

// A realistic browser UA (rotated) is far less likely to get an immediate
// bot-block from a WAF than a self-identifying "Bot/1.0" string. This is a
// single, low-volume, read-only GET of a public homepage - not scraping at
// a scale that would normally trigger abuse detection - but looking like an
// ordinary visitor further reduces the odds any individual site flags it.
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];

function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function jitterDelay() {
  // Small random stagger (300-900ms) so requests don't fire in an obvious,
  // uniform burst from the same IP - closer to how a real visitor arrives.
  const ms = 300 + Math.floor(Math.random() * 600);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PLATFORM_PATTERNS = [
  { key: "facebook", regex: /https?:\/\/(www\.)?facebook\.com\/[^\s"'<>)]+/gi },
  { key: "instagram", regex: /https?:\/\/(www\.)?instagram\.com\/[^\s"'<>)]+/gi },
  { key: "linkedin", regex: /https?:\/\/(www\.)?linkedin\.com\/[^\s"'<>)]+/gi },
  { key: "tiktok", regex: /https?:\/\/(www\.)?tiktok\.com\/[^\s"'<>)]+/gi },
];

// Share-button / widget links aren't the business's own profile - filter them out.
const NOISE_PATTERNS = [
  /sharer\.php/i,
  /share\.php/i,
  /intent\/tweet/i,
  /\/share\?/i,
  /plugins\/(like|share)/i,
  /\/dialog\//i,
];

// Generic-looking inboxes are usually not a useful lead contact, and
// clutter results with webmaster@ / no-reply@ / example.com placeholders.
const NOISE_EMAIL_PATTERNS = [
  /^(no-?reply|donotreply|webmaster|postmaster|abuse|mailer-daemon)@/i,
  /@(example\.com|sentry\.io|wixpress\.com|godaddy\.com)$/i,
  /\.(png|jpg|jpeg|gif|svg|webp)$/i, // image filenames that look like emails in minified JS
];

function cleanMatch(url) {
  return url.replace(/&amp;.*$/, "").replace(/["').,;]+$/, "");
}

function isNoise(url) {
  return NOISE_PATTERNS.some((p) => p.test(url));
}

function findEmail(html) {
  // Prefer explicit mailto: links first - much more reliable than scanning
  // raw text, which turns up false positives from scripts/analytics tags.
  const mailtoMatches = html.match(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi);
  if (mailtoMatches) {
    for (const m of mailtoMatches) {
      const email = m.replace(/^mailto:/i, "").split("?")[0];
      if (!NOISE_EMAIL_PATTERNS.some((p) => p.test(email))) return email;
    }
  }

  // Fall back to a plain-text scan of the visible HTML.
  const textMatches = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
  if (textMatches) {
    const clean = textMatches.find((e) => !NOISE_EMAIL_PATTERNS.some((p) => p.test(e)));
    if (clean) return clean;
  }

  return null;
}

async function findSocialLinks(websiteUrl) {
  if (!websiteUrl) return {};

  await jitterDelay();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(websiteUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": randomUserAgent(),
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    if (!res.ok) return {};

    let html = await res.text();
    if (html.length > MAX_HTML_BYTES) html = html.slice(0, MAX_HTML_BYTES);

    const found = {};
    for (const { key, regex } of PLATFORM_PATTERNS) {
      const matches = html.match(regex);
      if (!matches) continue;
      const clean = matches.map(cleanMatch).find((m) => !isNoise(m));
      if (clean) found[key] = clean;
    }

    const email = findEmail(html);
    if (email) found.email = email;

    return found;
  } catch (err) {
    // Timeout, DNS failure, TLS error, bot-blocked, whatever - just skip silently.
    return {};
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Enrich a batch of places with social links + email, bounded concurrency
 * (kept deliberately low) so this doesn't fire a burst of simultaneous
 * outbound requests from your VPS's single IP. Combined with the jittered
 * per-request delay above, this spreads the load out and avoids looking
 * like an obvious scraping run to any individual site or WAF - though
 * nothing free can *guarantee* a site won't block it; only a rotating
 * residential proxy pool would meaningfully change that, and that's a paid
 * service outside "free resources."
 */
async function enrichWithSocials(places, concurrency = 4) {
  const queue = [...places];
  const results = new Map();

  async function worker() {
    while (queue.length > 0) {
      const place = queue.shift();
      if (!place.website) continue;
      const socials = await findSocialLinks(place.website);
      if (Object.keys(socials).length > 0) {
        results.set(place.place_id, socials);
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, places.length) }, worker);
  await Promise.all(workers);
  return results; // Map<place_id, {facebook?, instagram?, linkedin?, tiktok?, email?}>
}

module.exports = { findSocialLinks, enrichWithSocials };
