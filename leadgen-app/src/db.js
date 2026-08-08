const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const dataDir = path.join(__dirname, "..", "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, "leadgen.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

// ---------- Step 1: base schema (safe no-op on existing tables) ----------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member', -- 'admin' | 'member'
  theme TEXT, -- JSON: { mode: 'light'|'dark', colors: { ...overrides } }
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS niches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS catch_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  niche_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  keyword TEXT,
  location TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS search_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  search_date TEXT NOT NULL,
  leads_pulled INTEGER NOT NULL,
  keyword TEXT,
  location TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Tracks businesses ever pulled per (user, niche, normalized location) so a
-- repeat hunt for the same niche+city can skip what's already been surfaced
-- and dig for new ones instead. See src/routes/search.js for how this is used.
CREATE TABLE IF NOT EXISTS seen_places (
  user_id INTEGER NOT NULL,
  niche_id INTEGER NOT NULL,
  location_key TEXT NOT NULL,
  place_id TEXT NOT NULL,
  first_seen_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, niche_id, location_key, place_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  label TEXT NOT NULL,
  key_value TEXT NOT NULL,
  is_active INTEGER DEFAULT 0,
  requests_made INTEGER DEFAULT 0,
  leads_caught INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// ---------- Step 2: additive migrations for pre-existing installs ----------
// These must run BEFORE step 3 (ownership backfill), since that step writes
// to these columns and they may not exist yet on an older database file.

// niches.name used to be globally UNIQUE; now it must be unique per-user
// instead. SQLite can't ALTER a UNIQUE constraint in place, so rebuild.
{
  const nicheTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='niches'").get().sql;
  if (!nicheTableSql.includes("UNIQUE(user_id, name)")) {
    db.exec("ALTER TABLE niches RENAME TO niches_old");
    db.exec(`
      CREATE TABLE niches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        name TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(user_id, name)
      );
    `);
    const oldCols = db.prepare("PRAGMA table_info(niches_old)").all().map((c) => c.name);
    const hasUserIdAlready = oldCols.includes("user_id");
    if (hasUserIdAlready) {
      db.exec("INSERT INTO niches (id, user_id, name, created_at) SELECT id, user_id, name, created_at FROM niches_old");
    } else {
      db.exec("INSERT INTO niches (id, name, created_at) SELECT id, name, created_at FROM niches_old");
    }
    db.exec("DROP TABLE niches_old");
    console.log("[migration] niches.name uniqueness is now scoped per-user instead of global.");
  }
}

{
  const apiKeyCols = db.prepare("PRAGMA table_info(api_keys)").all().map((c) => c.name);
  if (!apiKeyCols.includes("user_id")) db.exec("ALTER TABLE api_keys ADD COLUMN user_id INTEGER");
  if (!apiKeyCols.includes("is_active")) db.exec("ALTER TABLE api_keys ADD COLUMN is_active INTEGER DEFAULT 0");
  if (!apiKeyCols.includes("requests_made")) db.exec("ALTER TABLE api_keys ADD COLUMN requests_made INTEGER DEFAULT 0");
  if (!apiKeyCols.includes("leads_caught")) db.exec("ALTER TABLE api_keys ADD COLUMN leads_caught INTEGER DEFAULT 0");
  // "provider" distinguishes Google Places keys (used for hunting) from
  // Gemini keys (used for business analysis + outreach content) - existing
  // rows predate this column and are all Google Places keys.
  if (!apiKeyCols.includes("provider")) {
    db.exec("ALTER TABLE api_keys ADD COLUMN provider TEXT DEFAULT 'google_places'");
    db.exec("UPDATE api_keys SET provider = 'google_places' WHERE provider IS NULL");
  }
}

{
  const searchLogCols = db.prepare("PRAGMA table_info(search_log)").all().map((c) => c.name);
  if (!searchLogCols.includes("user_id")) db.exec("ALTER TABLE search_log ADD COLUMN user_id INTEGER");
}

// ---------- Step 3: migrate the old hardcoded single login into a real user ----------
// Earlier versions had one hardcoded admin (Saeeddev / Saeed@@2026&&) and no
// concept of ownership on niches/api_keys/search_log. This creates a real
// `users` row for that account (same credentials, nobody gets locked out)
// and assigns every existing un-owned row to it.
{
  const userCount = db.prepare("SELECT COUNT(*) AS c FROM users").get().c;
  if (userCount === 0) {
    const hash = bcrypt.hashSync("Saeed@@2026&&", 10);
    const info = db
      .prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')")
      .run("Saeeddev", hash);
    const adminId = info.lastInsertRowid;

    db.prepare("UPDATE niches SET user_id = ? WHERE user_id IS NULL").run(adminId);
    db.prepare("UPDATE api_keys SET user_id = ? WHERE user_id IS NULL").run(adminId);
    db.prepare("UPDATE search_log SET user_id = ? WHERE user_id IS NULL").run(adminId);

    // Whichever key was globally "active" before becomes this admin's active key.
    const activeIdSetting = db.prepare("SELECT value FROM settings WHERE key = 'active_api_key_id'").get();
    if (activeIdSetting && activeIdSetting.value) {
      db.prepare("UPDATE api_keys SET is_active = 1 WHERE id = ?").run(Number(activeIdSetting.value));
    }

    console.log('[migration] Created admin account "Saeeddev" (same password as before) and assigned all existing data to it.');
  }
}

// One-time migration: earlier versions of Settings stored a single key under
// settings.google_places_api_key (from before api_keys existed at all). Move
// it into the multi-key list so nothing anyone already saved gets lost.
{
  const keyCount = db.prepare("SELECT COUNT(*) AS c FROM api_keys").get().c;
  if (keyCount === 0) {
    const legacy = db.prepare("SELECT value FROM settings WHERE key = ?").get("google_places_api_key");
    const adminRow = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1").get();
    if (legacy && legacy.value && adminRow) {
      db.prepare("INSERT INTO api_keys (user_id, label, key_value, is_active) VALUES (?, 'Default', ?, 1)").run(
        adminRow.id,
        legacy.value
      );
      console.log('[migration] Moved the existing Google API key into the new multi-key list as "Default".');
    }
  }
}

// ---------- Step 4: leads table (catch-log schema + socials column) ----------
const leadsTableExists = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='leads'")
  .get();

if (!leadsTableExists) {
  db.exec(`
    CREATE TABLE leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      catch_log_id INTEGER NOT NULL,
      place_id TEXT,
      name TEXT NOT NULL,
      address TEXT,
      phone TEXT,
      website TEXT,
      rating REAL,
      review_count INTEGER,
      business_status TEXT,
      needs TEXT,
      socials TEXT,
      status TEXT DEFAULT 'new',
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(catch_log_id, place_id)
    );
  `);
} else {
  const cols = db.prepare("PRAGMA table_info(leads)").all();
  const hasCatchLogId = cols.some((c) => c.name === "catch_log_id");

  if (!hasCatchLogId) {
    console.log("[migration] Old leads schema detected. Migrating into Niches/Catch Logs...");

    const adminRow = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1").get();
    let defaultNiche = db.prepare("SELECT * FROM niches WHERE name = ? AND user_id = ?").get("Uncategorized", adminRow.id);
    if (!defaultNiche) {
      const info = db.prepare("INSERT INTO niches (user_id, name) VALUES (?, ?)").run(adminRow.id, "Uncategorized");
      defaultNiche = { id: info.lastInsertRowid };
    }

    const oldLeads = db.prepare("SELECT * FROM leads").all();
    const groupToCatchLogId = new Map();

    function getOrCreateCatchLog(keyword, location) {
      const key = `${keyword || ""}::${location || ""}`;
      if (groupToCatchLogId.has(key)) return groupToCatchLogId.get(key);
      const logName =
        keyword || location
          ? `${keyword || "search"} in ${location || "unknown"} (imported)`
          : "Imported leads";
      const info = db
        .prepare("INSERT INTO catch_logs (niche_id, name, keyword, location) VALUES (?, ?, ?, ?)")
        .run(defaultNiche.id, logName, keyword || null, location || null);
      groupToCatchLogId.set(key, info.lastInsertRowid);
      return info.lastInsertRowid;
    }

    db.exec("ALTER TABLE leads RENAME TO leads_old");
    db.exec(`
      CREATE TABLE leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        catch_log_id INTEGER NOT NULL,
        place_id TEXT,
        name TEXT NOT NULL,
        address TEXT,
        phone TEXT,
        website TEXT,
        rating REAL,
        review_count INTEGER,
        business_status TEXT,
        needs TEXT,
        socials TEXT,
        status TEXT DEFAULT 'new',
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(catch_log_id, place_id)
      );
    `);

    const insertMigrated = db.prepare(`
      INSERT INTO leads (catch_log_id, place_id, name, address, phone, website, rating,
                          review_count, business_status, needs, status, notes, created_at)
      VALUES (@catch_log_id, @place_id, @name, @address, @phone, @website, @rating,
              @review_count, @business_status, @needs, @status, @notes, @created_at)
    `);

    const migrate = db.transaction((rows) => {
      for (const row of rows) {
        const catchLogId = getOrCreateCatchLog(row.search_keyword, row.search_location);
        insertMigrated.run({
          catch_log_id: catchLogId,
          place_id: row.place_id,
          name: row.name,
          address: row.address,
          phone: row.phone,
          website: row.website,
          rating: row.rating,
          review_count: row.review_count,
          business_status: row.business_status,
          needs: row.needs,
          status: row.status,
          notes: row.notes,
          created_at: row.created_at,
        });
      }
    });
    migrate(oldLeads);

    db.exec("DROP TABLE leads_old");
    console.log(`[migration] Done. ${oldLeads.length} existing leads moved under "Uncategorized".`);
  }

  const currentCols = db.prepare("PRAGMA table_info(leads)").all();
  if (!currentCols.some((c) => c.name === "socials")) {
    db.exec("ALTER TABLE leads ADD COLUMN socials TEXT");
    console.log('[migration] Added "socials" column to leads.');
  }
}

// ---------- Per-user daily lead cap (default 300, editable in Settings) ----------
{
  const userCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!userCols.includes("daily_lead_cap")) {
    db.exec("ALTER TABLE users ADD COLUMN daily_lead_cap INTEGER DEFAULT 300");
    console.log('[migration] Added "daily_lead_cap" column to users (default 300).');
  }
  if (!userCols.includes("page_size")) {
    db.exec("ALTER TABLE users ADD COLUMN page_size INTEGER DEFAULT 50");
  }
  if (!userCols.includes("signature")) {
    const defaultSignature = `Kind Regards,<br>&nbsp;&nbsp;&nbsp;<b>Saeed Iqbal</b><br>&nbsp;&nbsp;&nbsp;Ceo | Xeven Pixels<br>&nbsp;&nbsp;&nbsp;<a href="https://xevenpixels.com">https://xevenpixels.com</a><br>&nbsp;&nbsp;&nbsp;contact@xevenpixels.com`;
    db.prepare("ALTER TABLE users ADD COLUMN signature TEXT").run();
    db.prepare("UPDATE users SET signature = ? WHERE signature IS NULL").run(defaultSignature);
  }
  if (!userCols.includes("meeting_link")) db.exec("ALTER TABLE users ADD COLUMN meeting_link TEXT");
  if (!userCols.includes("website_link")) db.exec("ALTER TABLE users ADD COLUMN website_link TEXT");
  if (!userCols.includes("preferred_content_provider")) db.exec("ALTER TABLE users ADD COLUMN preferred_content_provider TEXT DEFAULT ''");
  if (!userCols.includes("preferred_inspection_provider")) db.exec("ALTER TABLE users ADD COLUMN preferred_inspection_provider TEXT DEFAULT ''");
}

// ---------- One catch log per (niche, city): merge any existing duplicates ----------
// Before this version, every hunt created a brand new catch log even for a
// niche+city you'd already searched before. Merge any existing duplicates
// into a single canonical catch log per (niche_id, normalized location) so
// old data matches the new "hunts append instead of duplicating" behavior.
{
  function normLoc(loc) {
    return (loc || "").trim().toLowerCase().replace(/[,\s]+/g, " ");
  }

  const allLogs = db
    .prepare("SELECT * FROM catch_logs WHERE location IS NOT NULL AND location != ''")
    .all();
  const groups = new Map(); // "nicheId::normalizedLocation" -> [logs...]
  for (const log of allLogs) {
    const key = `${log.niche_id}::${normLoc(log.location)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(log);
  }

  let mergedGroups = 0;
  const mergeTx = db.transaction(() => {
    for (const logs of groups.values()) {
      if (logs.length < 2) continue; // nothing to merge

      logs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      const canonical = logs[0];
      const duplicates = logs.slice(1);

      for (const dup of duplicates) {
        const dupLeads = db.prepare("SELECT * FROM leads WHERE catch_log_id = ?").all(dup.id);
        for (const lead of dupLeads) {
          const clash = lead.place_id
            ? db
                .prepare("SELECT id FROM leads WHERE catch_log_id = ? AND place_id = ?")
                .get(canonical.id, lead.place_id)
            : null;
          if (clash) {
            // Already have this exact business in the canonical log - drop the duplicate row
            db.prepare("DELETE FROM leads WHERE id = ?").run(lead.id);
          } else {
            db.prepare("UPDATE leads SET catch_log_id = ? WHERE id = ?").run(canonical.id, lead.id);
          }
        }
        db.prepare("DELETE FROM catch_logs WHERE id = ?").run(dup.id);
      }
      mergedGroups++;
    }
  });
  mergeTx();

  if (mergedGroups > 0) {
    console.log(`[migration] Merged duplicate catch logs for ${mergedGroups} niche+city combo(s) into one each.`);
  }
}

// ---------- Daily-granularity API key usage (Reports page needs "today's
// usage" specifically, not just the all-time cumulative totals already on
// api_keys) ----------
db.exec(`
CREATE TABLE IF NOT EXISTS api_key_daily_usage (
  api_key_id INTEGER NOT NULL,
  usage_date TEXT NOT NULL,
  requests_made INTEGER DEFAULT 0,
  leads_caught INTEGER DEFAULT 0,
  PRIMARY KEY (api_key_id, usage_date)
);
`);

{
  const leadCols = db.prepare("PRAGMA table_info(leads)").all().map((c) => c.name);
  if (!leadCols.includes("pinned")) db.exec("ALTER TABLE leads ADD COLUMN pinned INTEGER DEFAULT 0");
  if (!leadCols.includes("owner_name")) db.exec("ALTER TABLE leads ADD COLUMN owner_name TEXT");
}

// ---------- Business deep-analysis (Reach Out "Inspect" feature) ----------
db.exec(`
CREATE TABLE IF NOT EXISTS business_analysis (
  lead_id INTEGER PRIMARY KEY,
  status TEXT DEFAULT 'pending',
  current_step TEXT,
  overall_score INTEGER,
  website_score INTEGER,
  gmb_score INTEGER,
  social_score INTEGER,
  reputation_score INTEGER,
  checklist TEXT,
  strengths TEXT,
  weaknesses TEXT,
  suggested_services TEXT,
  raw_data TEXT,
  error TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
`);

{
  const businessAnalysisCols = db.prepare("PRAGMA table_info(business_analysis)").all().map((c) => c.name);
  if (!businessAnalysisCols.includes("provider")) db.exec("ALTER TABLE business_analysis ADD COLUMN provider TEXT");
}

// ---------- Generated outreach content, per lead per platform ----------
db.exec(`
CREATE TABLE IF NOT EXISTS outreach_content (
  lead_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  tone TEXT,
  content TEXT,
  generated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (lead_id, platform)
);
`);

{
  const outreachContentCols = db.prepare("PRAGMA table_info(outreach_content)").all().map((c) => c.name);
  if (!outreachContentCols.includes("length")) db.exec("ALTER TABLE outreach_content ADD COLUMN length TEXT");
  if (!outreachContentCols.includes("provider")) db.exec("ALTER TABLE outreach_content ADD COLUMN provider TEXT");
  if (!outreachContentCols.includes("language")) db.exec("ALTER TABLE outreach_content ADD COLUMN language TEXT");
}

// ---------- Migrate outreach_content's primary key to include language ----------
// Previously keyed by just (lead_id, platform), meaning generating content
// in a second language would silently overwrite the first language's saved
// version. Each language now needs to coexist independently per platform,
// which requires changing the PRIMARY KEY - SQLite can't ALTER a table to
// do that directly, so this recreates the table and copies the data across.
// Detected by checking whether "language" is actually part of the primary
// key yet (its pk position via PRAGMA table_info), not just whether the
// column exists.
{
  const cols = db.prepare("PRAGMA table_info(outreach_content)").all();
  const languageCol = cols.find((c) => c.name === "language");
  const languageIsInPrimaryKey = languageCol && languageCol.pk > 0;

  if (!languageIsInPrimaryKey) {
    db.exec(`
      CREATE TABLE outreach_content_new (
        lead_id INTEGER NOT NULL,
        platform TEXT NOT NULL,
        tone TEXT,
        length TEXT,
        content TEXT,
        provider TEXT,
        language TEXT NOT NULL DEFAULT 'English',
        generated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (lead_id, platform, language)
      );
      INSERT INTO outreach_content_new (lead_id, platform, tone, length, content, provider, language, generated_at)
        SELECT lead_id, platform, tone, length, content, provider, COALESCE(language, 'English'), generated_at FROM outreach_content;
      DROP TABLE outreach_content;
      ALTER TABLE outreach_content_new RENAME TO outreach_content;
    `);
    console.log("[migration] outreach_content is now keyed by (lead_id, platform, language) - each language's generated content is preserved independently instead of being overwritten by the next language.");
  }
}

// Subject line, stored separately from the body - only meaningful for the
// "email" platform (other platforms like Facebook/Instagram DMs don't
// have a subject concept), but added to every row's schema for simplicity.
{
  const outreachContentCols = db.prepare("PRAGMA table_info(outreach_content)").all().map((c) => c.name);
  if (!outreachContentCols.includes("subject")) db.exec("ALTER TABLE outreach_content ADD COLUMN subject TEXT");
}

// ---------- Async batch content generation job tracking (generates all
// platforms at once in the background, mirroring the Inspect job pattern -
// this is what avoids any single HTTP request needing to stay open long
// enough to hit a reverse-proxy timeout) ----------
db.exec(`
CREATE TABLE IF NOT EXISTS content_generation_jobs (
  lead_id INTEGER PRIMARY KEY,
  status TEXT DEFAULT 'pending',
  current_step TEXT,
  completed_platforms TEXT DEFAULT '[]',
  failed_platforms TEXT DEFAULT '{}',
  updated_at TEXT DEFAULT (datetime('now'))
);
`);

// ---------- Generated freebie landing pages (the "Create Website" feature) ----------
// One row per generated site. html is the fully-assembled, ready-to-serve
// page (template + AI copy + color preset baked in) - stored as a single
// blob rather than re-assembled on every request, so serving it is just a
// straight read, no template/AI logic on the hot path.
db.exec(`
CREATE TABLE IF NOT EXISTS generated_sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER,
  user_id INTEGER NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  niche TEXT,
  city TEXT,
  business_name TEXT,
  design_style TEXT,
  color_preset TEXT,
  use_visuals INTEGER DEFAULT 1,
  status TEXT DEFAULT 'pending',
  current_step TEXT,
  error TEXT,
  html TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// ---------- Email open/click tracker (the "Contacted" feature) ----------
// Ported from a standalone Postgres-backed app into this app's own SQLite
// database - same tracking model (pixel + link-rewrite, self-open and
// bot/scanner filtering, notifications, SMTP alerts), but every table is
// scoped per-user (user_id) since this app has multiple users and the
// original was single-admin. id on tracked_emails stays a UUID string
// (generated in JS) rather than an integer, to match the format already
// baked into the browser extension's tracking-pixel/click URLs.
db.exec(`
CREATE TABLE IF NOT EXISTS tracked_emails (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  recipients TEXT NOT NULL DEFAULT '[]',
  sender TEXT,
  sender_ip TEXT,
  notes TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT 'hostinger',
  status TEXT NOT NULL DEFAULT 'sent',
  open_count INTEGER NOT NULL DEFAULT 0,
  click_count INTEGER NOT NULL DEFAULT 0,
  first_opened_at TEXT,
  last_opened_at TEXT,
  body_html TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tracked_emails_user ON tracked_emails(user_id);
CREATE INDEX IF NOT EXISTS idx_tracked_emails_created_at ON tracked_emails(created_at DESC);

CREATE TABLE IF NOT EXISTS tracked_opens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id TEXT NOT NULL REFERENCES tracked_emails(id) ON DELETE CASCADE,
  opened_at TEXT DEFAULT (datetime('now')),
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_tracked_opens_email ON tracked_opens(email_id);

CREATE TABLE IF NOT EXISTS tracked_clicks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id TEXT NOT NULL REFERENCES tracked_emails(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  clicked_at TEXT DEFAULT (datetime('now')),
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_tracked_clicks_email ON tracked_clicks(email_id);

CREATE TABLE IF NOT EXISTS tracked_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id TEXT NOT NULL REFERENCES tracked_emails(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  url TEXT,
  message TEXT NOT NULL DEFAULT '',
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tracked_notif_user ON tracked_notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_tracked_notif_read ON tracked_notifications(is_read);
`);

// Per-user tracker settings + the auto-generated API key the extension
// authenticates with - lives on the users table alongside signature/
// meeting_link/etc, matching this app's existing per-user-settings pattern
// rather than the original's single global settings row.
{
  const userCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  const trackerCols = {
    tracker_api_key: "TEXT",
    tracker_refresh_interval: "INTEGER DEFAULT 0",
    tracker_notify_email_enabled: "INTEGER DEFAULT 0",
    tracker_notify_email_to: "TEXT",
    tracker_smtp_host: "TEXT",
    tracker_smtp_port: "INTEGER",
    tracker_smtp_user: "TEXT",
    tracker_smtp_pass: "TEXT",
    tracker_smtp_from: "TEXT",
    gmail_smtp_user: "TEXT",
    gmail_smtp_app_password: "TEXT",
  };
  for (const [col, type] of Object.entries(trackerCols)) {
    if (!userCols.includes(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} ${type}`);
  }
}

// ---------- Automated email campaigns ----------
// One campaign targets a niche/city scope and a list of leads, working
// through them one at a time: inspect (if requested and not already
// done) -> generate content -> send via the user's own Hostinger SMTP,
// with a randomized 5-10 minute gap between sends to avoid tripping spam
// detection. Each send reuses the exact same tracking mechanism as the
// browser extension (pixel + rewritten links), just built server-side
// instead of client-side, and appended to the Hostinger Sent folder via
// IMAP so it shows up in the mailbox exactly like a normally-sent email.
db.exec(`
CREATE TABLE IF NOT EXISTS email_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  niche_id INTEGER,
  catch_log_id INTEGER,
  catch_log_ids TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  require_inspection INTEGER NOT NULL DEFAULT 1,
  tone TEXT,
  length TEXT,
  language TEXT DEFAULT 'English',
  cta INTEGER DEFAULT 0,
  meeting INTEGER DEFAULT 0,
  meeting_link TEXT,
  ai_provider TEXT DEFAULT '',
  max_per_day INTEGER NOT NULL DEFAULT 100,
  min_gap_minutes INTEGER NOT NULL DEFAULT 5,
  max_gap_minutes INTEGER NOT NULL DEFAULT 10,
  pause_reason TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,
  paused_at TEXT,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_campaigns_user ON email_campaigns(user_id);
CREATE INDEX IF NOT EXISTS idx_email_campaigns_status ON email_campaigns(status);

CREATE TABLE IF NOT EXISTS email_campaign_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES email_campaigns(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  tracked_email_id TEXT,
  error TEXT,
  sent_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_campaign ON email_campaign_leads(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_status ON email_campaign_leads(status);
`);

// General-purpose notifications - campaign pause/complete/fail events and
// anything else that isn't a specific email open/click (those stay in
// tracked_notifications, which is tightly tied to a specific tracked
// email). The header notification feed merges both tables so campaign
// events and tracker alerts show up together in one place.
db.exec(`
CREATE TABLE IF NOT EXISTS app_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  link TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_app_notifications_user ON app_notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_app_notifications_read ON app_notifications(is_read);
`);

{
  const campaignCols = db.prepare("PRAGMA table_info(email_campaigns)").all().map((c) => c.name);
  if (!campaignCols.includes("ai_provider")) db.exec("ALTER TABLE email_campaigns ADD COLUMN ai_provider TEXT DEFAULT ''");
  if (!campaignCols.includes("catch_log_ids")) db.exec("ALTER TABLE email_campaigns ADD COLUMN catch_log_ids TEXT");
}

{
  const trackedEmailCols = db.prepare("PRAGMA table_info(tracked_emails)").all().map((c) => c.name);
  if (!trackedEmailCols.includes("body_html")) db.exec("ALTER TABLE tracked_emails ADD COLUMN body_html TEXT");
}

// One-time fix: the auto-refresh interval used to default to 15 (inherited
// from the original standalone tracker's different set of intervals), but
// this app's actual dropdown only offers 0/60/180/300/900/1800/3600/7200/
// 21600/43200 - 15 was never a value the dropdown could display, so it
// silently showed as unselected. Reset any row still sitting on that
// stale, never-actually-chosen default back to 0 (Off).
db.prepare("UPDATE users SET tracker_refresh_interval = 0 WHERE tracker_refresh_interval = 15").run();

module.exports = db;
