const crypto = require("crypto");
const db = require("./db");
const analysisJobs = require("./analysisJobs");
const { isValidEmailAddress } = require("./emailValidation");
const { generateOutreachContent } = require("./outreachContent");
const { buildTrackedHtmlEmail } = require("./campaignEmailBuilder");
const { sendCampaignEmail, resolveSmtpConfig } = require("./campaignSender");
const { getSetting } = require("./settingsStore");

const TICK_INTERVAL_MS = 60000; // check every minute whether any campaign is due to send
const INSPECTION_TIMEOUT_MS = 120000; // give a single inspection up to 2 minutes before giving up

// campaignId -> true while a tick is actively processing that campaign -
// prevents two overlapping ticks from both trying to send for the same
// campaign if one send takes longer than the tick interval.
const busyCampaigns = new Set();

function randomGapMs(minMinutes, maxMinutes) {
  const minMs = minMinutes * 60000;
  const maxMs = maxMinutes * 60000;
  return Math.floor(minMs + Math.random() * (maxMs - minMs));
}

function notifyUser(userId, { type, title, message, link }) {
  try {
    db.prepare("INSERT INTO app_notifications (user_id, type, title, message, link) VALUES (?, ?, ?, ?, ?)").run(userId, type, title, message, link || null);
  } catch (err) {
    console.error(`[campaign] Failed to persist notification for user ${userId}:`, err.message);
  }
  console.log(`[campaign] Notice for user ${userId}: ${title} - ${message}`);
}

function countSentToday(campaignId) {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM email_campaign_leads WHERE campaign_id = ? AND status = 'sent' AND date(sent_at) = date('now')`)
    .get(campaignId);
  return row.c;
}

async function waitForInspection(userId, lead, aiProvider) {
  const existing = analysisJobs.getAnalysis(lead.id);
  if (existing && existing.status === "done") return existing;

  if (!existing || (existing.status !== "running" && existing.status !== "pending")) {
    analysisJobs.startAnalysis(userId, lead, aiProvider);
  }

  const start = Date.now();
  while (Date.now() - start < INSPECTION_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 3000));
    const check = analysisJobs.getAnalysis(lead.id);
    if (check && check.status === "done") return check;
    if (check && check.status === "failed") throw new Error(`Inspection failed: ${check.error || "unknown error"}`);
  }
  throw new Error("Inspection timed out");
}

async function processCampaignLead(campaign, campaignLeadRow) {
  const lead = db
    .prepare(
      `SELECT l.*, cl.name AS city_name, n.name AS niche_name FROM leads l
       JOIN catch_logs cl ON cl.id = l.catch_log_id JOIN niches n ON n.id = cl.niche_id
       WHERE l.id = ?`
    )
    .get(campaignLeadRow.lead_id);

  if (!lead) {
    db.prepare("UPDATE email_campaign_leads SET status = 'skipped', error = ? WHERE id = ?").run("Lead no longer exists", campaignLeadRow.id);
    return { ok: true, skipped: true };
  }

  let socials = {};
  try {
    socials = JSON.parse(lead.socials || "{}");
  } catch {
    socials = {};
  }
  if (!isValidEmailAddress(socials.email)) {
    db.prepare("UPDATE email_campaign_leads SET status = 'skipped', error = ? WHERE id = ?").run(
      socials.email ? `Malformed email address on file: "${socials.email}"` : "No email address on file for this lead",
      campaignLeadRow.id
    );
    return { ok: true, skipped: true };
  }

  // Resolve which AI provider to use: an explicit campaign-level choice
  // wins, otherwise fall back to whatever the user has saved as their
  // default for each step (content vs inspection can differ), otherwise
  // Auto (the normal fallback chain).
  const userProviderPrefs = db
    .prepare("SELECT preferred_content_provider, preferred_inspection_provider FROM users WHERE id = ?")
    .get(campaign.user_id);
  const inspectionProvider = campaign.ai_provider || userProviderPrefs?.preferred_inspection_provider || undefined;
  const contentProvider = campaign.ai_provider || userProviderPrefs?.preferred_content_provider || undefined;

  // Step 1: inspect first, if requested and not already done
  let analysis = null;
  if (campaign.require_inspection) {
    db.prepare("UPDATE email_campaign_leads SET status = 'inspecting' WHERE id = ?").run(campaignLeadRow.id);
    analysis = await waitForInspection(campaign.user_id, lead, inspectionProvider);
  } else {
    analysis = analysisJobs.getAnalysis(lead.id);
  }

  // Step 2: generate the email content
  db.prepare("UPDATE email_campaign_leads SET status = 'generating' WHERE id = ?").run(campaignLeadRow.id);
  const userRow = db.prepare("SELECT signature FROM users WHERE id = ?").get(campaign.user_id);
  const genResult = await generateOutreachContent(campaign.user_id, {
    lead,
    platform: "email",
    tone: campaign.tone,
    length: campaign.length,
    analysis,
    signature: userRow?.signature,
    language: campaign.language || "English",
    cta: !!campaign.cta,
    meeting: !!campaign.meeting,
    meetingLink: campaign.meeting_link,
    aiProvider: contentProvider,
  });
  if (!genResult.ok) throw new Error(`Content generation failed: ${genResult.error}`);

  // Persist to outreach_content too, not just the sent email - this is
  // what the lead's own "Generate Content" panel reads from, so without
  // this, content a campaign generated and sent would be invisible when
  // checked later from the lead's expand panel (it would show "not
  // generated yet" despite having actually been generated and sent).
  db.prepare(
    `INSERT INTO outreach_content (lead_id, platform, tone, length, content, subject, provider, language, generated_at) VALUES (?, 'email', ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(lead_id, platform, language) DO UPDATE SET tone = excluded.tone, length = excluded.length, content = excluded.content, subject = excluded.subject, provider = excluded.provider, generated_at = excluded.generated_at`
  ).run(lead.id, campaign.tone, campaign.length || null, genResult.content, genResult.subject || null, genResult.provider || null, campaign.language || "English");

  // Step 3: create the tracked_email record (same table/mechanism the
  // extension's create-email call uses, just invoked directly in-process
  // instead of over HTTP with an API key)
  const smtpCfg = resolveSmtpConfig(campaign.user_id);
  const trackedId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO tracked_emails (id, user_id, subject, recipients, sender, provider, status) VALUES (?, ?, ?, ?, ?, 'hostinger', 'sent')`
  ).run(trackedId, campaign.user_id, genResult.subject || "", JSON.stringify([socials.email]), smtpCfg?.from || null);

  // Step 4: build the tracked HTML and send
  const baseUrl = getSetting("app_base_url") || "http://localhost:3000";
  const html = buildTrackedHtmlEmail({
    bodyText: genResult.content,
    signatureHtml: genResult.signatureHtml,
    pixelUrl: `${baseUrl}/t/${trackedId}/pixel.png`,
    clickBaseUrl: `${baseUrl}/t/${trackedId}/click`,
  });

  db.prepare("UPDATE email_campaign_leads SET status = 'sending' WHERE id = ?").run(campaignLeadRow.id);
  const sendResult = await sendCampaignEmail(campaign.user_id, { to: socials.email, subject: genResult.subject || "A quick idea for your business", html });
  if (!sendResult.ok) {
    db.prepare("DELETE FROM tracked_emails WHERE id = ?").run(trackedId); // never sent - don't leave a phantom tracked row
    throw new Error(sendResult.error);
  }

  db.prepare("UPDATE tracked_emails SET body_html = ? WHERE id = ?").run(html, trackedId);
  db.prepare("UPDATE email_campaign_leads SET status = 'sent', tracked_email_id = ?, sent_at = datetime('now') WHERE id = ?").run(trackedId, campaignLeadRow.id);
  db.prepare("UPDATE leads SET status = 'contacted' WHERE id = ? AND status IN ('new', 'shortlisted')").run(lead.id);
  return { ok: true, skipped: false };
}

async function tick() {
  const campaigns = db.prepare("SELECT * FROM email_campaigns WHERE status = 'running'").all();

  for (const campaign of campaigns) {
    if (busyCampaigns.has(campaign.id)) continue;

    if (countSentToday(campaign.id) >= campaign.max_per_day) continue; // today's cap reached, try again tomorrow

    const lastSent = db
      .prepare("SELECT sent_at FROM email_campaign_leads WHERE campaign_id = ? AND status = 'sent' ORDER BY sent_at DESC LIMIT 1")
      .get(campaign.id);
    if (lastSent) {
      const elapsedMs = Date.now() - new Date(lastSent.sent_at.replace(" ", "T") + "Z").getTime();
      // Re-roll a fresh random gap each tick rather than storing a fixed
      // "next send time" - simpler, and statistically equivalent since
      // ticks run every minute anyway.
      if (elapsedMs < campaign.min_gap_minutes * 60000) continue;
      if (elapsedMs < randomGapMs(campaign.min_gap_minutes, campaign.max_gap_minutes)) continue;
    }

    const nextLead = db
      .prepare("SELECT * FROM email_campaign_leads WHERE campaign_id = ? AND status = 'pending' ORDER BY id ASC LIMIT 1")
      .get(campaign.id);

    if (!nextLead) {
      db.prepare("UPDATE email_campaigns SET status = 'completed', completed_at = datetime('now') WHERE id = ?").run(campaign.id);
      notifyUser(campaign.user_id, {
        type: "campaign_completed",
        title: "Campaign finished",
        message: `"${campaign.name}" - every lead has been processed.`,
        link: `campaign:${campaign.id}`,
      });
      continue;
    }

    busyCampaigns.add(campaign.id);
    try {
      await processCampaignLead(campaign, nextLead);
    } catch (err) {
      db.prepare("UPDATE email_campaign_leads SET status = 'failed', error = ? WHERE id = ?").run(err.message, nextLead.id);
      db.prepare("UPDATE email_campaigns SET status = 'paused', paused_at = datetime('now'), pause_reason = ? WHERE id = ?").run(err.message, campaign.id);
      notifyUser(campaign.user_id, {
        type: "campaign_paused",
        title: "Campaign paused",
        message: `"${campaign.name}" - ${err.message}`,
        link: `campaign:${campaign.id}`,
      });
    } finally {
      busyCampaigns.delete(campaign.id);
    }
  }
}

let tickTimer = null;
function startScheduler() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    tick().catch((err) => console.error("[campaign-scheduler] Tick failed:", err));
  }, TICK_INTERVAL_MS);
}

module.exports = { startScheduler, tick };
