const express = require("express");
const db = require("../db");
const asyncHandler = require("../asyncHandler");
const { buildCatchLogCsv, buildCatchLogPdf, buildNicheXlsx, buildExportFilename } = require("../export");
const apiKeys = require("../apiKeys");
const { buildLeadsQuery, SORT_COLUMNS } = require("../leadsQuery");

const router = express.Router();

function rowToLead(row) {
  return {
    ...row,
    needs: row.needs ? JSON.parse(row.needs) : [],
    socials: row.socials ? JSON.parse(row.socials) : {},
  };
}

// GET /api/leads?status=&need=&search=&catchLogId=&nicheId=&page=&pageSize=&sortBy=&sortDir=
router.get("/", (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 50, 1), 200);
  const { baseQuery, params, sortBy, direction } = buildLeadsQuery(req.session.userId, req.query);

  const total = db.prepare(`SELECT COUNT(*) AS c ${baseQuery}`).get(...params).c;

  const offset = (page - 1) * pageSize;
  const rows = db
    .prepare(
      `SELECT l.*, cl.name AS city_name, n.name AS niche_name,
              EXISTS(SELECT 1 FROM business_analysis ba WHERE ba.lead_id = l.id AND ba.status = 'done') AS has_analysis,
              EXISTS(SELECT 1 FROM outreach_content oc WHERE oc.lead_id = l.id) AS has_content
       ${baseQuery} ORDER BY ${SORT_COLUMNS[sortBy]} ${direction} LIMIT ? OFFSET ?`
    )
    .all(...params, pageSize, offset);

  res.json({
    leads: rows.map(rowToLead),
    total,
    page,
    pageSize,
    totalPages: Math.max(Math.ceil(total / pageSize), 1),
  });
});

// GET /api/leads/export/:format(csv|xlsx|pdf) - same filters as above, no pagination
router.get("/export/:format", (req, res) => {
  const { format } = req.params;
  if (!["csv", "xlsx", "pdf"].includes(format)) {
    return res.status(400).json({ error: "format must be csv, xlsx, or pdf" });
  }

  const { baseQuery, params, sortBy, direction } = buildLeadsQuery(req.session.userId, req.query);
  const rows = db
    .prepare(`SELECT l.*, cl.name AS city_name, n.name AS niche_name ${baseQuery} ORDER BY ${SORT_COLUMNS[sortBy]} ${direction}`)
    .all(...params);
  const leads = rows.map(rowToLead);

  const title = "Current View";
  // Resolve actual names when the view is scoped to a specific niche/city,
  // so the filename is meaningful rather than always just "current-view".
  let filenameNiche = null;
  let filenameCity = null;
  if (req.query.catchLogId) {
    const row = db
      .prepare(
        `SELECT cl.name AS city_name, n.name AS niche_name FROM catch_logs cl
         JOIN niches n ON n.id = cl.niche_id
         WHERE cl.id = ? AND n.user_id = ?`
      )
      .get(req.query.catchLogId, req.session.userId);
    if (row) {
      filenameNiche = row.niche_name;
      filenameCity = row.city_name;
    }
  } else if (req.query.nicheId) {
    const row = db.prepare("SELECT name FROM niches WHERE id = ? AND user_id = ?").get(req.query.nicheId, req.session.userId);
    if (row) filenameNiche = row.name;
  }
  const filename = buildExportFilename({ niche: filenameNiche || "AllNiches", city: filenameCity });

  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}.csv"`);
    return res.send(buildCatchLogCsv(title, leads));
  }

  if (format === "pdf") {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}.pdf"`);
    const doc = buildCatchLogPdf(title, leads);
    return doc.pipe(res);
  }

  // xlsx
  buildNicheXlsx(title, [{ name: title, leads }]).then((buffer) => {
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}.xlsx"`);
    res.send(buffer);
  });
});

// Verifies a lead belongs (via catch_log -> niche) to this user before any
// write - without this, PATCH/DELETE by numeric ID would let any logged-in
// user touch any other user's leads.
function getOwnedLead(userId, leadId) {
  return db
    .prepare(
      `SELECT l.* FROM leads l
       JOIN catch_logs cl ON cl.id = l.catch_log_id
       JOIN niches n ON n.id = cl.niche_id
       WHERE l.id = ? AND n.user_id = ?`
    )
    .get(leadId, userId);
}

// PATCH /api/leads/:id  { status?, notes? }
router.patch("/:id", (req, res) => {
  const { id } = req.params;
  const { status, notes, pinned, ownerName } = req.body;

  const existing = getOwnedLead(req.session.userId, id);
  if (!existing) return res.status(404).json({ error: "Lead not found" });

  const newStatus = status !== undefined ? status : existing.status;
  const newNotes = notes !== undefined ? notes : existing.notes;
  const newPinned = pinned !== undefined ? (pinned ? 1 : 0) : existing.pinned;
  const newOwnerName = ownerName !== undefined ? ownerName : existing.owner_name;

  db.prepare("UPDATE leads SET status = ?, notes = ?, pinned = ?, owner_name = ? WHERE id = ?").run(newStatus, newNotes, newPinned, newOwnerName, id);
  res.json(rowToLead(db.prepare("SELECT * FROM leads WHERE id = ?").get(id)));
});

// DELETE /api/leads/:id
router.delete("/:id", (req, res) => {
  const existing = getOwnedLead(req.session.userId, req.params.id);
  if (!existing) return res.status(404).json({ error: "Lead not found" });

  db.prepare("DELETE FROM leads WHERE id = ?").run(req.params.id);
  res.json({ deleted: true });
});

// ---------- Business deep-analysis ("Inspect") ----------
const analysisJobs = require("../analysisJobs");

function getOwnedLeadWithContext(userId, leadId) {
  return db
    .prepare(
      `SELECT l.*, cl.name AS city_name, n.name AS niche_name FROM leads l
       JOIN catch_logs cl ON cl.id = l.catch_log_id
       JOIN niches n ON n.id = cl.niche_id
       WHERE l.id = ? AND n.user_id = ?`
    )
    .get(leadId, userId);
}

// POST /api/leads/:id/inspect/start
router.post("/:id/inspect/start", (req, res) => {
  const lead = getOwnedLeadWithContext(req.session.userId, req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });

  let aiProvider = req.body?.aiProvider;
  if (!aiProvider) {
    const userRow = db.prepare("SELECT preferred_inspection_provider FROM users WHERE id = ?").get(req.session.userId);
    aiProvider = userRow?.preferred_inspection_provider || undefined;
  }

  const result = analysisJobs.startAnalysis(req.session.userId, lead, aiProvider);
  if (result.alreadyRunning) {
    return res.status(409).json({ error: "An inspection is already running for this lead." });
  }
  res.json({ ok: true });
});

// GET /api/leads/:id/inspect/status
router.get("/:id/inspect/status", (req, res) => {
  const lead = getOwnedLead(req.session.userId, req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });

  const analysis = analysisJobs.getAnalysis(Number(req.params.id));
  res.json(analysis || { leadId: Number(req.params.id), status: "pending" });
});

// POST /api/leads/:id/inspect/stop
router.post("/:id/inspect/stop", (req, res) => {
  const lead = getOwnedLead(req.session.userId, req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });

  const stopped = analysisJobs.stopAnalysis(Number(req.params.id));
  res.json({ ok: true, stopped });
});

// ---------- Outreach content generation (async job - generates all
// platforms in the background, mirroring the Inspect job pattern) ----------
const { generateOutreachContent, TONES, LENGTHS, PLATFORM_LIST } = require("../outreachContent");
const contentJobs = require("../contentGenerationJobs");
const siteJobs = require("../siteGenerationJobs");
const { COLOR_PRESETS, DESIGN_STYLES } = require("../websiteGenerator");

// GET /api/leads/:id/outreach-content -> everything already generated+saved for this lead
router.get("/:id/outreach-content", (req, res) => {
  const lead = getOwnedLead(req.session.userId, req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });

  const rows = db
    .prepare("SELECT platform, tone, length, content, subject, provider, language, generated_at FROM outreach_content WHERE lead_id = ?")
    .all(req.params.id);
  res.json({ tones: TONES, lengths: LENGTHS, platforms: PLATFORM_LIST, content: rows });
});

// POST /api/leads/:id/generate-content/start { tone, length, platforms? }
// platforms is optional - omit it to generate all 6 at once (the normal
// "Generate Content" button flow), or pass a single-item array to
// regenerate just one platform.
// POST /api/leads/:id/regenerate-subject { language?, aiProvider? } -> only
// regenerates the email subject, using the already-saved body as context
router.post("/:id/regenerate-subject", async (req, res) => {
  const lead = getOwnedLeadWithContext(req.session.userId, req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });

  const { language, aiProvider } = req.body || {};
  const targetLanguage = language || "English";

  const row = db
    .prepare("SELECT content, tone FROM outreach_content WHERE lead_id = ? AND platform = 'email' AND language = ?")
    .get(req.params.id, targetLanguage);
  if (!row) return res.status(404).json({ error: "Generate the email body first, then regenerate the subject." });

  const { generateSubjectOnly } = require("../outreachContent");
  const result = await generateSubjectOnly(req.session.userId, { lead, tone: row.tone || "", language: targetLanguage, body: row.content, aiProvider });
  if (!result.ok) return res.status(502).json({ error: result.error });

  db.prepare("UPDATE outreach_content SET subject = ? WHERE lead_id = ? AND platform = 'email' AND language = ?").run(result.subject, req.params.id, targetLanguage);
  res.json({ ok: true, subject: result.subject });
});

router.post("/:id/generate-content/start", (req, res) => {
  const lead = getOwnedLeadWithContext(req.session.userId, req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });

  const { tone, length, platforms, language, aiProvider, cta, meeting, meetingLink, website, websiteLink } = req.body || {};
  if (!tone) return res.status(400).json({ error: "tone is required" });

  const analysis = analysisJobs.getAnalysis(Number(req.params.id));
  const result = contentJobs.startGeneration(req.session.userId, lead, {
    tone,
    length,
    analysis,
    platforms,
    language,
    aiProvider,
    cta,
    meeting,
    meetingLink,
    website,
    websiteLink,
  });
  if (result.alreadyRunning) {
    return res.status(409).json({ error: "Content generation is already running for this lead." });
  }
  res.json({ ok: true });
});

// GET /api/leads/:id/generate-content/status
router.get("/:id/generate-content/status", (req, res) => {
  const lead = getOwnedLead(req.session.userId, req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });

  const job = contentJobs.getJob(Number(req.params.id));
  res.json(job || { leadId: Number(req.params.id), status: "pending", completedPlatforms: [], failedPlatforms: {} });
});

// POST /api/leads/:id/generate-content/stop
router.post("/:id/generate-content/stop", (req, res) => {
  const lead = getOwnedLead(req.session.userId, req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });

  const stopped = contentJobs.stopGeneration(Number(req.params.id));
  res.json({ ok: true, stopped });
});

// DELETE /api/leads/:id/outreach-content/:platform -> clear one platform's
// saved content. Generated content is otherwise permanent - it's never
// cleared automatically, only by an explicit delete or a fresh regenerate.
router.delete("/:id/outreach-content/:platform", (req, res) => {
  const lead = getOwnedLead(req.session.userId, req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });

  if (req.query.language) {
    db.prepare("DELETE FROM outreach_content WHERE lead_id = ? AND platform = ? AND language = ?").run(req.params.id, req.params.platform, req.query.language);
  } else {
    db.prepare("DELETE FROM outreach_content WHERE lead_id = ? AND platform = ?").run(req.params.id, req.params.platform);
  }
  res.json({ ok: true });
});

// DELETE /api/leads/:id/outreach-content -> clear ALL saved content for this lead
router.delete("/:id/outreach-content", (req, res) => {
  const lead = getOwnedLead(req.session.userId, req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });

  db.prepare("DELETE FROM outreach_content WHERE lead_id = ?").run(req.params.id);
  res.json({ ok: true });
});

// GET /api/leads/pinned/list -> every pinned lead this user has, with niche
// and city names attached so the frontend can group them into a
// Niche -> City -> Leads tree, same shape as Hunt's sidebar.
router.get("/pinned/list", (req, res) => {
  const rows = db
    .prepare(
      `SELECT l.*, cl.id AS catch_log_id, cl.name AS city_name, n.id AS niche_id, n.name AS niche_name,
              EXISTS(SELECT 1 FROM business_analysis ba WHERE ba.lead_id = l.id AND ba.status = 'done') AS has_analysis,
              EXISTS(SELECT 1 FROM outreach_content oc WHERE oc.lead_id = l.id) AS has_content
       FROM leads l
       JOIN catch_logs cl ON cl.id = l.catch_log_id
       JOIN niches n ON n.id = cl.niche_id
       WHERE n.user_id = ? AND l.pinned = 1
       ORDER BY n.name COLLATE NOCASE, cl.name COLLATE NOCASE, l.name COLLATE NOCASE`
    )
    .all(req.session.userId);
  res.json(rows.map(rowToLead));
});

// POST /api/leads/:id/generate-website/start { niche, city, businessName, designStyle, colorPreset, useVisuals }
router.post("/:id/generate-website/start", (req, res) => {
  const lead = getOwnedLeadWithContext(req.session.userId, req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });

  const { niche, city, businessName, designStyle, colorPreset, services, ctaGoal } = req.body || {};
  if (!businessName || !businessName.trim()) return res.status(400).json({ error: "Business name is required" });

  const analysis = analysisJobs.getAnalysis(Number(req.params.id));
  const strengths = analysis?.strengths?.length ? analysis.strengths.join("; ") : null;

  let parsedSocials = null;
  try {
    parsedSocials = lead.socials ? JSON.parse(lead.socials) : null;
  } catch {
    parsedSocials = null;
  }

  const { siteId, slug } = siteJobs.startSiteGeneration(req.session.userId, {
    leadId: lead.id,
    niche: niche || lead.niche_name || "local business",
    city: city || lead.city_name || "",
    businessName: businessName.trim(),
    designStyle,
    colorPreset,
    services: services || null,
    ctaGoal: ctaGoal || null,
    phone: lead.phone || null,
    address: lead.address || null,
    socials: parsedSocials,
    strengths,
  });

  res.json({ ok: true, siteId, slug });
});

// GET /api/leads/generate-website/status/:siteId
router.get("/generate-website/status/:siteId", (req, res) => {
  const status = siteJobs.getSiteStatus(Number(req.params.siteId));
  if (!status) return res.status(404).json({ error: "Not found" });
  res.json(status);
});

// POST /api/leads/generate-website/stop/:siteId
router.post("/generate-website/stop/:siteId", (req, res) => {
  siteJobs.stopSiteGeneration(Number(req.params.siteId));
  res.json({ ok: true });
});

// GET /api/leads/:id/generated-sites -> every site ever generated for this
// lead, most recent first, so reopening the panel shows past sites too
router.get("/:id/generated-sites", (req, res) => {
  const lead = getOwnedLead(req.session.userId, req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });

  const rows = db
    .prepare(
      `SELECT id, slug, design_style, color_preset, status, current_step, error, created_at
       FROM generated_sites WHERE lead_id = ? AND user_id = ? ORDER BY created_at DESC`
    )
    .all(req.params.id, req.session.userId);
  res.json(rows);
});

// DELETE /api/leads/generated-sites/:siteId
router.delete("/generated-sites/:siteId", (req, res) => {
  const row = db.prepare("SELECT id FROM generated_sites WHERE id = ? AND user_id = ?").get(req.params.siteId, req.session.userId);
  if (!row) return res.status(404).json({ error: "Not found" });
  db.prepare("DELETE FROM generated_sites WHERE id = ?").run(req.params.siteId);
  res.json({ ok: true });
});

// GET /api/leads/:id - full lead detail, needed anywhere a lead's expand
// panel is rendered outside the main board (which already has leads
// preloaded in memory from its own list fetch). Deliberately placed last
// among GET routes - a bare /:id wildcard would otherwise shadow every
// more specific route above it (e.g. /pinned/list, /export/:format),
// since Express matches in definition order.
router.get("/:id", (req, res) => {
  const lead = getOwnedLeadWithContext(req.session.userId, req.params.id);
  if (!lead) return res.status(404).json({ error: "Lead not found" });
  res.json(lead);
});

module.exports = router;
