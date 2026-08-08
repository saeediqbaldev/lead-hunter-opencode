// Thin client for Google's Gemini API (generativelanguage.googleapis.com).
// Used for: the business deep-analysis writeup (strengths/weaknesses/
// suggested services) and the outreach content generator. Both are plain
// text-generation calls - no need for a heavier SDK dependency for this.
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
// Default stays conservative for short calls (business-analysis writeup,
// short copy). Every caller of generateText already runs inside an async
// job runner (Inspect, content generation, website generation all poll
// for progress rather than blocking the browser-facing request), so a
// longer timeout no longer risks the reverse-proxy timeout that motivated
// keeping this short originally - callers needing more time (a full HTML
// page can genuinely take 30-90s to generate) pass their own timeoutMs.
const DEFAULT_TIMEOUT_MS = 20000;

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    console.log(`[gemini] request completed in ${Date.now() - startedAt}ms (status ${res.status})`);
    return res;
  } catch (err) {
    console.log(`[gemini] request failed after ${Date.now() - startedAt}ms: ${err.name} - ${err.message}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// GET /v1beta/models is a free, lightweight call (lists available models)
// - good enough to validate a key actually works without spending any real
// generation quota, mirroring how testApiKey works for Google Places.
async function testApiKey(apiKey) {
  if (!apiKey || !apiKey.trim()) {
    return { ok: false, error: "Enter an API key first." };
  }
  try {
    const res = await fetchWithTimeout(`${GEMINI_BASE}/models`, {
      headers: { "x-goog-api-key": apiKey.trim() },
    });
    if (res.ok) return { ok: true };

    const errText = await res.text();
    let message = `Google rejected the key (HTTP ${res.status}).`;
    try {
      const parsed = JSON.parse(errText);
      if (parsed.error && parsed.error.message) message = parsed.error.message;
    } catch {
      // keep the generic message above
    }
    return { ok: false, error: message };
  } catch (err) {
    const timedOut = err.name === "AbortError";
    return { ok: false, error: timedOut ? "Timed out waiting for Google's servers." : `Could not reach Google's servers: ${err.message}` };
  }
}

// Generates plain text from a prompt. Returns { ok, text, error }.
// responseSchema (optional) requests structured JSON output directly from
// the model instead of us having to parse free-form text.
async function generateText(apiKey, prompt, { responseSchema, timeoutMs, maxOutputTokens } = {}) {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    // Same reasoning as the OpenAI-compatible client's default - 2000 is
    // generous for short content while callers that genuinely need more
    // (website generation) pass their own larger explicit value.
    generationConfig: { maxOutputTokens: maxOutputTokens || 2000 },
  };
  if (responseSchema) {
    body.generationConfig.responseMimeType = "application/json";
    body.generationConfig.responseSchema = responseSchema;
  }

  try {
    const res = await fetchWithTimeout(
      `${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
      },
      timeoutMs || DEFAULT_TIMEOUT_MS
    );

    if (!res.ok) {
      const errText = await res.text();
      let message = `Gemini returned HTTP ${res.status}.`;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.error && parsed.error.message) message = parsed.error.message;
        if (res.status === 429 || parsed.error?.status === "RESOURCE_EXHAUSTED") {
          const retryMatch = message.match(/retry in ([\d.]+)s/i);
          const waitSeconds = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) : null;
          message = `You've hit your Gemini free-tier quota${waitSeconds ? ` - try again in about ${waitSeconds} seconds` : ""}. Free-tier limits reset daily and can be as low as 20 requests/day depending on your account - check current limits at ai.google.dev/gemini-api/docs/rate-limits, or add billing to raise them.`;
        }
      } catch {
        // keep generic message
      }
      return { ok: false, error: message };
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) return { ok: false, error: "Gemini returned an empty response." };
    return { ok: true, text };
  } catch (err) {
    const timedOut = err.name === "AbortError";
    return { ok: false, error: timedOut ? "Gemini took too long to respond - try again, or try a shorter length setting." : `Could not reach Gemini: ${err.message}` };
  }
}

module.exports = { testApiKey, generateText, GEMINI_MODEL };
