const fetch = require("node-fetch");
const FormData = require("form-data");
const db = require("./db");

const SCRAPER_BASE_URL = process.env.SCRAPER_SERVICE_URL || "http://scraper:8000";
const SCRAPER_SECRET = process.env.SCRAPER_API_SECRET || "";

function headers(extra = {}) {
  const h = { ...extra };
  if (SCRAPER_SECRET) h["X-Scraper-Secret"] = SCRAPER_SECRET;
  return h;
}

// The Python scraper is a single shared instance with ONE global working
// table - it has no concept of "whose" batch is running (see the spec's
// §8.3: safe only because it's single-process, single-tenant-at-a-time).
// Since our Node app is multi-tenant, this in-memory lock makes sure only
// one user's catch log is being scraped at once; everyone else gets a
// friendly "busy" response instead of their businesses getting mixed into
// someone else's batch.
let activeLock = null; // { userId, catchLogId, catchLogName, startedAt }

function getLock() {
  return activeLock;
}

function isLockedByOther(userId, catchLogId) {
  return activeLock && !(activeLock.userId === userId && activeLock.catchLogId === Number(catchLogId));
}

function acquireLock(userId, catchLogId, catchLogName) {
  activeLock = { userId, catchLogId: Number(catchLogId), catchLogName, startedAt: Date.now() };
}

function releaseLock() {
  activeLock = null;
}

// ---------- CSV generation (matches the scraper's flexible COLUMN_ALIASES) ----------
function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

function leadsToScraperCsv(leads) {
  const header = ["Business Name", "Address", "Phone", "Website", "Rating", "Reviews"];
  const lines = [header.join(",")];
  for (const lead of leads) {
    lines.push(
      [lead.name, lead.address, lead.phone, lead.website, lead.rating, lead.review_count]
        .map(csvEscape)
        .join(",")
    );
  }
  return lines.join("\n");
}

// ---------- calls to the scraper service ----------
async function scraperFetch(path, options = {}) {
  const res = await fetch(`${SCRAPER_BASE_URL}${path}`, {
    ...options,
    headers: headers(options.headers),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Scraper service error (${res.status}): ${text || res.statusText}`);
  }
  return res;
}

async function resetScraperWorkingTable() {
  await scraperFetch("/reset", { method: "POST" });
}

async function importLeadsAsCsv(leads) {
  const csv = leadsToScraperCsv(leads);
  const form = new FormData();
  form.append("file", Buffer.from(csv, "utf-8"), { filename: "batch.csv", contentType: "text/csv" });
  const res = await scraperFetch("/import-csv", { method: "POST", body: form, headers: form.getHeaders() });
  return res.json();
}

async function startScrape() {
  const res = await scraperFetch("/scrape/start", { method: "POST" });
  return res.json();
}

async function stopScrape() {
  const res = await scraperFetch("/scrape/stop", { method: "POST" });
  return res.json();
}

async function getStatus() {
  const res = await scraperFetch("/scrape/status");
  return res.json();
}

async function getScrapedBusinesses() {
  const res = await scraperFetch("/businesses");
  return res.json();
}

// ---------- merging scraped results back into OUR leads ----------
// Matches by (name, website) - exactly what we sent in, so this is a
// reliable exact-string match, not fuzzy. Stores the scraper's tel: link
// finding as socials.phone (distinct from the Google-Places-sourced phone
// already shown in the Contact column) so the Social column's Phone icon
// specifically means "we independently confirmed a click-to-call link on
// their site," not just "Google Places had a number for them."
function mergeScrapedResultsIntoLeads(catchLogId, scrapedBusinesses) {
  const leads = db.prepare("SELECT * FROM leads WHERE catch_log_id = ?").all(catchLogId);
  const byKey = new Map();
  for (const lead of leads) {
    byKey.set(`${(lead.name || "").trim().toLowerCase()}|${(lead.website || "").trim().toLowerCase()}`, lead);
  }

  const update = db.prepare("UPDATE leads SET socials = ? WHERE id = ?");
  let mergedCount = 0;

  for (const biz of scrapedBusinesses) {
    const key = `${(biz.business_name || "").trim().toLowerCase()}|${(biz.website || "").trim().toLowerCase()}`;
    const lead = byKey.get(key);
    if (!lead) continue;

    const existingSocials = lead.socials ? JSON.parse(lead.socials) : {};
    const newSocials = { ...existingSocials };
    if (biz.email) newSocials.email = biz.email;
    if (biz.facebook) newSocials.facebook = biz.facebook;
    if (biz.instagram) newSocials.instagram = biz.instagram;
    if (biz.linkedin) newSocials.linkedin = biz.linkedin;
    if (biz.tiktok) newSocials.tiktok = biz.tiktok;
    if (biz.phone_scraped) newSocials.phone = biz.phone_scraped;

    update.run(JSON.stringify(newSocials), lead.id);
    mergedCount++;
  }

  return mergedCount;
}

module.exports = {
  getLock,
  isLockedByOther,
  acquireLock,
  releaseLock,
  resetScraperWorkingTable,
  importLeadsAsCsv,
  startScrape,
  stopScrape,
  getStatus,
  getScrapedBusinesses,
  mergeScrapedResultsIntoLeads,
};
