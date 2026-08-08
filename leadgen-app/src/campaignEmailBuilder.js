// Converts a plain-text generated email body into a tracked HTML email -
// the server-side equivalent of what the browser extension does by
// modifying the compose window's DOM before send. Same tracking model
// (invisible pixel + rewritten links through the click redirect), just
// built directly as HTML since there's no browser/compose-window involved
// in an automated send.

const URL_PATTERN = /(https?:\/\/[^\s<>")]+)/g;

// Common sentence-ending/list punctuation that a URL regex will greedily
// swallow if it happens to appear immediately after a link with no space
// (e.g. "book here: https://cal.com/you/15min." - the AI writes normal
// prose, so a trailing period is expected, not an edge case). Strips any
// of these off the END of a matched URL and returns them separately so
// they can be placed back into the surrounding text instead of the href.
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/;

function splitTrailingPunctuation(url) {
  const match = url.match(TRAILING_PUNCTUATION);
  if (!match) return { cleanUrl: url, trailing: "" };
  return { cleanUrl: url.slice(0, -match[0].length), trailing: match[0] };
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Turns plain-text body into simple HTML paragraphs, and rewrites any raw
// URL in the text into a real <a> tag pointing through the click-tracking
// redirect (so a link the AI wove into the message, e.g. a meeting link,
// gets click-tracked exactly like a link the extension would have
// rewritten in a browser compose window).
function trackSignatureLinks(signatureHtml, clickBaseUrl) {
  if (!signatureHtml) return "";
  return signatureHtml.replace(/href\s*=\s*"([^"]+)"/gi, (match, href) => {
    if (!/^https?:\/\//i.test(href)) return match; // leave mailto:/tel:/relative links untouched
    return `href="${clickBaseUrl}?url=${encodeURIComponent(href)}"`;
  });
}

function buildTrackedHtmlEmail({ bodyText, signatureHtml, pixelUrl, clickBaseUrl }) {
  const paragraphs = String(bodyText || "")
    .split(/\n{2,}/)
    .map((block) => {
      const withLineBreaks = escapeHtml(block).replace(/\n/g, "<br>");
      const withTrackedLinks = withLineBreaks.replace(URL_PATTERN, (url) => {
        const { cleanUrl, trailing } = splitTrailingPunctuation(url);
        const trackedHref = `${clickBaseUrl}?url=${encodeURIComponent(cleanUrl)}`;
        return `<a href="${trackedHref}">${cleanUrl}</a>${trailing}`;
      });
      return `<p style="margin:0 0 14px 0;">${withTrackedLinks}</p>`;
    })
    .join("\n");

  const trackedSignature = trackSignatureLinks(signatureHtml, clickBaseUrl);
  const signatureBlock = trackedSignature ? `<div style="margin-top:18px; padding-top:14px; border-top:1px solid #e0e0e0;">${trackedSignature}</div>` : "";

  return `<!DOCTYPE html>
<html>
<body style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; color: #222; line-height: 1.5; max-width: 600px;">
${paragraphs}
${signatureBlock}
<img src="${pixelUrl}" width="1" height="1" alt="" style="display:none; width:1px; height:1px; border:0;" />
</body>
</html>`;
}

module.exports = { buildTrackedHtmlEmail };
