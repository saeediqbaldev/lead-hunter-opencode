// Orchestrates calling whichever AI provider is actually available for a
// user, with automatic fallback: if the first provider fails for any
// reason (no key configured, rate-limited, network error, timeout), it
// tries the next one instead of failing the whole request. This is what
// protects against exactly the kind of outage that motivated adding
// Groq/DeepSeek in the first place - Gemini's free tier hitting its daily
// cap, or any single provider having a bad moment.
const apiKeys = require("./apiKeys");
const gemini = require("./gemini");
const { groqClient, deepseekClient } = require("./openaiCompatible");
const opencode = require("./opencodeClient");

// Order matters: Groq is tried first (generous recurring free tier + very
// fast responses, which also helps avoid proxy-timeout issues), then
// Gemini (recurring but a much tighter free cap), then DeepSeek
// (its free access is a one-time token grant per account, not a
// recurring daily quota, so it's the one worth preserving longest), and
// OpenCode last as a server-side agent fallback. OpenCode is special: it
// holds its own model keys server-side and is only "available" when an
// OPENCODE_URL is configured - it needs no per-user API key.
const PROVIDER_ORDER = ["groq", "gemini", "deepseek", "opencode"];

const PROVIDER_LABELS = { groq: "Groq", gemini: "Gemini", deepseek: "DeepSeek", opencode: "OpenCode" };

function getClientFor(provider) {
  if (provider === "gemini") return gemini;
  if (provider === "groq") return groqClient;
  if (provider === "deepseek") return deepseekClient;
  if (provider === "opencode") return opencode;
  return null;
}

// Whether a provider is usable for this user. OpenCode is server-level
// (available when the server is configured at all); every other provider
// requires the user to have an active key saved.
function providerAvailable(userId, provider) {
  if (provider === "opencode") return opencode.isConfigured();
  return !!apiKeys.getActiveKey(userId, provider);
}

// Returns the ordered list of providers this user actually has available
// (an active key, or a configured OpenCode server) - unavailable providers
// are skipped entirely rather than counted as a "failed attempt".
function availableProviders(userId) {
  return PROVIDER_ORDER.filter((p) => providerAvailable(userId, p));
}

// Calls generateText on the given provider, normalizing Gemini's slightly
// different signature (responseSchema/maxOutputTokens) to the same
// { ok, text, error } shape the OpenAI-compatible clients use.
// maxTokens may be a single number (same budget for every provider) or a
// map like { groq: 5500, gemini: 12000 } - some free tiers (Groq's larger
// models especially) have a much tighter combined input+output token
// ceiling per request than others, so a single universal budget that's
// safe for one provider can be far too small - or too large - for another.
function resolveMaxTokens(maxTokens, provider) {
  if (maxTokens == null) return undefined;
  if (typeof maxTokens === "object") return maxTokens[provider];
  return maxTokens;
}

async function callProvider(provider, apiKey, prompt, { jsonMode, geminiSchema, timeoutMs, maxTokens } = {}) {
  if (provider === "opencode") {
    // Server-level client - it reads OPENCODE_MODEL itself and ignores
    // maxTokens (the opencode message API doesn't expose a token cap).
    return opencode.generateText(prompt, { jsonMode, timeoutMs });
  }
  const resolvedMaxTokens = resolveMaxTokens(maxTokens, provider);
  if (provider === "gemini") {
    return gemini.generateText(apiKey, prompt, {
      responseSchema: geminiSchema || undefined,
      timeoutMs,
      maxOutputTokens: resolvedMaxTokens,
    });
  }
  const client = getClientFor(provider);
  return client.generateText(apiKey, prompt, { jsonMode, timeoutMs, maxTokens: resolvedMaxTokens });
}

// Tries each available provider in order until one succeeds. Returns
// { ok, text, provider, error, attempts } - attempts is the full list of
// what was tried and why each one failed, useful for surfacing a genuinely
// informative error if every provider fails.
// onlyProvider (optional): when the user explicitly picks a specific AI
// instead of "Auto", this restricts the attempt to ONLY that provider -
// no silent fallback to a different one, so the user's choice is honored
// exactly rather than quietly substituted.
// timeoutMs/maxTokens (optional): override the client defaults - used by
// full-page website generation, which needs much more time and output
// budget than a short copy snippet.
async function generateWithFallback(userId, prompt, { jsonMode, geminiSchema, onlyProvider, timeoutMs, maxTokens } = {}) {
  const providers = onlyProvider ? [onlyProvider] : availableProviders(userId);
  if (providers.length === 0) {
    return {
      ok: false,
      error: "No AI provider configured. Add a key for Groq, Gemini, or DeepSeek in Settings.",
      attempts: [],
    };
  }
  if (onlyProvider && !providerAvailable(userId, onlyProvider)) {
    return {
      ok: false,
      error:
        onlyProvider === "opencode"
          ? "OpenCode server is not configured. Set OPENCODE_URL (and OPENCODE_SERVER_PASSWORD if enabled) on the server."
          : `No ${PROVIDER_LABELS[onlyProvider] || onlyProvider} key configured - add one in Settings, or choose Auto instead.`,
      attempts: [],
    };
  }

  const attempts = [];
  for (const provider of providers) {
    const keyRow = provider === "opencode" ? null : apiKeys.getActiveKey(userId, provider);
    const result = await callProvider(provider, keyRow?.key_value, prompt, { jsonMode, geminiSchema, timeoutMs, maxTokens });
    if (result.ok) {
      if (keyRow) apiKeys.recordUsage(userId, keyRow.id, { requests: 1 });
      return { ok: true, text: result.text, provider, attempts: [...attempts, { provider, ok: true }] };
    }
    attempts.push({ provider, ok: false, error: result.error });
    console.log(`[ai-fallback] ${PROVIDER_LABELS[provider]} failed: ${result.error} - trying next provider...`);
  }

  const summary = attempts.map((a) => `${PROVIDER_LABELS[a.provider]}: ${a.error}`).join(" | ");
  return { ok: false, error: `All configured AI providers failed. ${summary}`, attempts };
}

module.exports = { generateWithFallback, availableProviders, PROVIDER_ORDER, PROVIDER_LABELS };
