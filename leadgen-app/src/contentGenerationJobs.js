// Runs content generation for ALL platforms as a single background job,
// mirroring the Inspect feature's proven pattern (start/status/stop with
// live progress). This is the real fix for requests hanging behind a
// reverse-proxy timeout: the initial "start" call returns immediately, the
// actual AI calls happen in the background, and the browser just polls for
// progress - so no single HTTP request ever needs to stay open as long as
// 6 sequential AI calls would take.
const db = require("./db");
const { generateOutreachContent, PLATFORM_LIST } = require("./outreachContent");

// leadId -> { cancelled: boolean }
const activeJobs = new Map();

function upsertJobRow(leadId, fields) {
  const existing = db.prepare("SELECT lead_id FROM content_generation_jobs WHERE lead_id = ?").get(leadId);
  const cols = Object.keys(fields);
  const values = Object.values(fields);

  if (existing) {
    const setClause = cols.map((c) => `${c} = ?`).join(", ");
    db.prepare(`UPDATE content_generation_jobs SET ${setClause}, updated_at = datetime('now') WHERE lead_id = ?`).run(...values, leadId);
  } else {
    const allCols = ["lead_id", ...cols];
    const placeholders = allCols.map(() => "?").join(", ");
    db.prepare(`INSERT INTO content_generation_jobs (${allCols.join(", ")}) VALUES (${placeholders})`).run(leadId, ...values);
  }
}

function getJob(leadId) {
  const row = db.prepare("SELECT * FROM content_generation_jobs WHERE lead_id = ?").get(leadId);
  if (!row) return null;
  return {
    leadId: row.lead_id,
    status: row.status,
    currentStep: row.current_step,
    completedPlatforms: JSON.parse(row.completed_platforms || "[]"),
    failedPlatforms: JSON.parse(row.failed_platforms || "{}"),
    updatedAt: row.updated_at,
  };
}

function isCancelled(leadId) {
  const job = activeJobs.get(leadId);
  return !job || job.cancelled;
}

async function runJob(userId, leadId, lead, platforms, options) {
  const { tone, length, analysis, language, aiProvider, cta, meeting, meetingLink, website, websiteLink } = options;
  const completed = [];
  const failed = {};
  const userRow = db.prepare("SELECT signature FROM users WHERE id = ?").get(userId);
  const signature = userRow ? userRow.signature : null;

  try {
    upsertJobRow(leadId, { status: "running", current_step: `Generating ${platforms[0]}…`, completed_platforms: "[]", failed_platforms: "{}" });

    for (const platform of platforms) {
      if (isCancelled(leadId)) return;

      // Throttled to stay well under free-tier per-minute rate limits
      // (Gemini's free tier allows as few as 10 requests/minute) - firing
      // all 6 platforms with zero delay between them can approach or
      // exceed that ceiling on its own, especially if anything else (like
      // an Inspect run) used the same provider in the same minute.
      if (platform !== platforms[0]) await new Promise((r) => setTimeout(r, 2500));

      upsertJobRow(leadId, { current_step: `Generating ${platform}…` });
      const result = await generateOutreachContent(userId, {
        lead,
        platform,
        tone,
        length,
        analysis,
        signature,
        language,
        aiProvider,
        cta,
        meeting,
        meetingLink,
        website,
        websiteLink,
      });

      if (isCancelled(leadId)) return;

      if (result.ok) {
        db.prepare(
          `INSERT INTO outreach_content (lead_id, platform, tone, length, content, subject, provider, language, generated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(lead_id, platform, language) DO UPDATE SET tone = excluded.tone, length = excluded.length, content = excluded.content, subject = excluded.subject, provider = excluded.provider, generated_at = excluded.generated_at`
        ).run(leadId, platform, tone, length || null, result.content, result.subject || null, result.provider || null, language || "English");
        completed.push(platform);
      } else {
        failed[platform] = result.error;
      }

      upsertJobRow(leadId, { completed_platforms: JSON.stringify(completed), failed_platforms: JSON.stringify(failed) });
    }

    upsertJobRow(leadId, {
      status: completed.length > 0 ? "done" : "failed",
      current_step: null,
      completed_platforms: JSON.stringify(completed),
      failed_platforms: JSON.stringify(failed),
    });
  } catch (err) {
    upsertJobRow(leadId, { status: "failed", current_step: null, failed_platforms: JSON.stringify({ ...failed, _unexpected: err.message }) });
  } finally {
    activeJobs.delete(leadId);
  }
}

function startGeneration(userId, lead, options) {
  const leadId = lead.id;
  if (activeJobs.has(leadId)) return { alreadyRunning: true };

  const targetPlatforms = options.platforms && options.platforms.length ? options.platforms : PLATFORM_LIST;
  activeJobs.set(leadId, { cancelled: false });
  runJob(userId, leadId, lead, targetPlatforms, options); // fire and forget - progress is polled via getJob()
  return { alreadyRunning: false };
}

function stopGeneration(leadId) {
  const job = activeJobs.get(leadId);
  if (!job) return false;
  job.cancelled = true;
  upsertJobRow(leadId, { status: "stopped", current_step: null });
  return true;
}

module.exports = { startGeneration, stopGeneration, getJob };
