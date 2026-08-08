const nodemailer = require("nodemailer");
const MailComposer = require("nodemailer/lib/mail-composer");
const { ImapFlow } = require("imapflow");
const db = require("./db");

// Hostinger's IMAP host is fixed/well-known (confirmed by the user) -
// only the SMTP credentials need to be supplied, since Hostinger uses the
// same login for both SMTP and IMAP.
const HOSTINGER_IMAP_HOST = "imap.hostinger.com";
const HOSTINGER_IMAP_PORT = 993;

function resolveSmtpConfig(userId) {
  const row = db
    .prepare("SELECT tracker_smtp_host, tracker_smtp_port, tracker_smtp_user, tracker_smtp_pass, tracker_smtp_from FROM users WHERE id = ?")
    .get(userId);
  if (!row || !row.tracker_smtp_host || !row.tracker_smtp_user || !row.tracker_smtp_pass) return null;
  return {
    host: row.tracker_smtp_host,
    port: row.tracker_smtp_port || 465,
    user: row.tracker_smtp_user,
    pass: row.tracker_smtp_pass,
    from: row.tracker_smtp_from || row.tracker_smtp_user,
  };
}

function buildRawMessage({ from, to, subject, html }) {
  return new Promise((resolve, reject) => {
    const composer = new MailComposer({ from, to, subject, html });
    composer.compile().build((err, message) => {
      if (err) return reject(err);
      resolve(message);
    });
  });
}

// Sends one campaign email: builds a single raw MIME buffer, sends it via
// SMTP, then appends that exact same buffer to the Hostinger "Sent" IMAP
// folder so it shows up in the mailbox exactly as if sent normally from
// Hostinger Webmail. IMAP append failure is logged but doesn't fail the
// send itself - the email genuinely was sent and tracked either way, a
// missing Sent-folder copy is a lesser problem than silently not sending.
async function sendCampaignEmail(userId, { to, subject, html }) {
  const cfg = resolveSmtpConfig(userId);
  if (!cfg) {
    return { ok: false, error: "SMTP isn't fully configured yet - set it up on the Hostinger Setup page first." };
  }

  const raw = await buildRawMessage({ from: cfg.from, to, subject, html });

  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });

  try {
    await transport.sendMail({ raw, envelope: { from: cfg.from, to } });
  } catch (err) {
    return { ok: false, error: `SMTP send failed: ${err.message}` };
  }

  try {
    await appendToSentFolder(cfg, raw);
  } catch (err) {
    console.error(`[campaign-sender] Sent via SMTP OK, but IMAP append to Sent folder failed for user ${userId}:`, err.message);
  }

  return { ok: true };
}

async function appendToSentFolder(cfg, raw) {
  const client = new ImapFlow({
    host: HOSTINGER_IMAP_HOST,
    port: HOSTINGER_IMAP_PORT,
    secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  });
  await client.connect();
  try {
    // Hostinger's Sent folder is conventionally named "Sent" - fall back
    // to trying the common IMAP special-use alternative if that exact
    // name isn't present, rather than silently doing nothing.
    const mailboxes = await client.list();
    const sentBox = mailboxes.find((m) => m.path === "Sent" || m.specialUse === "\\Sent") || mailboxes.find((m) => /sent/i.test(m.path));
    if (!sentBox) throw new Error("Could not find a Sent folder on this account");
    await client.append(sentBox.path, raw, ["\\Seen"]);
  } finally {
    await client.logout().catch(() => {});
  }
}

// Used by campaign creation to fail fast with a clear message rather than
// silently queuing a campaign that will fail on its very first send.
function hasSmtpConfigured(userId) {
  return !!resolveSmtpConfig(userId);
}

module.exports = { sendCampaignEmail, hasSmtpConfigured, resolveSmtpConfig };
