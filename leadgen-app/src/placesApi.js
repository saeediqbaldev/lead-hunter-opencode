const fetch = require("node-fetch");
const { getSetting } = require("./settingsStore");
const apiKeys = require("./apiKeys");

const PLACES_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";

// Key resolution order: whichever key is marked "active" for this user
// (Settings UI) -> for the admin account ONLY, a single legacy key from
// before multi-key support existed, then the GOOGLE_PLACES_API_KEY env var
// as a last-resort shared fallback. Non-admin users must configure their
// own key - the shared/legacy fallback never applies to them, so the app
// can't accidentally run on the admin's credentials for every user.
function resolveApiKey(userId, isAdmin) {
  const activeKeyRow = apiKeys.getActiveKey(userId);
  if (activeKeyRow) return { value: activeKeyRow.key_value, keyId: activeKeyRow.id };

  if (!isAdmin) return { value: null, keyId: null };

  const legacy = getSetting("google_places_api_key");
  if (legacy) return { value: legacy, keyId: null };

  if (process.env.GOOGLE_PLACES_API_KEY) return { value: process.env.GOOGLE_PLACES_API_KEY, keyId: null };

  return { value: null, keyId: null };
}

// Essentials-tier fields only, by default, to stay inside the free monthly
// quota (10,000 calls/month for Essentials SKUs as of 2026).
// Adding rating / userRatingCount bumps the whole call to Pro pricing.
const ESSENTIALS_FIELDS = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.businessStatus",
  "nextPageToken",
].join(",");

const PRO_FIELDS_EXTRA = ["places.rating", "places.userRatingCount"].join(",");

const MAX_PAGES = 3; // Google Places pagination caps out around 60 results (3 x 20) same as legacy API

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeForDedup(place) {
  if (!place.website) return null; // no website -> can't confidently identify as a duplicate branch
  let host;
  try {
    host = new URL(place.website).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    host = place.website.toLowerCase();
  }
  const name = place.name.trim().toLowerCase();
  return `${name}|${host}`;
}

function mapPlace(p) {
  return {
    place_id: p.id,
    name: p.displayName ? p.displayName.text : "(no name)",
    address: p.formattedAddress || null,
    phone: p.nationalPhoneNumber || p.internationalPhoneNumber || null,
    website: p.websiteUri || null,
    rating: typeof p.rating === "number" ? p.rating : null,
    review_count: typeof p.userRatingCount === "number" ? p.userRatingCount : null,
    business_status: p.businessStatus || null,
  };
}

async function fetchPage({ keyword, location, pageToken, fieldMask, apiKey }) {
  const body = {
    textQuery: `${keyword} in ${location}`,
    maxResultCount: 20, // Places API hard cap per individual request
  };
  if (pageToken) body.pageToken = pageToken;

  const res = await fetch(PLACES_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": fieldMask,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Places API error (${res.status}): ${errText}`);
  }

  return res.json();
}

/**
 * Search Google Places (Text Search - New) for businesses matching a
 * keyword + location, e.g. keyword="dentist", location="Swabi, Pakistan".
 *
 * Automatically pages through results (up to MAX_PAGES, Google's real hard
 * cap for one exact query - roughly 60 total) and de-duplicates businesses
 * that share the same name + website (typically multiple branches of the
 * same chain). Also skips any place_id already in `excludePlaceIds` - this
 * is how repeat hunts for the same niche+city surface NEW businesses instead
 * of the same ones again (see src/routes/search.js for how the exclusion set
 * is built and why Google's own ~60-result cap is the real ceiling here).
 *
 * @param {string} keyword
 * @param {string} location
 * @param {number} maxResults        how many distinct NEW businesses you want (<=60)
 * @param {boolean} includeRatings
 * @param {number} userId            whose API key to use
 * @param {Set<string>} excludePlaceIds  place_ids to skip (already hunted before)
 * @returns {{ places: object[], requestsMade: number, keyId: number|null, exhausted: boolean }}
 *   `exhausted` is true if Google's own result cap was hit before reaching
 *   maxResults NEW businesses - i.e. there may genuinely be no more left to find.
 */
async function searchPlaces({
  keyword,
  location,
  maxResults = 20,
  includeRatings = false,
  userId,
  isAdmin,
  excludePlaceIds = new Set(),
}) {
  const { value: apiKey, keyId } = resolveApiKey(userId, isAdmin);
  if (!apiKey) {
    throw new Error(
      "No Google Places API key configured. Add one under Settings in the app."
    );
  }

  const fieldMask = includeRatings ? `${ESSENTIALS_FIELDS},${PRO_FIELDS_EXTRA}` : ESSENTIALS_FIELDS;

  const collected = [];
  const seenDedupKeys = new Set();
  let pageToken = null;
  let pagesFetched = 0;
  let sawAnyExcluded = false;

  do {
    if (pageToken) {
      // Google requires a short delay before a pageToken becomes valid
      await sleep(2000);
    }

    const data = await fetchPage({ keyword, location, pageToken, fieldMask, apiKey });
    pagesFetched++;
    const places = data.places || [];

    for (const rawPlace of places) {
      const place = mapPlace(rawPlace);

      if (excludePlaceIds.has(place.place_id)) {
        sawAnyExcluded = true;
        continue; // already hunted in a previous search for this niche+city
      }

      const dedupKey = normalizeForDedup(place);
      if (dedupKey) {
        if (seenDedupKeys.has(dedupKey)) continue; // same brand + website already picked, skip this branch
        seenDedupKeys.add(dedupKey);
      }

      collected.push(place);
      if (collected.length >= maxResults) break;
    }

    pageToken = data.nextPageToken || null;
  } while (collected.length < maxResults && pageToken && pagesFetched < MAX_PAGES);

  const exhausted = collected.length < maxResults && !pageToken;

  return { places: collected, requestsMade: pagesFetched, keyId, exhausted, sawAnyExcluded };
}

/**
 * Fire a minimal, essentials-tier request just to confirm a key is valid and
 * has the "Places API (New)" enabled - used by the Settings "Connect" button.
 * Costs a single Essentials-tier call (well inside the free monthly quota).
 */
async function testApiKey(apiKey) {
  if (!apiKey || !apiKey.trim()) {
    return { ok: false, error: "Enter an API key first." };
  }

  try {
    const res = await fetch(PLACES_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey.trim(),
        "X-Goog-FieldMask": "places.id",
      },
      body: JSON.stringify({ textQuery: "coffee shop", maxResultCount: 1 }),
    });

    if (res.ok) return { ok: true };

    const errText = await res.text();
    let message = `Google rejected the key (HTTP ${res.status}).`;
    try {
      const parsed = JSON.parse(errText);
      if (parsed.error && parsed.error.message) message = parsed.error.message;
    } catch {
      // leave the generic message in place
    }
    return { ok: false, error: message };
  } catch (err) {
    return { ok: false, error: `Could not reach Google: ${err.message}` };
  }
}

module.exports = { searchPlaces, testApiKey, resolveApiKey };
