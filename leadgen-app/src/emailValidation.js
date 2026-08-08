// A practical (not full RFC-5322) email format check - good enough to
// catch the malformed addresses that actually show up in scraped data:
// missing/extra @ symbols, stray whitespace, concatenated addresses with
// no separator, HTML entities that never got decoded, and similar
// scraping artifacts. This is what "501 5.1.3 Bad recipient address
// syntax" from Hostinger's SMTP server is complaining about - it's a
// syntax check on their end, not a deliverability/reputation issue, so
// catching it before we ever hand the address to SMTP avoids the failure
// (and the campaign-wide pause it triggers) entirely.
const EMAIL_PATTERN = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

function isValidEmailAddress(email) {
  if (!email || typeof email !== "string") return false;
  const trimmed = email.trim();
  if (trimmed !== email) return false; // leading/trailing whitespace is itself a sign of a scraping artifact
  if (trimmed.length > 254) return false; // RFC 5321 practical max
  return EMAIL_PATTERN.test(trimmed);
}

module.exports = { isValidEmailAddress };
