const db = require("./db");

const DEFAULT_PROVIDER = "google_places";

function listKeys(userId, provider = DEFAULT_PROVIDER) {
  return db
    .prepare("SELECT * FROM api_keys WHERE user_id = ? AND provider = ? ORDER BY created_at ASC, id ASC")
    .all(userId, provider);
}

function getKeyById(userId, id) {
  return db.prepare("SELECT * FROM api_keys WHERE user_id = ? AND id = ?").get(userId, id);
}

function getActiveKey(userId, provider = DEFAULT_PROVIDER) {
  return db.prepare("SELECT * FROM api_keys WHERE user_id = ? AND provider = ? AND is_active = 1").get(userId, provider);
}

function getActiveKeyValue(userId, provider = DEFAULT_PROVIDER) {
  const row = getActiveKey(userId, provider);
  return row ? row.key_value : null;
}

// Only deactivates other keys of the SAME provider - activating a Gemini
// key must never touch which Google Places key is active, and vice versa.
function setActive(userId, id, provider = DEFAULT_PROVIDER) {
  const tx = db.transaction(() => {
    db.prepare("UPDATE api_keys SET is_active = 0 WHERE user_id = ? AND provider = ?").run(userId, provider);
    db.prepare("UPDATE api_keys SET is_active = 1 WHERE user_id = ? AND id = ? AND provider = ?").run(userId, id, provider);
  });
  tx();
}

function insertKey(userId, label, keyValue, provider = DEFAULT_PROVIDER) {
  const wasEmpty = db.prepare("SELECT COUNT(*) AS c FROM api_keys WHERE user_id = ? AND provider = ?").get(userId, provider).c === 0;
  const info = db
    .prepare("INSERT INTO api_keys (user_id, label, key_value, is_active, provider) VALUES (?, ?, ?, 0, ?)")
    .run(userId, label, keyValue, provider);
  // First key this user ever saves for this provider becomes active automatically.
  if (wasEmpty) setActive(userId, info.lastInsertRowid, provider);
  return getKeyById(userId, info.lastInsertRowid);
}

function deleteKey(userId, id) {
  db.prepare("DELETE FROM api_keys WHERE user_id = ? AND id = ?").run(userId, id);
}

// Called after every Places/Gemini API call this key was used for, so usage is
// visible per-key in Settings ("how much has each key actually been used").
function recordUsage(userId, keyId, { requests = 0, leadsCaught = 0 } = {}) {
  if (!keyId) return;
  db.prepare(
    "UPDATE api_keys SET requests_made = requests_made + ?, leads_caught = leads_caught + ? WHERE user_id = ? AND id = ?"
  ).run(requests, leadsCaught, userId, keyId);

  const today = new Date().toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO api_key_daily_usage (api_key_id, usage_date, requests_made, leads_caught) VALUES (?, ?, ?, ?)
     ON CONFLICT(api_key_id, usage_date) DO UPDATE SET
       requests_made = requests_made + excluded.requests_made,
       leads_caught = leads_caught + excluded.leads_caught`
  ).run(keyId, today, requests, leadsCaught);
}

function todaysUsage(userId, provider = DEFAULT_PROVIDER) {
  const today = new Date().toISOString().slice(0, 10);
  return db
    .prepare(
      `SELECT k.id, k.label, k.is_active,
              COALESCE(d.requests_made, 0) AS requests_made,
              COALESCE(d.leads_caught, 0) AS leads_caught
       FROM api_keys k
       LEFT JOIN api_key_daily_usage d ON d.api_key_id = k.id AND d.usage_date = ?
       WHERE k.user_id = ? AND k.provider = ?
       ORDER BY k.created_at ASC`
    )
    .all(today, userId, provider);
}

// All-time cumulative usage per key - reads directly off api_keys' running
// totals (updated on every hunt via recordUsage), so this is correct
// regardless of when the key was created or how it's been used across
// redeploys - it's not derived from summing daily rows, so nothing about a
// server restart or a backup import could make it drift out of sync.
function allTimeUsage(userId, provider = DEFAULT_PROVIDER) {
  return db
    .prepare(
      `SELECT id, label, is_active, requests_made, leads_caught, created_at
       FROM api_keys WHERE user_id = ? AND provider = ? ORDER BY created_at ASC`
    )
    .all(userId, provider);
}

// Daily usage history per key, for the "usage over time" line chart.
// Reads from api_key_daily_usage, which is populated incrementally by
// recordUsage() on every real hunt - not recalculated from anything else,
// so it stays accurate across redeploys. A backup restore also carries
// this table's rows along (see src/routes/backup.js), so importing an
// older backup doesn't lose or duplicate history either.
function dailyUsageHistory(userId, days = 90, provider = DEFAULT_PROVIDER) {
  if (days === null) {
    // "all time" - no lower bound on date
    return db
      .prepare(
        `SELECT d.usage_date, k.id AS api_key_id, k.label, d.requests_made, d.leads_caught
         FROM api_key_daily_usage d
         JOIN api_keys k ON k.id = d.api_key_id
         WHERE k.user_id = ? AND k.provider = ?
         ORDER BY d.usage_date ASC`
      )
      .all(userId, provider);
  }

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const startStr = startDate.toISOString().slice(0, 10);

  return db
    .prepare(
      `SELECT d.usage_date, k.id AS api_key_id, k.label, d.requests_made, d.leads_caught
       FROM api_key_daily_usage d
       JOIN api_keys k ON k.id = d.api_key_id
       WHERE k.user_id = ? AND k.provider = ? AND d.usage_date >= ?
       ORDER BY d.usage_date ASC`
    )
    .all(userId, provider, startStr);
}

// Sum of usage within the current calendar month, per key - used by the
// Settings "Limits Usage" page so the user can see where they stand against
// approximate free-tier caps without needing to check Google's console.
function currentMonthUsage(userId, provider = DEFAULT_PROVIDER) {
  const monthStart = new Date();
  monthStart.setDate(1);
  const monthStartStr = monthStart.toISOString().slice(0, 10);

  const rows = db
    .prepare(
      `SELECT COALESCE(SUM(d.requests_made), 0) AS totalRequests, COALESCE(SUM(d.leads_caught), 0) AS totalLeads
       FROM api_key_daily_usage d
       JOIN api_keys k ON k.id = d.api_key_id
       WHERE k.user_id = ? AND k.provider = ? AND d.usage_date >= ?`
    )
    .get(userId, provider, monthStartStr);

  return { totalRequests: rows.totalRequests || 0, totalLeads: rows.totalLeads || 0 };
}

module.exports = {
  listKeys,
  getKeyById,
  getActiveKey,
  getActiveKeyValue,
  setActive,
  insertKey,
  deleteKey,
  recordUsage,
  todaysUsage,
  allTimeUsage,
  dailyUsageHistory,
  currentMonthUsage,
};
