const express = require("express");
const db = require("../db");
const { buildCatchLogCsv, buildCatchLogPdf, sanitizeFilename, buildExportFilename } = require("../export");
const scraperService = require("../scraperService");
const { capitalizeWords } = require("../textUtils");
const { buildLeadsQuery } = require("../leadsQuery");

const router = express.Router();

function parseLeadRow(row) {
  return {
    ...row,
    needs: row.needs ? JSON.parse(row.needs) : [],
    socials: row.socials ? JSON.parse(row.socials) : {},
  };
}

// A catch log's ownership runs through its niche - fetch it joined with the
// niche's user_id so every route can verify "does this belong to me" in one query.
function getOwnedCatchLog(userId, catchLogId) {
  return db
    .prepare(
      `SELECT cl.*, n.name AS niche_name FROM catch_logs cl
       JOIN niches n ON n.id = cl.niche_id
       WHERE cl.id = ? AND n.user_id = ?`
    )
    .get(catchLogId, userId);
}

// GET /api/catch-logs?nicheId=  -> this user's catch logs (optionally scoped to one niche)
router.get("/", (req, res) => {
  const { nicheId } = req.query;

  let query = `
    SELECT cl.id, cl.niche_id, cl.name, cl.keyword, cl.location, cl.created_at,
           n.name AS niche_name,
           COUNT(l.id) AS lead_count
    FROM catch_logs cl
    JOIN niches n ON n.id = cl.niche_id
    LEFT JOIN leads l ON l.catch_log_id = cl.id
    WHERE n.user_id = ?
  `;
  const params = [req.session.userId];
  if (nicheId) {
    query += " AND cl.niche_id = ?";
    params.push(nicheId);
  }
  query += " GROUP BY cl.id ORDER BY cl.created_at DESC";

  const rows = db.prepare(query).all(...params);
  res.json(rows);
});

// POST /api/catch-logs { nicheId, name, keyword?, location? }
router.post("/", (req, res) => {
  const { nicheId, name, keyword, location } = req.body;
  if (!nicheId || !name || !name.trim()) {
    return res.status(400).json({ error: "nicheId and name are required" });
  }
  const capitalizedName = capitalizeWords(name.trim());

  const niche = db.prepare("SELECT * FROM niches WHERE id = ? AND user_id = ?").get(nicheId, req.session.userId);
  if (!niche) return res.status(404).json({ error: "Niche not found" });

  const info = db
    .prepare("INSERT INTO catch_logs (niche_id, name, keyword, location) VALUES (?, ?, ?, ?)")
    .run(nicheId, capitalizedName, keyword || null, location || null);

  res.json({
    id: info.lastInsertRowid,
    niche_id: Number(nicheId),
    name: capitalizedName,
    keyword: keyword || null,
    location: location || null,
    lead_count: 0,
  });
});

// PATCH /api/catch-logs/:id { name }
router.patch("/:id", (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "name is required" });
  const capitalizedName = capitalizeWords(name.trim());

  const existing = getOwnedCatchLog(req.session.userId, req.params.id);
  if (!existing) return res.status(404).json({ error: "Catch log not found" });

  db.prepare("UPDATE catch_logs SET name = ? WHERE id = ?").run(capitalizedName, req.params.id);
  res.json({ ...existing, name: capitalizedName });
});

// DELETE /api/catch-logs/:id -> cascades to its leads
router.delete("/:id", (req, res) => {
  const { id } = req.params;
  const existing = getOwnedCatchLog(req.session.userId, id);
  if (!existing) return res.status(404).json({ error: "Catch log not found" });

  const del = db.transaction(() => {
    db.prepare("DELETE FROM leads WHERE catch_log_id = ?").run(id);
    db.prepare("DELETE FROM catch_logs WHERE id = ?").run(id);
  });
  del();

  res.json({ deleted: true });
});

// GET /api/catch-logs/:id/export/csv
router.get("/:id/export/csv", (req, res) => {
  const log = getOwnedCatchLog(req.session.userId, req.params.id);
  if (!log) return res.status(404).json({ error: "Catch log not found" });

  const leads = db
    .prepare("SELECT * FROM leads WHERE catch_log_id = ? ORDER BY created_at ASC")
    .all(req.params.id)
    .map(parseLeadRow)
    .map((lead) => ({ ...lead, city_name: log.name }));

  const csv = buildCatchLogCsv(log.name, leads);
  const filename = buildExportFilename({ niche: log.niche_name, city: log.name });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}.csv"`);
  res.send(csv);
});

// GET /api/catch-logs/:id/export/pdf
router.get("/:id/export/pdf", (req, res) => {
  const log = getOwnedCatchLog(req.session.userId, req.params.id);
  if (!log) return res.status(404).json({ error: "Catch log not found" });

  const leads = db
    .prepare("SELECT * FROM leads WHERE catch_log_id = ? ORDER BY created_at ASC")
    .all(req.params.id)
    .map(parseLeadRow)
    .map((lead) => ({ ...lead, city_name: log.name }));

  res.setHeader("Content-Type", "application/pdf");
  const filename = buildExportFilename({ niche: log.niche_name, city: log.name });
  res.setHeader("Content-Disposition", `attachment; filename="${filename}.pdf"`);
  const doc = buildCatchLogPdf(log.name, leads);
  doc.pipe(res);
});

// ---------- Contact deep-scrape (separate Python microservice) ----------

// POST /api/catch-logs/:id/scrape/start
router.post("/:id/scrape/start", async (req, res) => {
  const userId = req.session.userId;
  const catchLogId = req.params.id;
  const log = getOwnedCatchLog(userId, catchLogId);
  if (!log) return res.status(404).json({ error: "Catch log not found" });

  if (scraperService.isLockedByOther(userId, catchLogId)) {
    const lock = scraperService.getLock();
    return res.status(409).json({
      error: `Another scrape is currently running (started ${Math.round((Date.now() - lock.startedAt) / 1000)}s ago). Only one scrape can run at a time across all users - please wait for it to finish.`,
    });
  }

  // Same catch log already holds the lock - could mean a prior job is still
  // actively running (double-click, or reopening the panel and clicking
  // Start again). Check the scraper's own live status before allowing a
  // reset+reimport, since doing that mid-job would corrupt the counts by
  // wiping out businesses the scraper is still actively processing.
  const existingLock = scraperService.getLock();
  if (existingLock && existingLock.userId === userId && existingLock.catchLogId === Number(catchLogId)) {
    try {
      const liveStatus = await scraperService.getStatus();
      if (liveStatus.job_running) {
        return res.status(409).json({
          error: "A scrape for this catch log is already running. Wait for it to finish, or use Stop first.",
        });
      }
      // Lock exists but nothing is actually running (e.g. a previous run
      // finished and just hasn't been polled/released yet) - safe to release
      // it ourselves and proceed with a fresh start below.
      scraperService.releaseLock();
    } catch (err) {
      // Can't reach the scraper to check - safer to refuse than to guess.
      return res.status(502).json({ error: `Could not reach the scraper service to check its status: ${err.message}` });
    }
  }

  // Scoped to whatever the current view actually shows (same filters as
  // the board: status, search, need, inspected-only), not indiscriminately
  // every lead ever caught in this catch log - "scrape the current view"
  // should mean exactly that, using the identical query builder the board
  // itself uses so the two can never drift out of sync.
  const { baseQuery, params } = buildLeadsQuery(userId, { ...req.query, catchLogId });
  const leads = db.prepare(`SELECT l.* ${baseQuery} AND l.website IS NOT NULL AND l.website != ''`).all(...params);
  if (leads.length === 0) {
    return res.status(400).json({ error: "No records with a website in the current view to scrape. Adjust your filters or switch views if you expected more." });
  }

  try {
    scraperService.acquireLock(userId, catchLogId, log.name);
    await scraperService.resetScraperWorkingTable();
    const importResult = await scraperService.importLeadsAsCsv(leads);
    await scraperService.startScrape();
    res.json({ status: "started", queued: importResult.imported });
  } catch (err) {
    scraperService.releaseLock();
    console.error("Failed to start scrape:", err);
    res.status(502).json({ error: `Could not reach the scraper service: ${err.message}` });
  }
});

// GET /api/catch-logs/:id/scrape/status
// Also responsible for pulling results back and merging them into our
// leads once the scraper's job finishes - polled by the frontend, no
// separate webhook/push mechanism needed.
router.get("/:id/scrape/status", async (req, res) => {
  const userId = req.session.userId;
  const catchLogId = req.params.id;
  const log = getOwnedCatchLog(userId, catchLogId);
  if (!log) return res.status(404).json({ error: "Catch log not found" });

  const lock = scraperService.getLock();
  const isOurs = lock && lock.userId === userId && lock.catchLogId === Number(catchLogId);

  if (!isOurs) {
    return res.json({ active: false, jobRunning: false });
  }

  try {
    const status = await scraperService.getStatus();

    if (!status.job_running) {
      // Job just finished (or was never started this call) - pull results
      // back and merge them into our leads, then release the lock.
      const businesses = await scraperService.getScrapedBusinesses();
      const mergedCount = scraperService.mergeScrapedResultsIntoLeads(catchLogId, businesses);
      scraperService.releaseLock();
      return res.json({ active: false, jobRunning: false, ...status, merged: true, mergedCount });
    }

    res.json({ active: true, jobRunning: true, ...status });
  } catch (err) {
    scraperService.releaseLock();
    console.error("Failed to poll scrape status:", err);
    res.status(502).json({ error: `Could not reach the scraper service: ${err.message}` });
  }
});

// POST /api/catch-logs/:id/scrape/stop
router.post("/:id/scrape/stop", async (req, res) => {
  const userId = req.session.userId;
  const catchLogId = req.params.id;
  const log = getOwnedCatchLog(userId, catchLogId);
  if (!log) return res.status(404).json({ error: "Catch log not found" });

  const lock = scraperService.getLock();
  if (!lock || lock.userId !== userId || lock.catchLogId !== Number(catchLogId)) {
    return res.json({ status: "not_running" });
  }

  try {
    const result = await scraperService.stopScrape();
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: `Could not reach the scraper service: ${err.message}` });
  }
});

module.exports = router;
