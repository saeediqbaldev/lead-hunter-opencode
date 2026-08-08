// Runs the business deep-analysis pipeline as a background job with live
// progress, mirroring the pattern already proven by the contact-scraper
// feature (start/status/stop), but entirely in-process since every step
// here (website fetch, PageSpeed, Gemini) is a plain HTTP call Node can
// make directly - no separate microservice needed.
const db = require("./db");
const apiKeys = require("./apiKeys");
const { runWebsiteChecks, runGmbChecks, runSocialChecks, scoreFromChecks, analyzeWithAI } = require("./businessAnalysis");

const STEPS = [
  "Checking website health…",
  "Checking GMB & local SEO signals…",
  "Checking social media presence…",
  "Generating AI summary…",
  "Saving results…",
];

// leadId -> { cancelled: boolean }
const activeJobs = new Map();

function upsertAnalysisRow(leadId, fields) {
  const existing = db.prepare("SELECT lead_id FROM business_analysis WHERE lead_id = ?").get(leadId);
  const cols = Object.keys(fields);
  const values = Object.values(fields);

  if (existing) {
    const setClause = cols.map((c) => `${c} = ?`).join(", ");
    db.prepare(`UPDATE business_analysis SET ${setClause}, updated_at = datetime('now') WHERE lead_id = ?`).run(...values, leadId);
  } else {
    const allCols = ["lead_id", ...cols];
    const placeholders = allCols.map(() => "?").join(", ");
    db.prepare(`INSERT INTO business_analysis (${allCols.join(", ")}) VALUES (${placeholders})`).run(leadId, ...values);
  }
}

function getAnalysis(leadId) {
  const row = db.prepare("SELECT * FROM business_analysis WHERE lead_id = ?").get(leadId);
  if (!row) return null;
  return {
    leadId: row.lead_id,
    status: row.status,
    currentStep: row.current_step,
    overallScore: row.overall_score,
    websiteScore: row.website_score,
    gmbScore: row.gmb_score,
    socialScore: row.social_score,
    reputationScore: row.reputation_score,
    checklist: row.checklist ? JSON.parse(row.checklist) : [],
    strengths: row.strengths ? JSON.parse(row.strengths) : [],
    weaknesses: row.weaknesses ? JSON.parse(row.weaknesses) : [],
    suggestedServices: row.suggested_services ? JSON.parse(row.suggested_services) : [],
    provider: row.provider,
    error: row.error,
    updatedAt: row.updated_at,
  };
}

function isCancelled(leadId) {
  const job = activeJobs.get(leadId);
  return !job || job.cancelled;
}

async function runPipeline(userId, leadId, lead, aiProvider) {
  try {
    upsertAnalysisRow(leadId, { status: "running", current_step: STEPS[0], error: null });
    if (isCancelled(leadId)) return;

    const website = await runWebsiteChecks(lead.website);
    if (isCancelled(leadId)) return;

    upsertAnalysisRow(leadId, { current_step: STEPS[1] });
    const gmb = runGmbChecks(lead);
    if (isCancelled(leadId)) return;

    upsertAnalysisRow(leadId, { current_step: STEPS[2] });
    const social = await runSocialChecks(lead.socials ? JSON.parse(lead.socials) : {});
    if (isCancelled(leadId)) return;

    const reputation = { checks: gmb.checks.filter((c) => c.label.includes("rating") || c.label.includes("Review")), score: null };
    reputation.score = scoreFromChecks(reputation.checks.length ? reputation.checks : gmb.checks);

    const overallScore = Math.round((website.score + gmb.score + social.score + reputation.score) / 4);

    upsertAnalysisRow(leadId, {
      current_step: STEPS[3],
      website_score: website.score,
      gmb_score: gmb.score,
      social_score: social.score,
      reputation_score: reputation.score,
      overall_score: overallScore,
      checklist: JSON.stringify([...website.checks, ...gmb.checks, ...social.checks]),
    });
    if (isCancelled(leadId)) return;

    // AI writeup - only runs if at least one AI provider key is configured;
    // otherwise the checklist/scores are still saved and useful on their
    // own. Uses the fallback chain (Groq -> Gemini -> DeepSeek), so a
    // single provider being rate-limited or down doesn't skip this step
    // entirely if another provider is available.
    const aiResult = await analyzeWithAI(userId, lead, { website, gmb, social }, aiProvider);
    if (isCancelled(leadId)) return;

    upsertAnalysisRow(leadId, {
      strengths: JSON.stringify(aiResult.ok ? aiResult.strengths : []),
      weaknesses: JSON.stringify(aiResult.ok ? aiResult.weaknesses : []),
      suggested_services: JSON.stringify(aiResult.ok ? aiResult.suggestedServices : []),
      raw_data: JSON.stringify({ aiError: aiResult.ok ? null : aiResult.error }),
      provider: aiResult.ok ? aiResult.provider : null,
      status: "done",
      current_step: null,
    });
  } catch (err) {
    upsertAnalysisRow(leadId, { status: "failed", error: err.message, current_step: null });
  } finally {
    activeJobs.delete(leadId);
  }
}

function startAnalysis(userId, lead, aiProvider) {
  const leadId = lead.id;
  if (activeJobs.has(leadId)) return { alreadyRunning: true };

  activeJobs.set(leadId, { cancelled: false });
  runPipeline(userId, leadId, lead, aiProvider); // fire and forget - progress is polled via getAnalysis()
  return { alreadyRunning: false };
}

function stopAnalysis(leadId) {
  const job = activeJobs.get(leadId);
  if (!job) return false;
  job.cancelled = true;
  upsertAnalysisRow(leadId, { status: "stopped", current_step: null });
  return true;
}

module.exports = { startAnalysis, stopAnalysis, getAnalysis };
