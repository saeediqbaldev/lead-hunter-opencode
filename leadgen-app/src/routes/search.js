const express = require("express");
const db = require("../db");
const { searchPlaces } = require("../placesApi");
const { tagNeeds } = require("../filters");
const apiKeys = require("../apiKeys");

const router = express.Router();

const DEFAULT_DAILY_CAP = 300;

function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function userDailyCap(userId) {
  const row = db.prepare("SELECT daily_lead_cap FROM users WHERE id = ?").get(userId);
  if (row && row.daily_lead_cap) return row.daily_lead_cap;
  return Number(process.env.DAILY_LEAD_CAP) || DEFAULT_DAILY_CAP;
}

function leadsPulledToday(userId) {
  const row = db
    .prepare(`SELECT COALESCE(SUM(leads_pulled), 0) AS total FROM search_log WHERE search_date = ? AND user_id = ?`)
    .get(todayStr(), userId);
  return row.total;
}

function firstWordOfLocation(loc) {
  const word = loc.trim().split(/[\s,]+/)[0];
  return word || loc.trim();
}

// Normalizes a free-text location into a stable key, so "Berlin, Germany"
// and "berlin,  germany" are treated as the same city rather than
// accidentally tracked (or hunted into) as two different scopes.
function normalizeLocationKey(location) {
  return location.trim().toLowerCase().replace(/[,\s]+/g, " ");
}

// A niche has at most ONE catch log per distinct city. Repeat hunts for a
// city you've already searched append new businesses into that same catch
// log rather than creating another one - this is what makes the dedup-
// across-hunts logic (seen_places) actually mean something structurally,
// not just cosmetically.
function findExistingCatchLogForCity(nicheId, locationKey) {
  const logs = db.prepare("SELECT * FROM catch_logs WHERE niche_id = ? AND location IS NOT NULL").all(nicheId);
  return logs.find((log) => normalizeLocationKey(log.location) === locationKey) || null;
}

// POST /api/search  { keyword, location, maxResults, includeRatings, nicheId?, nicheName?, catchLogName? }
// Requires either an existing nicheId or a new nicheName. Nothing is written
// to the database until the Places API call actually succeeds, so a failed
// search (bad key, quota, network) never leaves behind an empty niche/catch log.
router.post("/", async (req, res) => {
  try {
    const userId = req.session.userId;
    const { keyword, location, maxResults, includeRatings, nicheId, nicheName, catchLogName } = req.body;

    if (!keyword || !location) {
      return res.status(400).json({ error: "keyword and location are required" });
    }
    if (!nicheId && (!nicheName || !nicheName.trim())) {
      return res.status(400).json({ error: "Select an existing niche or provide a new niche name" });
    }

    // If an existing niche was named/selected, validate it exists and belongs
    // to this user - this is a read-only check, safe to do before the API call.
    let existingNiche = null;
    if (nicheId) {
      existingNiche = db.prepare("SELECT * FROM niches WHERE id = ? AND user_id = ?").get(nicheId, userId);
      if (!existingNiche) return res.status(404).json({ error: "Selected niche not found" });
    } else {
      existingNiche = db.prepare("SELECT * FROM niches WHERE name = ? AND user_id = ?").get(nicheName.trim(), userId);
    }

    const cap = userDailyCap(userId);
    const pulledToday = leadsPulledToday(userId);
    const remaining = cap - pulledToday;

    if (remaining <= 0) {
      return res.status(429).json({
        error: `Daily lead cap of ${cap} reached. Try again tomorrow, or raise it under Settings.`,
      });
    }

    const requestCount = Math.min(Number(maxResults) || 20, remaining, 60);
    const locationKey = normalizeLocationKey(location);

    // Build the "already hunted" exclusion set for this niche+city, so a
    // repeat hunt surfaces new businesses instead of the same ones again.
    let excludePlaceIds = new Set();
    let existingCatchLog = null;
    if (existingNiche) {
      existingCatchLog = findExistingCatchLogForCity(existingNiche.id, locationKey);
      const seenRows = db
        .prepare("SELECT place_id FROM seen_places WHERE user_id = ? AND niche_id = ? AND location_key = ?")
        .all(userId, existingNiche.id, locationKey);
      excludePlaceIds = new Set(seenRows.map((r) => r.place_id));
    }

    // Do the actual (failure-prone) API work FIRST, before touching the DB.
    const searchResult = await searchPlaces({
      keyword,
      location,
      maxResults: requestCount,
      includeRatings: !!includeRatings,
      userId,
      isAdmin: req.session.role === "admin",
      excludePlaceIds,
    });
    const { places, requestsMade, keyId, exhausted } = searchResult;

    // Only now create/reuse the niche and catch log, since we know we have results to save.
    let niche = existingNiche;
    if (!niche) {
      const info = db.prepare("INSERT INTO niches (user_id, name) VALUES (?, ?)").run(userId, nicheName.trim());
      niche = { id: info.lastInsertRowid, name: nicheName.trim() };
    }

    let catchLogId;
    let logName;
    if (existingCatchLog) {
      // Same niche + same city as a previous hunt - append to it, don't duplicate.
      catchLogId = existingCatchLog.id;
      logName = existingCatchLog.name;
    } else {
      logName = (catchLogName && catchLogName.trim()) || firstWordOfLocation(location);
      const logInfo = db
        .prepare("INSERT INTO catch_logs (niche_id, name, keyword, location) VALUES (?, ?, ?, ?)")
        .run(niche.id, logName, keyword, location);
      catchLogId = logInfo.lastInsertRowid;
    }

    const insert = db.prepare(`
      INSERT INTO leads (catch_log_id, place_id, name, address, phone, website, rating, review_count, business_status, needs, socials)
      VALUES (@catch_log_id, @place_id, @name, @address, @phone, @website, @rating, @review_count, @business_status, @needs, @socials)
      ON CONFLICT(catch_log_id, place_id) DO UPDATE SET
        name=excluded.name, address=excluded.address, phone=excluded.phone,
        website=excluded.website, rating=excluded.rating, review_count=excluded.review_count,
        business_status=excluded.business_status, needs=excluded.needs
    `);
    const markSeen = db.prepare(
      "INSERT OR IGNORE INTO seen_places (user_id, niche_id, location_key, place_id) VALUES (?, ?, ?, ?)"
    );

    let newCount = 0;
    const results = [];
    for (const place of places) {
      const needs = tagNeeds(place);
      // No automatic social scraping here - that's now only ever done via
      // the explicit "Scrape" button (separate Python microservice), so a
      // hunt never gets slowed down or blocked by scanning every website.
      insert.run({ ...place, catch_log_id: catchLogId, needs: JSON.stringify(needs), socials: JSON.stringify({}) });
      markSeen.run(userId, niche.id, locationKey, place.place_id);
      results.push({ ...place, needs, socials: {} });
      newCount++;
    }

    db.prepare(
      `INSERT INTO search_log (user_id, search_date, leads_pulled, keyword, location) VALUES (?, ?, ?, ?, ?)`
    ).run(userId, todayStr(), newCount, keyword, location);

    apiKeys.recordUsage(userId, keyId, { requests: requestsMade, leadsCaught: newCount });

    res.json({
      pulled: newCount,
      remainingToday: Math.max(cap - (pulledToday + newCount), 0),
      catchLogId,
      catchLogName: logName,
      nicheId: niche.id,
      nicheName: niche.name,
      leads: results,
      exhausted: exhausted && newCount < requestCount,
      appendedToExisting: !!existingCatchLog,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/search/quota  -> how many leads left today
router.get("/quota", (req, res) => {
  const cap = userDailyCap(req.session.userId);
  const pulled = leadsPulledToday(req.session.userId);
  res.json({ cap, pulledToday: pulled, remaining: Math.max(cap - pulled, 0) });
});

module.exports = router;
