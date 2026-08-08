const express = require("express");
const db = require("../db");
const { isValidEmailAddress } = require("../emailValidation");
const { hasSmtpConfigured } = require("../campaignSender");

const router = express.Router();

// POST /api/campaigns { name, nicheId, catchLogId, leadIds?, requireInspection, tone, length, language, cta, meeting, meetingLink, maxPerDay, minGapMinutes, maxGapMinutes }
// leadIds omitted -> every lead currently in the given niche/catch-log scope with an email on file
router.post("/", (req, res) => {
  const userId = req.session.userId;
  const {
    name,
    nicheId,
    catchLogId,
    catchLogIds,
    leadIds,
    requireInspection,
    tone,
    length,
    language,
    cta,
    meeting,
    meetingLink,
    maxPerDay,
    minGapMinutes,
    maxGapMinutes,
    aiProvider,
  } = req.body || {};

  if (!name || !name.trim()) return res.status(400).json({ error: "Campaign name is required" });
  if (!tone) return res.status(400).json({ error: "Tone is required" });
  if (!hasSmtpConfigured(userId)) {
    return res.status(400).json({ error: "Set up SMTP on the Hostinger Setup page first - a campaign can't send without it." });
  }

  // Resolve the target lead list - either the explicit list given, or
  // every lead in the niche/catch-log scope. Either way, only leads with
  // an email on file can actually be targeted (checked at send time too,
  // but filtering here means the campaign's lead count is accurate from
  // the start rather than silently including un-sendable leads).
  let candidateLeads;
  if (Array.isArray(leadIds) && leadIds.length) {
    const placeholders = leadIds.map(() => "?").join(",");
    candidateLeads = db
      .prepare(
        `SELECT l.id, l.socials FROM leads l JOIN catch_logs cl ON cl.id = l.catch_log_id JOIN niches n ON n.id = cl.niche_id
         WHERE l.id IN (${placeholders}) AND n.user_id = ?`
      )
      .all(...leadIds, userId);
  } else if (Array.isArray(catchLogIds) && catchLogIds.length) {
    const placeholders = catchLogIds.map(() => "?").join(",");
    candidateLeads = db
      .prepare(
        `SELECT l.id, l.socials FROM leads l JOIN catch_logs cl ON cl.id = l.catch_log_id JOIN niches n ON n.id = cl.niche_id
         WHERE cl.id IN (${placeholders}) AND n.user_id = ?`
      )
      .all(...catchLogIds, userId);
  } else if (catchLogId) {
    candidateLeads = db
      .prepare(`SELECT l.id, l.socials FROM leads l JOIN catch_logs cl ON cl.id = l.catch_log_id JOIN niches n ON n.id = cl.niche_id WHERE cl.id = ? AND n.user_id = ?`)
      .all(catchLogId, userId);
  } else if (nicheId) {
    candidateLeads = db
      .prepare(`SELECT l.id, l.socials FROM leads l JOIN catch_logs cl ON cl.id = l.catch_log_id JOIN niches n ON n.id = cl.niche_id WHERE n.id = ? AND n.user_id = ?`)
      .all(nicheId, userId);
  } else {
    return res.status(400).json({ error: "Select a niche, a city, or a specific list of leads to target" });
  }

  const emailable = candidateLeads.filter((l) => {
    try {
      return isValidEmailAddress(JSON.parse(l.socials || "{}").email);
    } catch {
      return false;
    }
  });

  if (emailable.length === 0) {
    return res.status(400).json({ error: "None of the leads in this scope have an email address on file - nothing to send to." });
  }

  const resolvedCatchLogIds = Array.isArray(catchLogIds) && catchLogIds.length ? catchLogIds : catchLogId ? [catchLogId] : [];

  const info = db
    .prepare(
      `INSERT INTO email_campaigns (user_id, name, niche_id, catch_log_id, catch_log_ids, require_inspection, tone, length, language, cta, meeting, meeting_link, ai_provider, max_per_day, min_gap_minutes, max_gap_minutes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      name.trim(),
      nicheId || null,
      resolvedCatchLogIds[0] || null,
      resolvedCatchLogIds.length ? JSON.stringify(resolvedCatchLogIds) : null,
      requireInspection ? 1 : 0,
      tone,
      length || "Medium",
      language || "English",
      cta ? 1 : 0,
      meeting ? 1 : 0,
      meetingLink || null,
      aiProvider || "",
      Math.min(maxPerDay || 100, 100),
      minGapMinutes || 5,
      maxGapMinutes || 10
    );
  const campaignId = info.lastInsertRowid;

  const insertLead = db.prepare("INSERT INTO email_campaign_leads (campaign_id, lead_id) VALUES (?, ?)");
  const insertMany = db.transaction((leads) => {
    for (const lead of leads) insertLead.run(campaignId, lead.id);
  });
  insertMany(emailable);

  res.json({ ok: true, campaignId, leadCount: emailable.length, skippedCount: candidateLeads.length - emailable.length });
});

// GET /api/campaigns -> list with progress counts
router.get("/", (req, res) => {
  const rows = db
    .prepare(
      `SELECT c.*,
        (SELECT COUNT(*) FROM email_campaign_leads WHERE campaign_id = c.id) AS total_leads,
        (SELECT COUNT(*) FROM email_campaign_leads WHERE campaign_id = c.id AND status = 'sent') AS sent_count,
        (SELECT COUNT(*) FROM email_campaign_leads WHERE campaign_id = c.id AND status = 'failed') AS failed_count,
        (SELECT COUNT(*) FROM email_campaign_leads WHERE campaign_id = c.id AND status = 'skipped') AS skipped_count
       FROM email_campaigns c WHERE c.user_id = ? ORDER BY c.created_at DESC`
    )
    .all(req.session.userId);
  res.json({ campaigns: rows });
});

// GET /api/campaigns/:id -> detail with the full per-lead queue
router.get("/:id", (req, res) => {
  const campaign = db.prepare("SELECT * FROM email_campaigns WHERE id = ? AND user_id = ?").get(req.params.id, req.session.userId);
  if (!campaign) return res.status(404).json({ error: "Not found" });

  const leads = db
    .prepare(
      `SELECT ecl.id, ecl.status, ecl.error, ecl.sent_at, ecl.tracked_email_id, ecl.created_at,
              l.id AS lead_id, l.name AS lead_name, l.socials, l.address, l.phone, l.website,
              te.subject AS sent_subject, te.status AS tracked_status, te.open_count, te.click_count, te.first_opened_at
       FROM email_campaign_leads ecl
       JOIN leads l ON l.id = ecl.lead_id
       LEFT JOIN tracked_emails te ON te.id = ecl.tracked_email_id
       WHERE ecl.campaign_id = ? ORDER BY ecl.id ASC`
    )
    .all(campaign.id)
    .map((row) => {
      let email = null;
      try {
        email = JSON.parse(row.socials || "{}").email || null;
      } catch {
        email = null;
      }
      const { socials, ...rest } = row;
      return { ...rest, recipient_email: email };
    });

  res.json({ campaign, leads });
});

function requireOwnedCampaign(req, res, next) {
  const campaign = db.prepare("SELECT * FROM email_campaigns WHERE id = ? AND user_id = ?").get(req.params.id, req.session.userId);
  if (!campaign) return res.status(404).json({ error: "Not found" });
  req.campaign = campaign;
  next();
}

router.post("/:id/start", requireOwnedCampaign, (req, res) => {
  if (req.campaign.status !== "draft") return res.status(400).json({ error: "Only a draft campaign can be started" });
  db.prepare("UPDATE email_campaigns SET status = 'running', started_at = datetime('now') WHERE id = ?").run(req.campaign.id);
  res.json({ ok: true });
});

router.post("/:id/pause", requireOwnedCampaign, (req, res) => {
  if (req.campaign.status !== "running") return res.status(400).json({ error: "Only a running campaign can be paused" });
  db.prepare("UPDATE email_campaigns SET status = 'paused', paused_at = datetime('now'), pause_reason = 'Paused manually' WHERE id = ?").run(req.campaign.id);
  res.json({ ok: true });
});

// Resuming retries whichever lead was mid-flight when a failure paused
// the campaign - without this, that lead's 'failed' status would never
// be picked up again since the scheduler only looks for 'pending' leads.
router.post("/:id/resume", requireOwnedCampaign, (req, res) => {
  if (req.campaign.status !== "paused") return res.status(400).json({ error: "Only a paused campaign can be resumed" });
  db.prepare("UPDATE email_campaign_leads SET status = 'pending', error = NULL WHERE campaign_id = ? AND status IN ('failed', 'inspecting', 'generating', 'sending')").run(req.campaign.id);
  db.prepare("UPDATE email_campaigns SET status = 'running', paused_at = NULL, pause_reason = NULL WHERE id = ?").run(req.campaign.id);
  res.json({ ok: true });
});

// POST /api/campaigns/:id/leads/:leadRowId/skip - marks one specific lead
// as permanently skipped (not retried, unlike a plain resume which
// retries every failed lead) and resumes the campaign so the scheduler
// continues with whatever comes after it. This is what lets a single bad
// lead (e.g. a malformed email that somehow still made it through) be
// set aside without abandoning the rest of an otherwise-healthy campaign.
router.post("/:id/leads/:leadRowId/skip", requireOwnedCampaign, (req, res) => {
  const leadRow = db.prepare("SELECT * FROM email_campaign_leads WHERE id = ? AND campaign_id = ?").get(req.params.leadRowId, req.campaign.id);
  if (!leadRow) return res.status(404).json({ error: "Lead not found in this campaign" });

  db.prepare("UPDATE email_campaign_leads SET status = 'skipped', error = COALESCE(error, 'Skipped manually') WHERE id = ?").run(leadRow.id);

  if (req.campaign.status === "paused") {
    db.prepare("UPDATE email_campaigns SET status = 'running', paused_at = NULL, pause_reason = NULL WHERE id = ?").run(req.campaign.id);
  }
  res.json({ ok: true });
});

router.post("/:id/cancel", requireOwnedCampaign, (req, res) => {
  db.prepare("UPDATE email_campaigns SET status = 'cancelled' WHERE id = ?").run(req.campaign.id);
  res.json({ ok: true });
});

// PUT /api/campaigns/:id - edit/rename/reconfig. Only allowed for draft or
// paused campaigns - a running campaign is actively being processed by
// the scheduler, and changing its settings mid-flight could race with an
// in-progress send (e.g. changing the tone while a lead is mid-generation).
// Pause it first if it needs adjusting.
router.put("/:id", requireOwnedCampaign, (req, res) => {
  if (!["draft", "paused"].includes(req.campaign.status)) {
    return res.status(400).json({ error: "Pause a running campaign before editing it." });
  }
  const { name, requireInspection, tone, length, language, cta, meeting, meetingLink, aiProvider, maxPerDay, minGapMinutes, maxGapMinutes } = req.body || {};
  if (name !== undefined && !name.trim()) return res.status(400).json({ error: "Campaign name can't be empty" });

  db.prepare(
    `UPDATE email_campaigns SET
      name = COALESCE(?, name),
      require_inspection = COALESCE(?, require_inspection),
      tone = COALESCE(?, tone),
      length = COALESCE(?, length),
      language = COALESCE(?, language),
      cta = COALESCE(?, cta),
      meeting = COALESCE(?, meeting),
      meeting_link = ?,
      ai_provider = COALESCE(?, ai_provider),
      max_per_day = COALESCE(?, max_per_day),
      min_gap_minutes = COALESCE(?, min_gap_minutes),
      max_gap_minutes = COALESCE(?, max_gap_minutes)
     WHERE id = ?`
  ).run(
    name !== undefined ? name.trim() : null,
    requireInspection !== undefined ? (requireInspection ? 1 : 0) : null,
    tone ?? null,
    length ?? null,
    language ?? null,
    cta !== undefined ? (cta ? 1 : 0) : null,
    meeting !== undefined ? (meeting ? 1 : 0) : null,
    meetingLink !== undefined ? meetingLink || null : req.campaign.meeting_link,
    aiProvider !== undefined ? aiProvider : null,
    maxPerDay !== undefined ? Math.min(maxPerDay, 100) : null,
    minGapMinutes ?? null,
    maxGapMinutes ?? null,
    req.campaign.id
  );

  const updated = db.prepare("SELECT * FROM email_campaigns WHERE id = ?").get(req.campaign.id);
  res.json({ ok: true, campaign: updated });
});

// DELETE /api/campaigns/:id - fully removes the campaign and its per-lead
// queue (cascades via the foreign key). Tracked emails already sent are
// untouched - they remain visible in Tracking/History regardless, since
// deleting the campaign shouldn't erase evidence of what was actually sent.
router.delete("/:id", requireOwnedCampaign, (req, res) => {
  db.prepare("DELETE FROM email_campaigns WHERE id = ?").run(req.campaign.id);
  res.json({ ok: true });
});

module.exports = router;
