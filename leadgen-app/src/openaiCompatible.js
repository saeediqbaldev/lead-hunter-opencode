// Shared client for any OpenAI-compatible chat completions API - Groq and
// DeepSeek both use this exact shape (only the base URL, default model, and
// auth header value differ), so one implementation serves both instead of
// duplicating the same fetch/parse/timeout logic twice.
const DEFAULT_TIMEOUT_MS = 15000;

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    console.log(`[${options.__providerLabel || "openai-compat"}] request completed in ${Date.now() - startedAt}ms (status ${res.status})`);
    return res;
  } catch (err) {
    console.log(`[${options.__providerLabel || "openai-compat"}] request failed after ${Date.now() - startedAt}ms: ${err.name} - ${err.message}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function createOpenAiCompatibleClient({ label, baseUrl, defaultModel }) {
  async function testApiKey(apiKey) {
    if (!apiKey || !apiKey.trim()) {
      return { ok: false, error: "Enter an API key first." };
    }
    try {
      const res = await fetchWithTimeout(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey.trim()}` },
        __providerLabel: label,
      });
      if (res.ok) return { ok: true };

      const errText = await res.text();
      let message = `${label} rejected the key (HTTP ${res.status}).`;
      try {
        const parsed = JSON.parse(errText);
        if (parsed.error?.message) message = parsed.error.message;
      } catch {
        // keep generic message
      }
      return { ok: false, error: message };
    } catch (err) {
      const timedOut = err.name === "AbortError";
      return { ok: false, error: timedOut ? `${label} took too long to respond.` : `Could not reach ${label}: ${err.message}` };
    }
  }

  async function generateText(apiKey, prompt, { jsonMode, timeoutMs, maxTokens } = {}) {
    const body = {
      model: defaultModel,
      messages: [{ role: "user", content: prompt }],
      // 2000 is generous for short content (a full email, a subject line,
      // a JSON-structured analysis writeup) while staying well clear of
      // Groq's free-tier 8,000 tokens-per-minute ceiling even combined
      // with prompt tokens - callers that genuinely need more (website
      // generation) pass their own larger, provider-aware value and are
      // unaffected by this default.
      max_tokens: maxTokens || 2000,
    };
    if (jsonMode) body.response_format = { type: "json_object" };

    try {
      const res = await fetchWithTimeout(
        `${baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          __providerLabel: label,
        },
        timeoutMs || DEFAULT_TIMEOUT_MS
      );

      if (!res.ok) {
        const errText = await res.text();
        let message = `${label} returned HTTP ${res.status}.`;
        try {
          const parsed = JSON.parse(errText);
          if (parsed.error?.message) message = parsed.error.message;
        } catch {
          // keep generic message
        }
        return { ok: false, error: message, httpStatus: res.status };
      }

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (!text) return { ok: false, error: `${label} returned an empty response.` };
      return { ok: true, text };
    } catch (err) {
      const timedOut = err.name === "AbortError";
      return { ok: false, error: timedOut ? `${label} took too long to respond - try again.` : `Could not reach ${label}: ${err.message}` };
    }
  }

  return { testApiKey, generateText, label };
}

const groqClient = createOpenAiCompatibleClient({
  label: "Groq",
  baseUrl: "https://api.groq.com/openai/v1",
  // llama-3.3-70b-versatile was deprecated (announced June 17, 2026, hard
  // shutdown August 16, 2026) - openai/gpt-oss-120b is Groq's official
  // recommended migration target.
  defaultModel: "openai/gpt-oss-120b",
});

const deepseekClient = createOpenAiCompatibleClient({
  label: "DeepSeek",
  baseUrl: "https://api.deepseek.com",
  // deepseek-chat is deprecated (2026/07/24) - deepseek-v4-flash is the
  // current model; deepseek-chat now maps to its non-thinking mode anyway.
  defaultModel: "deepseek-v4-flash",
});

module.exports = { groqClient, deepseekClient, createOpenAiCompatibleClient };
