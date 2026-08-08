const express = require("express");
const db = require("../db");

const router = express.Router();

// Bumped from 1 -> 2: now includes provider on API keys (was silently
// missing, which would have corrupted Groq/Gemini/DeepSeek key labeling on
// restore - every restored key would have come back as google_places
// regardless of what it actually was), plus business_analysis (Inspect
// results), outreach_content (generated messages), and the per-user
// page_size and signature settings. Old (v1) backups still import fine -
// the fields they don't have are simply treated as absent.
const BACKUP_FORMAT_VERSION = 2;

// GET /api/backup/export -> a single JSON file with everything this account
// owns: niches, catch logs, leads (including pinned status), seen_places
// (dedup history), API keys for ALL providers with their provider and usage
// history, business analysis (Inspect results), generated outreach content,
// theme, daily cap, page size, and signature.
// content_generation_jobs is intentionally excluded, same reasoning as
// search_log - it's transient in-progress job bookkeeping, not durable data
// (a completed/failed/stopped job has nothing worth restoring, and a
// currently-running one can't be meaningfully resumed from a backup file).
router.get("/export", (req, res) => {
  const userId = req.session.userId;

  const user = db.prepare("SELECT username, theme, daily_lead_cap, page_size, signature FROM users WHERE id = ?").get(userId);
  const niches = db.prepare("SELECT * FROM niches WHERE user_id = ?").all(userId);

  const nicheIds = niches.map((n) => n.id);
  const catchLogs = nicheIds.length
    ? db
        .prepare(`SELECT * FROM catch_logs WHERE niche_id IN (${nicheIds.map(() => "?").join(",")})`)
        .all(...nicheIds)
    : [];

  const catchLogIds = catchLogs.map((c) => c.id);
  const leads = catchLogIds.length
    ? db
        .prepare(`SELECT * FROM leads WHERE catch_log_id IN (${catchLogIds.map(() => "?").join(",")})`)
        .all(...catchLogIds)
    : [];

  const seenPlaces = db.prepare("SELECT niche_id, location_key, place_id, first_seen_at FROM seen_places WHERE user_id = ?").all(userId);

  // provider included this time - its earlier absence meant a restored key
  // could never be correctly matched back to Gemini/Groq/DeepSeek/Places.
  const apiKeys = db
    .prepare("SELECT id, label, key_value, provider, is_active, requests_made, leads_caught FROM api_keys WHERE user_id = ?")
    .all(userId);
  const apiKeyIds = apiKeys.map((k) => k.id);
  const apiKeyDailyUsage = apiKeyIds.length
    ? db
        .prepare(`SELECT api_key_id, usage_date, requests_made, leads_caught FROM api_key_daily_usage WHERE api_key_id IN (${apiKeyIds.map(() => "?").join(",")})`)
        .all(...apiKeyIds)
    : [];

  const leadIds = leads.map((l) => l.id);
  const businessAnalysis = leadIds.length
    ? db.prepare(`SELECT * FROM business_analysis WHERE lead_id IN (${leadIds.map(() => "?").join(",")})`).all(...leadIds)
    : [];
  const outreachContent = leadIds.length
    ? db.prepare(`SELECT * FROM outreach_content WHERE lead_id IN (${leadIds.map(() => "?").join(",")})`).all(...leadIds)
    : [];
  // Includes the full html - a restored site needs to actually be servable
  // immediately, not just have its metadata restored while silently
  // missing the page content (status would claim "done" but /site/:slug
  // would 404). Individual pages are small (~9KB), so this isn't a
  // meaningful size concern even for many sites.
  const generatedSites = db
    .prepare(
      "SELECT id, lead_id, slug, niche, city, business_name, design_style, color_preset, use_visuals, status, html, created_at FROM generated_sites WHERE user_id = ?"
    )
    .all(userId);

  const backup = {
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    username: user.username,
    theme: user.theme ? JSON.parse(user.theme) : null,
    dailyLeadCap: user.daily_lead_cap || 300,
    pageSize: user.page_size || 50,
    signature: user.signature,
    niches,
    catchLogs,
    leads,
    seenPlaces,
    apiKeys,
    apiKeyDailyUsage,
    businessAnalysis,
    outreachContent,
    generatedSites,
  };

  const filename = `xeven-leads-backup-${user.username}-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(JSON.stringify(backup, null, 2));
});

// POST /api/backup/import - body is the backup JSON itself.
// MERGES into the current account (never deletes anything already there):
//   - niches matched by name, reused if they already exist
//   - catch logs matched by (niche, normalized location) - same rule the
//     app already uses everywhere else, so imported cities line up with any
//     you've already hunted since the backup was taken
//   - leads matched by (catch_log, place_id) - existing local leads are
//     left untouched (their status/notes/pinned win), only genuinely new
//     businesses from the backup get inserted
//   - API keys matched by (key_value, provider) - skipped if you already
//     have that exact key+provider combo saved, added as inactive (not
//     auto-switched) otherwise
//   - business analysis and outreach content matched to the real (mapped)
//     lead id - only restored for leads that didn't already have their own
//     local analysis/content, never overwriting something already done
//     since the backup was taken
//   - theme, daily cap, page size, and signature are restored directly -
//     there's only one of each per account, so "merge" doesn't apply
router.post("/import", (req, res) => {
  const userId = req.session.userId;
  const backup = req.body;

  if (!backup || !Array.isArray(backup.niches)) {
    return res.status(400).json({ error: "This doesn't look like a valid Xeven Leads backup file." });
  }

  function normLoc(loc) {
    return (loc || "").trim().toLowerCase().replace(/[,\s]+/g, " ");
  }

  const stats = { niches: 0, catchLogs: 0, leads: 0, apiKeys: 0, businessAnalysis: 0, outreachContent: 0, generatedSites: 0 };

  const importTx = db.transaction(() => {
    const nicheIdMap = new Map(); // backup niche id -> real (existing or new) niche id

    for (const niche of backup.niches) {
      let existing = db.prepare("SELECT * FROM niches WHERE user_id = ? AND name = ?").get(userId, niche.name);
      if (!existing) {
        const info = db.prepare("INSERT INTO niches (user_id, name) VALUES (?, ?)").run(userId, niche.name);
        existing = { id: info.lastInsertRowid };
        stats.niches++;
      }
      nicheIdMap.set(niche.id, existing.id);
    }

    const catchLogIdMap = new Map(); // backup catch_log id -> real catch_log id

    for (const log of backup.catchLogs || []) {
      const realNicheId = nicheIdMap.get(log.niche_id);
      if (!realNicheId) continue; // orphaned reference in the backup file, skip safely

      const existingLogs = db.prepare("SELECT * FROM catch_logs WHERE niche_id = ?").all(realNicheId);
      let match = log.location
        ? existingLogs.find((l) => normLoc(l.location) === normLoc(log.location))
        : existingLogs.find((l) => l.name === log.name);

      if (!match) {
        const info = db
          .prepare("INSERT INTO catch_logs (niche_id, name, keyword, location) VALUES (?, ?, ?, ?)")
          .run(realNicheId, log.name, log.keyword || null, log.location || null);
        match = { id: info.lastInsertRowid };
        stats.catchLogs++;
      }
      catchLogIdMap.set(log.id, match.id);
    }

    // Tracks backup lead.id -> real (existing or newly inserted) lead id,
    // needed below to correctly remap business_analysis/outreach_content
    // rows onto whichever lead they actually ended up matching locally.
    const leadIdMap = new Map();

    const insertLead = db.prepare(`
      INSERT INTO leads (catch_log_id, place_id, name, address, phone, website, rating, review_count, business_status, needs, socials, status, notes, pinned, created_at)
      VALUES (@catch_log_id, @place_id, @name, @address, @phone, @website, @rating, @review_count, @business_status, @needs, @socials, @status, @notes, @pinned, @created_at)
      ON CONFLICT(catch_log_id, place_id) DO NOTHING
    `);
    const findExistingLead = db.prepare("SELECT id FROM leads WHERE catch_log_id = ? AND place_id = ?");

    for (const lead of backup.leads || []) {
      const realCatchLogId = catchLogIdMap.get(lead.catch_log_id);
      if (!realCatchLogId) continue;

      const info = insertLead.run({
        catch_log_id: realCatchLogId,
        place_id: lead.place_id,
        name: lead.name,
        address: lead.address,
        phone: lead.phone,
        website: lead.website,
        rating: lead.rating,
        review_count: lead.review_count,
        business_status: lead.business_status,
        needs: lead.needs,
        socials: lead.socials,
        status: lead.status || "new",
        notes: lead.notes,
        pinned: lead.pinned || 0,
        created_at: lead.created_at,
      });

      if (info.changes > 0) {
        stats.leads++;
        leadIdMap.set(lead.id, info.lastInsertRowid);
      } else {
        // Already existed locally (matched by catch_log_id + place_id) -
        // still need its real id so analysis/content below can be
        // correctly attributed, even though the lead row itself wasn't
        // touched.
        const existingLead = findExistingLead.get(realCatchLogId, lead.place_id);
        if (existingLead) leadIdMap.set(lead.id, existingLead.id);
      }
    }

    const insertSeen = db.prepare(
      "INSERT OR IGNORE INTO seen_places (user_id, niche_id, location_key, place_id) VALUES (?, ?, ?, ?)"
    );
    for (const seen of backup.seenPlaces || []) {
      const realNicheId = nicheIdMap.get(seen.niche_id);
      if (!realNicheId) continue;
      insertSeen.run(userId, realNicheId, seen.location_key, seen.place_id);
    }

    // provider defaults to "google_places" for backups taken before it
    // existed (formatVersion 1) - matching how the column itself defaults,
    // so an old backup's Places keys still come back correctly labeled.
    const apiKeyIdMap = new Map(); // backup api_key id -> real api_key id
    for (const key of backup.apiKeys || []) {
      const provider = key.provider || "google_places";
      let existing = db.prepare("SELECT id FROM api_keys WHERE user_id = ? AND key_value = ? AND provider = ?").get(userId, key.key_value, provider);
      if (!existing) {
        const info = db
          .prepare(
            "INSERT INTO api_keys (user_id, label, key_value, provider, is_active, requests_made, leads_caught) VALUES (?, ?, ?, ?, 0, ?, ?)"
          )
          .run(userId, key.label || "Imported key", key.key_value, provider, key.requests_made || 0, key.leads_caught || 0);
        existing = { id: info.lastInsertRowid };
        stats.apiKeys++;
      }
      if (key.id) apiKeyIdMap.set(key.id, existing.id);
    }

    // Restore per-day usage history for the Reports/Limits Usage "usage
    // over time" charts. Matched by (api_key_id, usage_date) - a date that
    // already has a row locally is left untouched (INSERT OR IGNORE), so
    // re-importing the same backup twice (or importing after already
    // using a key today) never double-counts anything.
    const insertDailyUsage = db.prepare(
      `INSERT OR IGNORE INTO api_key_daily_usage (api_key_id, usage_date, requests_made, leads_caught) VALUES (?, ?, ?, ?)`
    );
    for (const usage of backup.apiKeyDailyUsage || []) {
      const realKeyId = apiKeyIdMap.get(usage.api_key_id);
      if (!realKeyId) continue;
      insertDailyUsage.run(realKeyId, usage.usage_date, usage.requests_made || 0, usage.leads_caught || 0);
    }

    // Business analysis (Inspect results) - only restored if this lead
    // doesn't already have its OWN local analysis, so a backup can never
    // clobber a fresher inspection run since the backup was taken.
    const insertAnalysis = db.prepare(`
      INSERT INTO business_analysis (lead_id, status, overall_score, website_score, gmb_score, social_score, reputation_score, checklist, strengths, weaknesses, suggested_services, raw_data, provider, updated_at)
      VALUES (@lead_id, @status, @overall_score, @website_score, @gmb_score, @social_score, @reputation_score, @checklist, @strengths, @weaknesses, @suggested_services, @raw_data, @provider, @updated_at)
      ON CONFLICT(lead_id) DO NOTHING
    `);
    for (const analysis of backup.businessAnalysis || []) {
      const realLeadId = leadIdMap.get(analysis.lead_id);
      if (!realLeadId) continue;
      const info = insertAnalysis.run({
        lead_id: realLeadId,
        status: analysis.status,
        overall_score: analysis.overall_score,
        website_score: analysis.website_score,
        gmb_score: analysis.gmb_score,
        social_score: analysis.social_score,
        reputation_score: analysis.reputation_score,
        checklist: analysis.checklist,
        strengths: analysis.strengths,
        weaknesses: analysis.weaknesses,
        suggested_services: analysis.suggested_services,
        raw_data: analysis.raw_data,
        provider: analysis.provider,
        updated_at: analysis.updated_at,
      });
      if (info.changes > 0) stats.businessAnalysis++;
    }

    // Generated outreach content - same "don't clobber anything fresher"
    // rule, keyed by (lead_id, platform, language) same as the table's own
    // primary key (each language is stored independently).
    const insertContent = db.prepare(`
      INSERT INTO outreach_content (lead_id, platform, tone, length, content, subject, provider, language, generated_at)
      VALUES (@lead_id, @platform, @tone, @length, @content, @subject, @provider, @language, @generated_at)
      ON CONFLICT(lead_id, platform, language) DO NOTHING
    `);
    for (const content of backup.outreachContent || []) {
      const realLeadId = leadIdMap.get(content.lead_id);
      if (!realLeadId) continue;
      const info = insertContent.run({
        lead_id: realLeadId,
        platform: content.platform,
        tone: content.tone,
        length: content.length,
        content: content.content,
        subject: content.subject || null,
        provider: content.provider,
        language: content.language || "English",
        generated_at: content.generated_at,
      });
      if (info.changes > 0) stats.outreachContent++;
    }

    // Generated freebie websites - matched by slug (globally unique by
    // design), so re-importing the same backup twice never duplicates.
    // lead_id is remapped like everything else above; if the original
    // lead can't be matched (e.g. it was never in this backup), the site
    // is still restored but with no lead attached, since the page itself
    // is still a real, valid, servable artifact on its own.
    const insertSite = db.prepare(`
      INSERT INTO generated_sites (lead_id, user_id, slug, niche, city, business_name, design_style, color_preset, use_visuals, status, html, created_at)
      VALUES (@lead_id, @user_id, @slug, @niche, @city, @business_name, @design_style, @color_preset, @use_visuals, @status, @html, @created_at)
      ON CONFLICT(slug) DO NOTHING
    `);
    for (const site of backup.generatedSites || []) {
      const info = insertSite.run({
        lead_id: leadIdMap.get(site.lead_id) || null,
        user_id: userId,
        slug: site.slug,
        niche: site.niche,
        city: site.city,
        business_name: site.business_name,
        design_style: site.design_style,
        color_preset: site.color_preset,
        use_visuals: site.use_visuals,
        status: site.status,
        html: site.html,
        created_at: site.created_at,
      });
      if (info.changes > 0) stats.generatedSites++;
    }

    if (backup.theme) {
      db.prepare("UPDATE users SET theme = ? WHERE id = ?").run(JSON.stringify(backup.theme), userId);
    }
    if (backup.dailyLeadCap) {
      db.prepare("UPDATE users SET daily_lead_cap = ? WHERE id = ?").run(backup.dailyLeadCap, userId);
    }
    if (backup.pageSize) {
      db.prepare("UPDATE users SET page_size = ? WHERE id = ?").run(backup.pageSize, userId);
    }
    if (backup.signature != null) {
      db.prepare("UPDATE users SET signature = ? WHERE id = ?").run(backup.signature, userId);
    }
  });

  try {
    importTx();
    res.json({ ok: true, stats });
  } catch (err) {
    console.error("Backup import failed:", err);
    res.status(500).json({ error: `Import failed: ${err.message}` });
  }
});

module.exports = router;
