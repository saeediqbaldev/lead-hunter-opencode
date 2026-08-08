const express = require("express");
const db = require("../db");
const apiKeys = require("../apiKeys");
const { buildReportsCsv, buildReportsPdf } = require("../export");

const router = express.Router();

const RANGE_DAYS = {
  "1d": 1,
  "7d": 7,
  "1m": 30,
  "3m": 90,
  "6m": 180,
  "1y": 365,
  all: null,
};

// The app's day boundary (when "today" flips over) is anchored to this
// timezone offset, not the server's own local time (which is typically
// UTC in a Docker container) or a rolling 24-hour window. Defaults to
// Pakistan (UTC+5) per the app's primary usage.
const TIMEZONE_OFFSET_HOURS = 5;

function rangeStartDate(rangeKey) {
  const days = RANGE_DAYS[rangeKey];
  if (!days) return null; // "all time" - no lower bound

  const offsetMs = TIMEZONE_OFFSET_HOURS * 3600000;
  const now = new Date();
  // Shift "now" into the target timezone's wall-clock time, truncate to
  // that day's midnight, then shift back to UTC for the DB comparison
  // (created_at is stored in UTC via SQLite's datetime('now')).
  const shiftedNow = new Date(now.getTime() + offsetMs);
  const todayMidnightShifted = Date.UTC(shiftedNow.getUTCFullYear(), shiftedNow.getUTCMonth(), shiftedNow.getUTCDate());
  const startOfRangeShifted = todayMidnightShifted - (days - 1) * 86400000; // "1d" = just today, "7d" = today + 6 prior days
  const startUtc = new Date(startOfRangeShifted - offsetMs);

  return startUtc.toISOString().slice(0, 19).replace("T", " ");
}

const STATUS_KEYS = ["new", "shortlisted", "contacted", "engaged", "converted", "won", "rejected"];

// Shared filter builder for both /summary and /timeseries - keeps the two
// endpoints scoped identically to whatever range/niche/city is selected.
function buildFilteredQuery(userId, query) {
  const { niche, city } = query;
  const range = RANGE_DAYS.hasOwnProperty(query.range) ? query.range : "1d";
  const startDate = rangeStartDate(range);

  let sql = `
    FROM leads l
    JOIN catch_logs cl ON cl.id = l.catch_log_id
    JOIN niches n ON n.id = cl.niche_id
    WHERE n.user_id = ?
  `;
  const params = [userId];

  if (startDate) {
    sql += " AND l.created_at >= ?";
    params.push(startDate);
  }
  if (niche) {
    sql += " AND n.id = ?";
    params.push(niche);
  }
  if (city) {
    sql += " AND cl.id = ?";
    params.push(city);
  }

  return { sql, params, range };
}

// GET /api/reports/summary?range=1d|7d|1m|3m|6m|1y|all&niche=&city=
router.get("/summary", (req, res) => {
  const userId = req.session.userId;
  const { sql, params, range } = buildFilteredQuery(userId, req.query);

  const rows = db.prepare(`SELECT l.status, COUNT(*) AS c ${sql} GROUP BY l.status`).all(...params);
  const byStatus = Object.fromEntries(STATUS_KEYS.map((k) => [k, 0]));
  let total = 0;
  for (const row of rows) {
    if (byStatus.hasOwnProperty(row.status)) byStatus[row.status] = row.c;
    total += row.c;
  }

  res.json({ range, total, byStatus });
});

// GET /api/reports/timeseries?range=&niche=&city=
// Daily-bucketed counts per status, for the line chart. Bucket size is
// always one day regardless of range - for "all time" on an old account
// this could be a lot of points, but that's a reasonable tradeoff for
// keeping the query simple and the chart meaningful at every range.
router.get("/timeseries", (req, res) => {
  const userId = req.session.userId;
  const { sql, params, range } = buildFilteredQuery(userId, req.query);

  const rows = db
    .prepare(`SELECT date(l.created_at) AS day, l.status, COUNT(*) AS c ${sql} GROUP BY day, l.status ORDER BY day ASC`)
    .all(...params);

  const dayMap = new Map(); // day -> {status: count}
  for (const row of rows) {
    if (!dayMap.has(row.day)) dayMap.set(row.day, {});
    dayMap.get(row.day)[row.status] = row.c;
  }

  const days = Array.from(dayMap.keys()).sort();
  const series = Object.fromEntries(STATUS_KEYS.map((k) => [k, days.map((d) => dayMap.get(d)[k] || 0)]));

  res.json({ range, days, series });
});

// GET /api/reports/niches-cities -> flat list for the Reports page filter dropdowns
router.get("/niches-cities", (req, res) => {
  const userId = req.session.userId;
  const niches = db.prepare("SELECT id, name FROM niches WHERE user_id = ? ORDER BY name ASC").all(userId);
  const cities = db
    .prepare(
      `SELECT cl.id, cl.name, cl.niche_id FROM catch_logs cl
       JOIN niches n ON n.id = cl.niche_id
       WHERE n.user_id = ? ORDER BY cl.name ASC`
    )
    .all(userId);
  res.json({ niches, cities });
});

// GET /api/reports/api-usage?provider=google_places|gemini -> TODAY's usage
// specifically (not all-time totals). Defaults to google_places for
// backward compatibility with the existing Reports page call.
router.get("/api-usage", (req, res) => {
  const provider = req.query.provider === "gemini" ? "gemini" : "google_places";
  const rows = apiKeys.todaysUsage(req.session.userId, provider);
  res.json(
    rows.map((r) => ({
      id: r.id,
      label: r.label,
      requestsMade: r.requests_made || 0,
      leadsCaught: r.leads_caught || 0,
      active: !!r.is_active,
    }))
  );
});

// GET /api/reports/api-usage-history?provider= -> all-time totals per key +
// a daily timeseries (last 90 days) for the "usage over time" line chart.
router.get("/api-usage-history", (req, res) => {
  const provider = req.query.provider === "gemini" ? "gemini" : "google_places";
  const allTime = apiKeys.allTimeUsage(req.session.userId, provider);
  const daily = apiKeys.dailyUsageHistory(req.session.userId, 90, provider);

  const days = Array.from(new Set(daily.map((d) => d.usage_date))).sort();
  const byKey = {};
  for (const row of allTime) {
    byKey[row.id] = {
      id: row.id,
      label: row.label,
      active: !!row.is_active,
      totalRequests: row.requests_made || 0,
      totalLeads: row.leads_caught || 0,
      requestsSeries: days.map(() => 0),
      leadsSeries: days.map(() => 0),
    };
  }
  daily.forEach((row) => {
    const entry = byKey[row.api_key_id];
    if (!entry) return;
    const dayIndex = days.indexOf(row.usage_date);
    if (dayIndex === -1) return;
    entry.requestsSeries[dayIndex] = row.requests_made || 0;
    entry.leadsSeries[dayIndex] = row.leads_caught || 0;
  });

  res.json({ days, keys: Object.values(byKey) });
});

// GET /api/reports/export/csv?range=&niche=&city= -> downloadable CSV of
// the current filtered view's stats and daily breakdown
router.get("/export/csv", (req, res) => {
  const userId = req.session.userId;
  const { sql, params, range } = buildFilteredQuery(userId, req.query);

  const statusRows = db.prepare(`SELECT l.status, COUNT(*) AS c ${sql} GROUP BY l.status`).all(...params);
  const byStatus = Object.fromEntries(STATUS_KEYS.map((k) => [k, 0]));
  let total = 0;
  for (const row of statusRows) {
    if (byStatus.hasOwnProperty(row.status)) byStatus[row.status] = row.c;
    total += row.c;
  }

  const dayRows = db
    .prepare(`SELECT date(l.created_at) AS day, l.status, COUNT(*) AS c ${sql} GROUP BY day, l.status ORDER BY day ASC`)
    .all(...params);
  const dayMap = new Map();
  for (const row of dayRows) {
    if (!dayMap.has(row.day)) dayMap.set(row.day, { date: row.day });
    dayMap.get(row.day)[row.status] = row.c;
  }
  const timeseries = Array.from(dayMap.values());

  const meta = { rangeLabel: range, nicheLabel: req.query.nicheLabel, cityLabel: req.query.cityLabel };
  const csv = buildReportsCsv({ range, total, byStatus }, timeseries, meta);

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="xeven-leads-reports-${range}.csv"`);
  res.send(csv);
});

// POST /api/reports/export/pdf { range, niche, city, nicheLabel, cityLabel,
// chartImages: [{title, dataUrl}] } -> downloadable PDF including the
// stats summary and the actual rendered charts (captured client-side as
// PNGs, since Chart.js only exists in the browser - this is the reliable
// way to get real chart images into a server-generated PDF without
// re-implementing charting server-side).
router.post("/export/pdf", (req, res) => {
  const userId = req.session.userId;
  const { chartImages, nicheLabel, cityLabel } = req.body || {};
  const { sql, params, range } = buildFilteredQuery(userId, req.query);

  const statusRows = db.prepare(`SELECT l.status, COUNT(*) AS c ${sql} GROUP BY l.status`).all(...params);
  const byStatus = Object.fromEntries(STATUS_KEYS.map((k) => [k, 0]));
  let total = 0;
  for (const row of statusRows) {
    if (byStatus.hasOwnProperty(row.status)) byStatus[row.status] = row.c;
    total += row.c;
  }

  const meta = { rangeLabel: range, nicheLabel, cityLabel };
  const doc = buildReportsPdf({ range, total, byStatus }, null, Array.isArray(chartImages) ? chartImages : [], meta);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="xeven-leads-reports-${range}.pdf"`);
  doc.pipe(res);
});

module.exports = router;
