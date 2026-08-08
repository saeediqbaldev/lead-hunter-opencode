const nodemailer = require("nodemailer");
const db = require("./db");

// Resolves this user's SMTP config - unlike the original (a singleton
// settings row with an env-var fallback), every user has their own SMTP
// settings stored directly on their users row, matching this app's
// existing per-user settings pattern (signature, meeting_link, etc).
function resolveSmtpConfig(userId) {
  const row = db
    .prepare(
      `SELECT tracker_notify_email_enabled, tracker_notify_email_to,
              tracker_smtp_host, tracker_smtp_port, tracker_smtp_user, tracker_smtp_pass, tracker_smtp_from
       FROM users WHERE id = ?`
    )
    .get(userId);
  if (!row) return { enabled: false };

  return {
    enabled: !!row.tracker_notify_email_enabled,
    to: row.tracker_notify_email_to || null,
    host: row.tracker_smtp_host || null,
    port: row.tracker_smtp_port || 465,
    user: row.tracker_smtp_user || null,
    pass: row.tracker_smtp_pass || null,
    from: row.tracker_smtp_from || row.tracker_smtp_user || null,
  };
}

function buildTransporter(cfg) {
  if (!cfg.host || !cfg.user || !cfg.pass) return null;
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465, // 465 = SSL, 587 = STARTTLS
    auth: { user: cfg.user, pass: cfg.pass },
  });
}

// Sends a notification email if the feature is turned on AND SMTP is
// configured for this user. Never throws - failures are logged, not
// propagated, so a bad SMTP config can never break pixel/click tracking.
async function sendEmailNotification(userId, { subject, text, html }) {
  try {
    const cfg = resolveSmtpConfig(userId);
    if (!cfg.enabled || !cfg.to) return { ok: false, reason: "Email notifications are off" };

    const transport = buildTransporter(cfg);
    if (!transport) {
      console.warn(`[tracker-notify] Email notification skipped for user ${userId}: SMTP not fully configured.`);
      return { ok: false, reason: "SMTP not configured" };
    }

    await transport.sendMail({ from: cfg.from, to: cfg.to, subject, text, html });
    return { ok: true };
  } catch (err) {
    console.error(`[tracker-notify] Failed to send email notification for user ${userId}:`, err.message);
    return { ok: false, reason: err.message };
  }
}

// Used by the Settings page's "Send test email" button - ignores the
// enabled/disabled toggle (a test send should work while still setting
// up) but still requires a destination + working SMTP config, and
// surfaces the real error back to the caller instead of just logging it.
async function sendTestEmail(userId) {
  const cfg = resolveSmtpConfig(userId);
  if (!cfg.to) throw new Error('Set "Send notifications to" first, then save, then test.');

  const transport = buildTransporter(cfg);
  if (!transport) {
    throw new Error("SMTP host/user/password aren't fully set in Settings - fill those in first.");
  }

  await transport.sendMail({
    from: cfg.from,
    to: cfg.to,
    subject: "Xeven Leads - Contacted tracker test notification",
    text: "If you're reading this, email notifications are working correctly.",
  });
}

module.exports = { sendEmailNotification, sendTestEmail, resolveSmtpConfig };
