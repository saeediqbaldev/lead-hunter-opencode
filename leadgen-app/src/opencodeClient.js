// Client for the OpenCode agent server (https://opencode.ai) running via
// `opencode serve`. Unlike Groq/DeepSeek/Gemini, there is no per-user API
// key - OpenCode is a server-level agent that holds its OWN model keys
// (passed to the opencode process as env vars like GROQ_API_KEY /
// DEEPSEEK_API_KEY at startup). The lead-gen app just talks to it over
// HTTP and asks it to run prompts.
//
// Each request creates a fresh session, sends one message, collects the
// assistant's text, and deletes the session again - so the opencode
// server's session store doesn't grow unboundedly from automated calls.
//
// Tools are deliberately disabled for these calls: the app already does
// its own website/SEO fetching (see businessAnalysis.js) and passes the
// results into the prompt, so opencode is used here as a deterministic
// text/JSON engine matching the same contract as the direct Groq/DeepSeek
// clients - no agent tool-loop, no waiting on permission prompts.

const DEFAULT_TIMEOUT_MS = 90000;

// The opencode message API's `tools` field is a map of tool/permission name
// to whether it's enabled; it is converted into allow/deny session permission
// rules. Denying every standard tool keeps these calls as deterministic
// plain-text generation - the model cannot enter an agent tool-loop, and a
// headless server never blocks waiting for a permission prompt. (Note: the
// field must be an OBJECT, not an array - Effect's schema rejects an empty
// array with a 400 Bad Request.)
const DENIED_TOOLS = {
  bash: false,
  edit: false,
  write: false,
  apply_patch: false,
  webfetch: false,
  websearch: false,
  task: false,
  todo: false,
  todowrite: false,
  skill: false,
  question: false,
  plan: false,
  lsp: false,
  read: false,
  glob: false,
  grep: false,
  invalid: false,
  external_directory: false,
};

// OPENCODE_MODEL is "provider/model" (e.g. "groq/openai/gpt-oss-120b" or
// "deepseek/deepseek-v4-flash"). Defaults to the same Groq model the app
// already uses directly.
function resolveModel() {
  const raw = (process.env.OPENCODE_MODEL || "").trim();
  if (raw) {
    const slash = raw.indexOf("/");
    if (slash > 0 && slash < raw.length - 1) {
      return { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) };
    }
  }
  return { providerID: "groq", modelID: "openai/gpt-oss-120b" };
}

function isConfigured() {
  return !!(process.env.OPENCODE_URL && process.env.OPENCODE_URL.trim());
}

function baseUrl() {
  return (process.env.OPENCODE_URL || "http://opencode:4096").trim().replace(/\/$/, "");
}

function authHeaders() {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) return {};
  const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let message = `OpenCode server returned HTTP ${res.status}.`;
      try {
        const parsed = JSON.parse(body);
        // Effect HttpApi errors are { name: "BadRequest", data: { message } };
        // the OpenAI-compatible clients use { error: { message } }. Handle both.
        message = parsed?.error?.message || parsed?.data?.message || message;
      } catch {
        // keep generic message
      }
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function health() {
  if (!isConfigured()) return { ok: false, error: "OpenCode server is not configured (set OPENCODE_URL)." };
  try {
    const res = await fetchWithTimeout(`${baseUrl()}/global/health`, { headers: authHeaders() }, 8000);
    const data = await res.json();
    return { ok: true, healthy: !!data.healthy, version: data.version || null };
  } catch (err) {
    const timedOut = err.name === "AbortError";
    return { ok: false, error: timedOut ? "OpenCode server did not respond in time." : err.message };
  }
}

async function generateText(prompt, { jsonMode, timeoutMs } = {}) {
  if (!isConfigured()) {
    return { ok: false, error: "No OpenCode server configured. Set OPENCODE_URL (and OPENCODE_SERVER_PASSWORD if enabled) on the server." };
  }
  const timeout = timeoutMs || DEFAULT_TIMEOUT_MS;
  const url = baseUrl();
  const headers = { "Content-Type": "application/json", ...authHeaders() };

  try {
    const createRes = await fetchWithTimeout(
      `${url}/session`,
      { method: "POST", headers, body: JSON.stringify({ title: "Lead Hunter request" }) },
      timeout
    );
    const { id: sessionId } = await createRes.json();
    if (!sessionId) return { ok: false, error: "OpenCode server did not return a session id." };

    try {
      const msgRes = await fetchWithTimeout(
        `${url}/session/${sessionId}/message`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: resolveModel(),
            // Deny every standard tool = plain text generation, no agent
            // tool loop (and no hanging on permission prompts).
            tools: DENIED_TOOLS,
            parts: [{ type: "text", text: prompt }],
          }),
        },
        timeout
      );
      const data = await msgRes.json();
      const texts = (data?.parts || [])
        .filter((p) => p.type === "text" && typeof p.text === "string" && p.text.trim())
        .map((p) => p.text.trim());
      if (texts.length === 0) return { ok: false, error: "OpenCode returned an empty response." };
      return { ok: true, text: texts.join("\n") };
    } finally {
      // Clean up the session regardless of the outcome so repeated calls
      // don't pile up sessions on the opencode server.
      fetchWithTimeout(`${url}/session/${sessionId}`, { method: "DELETE", headers }, 8000).catch(() => {});
    }
  } catch (err) {
    const timedOut = err.name === "AbortError";
    return { ok: false, error: timedOut ? "OpenCode took too long to respond - try again." : err.message };
  }
}

module.exports = { isConfigured, health, generateText, resolveModel };
