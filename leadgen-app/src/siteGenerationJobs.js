const db = require("./db");
const { buildBaseSlug, resolveUniqueSlug, generateFullPage } = require("./websiteGenerator");

// leadId -> { cancelled: boolean } - same in-memory job-tracking pattern
// already proven for Inspect and content generation.
const activeJobs = new Map();

function isCancelled(siteId) {
  return activeJobs.get(siteId)?.cancelled === true;
}

async function runSiteJob(userId, siteId, ctx) {
  try {
    db.prepare("UPDATE generated_sites SET status = 'running', current_step = 'Designing and writing your page - this takes a bit longer for a full custom page…' WHERE id = ?").run(siteId);

    const result = await generateFullPage(userId, ctx);

    if (isCancelled(siteId)) return;

    if (!result.ok) {
      db.prepare("UPDATE generated_sites SET status = 'failed', error = ?, current_step = NULL WHERE id = ?").run(result.error, siteId);
      return;
    }

    db.prepare("UPDATE generated_sites SET status = 'done', current_step = NULL, html = ? WHERE id = ?").run(result.html, siteId);
  } catch (err) {
    db.prepare("UPDATE generated_sites SET status = 'failed', error = ?, current_step = NULL WHERE id = ?").run(err.message, siteId);
  } finally {
    activeJobs.delete(siteId);
  }
}

function startSiteGeneration(userId, { leadId, niche, city, businessName, designStyle, colorPreset, services, ctaGoal, phone, address, socials, strengths }) {
  const baseSlug = buildBaseSlug(niche, city, businessName);
  const slug = resolveUniqueSlug(baseSlug);

  const info = db
    .prepare(
      `INSERT INTO generated_sites (lead_id, user_id, slug, niche, city, business_name, design_style, color_preset, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    )
    .run(leadId || null, userId, slug, niche, city, businessName, designStyle, colorPreset);

  const siteId = info.lastInsertRowid;
  activeJobs.set(siteId, { cancelled: false });

  const ctx = { businessName, niche, city, designStyle, colorPreset, services, ctaGoal, phone, address, socials, strengths };
  runSiteJob(userId, siteId, ctx); // fire and forget - progress is polled via getSiteStatus()

  return { siteId, slug };
}

function getSiteStatus(siteId) {
  const row = db.prepare("SELECT id, status, current_step, error, slug FROM generated_sites WHERE id = ?").get(siteId);
  if (!row) return null;
  return { siteId: row.id, status: row.status, currentStep: row.current_step, error: row.error, slug: row.slug };
}

function stopSiteGeneration(siteId) {
  const job = activeJobs.get(siteId);
  if (job) job.cancelled = true;
  db.prepare("UPDATE generated_sites SET status = 'stopped', current_step = NULL WHERE id = ? AND status = 'running'").run(siteId);
}

module.exports = { startSiteGeneration, getSiteStatus, stopSiteGeneration };
