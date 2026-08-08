// Bump this on every meaningful change - shown in the topbar and console so
// you can immediately confirm the browser is running the build you just deployed.
const APP_VERSION = "2026.08.08-15.1";

// ---------- Diagnostics: surface failures instead of failing silently ----------
function showBanner(message) {
  let banner = document.getElementById("errorBanner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "errorBanner";
    banner.className = "error-banner";
    document.querySelector("main.layout").prepend(banner);
  }
  banner.textContent = message;
  banner.style.display = "block";
}

function hideBanner() {
  const banner = document.getElementById("errorBanner");
  if (banner) banner.style.display = "none";
}

// ---------- Toast notifications (bottom-right, fade in/out after 5s) ----------
const TOAST_ICONS = { success: "bi-check-circle-fill", error: "bi-x-circle-fill", info: "bi-info-circle-fill" };
function showToast(message, kind = "info") {
  const container = document.getElementById("toastContainer");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast ${kind}`;
  toast.innerHTML = `<i class="bi ${TOAST_ICONS[kind] || TOAST_ICONS.info}"></i><span>${message}</span>`;
  container.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add("show"));

  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300); // matches the CSS transition duration
  }, 5000);
}

// ---------- Auth-aware fetch wrapper ----------
async function api(url, opts) {
  const res = await fetch(url, opts);
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("Not authenticated");
  }
  return res;
}

document.getElementById("logoutBtn").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST" });
  } catch (err) {
    console.error("Logout request failed:", err);
  } finally {
    window.location.href = "/login";
  }
});

// ---------- Settings modal (Google Places API keys, set from the UI) ----------
const navSettingsApi = document.getElementById("navSettingsApi");
const apiKeysList = document.getElementById("apiKeysList");
const newKeyLabel = document.getElementById("newKeyLabel");
const newKeyValue = document.getElementById("newKeyValue");
const settingsResult = document.getElementById("settingsResult");
const settingsTestNewBtn = document.getElementById("settingsTestNewBtn");
const settingsSaveNewBtn = document.getElementById("settingsSaveNewBtn");

function showSettingsResult(kind, text) {
  settingsResult.style.display = "block";
  settingsResult.className = `settings-result ${kind}`;
  settingsResult.textContent = text;
}

function hideSettingsResult() {
  settingsResult.style.display = "none";
}

function apiKeyRowHtml(k) {
  return `
    <div class="api-key-row ${k.active ? "active" : ""}" data-key-id="${k.id}">
      <div class="api-key-info">
        <span class="api-key-label">${k.label}</span>
        <span class="api-key-masked">${k.masked}</span>
        ${k.active ? '<span class="api-key-active-badge">● In use</span>' : ""}
        <span class="api-key-usage" title="Places API requests made / leads captured with this key">
          ${k.requestsMade} req · ${k.leadsCaught} leads
        </span>
      </div>
      <div class="api-key-actions">
        ${!k.active ? `<button type="button" class="small-btn" data-action="activate-key" data-id="${k.id}">Use this</button>` : ""}
        <button type="button" class="small-btn" data-action="test-key" data-id="${k.id}">Test</button>
        <button type="button" class="small-btn danger-btn" data-action="delete-key" data-id="${k.id}">Delete</button>
      </div>
    </div>`;
}

// ---------- AI provider key management (Gemini/Groq/DeepSeek all use this
// same factory - mirrors the Google Places pattern, parameterized instead
// of duplicated three times) ----------
function setupAiProviderKeySection({ provider, label, displayLabel, endpointPrefix, view, getKeyHint }) {
  const dLabel = displayLabel || label;
  const keysList = document.getElementById(`${provider}KeysList`);
  const newKeyLabel = document.getElementById(`new${label}KeyLabel`);
  const newKeyValue = document.getElementById(`new${label}KeyValue`);
  const settingsResult = document.getElementById(`${provider}SettingsResult`);
  const testNewBtn = document.getElementById(`${provider}TestNewBtn`);
  const saveNewBtn = document.getElementById(`${provider}SaveNewBtn`);
  const navBtn = document.getElementById(`navSettings${label}`);

  function showResult(kind, text) {
    settingsResult.style.display = "block";
    settingsResult.className = `settings-result ${kind}`;
    settingsResult.textContent = text;
  }
  function hideResult() {
    settingsResult.style.display = "none";
  }

  function keyRowHtml(k) {
    return `
      <div class="api-key-row ${k.active ? "active" : ""}" data-key-id="${k.id}">
        <div class="api-key-info">
          <span class="api-key-label">${k.label}</span>
          <span class="api-key-masked">${k.masked}</span>
          ${k.active ? '<span class="api-key-active-badge">● In use</span>' : ""}
          <span class="api-key-usage" title="${dLabel} requests made with this key">${k.requestsMade} req</span>
        </div>
        <div class="api-key-actions">
          ${!k.active ? `<button type="button" class="small-btn" data-action="activate-${provider}-key" data-id="${k.id}">Use this</button>` : ""}
          <button type="button" class="small-btn" data-action="test-${provider}-key" data-id="${k.id}">Test</button>
          <button type="button" class="small-btn danger-btn" data-action="delete-${provider}-key" data-id="${k.id}">Delete</button>
        </div>
      </div>`;
  }

  async function loadKeys() {
    keysList.innerHTML = `<div class="api-keys-empty">Loading…</div>`;
    try {
      const res = await api(`/api/settings/${endpointPrefix}-keys`);
      const data = await res.json();
      keysList.innerHTML =
        data.keys.length === 0
          ? `<div class="api-keys-empty">No ${dLabel} key saved yet. ${getKeyHint}</div>`
          : data.keys.map(keyRowHtml).join("");
    } catch (err) {
      keysList.innerHTML = `<div class="api-keys-empty">Could not load saved keys.</div>`;
    }
  }

  navBtn.addEventListener("click", async () => {
    newKeyLabel.value = "";
    newKeyValue.value = "";
    hideResult();
    state.lastNavSection = "settings";
    setContentView(view);
    await loadKeys();

    const usageContainer = document.getElementById(`settingsUsage-${provider}`);
    if (usageContainer) {
      usageContainer.innerHTML = `<h3 class="settings-subheading">Usage</h3>` + buildProviderUsageSectionHtml(`settings-${provider}`, provider === "google_places");
      await loadAndRenderProviderUsage(provider, `settings-${provider}`, provider === "google_places");
    }
  });

  saveNewBtn.addEventListener("click", async () => {
    const keyLabel = newKeyLabel.value.trim() || "Untitled key";
    const apiKey = newKeyValue.value.trim();
    if (!apiKey) {
      showResult("bad", `Paste a ${dLabel} API key first.`);
      return;
    }
    saveNewBtn.disabled = true;
    saveNewBtn.textContent = "Saving…";
    try {
      const res = await api(`/api/settings/${endpointPrefix}-keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: keyLabel, apiKey }),
      });
      const data = await res.json();
      if (!res.ok) {
        showResult("bad", data.error || "Could not save this key.");
        showToast(`Could not save ${dLabel} key: ${data.error || "test failed"}`, "error");
        return;
      }
      showResult("ok", `Saved "${data.label}" (${data.masked}).`);
      showToast(`${dLabel} key "${data.label}" saved`, "success");
      newKeyLabel.value = "";
      newKeyValue.value = "";
      await loadKeys();
    } catch (err) {
      showResult("bad", err.message || "Could not save this key.");
      showToast(`Could not save ${dLabel} key: ${err.message}`, "error");
    } finally {
      saveNewBtn.disabled = false;
      saveNewBtn.textContent = "Test & Save";
    }
  });

  testNewBtn.addEventListener("click", async () => {
    const apiKey = newKeyValue.value.trim();
    if (!apiKey) {
      showResult("bad", `Paste a ${dLabel} API key first.`);
      return;
    }
    testNewBtn.disabled = true;
    testNewBtn.textContent = "Testing…";
    try {
      const res = await api(`/api/settings/${endpointPrefix}-keys/test-value`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      const data = await res.json();
      showResult(data.ok ? "ok" : "bad", data.ok ? "Success — this key works." : data.error || "This key doesn't work.");
    } finally {
      testNewBtn.disabled = false;
      testNewBtn.textContent = "Test";
    }
  });

  keysList.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;

    if (action === `activate-${provider}-key`) {
      await api(`/api/settings/${endpointPrefix}-keys/${id}/activate`, { method: "POST" });
      hideResult();
      showToast(`Active ${dLabel} key updated`, "success");
      await loadKeys();
      return;
    }

    if (action === `test-${provider}-key`) {
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Testing…";
      try {
        const res = await api(`/api/settings/${endpointPrefix}-keys/${id}/test`, { method: "POST" });
        const data = await res.json();
        showResult(data.ok ? "ok" : "bad", data.ok ? "Success — this key still works." : data.error || "This key no longer works.");
        showToast(data.ok ? "Key test succeeded" : `Key test failed: ${data.error || "no longer works"}`, data.ok ? "success" : "error");
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
      return;
    }

    if (action === `delete-${provider}-key`) {
      const row = btn.closest(".api-key-row");
      const rowLabel = row.querySelector(".api-key-label").textContent;
      const confirmed = await openModal({
        title: `Delete key "${rowLabel}"?`,
        message: `This cannot be undone. If this was the active key, ${dLabel} will be skipped in the AI fallback chain until another key is added or activated.`,
        confirmText: "Delete",
        danger: true,
      });
      if (!confirmed) return;
      await api(`/api/settings/${endpointPrefix}-keys/${id}`, { method: "DELETE" });
      hideResult();
      showToast(`${dLabel} key "${rowLabel}" deleted`, "success");
      await loadKeys();
      return;
    }
  });

  return { loadKeys };
}

setupAiProviderKeySection({
  provider: "gemini",
  label: "Gemini",
  endpointPrefix: "gemini",
  view: "settings-gemini",
  getKeyHint: "Add one below - get a free one at aistudio.google.com/apikey.",
});
setupAiProviderKeySection({
  provider: "groq",
  label: "Groq",
  endpointPrefix: "groq",
  view: "settings-groq",
  getKeyHint: "Add one below - get a free one at console.groq.com/keys.",
});
setupAiProviderKeySection({
  provider: "deepseek",
  label: "Deepseek",
  displayLabel: "DeepSeek",
  endpointPrefix: "deepseek",
  view: "settings-deepseek",
  getKeyHint: "Add one below - get one at platform.deepseek.com/api_keys.",
});

async function loadApiKeys() {
  apiKeysList.innerHTML = `<div class="api-keys-empty">Loading…</div>`;
  try {
    const res = await api("/api/settings/keys");
    const data = await res.json();
    if (data.keys.length === 0) {
      apiKeysList.innerHTML = data.envFallbackAvailable
        ? `<div class="api-keys-empty">No keys saved yet — currently falling back to GOOGLE_PLACES_API_KEY from .env.</div>`
        : `<div class="api-keys-empty">No keys saved yet. Add one below.</div>`;
    } else {
      apiKeysList.innerHTML = data.keys.map(apiKeyRowHtml).join("");
    }
  } catch (err) {
    apiKeysList.innerHTML = `<div class="api-keys-empty">Could not load saved keys.</div>`;
  }
}

const navSettingsAccount = document.getElementById("navSettingsAccount");

let cachedSignatureHtml = null;
async function getCachedSignature() {
  if (cachedSignatureHtml !== null) return cachedSignatureHtml;
  try {
    const res = await api("/api/settings/signature");
    const data = await res.json();
    cachedSignatureHtml = data.signature || "";
  } catch {
    cachedSignatureHtml = "";
  }
  return cachedSignatureHtml;
}
// Invalidated whenever the signature is saved, so a change is reflected
// immediately in already-open lead panels without needing a page reload.
function invalidateSignatureCache() {
  cachedSignatureHtml = null;
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// Escapes HTML special characters before we selectively re-introduce <b>
// tags below - without this, any literal <, >, or & in the AI's text
// would be misinterpreted as markup when rendered via innerHTML.
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Strips HTML down to plain text for clipboard copies - rich formatting
// and images can't survive a plain-text paste anyway, so this just
// preserves the readable text and turns block-level breaks into newlines.
function htmlToPlainText(html) {
  if (!html) return "";
  const div = document.createElement("div");
  div.innerHTML = html;
  div.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  div.querySelectorAll("p, div, li").forEach((el) => el.append("\n"));
  return div.textContent.replace(/\n{3,}/g, "\n\n").trim();
}

// Converts **bold** markdown (which occasionally slips through despite the
// generation prompt explicitly discouraging it) into real <b> tags for
// on-screen display, so the preview actually looks bold instead of
// showing raw asterisks. Also applied to content generated before this
// fix existed, not just new generations.
function renderFormattedContent(text) {
  const escaped = escapeHtml(text || "");
  return escaped
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/__(.+?)__/g, "<b>$1</b>")
    .replace(/(?<!\*)\*(?!\*)(.+?)\*(?!\*)/g, "<i>$1</i>")
    .replace(/(?<!_)_(?!_)(.+?)_(?!_)/g, "<i>$1</i>")
    .replace(/\n/g, "<br>");
}

// Strips markdown bold/italic markers entirely for the "Copy" action -
// plain text can't actually render bold, so leaving the asterisks in would
// just paste literal "**word**" into whatever the user pastes into.
function stripMarkdownFormatting(text) {
  return (text || "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/(?<!\*)\*(?!\*)(.+?)\*(?!\*)/g, "$1").replace(/_{1,2}(.+?)_{1,2}/g, "$1");
}

// ==================== Contacted (email open/click tracker) ====================

document.querySelectorAll("[data-toggle-platform]").forEach((header) => {
  header.addEventListener("click", () => {
    const node = header.closest("[data-platform-node]");
    node.classList.toggle("open");
  });
});

document.querySelectorAll("[data-goto-platform][data-goto-view]").forEach((leaf) => {
  leaf.addEventListener("click", () => {
    const platform = leaf.dataset.gotoPlatform;
    const view = leaf.dataset.gotoView;
    state.contactedPlatform = platform;
    state.lastNavSection = "contacted";
    document.querySelectorAll("[data-goto-platform][data-goto-view]").forEach((l) => l.classList.remove("active"));
    leaf.classList.add("active");
    setContentView(`contacted-${view}`);
    if (view === "setup") loadContactedSetup();
    else if (view === "tracking") loadContactedTracking();
    else if (view === "history") loadContactedHistory();
    else if (view === "reports") loadContactedReports("7d");
    else if (view === "alerts") loadContactedAlerts();
    else if (view === "campaigns") loadContactedCampaigns();
  });
});

async function refreshCurrentContactedView() {
  const view = state.contentView;
  if (view === "contacted-tracking") await loadContactedTracking();
  else if (view === "contacted-history") await loadContactedHistory();
  else if (view === "contacted-alerts") await loadContactedAlerts();
  else if (view === "contacted-reports") {
    const activeRange = document.querySelector("#contactedReportsRangeGroup .range-pill.active")?.dataset.range || "7d";
    await loadContactedReports(activeRange);
  } else if (view === "contacted-setup") await loadContactedSetup();
  else await loadContactedTracking(); // default landing view when refreshed from elsewhere
  await refreshContactedUnreadBadge();
}

let contactedAutoRefreshTimer = null;

async function setupContactedAutoRefresh(intervalSecondsOverride) {
  if (contactedAutoRefreshTimer) {
    clearInterval(contactedAutoRefreshTimer);
    contactedAutoRefreshTimer = null;
  }

  let seconds = intervalSecondsOverride;
  if (seconds === undefined) {
    try {
      const res = await api("/api/tracker/settings");
      const data = await res.json();
      seconds = data.settings?.refresh_interval_seconds || 0;
    } catch {
      seconds = 0;
    }
  }

  if (!seconds || seconds <= 0) return;

  contactedAutoRefreshTimer = setInterval(() => {
    // Only actually refresh while the user has a Contacted page open -
    // otherwise this would keep polling in the background forever even
    // while they're working in Hunt/Reach Out/somewhere else entirely.
    if (state.contentView && state.contentView.startsWith("contacted-")) {
      refreshCurrentContactedView();
    }
  }, seconds * 1000);
}
setupContactedAutoRefresh();

// ==================== Header notification feed ====================
const NOTIF_TYPE_ICON = {
  open: "bi-envelope-open-fill",
  click: "bi-cursor-fill",
  campaign_paused: "bi-exclamation-triangle-fill",
  campaign_completed: "bi-check-circle-fill",
};
const NOTIF_TYPE_COLOR = {
  open: "var(--warn)",
  click: "var(--good)",
  campaign_paused: "var(--danger)",
  campaign_completed: "var(--good)",
};

async function refreshHeaderNotifBadge() {
  try {
    const res = await api("/api/notifications/feed/unread-count");
    const data = await res.json();
    const badge = document.getElementById("headerNotifBadge");
    if (data.count > 0) {
      badge.textContent = data.count > 99 ? "99+" : data.count;
      badge.style.display = "inline-flex";
    } else {
      badge.style.display = "none";
    }
  } catch {
    // Non-critical
  }
}
refreshHeaderNotifBadge();
setInterval(refreshHeaderNotifBadge, 30000);

async function loadNotifPanel() {
  const res = await api("/api/notifications/feed?limit=50");
  const data = await res.json();
  const list = document.getElementById("notifPanelList");

  if (!data.notifications.length) {
    list.innerHTML = `<p class="hint" style="padding:16px;">Nothing yet - opens, clicks, and campaign events will show up here.</p>`;
    return;
  }

  list.innerHTML = data.notifications
    .map(
      (n) => `
    <div class="notif-item ${n.is_read ? "" : "unread"}" data-notif-source="${n.source}" data-notif-id="${n.id}">
      <i class="bi ${NOTIF_TYPE_ICON[n.type] || "bi-bell-fill"}" style="color:${NOTIF_TYPE_COLOR[n.type] || "var(--text-muted)"};"></i>
      <div class="notif-item-body">
        <div class="notif-item-title">${n.title || ""}</div>
        <div class="notif-item-msg">${n.message}</div>
        <div class="notif-item-time">${n.created_at}</div>
      </div>
    </div>`
    )
    .join("");

  list.querySelectorAll("[data-notif-id]").forEach((item) => {
    item.addEventListener("click", async () => {
      if (item.classList.contains("unread")) {
        await api(`/api/notifications/feed/${item.dataset.notifSource}/${item.dataset.notifId}/read`, { method: "POST" });
        item.classList.remove("unread");
        refreshHeaderNotifBadge();
      }
    });
  });
}

function openNotifPanel() {
  document.getElementById("notifPanelOverlay").style.display = "flex";
  loadNotifPanel();
}
function closeNotifPanel() {
  document.getElementById("notifPanelOverlay").style.display = "none";
}

document.getElementById("headerNotifBtn").addEventListener("click", openNotifPanel);
document.getElementById("notifPanelCloseBtn").addEventListener("click", closeNotifPanel);
document.getElementById("notifPanelOverlay").addEventListener("click", (e) => {
  if (e.target.id === "notifPanelOverlay") closeNotifPanel();
});
document.getElementById("notifMarkAllReadBtn").addEventListener("click", async () => {
  await api("/api/notifications/feed/mark-all-read", { method: "POST" });
  await loadNotifPanel();
  refreshHeaderNotifBadge();
});

async function refreshContactedUnreadBadge() {
  try {
    const totalRes = await api("/api/tracker/notifications/unread-count");
    const totalData = await totalRes.json();
    applyBadgeCount(document.getElementById("contactedUnreadBadge"), totalData.count);

    for (const platform of ["hostinger", "gmail"]) {
      const res = await api(`/api/tracker/notifications/unread-count?provider=${platform}`);
      const data = await res.json();
      applyBadgeCount(document.querySelector(`[data-platform-badge="${platform}"]`), data.count);
      applyBadgeCount(document.querySelector(`[data-platform-alerts-badge="${platform}"]`), data.count);
    }
  } catch {
    // Non-critical - just skip updating the badges this tick.
  }
}

function applyBadgeCount(el, count) {
  if (!el) return;
  if (count > 0) {
    el.textContent = count > 99 ? "99+" : count;
    el.style.display = "inline-flex";
  } else {
    el.style.display = "none";
  }
}
refreshContactedUnreadBadge();
setInterval(refreshContactedUnreadBadge, 30000);

// ---------- Setup page ----------
const PLATFORM_SETUP_COPY = {
  hostinger: {
    title: "Hostinger Mail Setup",
    scopeLine: "Track opens and clicks on emails you send from Hostinger Webmail - no manual config needed",
    stepTitle: "Open Hostinger Webmail and compose",
    stepBody: `A <b>Track</b> toggle appears near the send button - turn it on before sending and this dashboard will show opens and clicks automatically.`,
  },
  gmail: {
    title: "Gmail Setup",
    scopeLine: "Track opens and clicks on emails you send from Gmail - no manual config needed",
    stepTitle: "Open Gmail and compose",
    stepBody: `A <b>Track</b> toggle appears near the send button in the compose window - turn it on before sending and this dashboard will show opens and clicks automatically.`,
  },
};

// Attaches every Setup-page click handler exactly once, regardless of
// which platform (Hostinger or Gmail) happens to load this shared body
// element first - body is a static element defined once in index.html
// and never recreated, only its innerHTML gets replaced per platform, so
// a naive addEventListener would either stack up duplicate handlers on
// repeat visits, or (the actual bug this fixes) only ever attach for
// whichever platform's setup page was viewed first, leaving the other
// platform's buttons with no working handler at all.
function attachSetupListenersOnce(body) {
  if (body.dataset.listenersAttached) return;
  body.dataset.listenersAttached = "1";
  body.addEventListener("click", async (e) => {
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (action === "save-gmail-settings") {
      const resultEl = document.getElementById("contactedSettingsResult");
      const payload = { gmailUser: body.querySelector("[data-gmail-user]").value.trim() };
      const pass = body.querySelector("[data-gmail-app-password]").value.trim();
      if (pass) payload.appPassword = pass;
      const r = await api("/api/tracker/gmail-settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const d = await r.json();
      resultEl.style.display = "block";
      resultEl.className = `settings-result ${r.ok ? "ok" : "bad"}`;
      resultEl.textContent = r.ok ? "Gmail settings saved." : d.error;
      if (r.ok) {
        body.querySelector("[data-gmail-pass-hint]").textContent = d.appPasswordSet ? "(a password is already saved)" : "(not set)";
        body.querySelector("[data-gmail-app-password]").value = "";
      }
      return;
    }
    if (action === "fill-hostinger-smtp") {
      body.querySelector("[data-tracker-smtp-host]").value = "smtp.hostinger.com";
      body.querySelector("[data-tracker-smtp-port]").value = "465";
      showToast("Filled in Hostinger's standard SMTP host and port - username/password are still your own", "success");
      return;
    }
    if (action === "copy-tracker-key") {
      navigator.clipboard?.writeText(body.querySelector("[data-contacted-api-key]").value);
      showToast("API key copied", "success");
      return;
    }
    if (action === "rotate-tracker-key") {
      const confirmed = await openModal({
        title: "Generate a new API key?",
        message: "Any extension already installed will stop working until you download it again with the new key.",
        confirmText: "Generate new key",
        danger: true,
      });
      if (!confirmed) return;
      const r = await api("/api/tracker/setup/rotate-key", { method: "POST" });
      const d = await r.json();
      body.querySelector("[data-contacted-api-key]").value = d.apiKey;
      showToast("New API key generated - download the extension again", "success");
      return;
    }
    if (action === "save-tracker-settings") {
      const resultEl = document.getElementById("contactedSettingsResult");
      const port = body.querySelector("[data-tracker-smtp-port]").value;
      const payload = {
        refresh_interval_seconds: parseInt(body.querySelector("[data-tracker-auto-refresh]").value, 10),
        notify_email_enabled: body.querySelector("[data-tracker-notify-enabled]").checked,
        notify_email_to: body.querySelector("[data-tracker-notify-to]").value.trim(),
        smtp_host: body.querySelector("[data-tracker-smtp-host]").value.trim(),
        smtp_port: port ? parseInt(port, 10) : null,
        smtp_user: body.querySelector("[data-tracker-smtp-user]").value.trim(),
        smtp_from: body.querySelector("[data-tracker-smtp-from]").value.trim(),
      };
      const pass = body.querySelector("[data-tracker-smtp-pass]").value;
      if (pass) payload.smtp_pass = pass;
      const r = await api("/api/tracker/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const d = await r.json();
      resultEl.style.display = "block";
      if (!r.ok) {
        resultEl.className = "settings-result bad";
        resultEl.textContent = d.error || "Could not save settings";
      } else {
        resultEl.className = "settings-result ok";
        resultEl.textContent = "Settings saved.";
        body.querySelector("[data-tracker-smtp-pass-hint]").textContent = d.settings.smtp_pass_set ? "(a password is already saved)" : "(not set)";
        body.querySelector("[data-tracker-smtp-pass]").value = "";
        setupContactedAutoRefresh(d.settings.refresh_interval_seconds || 0);
      }
      return;
    }
    if (action === "test-tracker-email") {
      const resultEl = document.getElementById("contactedSettingsResult");
      const r = await api("/api/tracker/settings/test-email", { method: "POST" });
      const d = await r.json();
      resultEl.style.display = "block";
      resultEl.className = `settings-result ${r.ok ? "ok" : "bad"}`;
      resultEl.textContent = r.ok ? "Test email sent - check your inbox." : d.error;
      return;
    }
  });
}

async function loadContactedSetup() {
  const platform = state.contactedPlatform;
  const copy = PLATFORM_SETUP_COPY[platform] || PLATFORM_SETUP_COPY.hostinger;
  document.getElementById("contactedSetupTitle").textContent = copy.title;
  document.getElementById("contactedSetupScopeLine").textContent = copy.scopeLine;

  const body = document.getElementById("contactedSetupBody");
  body.innerHTML = `<p class="hint">Loading…</p>`;
  const res = await api("/api/tracker/setup");
  const data = await res.json();

  body.innerHTML = `
    <h3 class="settings-subheading">What this page is for</h3>
    <p class="hint">A one-time setup, done once: get your personal API key, install the browser extension it's baked into, and (optionally) turn on email alerts. The same extension and API key cover both Hostinger and Gmail - one install handles both. After this, you won't need to come back here - use <b>Tracking</b>, <b>History</b>, <b>Alerts</b>, and <b>Reports</b> under each platform for day-to-day use.</p>

    <h3 class="settings-subheading">Your API key</h3>
    <p class="hint">Identifies your account to the extension - already embedded in the download below, shown here only for reference.</p>
    <div class="contacted-setup-key-row">
      <input type="text" readonly value="${data.apiKey}" data-contacted-api-key />
      <button type="button" data-action="copy-tracker-key"><i class="bi bi-clipboard"></i> Copy key</button>
      <button type="button" data-action="rotate-tracker-key" title="Generate a new key (breaks any extension already installed)"><i class="bi bi-arrow-repeat"></i></button>
    </div>

    <a href="/api/tracker/extension-download" class="site-generate-btn" style="display:inline-flex; text-decoration:none; margin-bottom:22px;">
      <i class="bi bi-download"></i> Download the Chrome extension
    </a>

    <div class="contacted-setup-steps">
      <div class="contacted-setup-step">
        <div class="step-num"></div>
        <div class="step-body"><h4>Download and unzip</h4><p>Click the button above - it downloads a small .zip with your key already inside it.</p></div>
      </div>
      <div class="contacted-setup-step">
        <div class="step-num"></div>
        <div class="step-body"><h4>Load it into Chrome</h4><p>Go to <code>chrome://extensions</code>, turn on <b>Developer mode</b> (top right), click <b>Load unpacked</b>, and select the unzipped folder.</p></div>
      </div>
      <div class="contacted-setup-step">
        <div class="step-num"></div>
        <div class="step-body"><h4>${copy.stepTitle}</h4><p>${copy.stepBody}</p></div>
      </div>
    </div>

    <div class="settings-result bad" style="display:block; background:rgba(232,162,61,0.1); border-color:var(--warn); color:var(--warn);">
      <b>Testing it yourself?</b> Opens from the exact same network you sent from, or opened within the first few seconds, are deliberately not counted - this stops your own Sent-folder preview from falsely marking a message "Opened." Test from a different network/device, or wait a bit before checking. Clicks are never filtered this way, so link clicks always register immediately. Some mail clients also block remote images by default, which prevents opens from registering at all until images are allowed.
    </div>

    <div class="settings-divider"></div>

    <div class="settings-divider"></div>

    <h3 class="settings-subheading">Auto-refresh</h3>
    <p class="hint">How often Tracking, History, Alerts, and Reports quietly refresh themselves while you have them open. The manual refresh button always works regardless of this setting.</p>
    <label class="site-field-label">
      Refresh every
      <select data-tracker-auto-refresh>
        <option value="0">Off - refresh manually only</option>
        <option value="60">1 minute</option>
        <option value="180">3 minutes</option>
        <option value="300">5 minutes</option>
        <option value="900">15 minutes</option>
        <option value="1800">30 minutes</option>
        <option value="3600">1 hour</option>
        <option value="7200">2 hours</option>
        <option value="21600">6 hours</option>
        <option value="43200">12 hours</option>
      </select>
    </label>

    <div class="settings-divider"></div>

    ${
      platform === "gmail"
        ? `
    <h3 class="settings-subheading">Gmail sending</h3>
    <p class="hint">Gmail requires a Google <b>App Password</b> rather than your regular account password for programmatic access - <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">create one here</a> (2-Step Verification must be turned on for your Google account first).</p>
    <div class="smtp-card">
      <label class="site-field-label">Gmail address<input type="text" data-gmail-user placeholder="you@gmail.com"></label>
      <label class="site-field-label">App Password <small class="optional" data-gmail-pass-hint></small><input type="password" data-gmail-app-password placeholder="16-character app password"></label>
    </div>
    <button type="button" class="small-btn" data-action="save-gmail-settings">Save Gmail settings</button>
    <div class="settings-result" id="contactedSettingsResult" style="display:none;"></div>
    `
        : `
    <h3 class="settings-subheading">Email notifications</h3>
    <p class="hint">Get an email the moment someone opens or clicks - sent through your own SMTP account.</p>
    <label class="site-visuals-toggle"><input type="checkbox" data-tracker-notify-enabled /> Enable email notifications</label>
    <label class="site-field-label">Send notifications to<input type="text" data-tracker-notify-to placeholder="you@yourdomain.com"></label>

    <div class="smtp-card">
      <div class="smtp-card-head">
        <span>SMTP connection</span>
        <button type="button" class="smtp-quickfill-btn" data-action="fill-hostinger-smtp">Use Hostinger defaults</button>
      </div>
      <div class="smtp-field-row">
        <label class="site-field-label">SMTP host<input type="text" data-tracker-smtp-host placeholder="smtp.hostinger.com"></label>
        <label class="site-field-label smtp-field-narrow">SMTP port<input type="number" data-tracker-smtp-port placeholder="465"></label>
      </div>
      <div class="smtp-field-row">
        <label class="site-field-label">SMTP username<input type="text" data-tracker-smtp-user placeholder="you@yourdomain.com"></label>
        <label class="site-field-label">SMTP password <small class="optional" data-tracker-smtp-pass-hint></small><input type="password" data-tracker-smtp-pass placeholder="Leave blank to keep current"></label>
      </div>
      <label class="site-field-label">SMTP "from" address <small class="optional">(optional, defaults to the username)</small><input type="text" data-tracker-smtp-from placeholder="you@yourdomain.com"></label>
    </div>

    <div style="display:flex; gap:8px;">
      <button type="button" class="small-btn" data-action="save-tracker-settings">Save settings</button>
      <button type="button" class="small-btn" data-action="test-tracker-email">Send test email</button>
    </div>
    <div class="settings-result" id="contactedSettingsResult" style="display:none;"></div>
    `
    }
  `;

  if (platform === "gmail") {
    const gmailRes = await api("/api/tracker/gmail-settings");
    const gmailData = await gmailRes.json();
    body.querySelector("[data-gmail-user]").value = gmailData.gmailUser || "";
    body.querySelector("[data-gmail-pass-hint]").textContent = gmailData.appPasswordSet ? "(a password is already saved)" : "(not set)";
    attachSetupListenersOnce(body);
    return;
  }

  const settingsRes = await api("/api/tracker/settings");
  const settingsData = await settingsRes.json();
  const s = settingsData.settings || {};
  body.querySelector("[data-tracker-auto-refresh]").value = String(s.refresh_interval_seconds || 0);
  body.querySelector("[data-tracker-notify-enabled]").checked = !!s.notify_email_enabled;
  body.querySelector("[data-tracker-notify-to]").value = s.notify_email_to || "";
  body.querySelector("[data-tracker-smtp-host]").value = s.smtp_host || "";
  body.querySelector("[data-tracker-smtp-port]").value = s.smtp_port || "";
  body.querySelector("[data-tracker-smtp-user]").value = s.smtp_user || "";
  body.querySelector("[data-tracker-smtp-from]").value = s.smtp_from || "";
  body.querySelector("[data-tracker-smtp-pass-hint]").textContent = s.smtp_pass_set ? "(a password is already saved)" : "(not set)";

  attachSetupListenersOnce(body);
}

// ---------- Tracking ledger ----------
let contactedStatusFilter = "";
async function loadContactedTracking() {
  const statsRes = await api(`/api/tracker/stats?provider=${state.contactedPlatform}`);
  const stats = await statsRes.json();
  const statsRow = document.getElementById("contactedStatsRow");
  const cards = [
    { key: "", label: "Sent", value: stats.total_sent },
    { key: "opened", label: "Opened", value: stats.total_opened },
    { key: "sent", label: "Unopened", value: stats.total_unopened },
    { key: "clicked", label: "Clicked", value: stats.total_clicked },
  ];
  statsRow.innerHTML = cards
    .map((c) => `<div class="contacted-stat-card ${c.key === contactedStatusFilter ? "active" : ""}" data-status-filter="${c.key}"><div class="num">${c.value}</div><div class="label">${c.label}</div></div>`)
    .join("");
  statsRow.querySelectorAll("[data-status-filter]").forEach((card) => {
    card.addEventListener("click", () => {
      contactedStatusFilter = card.dataset.statusFilter;
      renderContactedTable();
    });
  });

  await renderContactedTable();
}

async function renderContactedTable() {
  const search = document.getElementById("contactedSearchInput").value.trim();
  const recipient = document.getElementById("contactedRecipientInput").value.trim();
  const params = new URLSearchParams();
  params.set("provider", state.contactedPlatform);
  if (contactedStatusFilter) params.set("status", contactedStatusFilter);
  if (search) params.set("search", search);
  if (recipient) params.set("recipient", recipient);

  const res = await api(`/api/tracker/emails?${params.toString()}`);
  const data = await res.json();
  const tbody = document.getElementById("contactedTableBody");

  if (!data.emails.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-muted); padding:24px;">No tracked emails yet - send one with the extension's Track toggle on.</td></tr>`;
    return;
  }

  tbody.innerHTML = data.emails
    .map(
      (email) => `
    <tr class="contacted-row" data-email-id="${email.id}">
      <td><input type="checkbox" class="contacted-row-check" data-email-id="${email.id}" onclick="event.stopPropagation()"></td>
      <td>${email.subject || "(no subject)"}</td>
      <td>${email.recipients.join(", ")}</td>
      <td><span class="contacted-status-pill ${email.status}">${email.status}</span></td>
      <td>${email.open_count}</td>
      <td>${email.click_count}</td>
      <td>${email.created_at}</td>
    </tr>`
    )
    .join("");

  tbody.querySelectorAll(".contacted-row").forEach((row) => {
    row.addEventListener("click", () => openContactedDetail(row.dataset.emailId));
  });
  updateContactedBulkDeleteVisibility();
}

function updateContactedBulkDeleteVisibility() {
  const checked = document.querySelectorAll(".contacted-row-check:checked");
  document.getElementById("contactedDeleteSelectedBtn").style.display = checked.length ? "inline-flex" : "none";
}

document.getElementById("contactedSearchInput").addEventListener("input", debounce(renderContactedTable, 300));
document.getElementById("contactedRecipientInput").addEventListener("input", debounce(renderContactedTable, 300));
document.getElementById("contactedRefreshBtn").addEventListener("click", loadContactedTracking);
document.getElementById("contactedSelectAll").addEventListener("change", (e) => {
  document.querySelectorAll(".contacted-row-check").forEach((cb) => (cb.checked = e.target.checked));
  updateContactedBulkDeleteVisibility();
});
document.getElementById("contactedTableBody").addEventListener("change", (e) => {
  if (e.target.classList.contains("contacted-row-check")) updateContactedBulkDeleteVisibility();
});
document.getElementById("contactedDeleteSelectedBtn").addEventListener("click", async () => {
  const ids = Array.from(document.querySelectorAll(".contacted-row-check:checked")).map((cb) => cb.dataset.emailId);
  if (!ids.length) return;
  const confirmed = await openModal({ title: `Delete ${ids.length} tracked email(s)?`, message: "This also deletes their open/click history. This cannot be undone.", confirmText: "Delete", danger: true });
  if (!confirmed) return;
  await api("/api/tracker/emails/bulk-delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
  showToast("Deleted", "success");
  loadContactedTracking();
});

async function openContactedDetail(emailId) {
  const res = await api(`/api/tracker/emails/${emailId}`);
  const data = await res.json();
  const existing = document.querySelector(".contacted-detail-panel");
  if (existing) existing.remove();

  const panel = document.createElement("div");
  panel.className = "contacted-detail-panel";
  panel.innerHTML = `
    <button class="contacted-detail-close" data-action="close-detail">&times;</button>
    <h3 style="margin-top:0;">${data.email.subject || "(no subject)"}</h3>
    <p class="hint">To: ${data.email.recipients.join(", ")}</p>
    <p class="hint">Sent ${data.email.created_at}</p>
    <div class="settings-divider"></div>
    <h4>Message</h4>
    ${
      data.email.body_html
        ? `<iframe class="contacted-detail-body-frame" srcdoc="${escapeHtml(data.email.body_html)}" sandbox=""></iframe>`
        : `<p class="hint">No content captured for this email - it was sent manually via the ${data.email.provider} extension, which only reports tracking metadata, not the message body.</p>`
    }
    <div class="settings-divider"></div>
    <label class="site-field-label">Notes<textarea data-detail-notes rows="3" style="width:100%; background:var(--panel-raised); border:1px solid var(--border); border-radius:6px; color:var(--text); padding:8px;">${data.email.notes || ""}</textarea></label>
    <button type="button" class="small-btn" data-action="save-detail-notes">Save note</button>
    <div class="settings-divider"></div>
    <h4>Opens (${data.opens.length})</h4>
    ${data.opens.map((o) => `<div class="contacted-detail-event"><b>${o.opened_at}</b><br>${o.ip || "unknown IP"}</div>`).join("") || `<p class="hint">No opens yet.</p>`}
    <h4>Clicks (${data.clicks.length})</h4>
    ${data.clicks.map((c) => `<div class="contacted-detail-event"><b>${c.clicked_at}</b><br>${c.url}</div>`).join("") || `<p class="hint">No clicks yet.</p>`}
    <div class="settings-divider"></div>
    <button type="button" class="small-btn danger-btn" data-action="delete-detail-email">Delete this tracked email</button>
  `;
  document.body.appendChild(panel);
  requestAnimationFrame(() => panel.classList.add("open"));

  panel.addEventListener("click", async (e) => {
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (action === "close-detail") {
      panel.classList.remove("open");
      setTimeout(() => panel.remove(), 250);
    } else if (action === "save-detail-notes") {
      const notes = panel.querySelector("[data-detail-notes]").value;
      await api(`/api/tracker/emails/${emailId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ notes }) });
      showToast("Note saved", "success");
    } else if (action === "delete-detail-email") {
      const confirmed = await openModal({ title: "Delete this tracked email?", message: "This cannot be undone.", confirmText: "Delete", danger: true });
      if (!confirmed) return;
      await api(`/api/tracker/emails/${emailId}`, { method: "DELETE" });
      panel.remove();
      showToast("Deleted", "success");
      loadContactedTracking();
    }
  });
}

// ---------- History ----------
async function loadContactedHistory() {
  const type = document.getElementById("contactedHistoryTypeSelect").value;
  const search = document.getElementById("contactedHistorySearchInput").value.trim();
  const params = new URLSearchParams();
  params.set("provider", state.contactedPlatform);
  if (type) params.set("type", type);
  if (search) params.set("search", search);

  const res = await api(`/api/tracker/history?${params.toString()}`);
  const data = await res.json();
  const tbody = document.getElementById("contactedHistoryTableBody");

  if (!data.events.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:24px;">No events yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = data.events
    .map(
      (ev) => `
    <tr class="contacted-row" data-history-email-id="${ev.email_id}">
      <td><span class="contacted-status-pill ${ev.type === "open" ? "opened" : "clicked"}">${ev.type}</span></td>
      <td>${ev.subject || "(no subject)"}</td>
      <td>${ev.recipients.join(", ")}</td>
      <td>${ev.type === "click" ? ev.url : ev.ip || ""}</td>
      <td>${ev.ts}</td>
    </tr>`
    )
    .join("");

  tbody.querySelectorAll("[data-history-email-id]").forEach((row) => {
    row.addEventListener("click", () => openContactedDetail(row.dataset.historyEmailId));
  });
}
document.getElementById("contactedHistoryTypeSelect").addEventListener("change", loadContactedHistory);
document.getElementById("contactedHistorySearchInput").addEventListener("input", debounce(loadContactedHistory, 300));

// ---------- Reports ----------
let contactedTimeseriesChartInstance = null;
async function loadContactedReports(range) {
  document.querySelectorAll("#contactedReportsRangeGroup .range-pill").forEach((btn) => btn.classList.toggle("active", btn.dataset.range === range));

  const res = await api(`/api/tracker/analytics?range=${range}&provider=${state.contactedPlatform}`);
  const data = await res.json();

  const statsRow = document.getElementById("contactedReportsStatsRow");
  const s = data.summary;
  statsRow.innerHTML = [
    { label: "Sent", value: s.sent },
    { label: "Opens", value: s.opens },
    { label: "Clicks", value: s.clicks },
    { label: "Unique opened", value: s.unique_opened },
    { label: "Open rate", value: `${Math.round(s.open_rate * 100)}%` },
  ]
    .map((c) => `<div class="contacted-stat-card"><div class="num">${c.value}</div><div class="label">${c.label}</div></div>`)
    .join("");

  const ctx = document.getElementById("contactedTimeseriesChart").getContext("2d");
  if (contactedTimeseriesChartInstance) contactedTimeseriesChartInstance.destroy();
  contactedTimeseriesChartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels: data.timeseries.map((t) => t.bucket),
      datasets: [
        { label: "Opens", data: data.timeseries.map((t) => t.opens), borderColor: "#e8a23d", backgroundColor: "rgba(232,162,61,0.12)", tension: 0.3, fill: true },
        { label: "Clicks", data: data.timeseries.map((t) => t.clicks), borderColor: "#2ea66e", backgroundColor: "rgba(46,166,110,0.12)", tension: 0.3, fill: true },
      ],
    },
    options: { responsive: true, plugins: { legend: { labels: { color: getComputedStyle(document.documentElement).getPropertyValue("--text") } } }, scales: { x: { ticks: { color: "#9a9186" } }, y: { ticks: { color: "#9a9186" }, beginAtZero: true } } },
  });

  const heatmapEl = document.getElementById("contactedHeatmap");
  const grid = new Map(data.heatmap.map((h) => [`${h.day}-${h.hour}`, h.count]));
  const maxCount = Math.max(1, ...data.heatmap.map((h) => h.count));
  const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let html = `<div class="hm-label"></div>`;
  for (let h = 0; h < 24; h += 1) html += `<div class="hm-label">${h % 6 === 0 ? h : ""}</div>`;
  for (let d = 0; d < 7; d += 1) {
    html += `<div class="hm-label">${dayLabels[d]}</div>`;
    for (let h = 0; h < 24; h += 1) {
      const count = grid.get(`${d}-${h}`) || 0;
      const alpha = count === 0 ? 0 : 0.15 + 0.85 * (count / maxCount);
      html += `<div class="hm-cell" style="background:rgba(255,106,61,${alpha});" title="${dayLabels[d]} ${h}:00 - ${count} event(s)"></div>`;
    }
  }
  heatmapEl.innerHTML = html;
}
document.getElementById("contactedReportsRangeGroup").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-range]");
  if (btn) loadContactedReports(btn.dataset.range);
});

// ---------- Alerts ----------
async function loadContactedAlerts() {
  const type = document.getElementById("contactedAlertsTypeSelect").value;
  const unreadOnly = document.getElementById("contactedUnreadOnlyToggle").checked;
  const params = new URLSearchParams();
  params.set("provider", state.contactedPlatform);
  if (type) params.set("type", type);
  if (unreadOnly) params.set("unread", "true");

  const res = await api(`/api/tracker/notifications?${params.toString()}`);
  const data = await res.json();
  const list = document.getElementById("contactedAlertsList");

  if (!data.notifications.length) {
    list.innerHTML = `<p class="hint">No notifications yet.</p>`;
    return;
  }

  list.innerHTML = data.notifications
    .map(
      (n) => `
    <div class="contacted-alert-item ${n.is_read ? "" : "unread"}" data-notif-id="${n.id}">
      <i class="bi ${n.is_read ? "bi-bell" : "bi-bell-fill"} contacted-alert-bell ${n.is_read ? "" : "unread"}" data-action="toggle-read" title="Toggle read"></i>
      <div class="msg" data-action="view-email" data-email-id="${n.email_id}" style="cursor:pointer;">${n.message}<div class="meta">${n.created_at}</div></div>
      <button class="del" data-action="delete-notif" title="Delete"><i class="bi bi-x-lg"></i></button>
    </div>`
    )
    .join("");

  list.querySelectorAll("[data-action]").forEach((el) => {
    el.addEventListener("click", async (e) => {
      const item = e.target.closest("[data-notif-id]");
      const id = item.dataset.notifId;
      const action = el.dataset.action;
      if (action === "view-email") {
        openContactedDetail(el.dataset.emailId);
      } else if (action === "toggle-read") {
        const isUnread = el.classList.contains("unread");
        await api(`/api/tracker/notifications/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ is_read: isUnread }) });
        loadContactedAlerts();
        refreshContactedUnreadBadge();
      } else if (action === "delete-notif") {
        await api(`/api/tracker/notifications/${id}`, { method: "DELETE" });
        loadContactedAlerts();
        refreshContactedUnreadBadge();
      }
    });
  });
}
document.getElementById("contactedAlertsTypeSelect").addEventListener("change", loadContactedAlerts);
document.getElementById("contactedUnreadOnlyToggle").addEventListener("change", loadContactedAlerts);
document.getElementById("contactedMarkAllReadBtn").addEventListener("click", async () => {
  await api("/api/tracker/notifications/mark-all-read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: state.contactedPlatform }),
  });
  loadContactedAlerts();
  refreshContactedUnreadBadge();
});

// ---------- Campaigns (Auto Send) ----------
const CAMPAIGN_STATUS_LABEL = {
  draft: "Draft",
  running: "Running",
  paused: "Paused",
  completed: "Completed",
  cancelled: "Cancelled",
};

function campaignProgressBarHtml(c) {
  const total = c.total_leads || 0;
  const pct = total > 0 ? Math.round((c.sent_count / total) * 100) : 0;
  return `
    <div class="campaign-progress-track"><div class="campaign-progress-fill" style="width:${pct}%;"></div></div>
    <div class="campaign-progress-label">${c.sent_count}/${total} sent${c.failed_count ? ` · ${c.failed_count} failed` : ""}${c.skipped_count ? ` · ${c.skipped_count} skipped` : ""}</div>
  `;
}

async function loadContactedCampaigns() {
  const res = await api("/api/campaigns");
  const data = await res.json();
  const list = document.getElementById("contactedCampaignsList");

  if (!data.campaigns.length) {
    list.innerHTML = `<p class="hint" style="padding:0 22px;">No campaigns yet - click "New Campaign" to set one up.</p>`;
    return;
  }

  list.innerHTML = data.campaigns
    .map(
      (c) => `
    <div class="campaign-card" data-campaign-id="${c.id}">
      <div class="campaign-card-top">
        <span class="campaign-name">${c.name}</span>
        <span class="campaign-status-pill campaign-status-${c.status}">${CAMPAIGN_STATUS_LABEL[c.status] || c.status}</span>
      </div>
      ${campaignProgressBarHtml(c)}
      <div class="campaign-card-meta">Every ${c.min_gap_minutes}-${c.max_gap_minutes} min, up to ${c.max_per_day}/day · Created ${c.created_at}</div>
    </div>`
    )
    .join("");

  list.querySelectorAll(".campaign-card").forEach((card) => {
    card.addEventListener("click", () => loadCampaignDetail(card.dataset.campaignId));
  });
}

document.getElementById("contactedNewCampaignBtn").addEventListener("click", showCampaignCreationForm);

async function showCampaignCreationForm() {
  setContentView("contacted-campaign-detail");
  document.getElementById("campaignDetailTitle").textContent = "New Campaign";
  document.getElementById("campaignDetailScope").textContent = "Set up an automated sending run";
  document.getElementById("campaignDetailActions").innerHTML = "";

  const [nichesRes] = await Promise.all([api("/api/niches")]);
  const niches = await nichesRes.json();

  const body = document.getElementById("campaignDetailBody");
  body.innerHTML = `
    <label class="site-field-label">Campaign name<input type="text" data-campaign-name placeholder="e.g. Bali Car Washes - August"></label>

    <label class="site-field-label">Niche
      <select data-campaign-niche>
        <option value="">Select a niche…</option>
        ${niches.map((n) => `<option value="${n.id}">${n.name} (${n.lead_count} leads)</option>`).join("")}
      </select>
    </label>
    <label class="site-field-label">Cities <small class="optional">(select one or more)</small></label>
    <div class="campaign-city-checklist" data-campaign-city-checklist>
      <p class="hint" style="padding:8px;">Select a niche first…</p>
    </div>
    <p class="hint" data-campaign-lead-preview></p>

    <label class="site-visuals-toggle"><input type="checkbox" data-campaign-require-inspection checked> Inspect uninspected leads first, before writing their email</label>

    <div class="smtp-field-row">
      <label class="site-field-label">Tone
        <select data-campaign-tone>${CONTENT_TONES.map((t) => `<option value="${t}">${t}</option>`).join("")}</select>
      </label>
      <label class="site-field-label">Length
        <select data-campaign-length>${CONTENT_LENGTHS.map((l) => `<option value="${l}" ${l === "Medium" ? "selected" : ""}>${l}</option>`).join("")}</select>
      </label>
    </div>
    <label class="site-field-label">Language
      <select data-campaign-language>${CONTENT_LANGUAGES.map((l) => `<option value="${l.value}" ${l.value === "English" ? "selected" : ""}>${l.flag} ${l.label}</option>`).join("")}</select>
    </label>
    <label class="site-field-label">AI provider <small class="optional">(optional - leave on Auto to use your saved defaults)</small>
      <select data-campaign-ai-provider>
        <option value="">Auto</option>
        <option value="groq">Groq</option>
        <option value="gemini">Gemini</option>
        <option value="deepseek">DeepSeek</option>
      </select>
    </label>

    <label class="site-visuals-toggle"><input type="checkbox" data-campaign-cta> Weave in a clear call-to-action</label>
    <label class="site-visuals-toggle"><input type="checkbox" data-campaign-meeting> Invite them to a meeting/call</label>
    <label class="site-field-label" data-campaign-meeting-link-row style="display:none;">Meeting booking link<input type="text" data-campaign-meeting-link placeholder="https://cal.com/you/15min"></label>

    <div class="settings-divider"></div>
    <h3 class="settings-subheading">Sending pace</h3>
    <p class="hint">Kept randomized within this range so sending doesn't look automated to spam filters.</p>
    <div class="smtp-field-row">
      <label class="site-field-label">Max per day<input type="number" data-campaign-max-per-day value="100" min="1" max="100"></label>
      <label class="site-field-label">Gap: min - max minutes
        <div style="display:flex; gap:6px;">
          <input type="number" data-campaign-min-gap value="5" min="1" style="width:70px;">
          <input type="number" data-campaign-max-gap value="10" min="1" style="width:70px;">
        </div>
      </label>
    </div>

    <div style="display:flex; gap:8px; margin-top:12px;">
      <button type="button" class="site-generate-btn" data-action="create-campaign"><i class="bi bi-send-fill"></i> Create Campaign</button>
      <button type="button" class="small-btn" data-action="cancel-campaign-form">Cancel</button>
    </div>
    <div class="settings-result" id="campaignFormResult" style="display:none;"></div>
  `;

  body.querySelector("[data-campaign-meeting]").addEventListener("change", (e) => {
    body.querySelector("[data-campaign-meeting-link-row]").style.display = e.target.checked ? "block" : "none";
  });

  const nicheSelect = body.querySelector("[data-campaign-niche]");
  const cityChecklist = body.querySelector("[data-campaign-city-checklist]");
  const previewEl = body.querySelector("[data-campaign-lead-preview]");

  async function updateLeadPreview() {
    const checkedIds = Array.from(cityChecklist.querySelectorAll("input:checked")).map((cb) => cb.value);
    if (!checkedIds.length) {
      previewEl.textContent = "";
      return;
    }
    const counts = await Promise.all(
      checkedIds.map((id) => api(`/api/leads?catchLogId=${id}&pageSize=1`).then((r) => r.json()).then((d) => d.total))
    );
    const total = counts.reduce((sum, n) => sum + n, 0);
    previewEl.textContent = `${total} lead(s) across ${checkedIds.length} ${checkedIds.length === 1 ? "city" : "cities"} - leads without an email on file will be skipped automatically.`;
  }

  nicheSelect.addEventListener("change", async () => {
    const nicheId = nicheSelect.value;
    cityChecklist.innerHTML = `<p class="hint" style="padding:8px;">Loading…</p>`;
    previewEl.textContent = "";
    if (!nicheId) {
      cityChecklist.innerHTML = `<p class="hint" style="padding:8px;">Select a niche first…</p>`;
      return;
    }
    const res = await api(`/api/catch-logs?nicheId=${nicheId}`);
    const cities = await res.json();
    if (!cities.length) {
      cityChecklist.innerHTML = `<p class="hint" style="padding:8px;">No cities caught for this niche yet.</p>`;
      return;
    }
    cityChecklist.innerHTML = cities
      .map(
        (c) => `
      <label class="campaign-city-check-row">
        <input type="checkbox" value="${c.id}" data-campaign-city-checkbox>
        ${c.name} <span class="hint">(${c.lead_count} leads)</span>
      </label>`
      )
      .join("");
    cityChecklist.querySelectorAll("[data-campaign-city-checkbox]").forEach((cb) => cb.addEventListener("change", updateLeadPreview));
  });

  body.addEventListener("click", async (e) => {
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (action === "cancel-campaign-form") {
      loadContactedCampaigns();
      setContentView("contacted-campaigns");
      return;
    }
    if (action === "create-campaign") {
      const resultEl = document.getElementById("campaignFormResult");
      const checkedCityIds = Array.from(cityChecklist.querySelectorAll("input:checked")).map((cb) => Number(cb.value));
      const payload = {
        name: body.querySelector("[data-campaign-name]").value.trim(),
        nicheId: nicheSelect.value || undefined,
        catchLogIds: checkedCityIds.length ? checkedCityIds : undefined,
        requireInspection: body.querySelector("[data-campaign-require-inspection]").checked,
        tone: body.querySelector("[data-campaign-tone]").value,
        length: body.querySelector("[data-campaign-length]").value,
        language: body.querySelector("[data-campaign-language]").value,
        cta: body.querySelector("[data-campaign-cta]").checked,
        meeting: body.querySelector("[data-campaign-meeting]").checked,
        meetingLink: body.querySelector("[data-campaign-meeting-link]").value.trim() || undefined,
        aiProvider: body.querySelector("[data-campaign-ai-provider]").value || undefined,
        maxPerDay: parseInt(body.querySelector("[data-campaign-max-per-day]").value, 10) || 100,
        minGapMinutes: parseInt(body.querySelector("[data-campaign-min-gap]").value, 10) || 5,
        maxGapMinutes: parseInt(body.querySelector("[data-campaign-max-gap]").value, 10) || 10,
      };
      if (!payload.name) {
        resultEl.style.display = "block";
        resultEl.className = "settings-result bad";
        resultEl.textContent = "Give the campaign a name first.";
        return;
      }
      if (!payload.catchLogIds) {
        resultEl.style.display = "block";
        resultEl.className = "settings-result bad";
        resultEl.textContent = "Select a niche and at least one city first.";
        return;
      }
      const res = await api("/api/campaigns", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await res.json();
      resultEl.style.display = "block";
      if (!res.ok) {
        resultEl.className = "settings-result bad";
        resultEl.textContent = data.error;
        return;
      }
      showToast(`Campaign created - ${data.leadCount} lead(s) queued${data.skippedCount ? `, ${data.skippedCount} skipped (no email on file)` : ""}`, "success");
      loadCampaignDetail(data.campaignId);
    }
  });
}

function showCampaignEditForm(campaign) {
  setContentView("contacted-campaign-detail");
  document.getElementById("campaignDetailTitle").textContent = `Edit: ${campaign.name}`;
  document.getElementById("campaignDetailScope").textContent = "Reconfigure this campaign - the lead scope (niche/city) can't be changed after creation";
  document.getElementById("campaignDetailActions").innerHTML = `<button class="icon-toggle-btn" data-campaign-action="cancel-edit" title="Back"><i class="bi bi-arrow-left"></i></button>`;
  document.getElementById("campaignDetailActions").querySelector("[data-campaign-action]").addEventListener("click", () => loadCampaignDetail(campaign.id));

  const body = document.getElementById("campaignDetailBody");
  body.innerHTML = `
    <label class="site-field-label">Campaign name<input type="text" data-edit-name value="${campaign.name}"></label>
    <label class="site-visuals-toggle"><input type="checkbox" data-edit-require-inspection ${campaign.require_inspection ? "checked" : ""}> Inspect uninspected leads first, before writing their email</label>
    <div class="smtp-field-row">
      <label class="site-field-label">Tone
        <select data-edit-tone>${CONTENT_TONES.map((t) => `<option value="${t}" ${t === campaign.tone ? "selected" : ""}>${t}</option>`).join("")}</select>
      </label>
      <label class="site-field-label">Length
        <select data-edit-length>${CONTENT_LENGTHS.map((l) => `<option value="${l}" ${l === campaign.length ? "selected" : ""}>${l}</option>`).join("")}</select>
      </label>
    </div>
    <label class="site-field-label">Language
      <select data-edit-language>${CONTENT_LANGUAGES.map((l) => `<option value="${l.value}" ${l.value === campaign.language ? "selected" : ""}>${l.flag} ${l.label}</option>`).join("")}</select>
    </label>
    <label class="site-field-label">AI provider
      <select data-edit-ai-provider>
        <option value="" ${!campaign.ai_provider ? "selected" : ""}>Auto</option>
        <option value="groq" ${campaign.ai_provider === "groq" ? "selected" : ""}>Groq</option>
        <option value="gemini" ${campaign.ai_provider === "gemini" ? "selected" : ""}>Gemini</option>
        <option value="deepseek" ${campaign.ai_provider === "deepseek" ? "selected" : ""}>DeepSeek</option>
      </select>
    </label>
    <label class="site-visuals-toggle"><input type="checkbox" data-edit-cta ${campaign.cta ? "checked" : ""}> Weave in a clear call-to-action</label>
    <label class="site-visuals-toggle"><input type="checkbox" data-edit-meeting ${campaign.meeting ? "checked" : ""}> Invite them to a meeting/call</label>
    <label class="site-field-label" data-edit-meeting-link-row style="${campaign.meeting ? "" : "display:none;"}">Meeting booking link<input type="text" data-edit-meeting-link value="${campaign.meeting_link || ""}"></label>
    <div class="settings-divider"></div>
    <h3 class="settings-subheading">Sending pace</h3>
    <div class="smtp-field-row">
      <label class="site-field-label">Max per day<input type="number" data-edit-max-per-day value="${campaign.max_per_day}" min="1" max="100"></label>
      <label class="site-field-label">Gap: min - max minutes
        <div style="display:flex; gap:6px;">
          <input type="number" data-edit-min-gap value="${campaign.min_gap_minutes}" min="1" style="width:70px;">
          <input type="number" data-edit-max-gap value="${campaign.max_gap_minutes}" min="1" style="width:70px;">
        </div>
      </label>
    </div>
    <div style="display:flex; gap:8px; margin-top:12px;">
      <button type="button" class="site-generate-btn" data-action="save-campaign-edit">Save changes</button>
      <button type="button" class="small-btn" data-action="cancel-campaign-edit">Cancel</button>
    </div>
    <div class="settings-result" id="campaignEditResult" style="display:none;"></div>
  `;

  body.querySelector("[data-edit-meeting]").addEventListener("change", (e) => {
    body.querySelector("[data-edit-meeting-link-row]").style.display = e.target.checked ? "block" : "none";
  });

  body.addEventListener("click", async (e) => {
    const action = e.target.closest("[data-action]")?.dataset.action;
    if (action === "cancel-campaign-edit") {
      loadCampaignDetail(campaign.id);
      return;
    }
    if (action === "save-campaign-edit") {
      const payload = {
        name: body.querySelector("[data-edit-name]").value.trim(),
        requireInspection: body.querySelector("[data-edit-require-inspection]").checked,
        tone: body.querySelector("[data-edit-tone]").value,
        length: body.querySelector("[data-edit-length]").value,
        language: body.querySelector("[data-edit-language]").value,
        aiProvider: body.querySelector("[data-edit-ai-provider]").value,
        cta: body.querySelector("[data-edit-cta]").checked,
        meeting: body.querySelector("[data-edit-meeting]").checked,
        meetingLink: body.querySelector("[data-edit-meeting-link]").value.trim(),
        maxPerDay: parseInt(body.querySelector("[data-edit-max-per-day]").value, 10) || 100,
        minGapMinutes: parseInt(body.querySelector("[data-edit-min-gap]").value, 10) || 5,
        maxGapMinutes: parseInt(body.querySelector("[data-edit-max-gap]").value, 10) || 10,
      };
      const res = await api(`/api/campaigns/${campaign.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await res.json();
      const resultEl = document.getElementById("campaignEditResult");
      if (!res.ok) {
        resultEl.style.display = "block";
        resultEl.className = "settings-result bad";
        resultEl.textContent = data.error;
        return;
      }
      showToast("Campaign updated", "success");
      loadCampaignDetail(campaign.id);
    }
  });
}

async function loadCampaignDetail(campaignId) {
  setContentView("contacted-campaign-detail");
  const res = await api(`/api/campaigns/${campaignId}`);
  const data = await res.json();
  const { campaign, leads } = data;

  document.getElementById("campaignDetailTitle").textContent = campaign.name;
  document.getElementById("campaignDetailScope").textContent = `${CAMPAIGN_STATUS_LABEL[campaign.status]}${campaign.pause_reason ? ` - ${campaign.pause_reason}` : ""}`;

  const actionsEl = document.getElementById("campaignDetailActions");
  const actions = [];
  if (campaign.status === "draft") actions.push(`<button class="site-generate-btn" data-campaign-action="start">Start</button>`);
  if (campaign.status === "running") actions.push(`<button class="small-btn" data-campaign-action="pause">Pause</button>`);
  if (campaign.status === "paused") actions.push(`<button class="site-generate-btn" data-campaign-action="resume">Resume</button>`);
  if (["draft", "paused"].includes(campaign.status)) actions.push(`<button class="small-btn" data-campaign-action="edit">Edit</button>`);
  if (["draft", "running", "paused"].includes(campaign.status)) actions.push(`<button class="small-btn danger-btn" data-campaign-action="cancel">Cancel</button>`);
  actions.push(`<button class="small-btn danger-btn" data-campaign-action="delete">Delete</button>`);
  actions.push(`<button class="icon-toggle-btn" data-campaign-action="back" title="Back to list"><i class="bi bi-arrow-left"></i></button>`);
  actionsEl.innerHTML = actions.join("");

  actionsEl.querySelectorAll("[data-campaign-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const action = btn.dataset.campaignAction;
      if (action === "back") {
        loadContactedCampaigns();
        setContentView("contacted-campaigns");
        return;
      }
      if (action === "edit") {
        showCampaignEditForm(campaign);
        return;
      }
      if (action === "delete") {
        const confirmed = await openModal({
          title: `Delete "${campaign.name}"?`,
          message: `This removes the campaign and its lead queue. Emails already sent stay visible in Tracking/History - this only deletes the campaign record itself. This cannot be undone.`,
          confirmText: "Delete",
          danger: true,
        });
        if (!confirmed) return;
        await api(`/api/campaigns/${campaignId}`, { method: "DELETE" });
        showToast("Campaign deleted", "success");
        loadContactedCampaigns();
        setContentView("contacted-campaigns");
        return;
      }
      await api(`/api/campaigns/${campaignId}/${action}`, { method: "POST" });
      showToast(`Campaign ${action}d`, "success");
      loadCampaignDetail(campaignId);
    });
  });

  const bodyEl = document.getElementById("campaignDetailBody");
  const CAMPAIGN_LEAD_STATUS_ICON = {
    pending: "bi-hourglass",
    inspecting: "bi-search",
    generating: "bi-stars",
    sending: "bi-send",
    sent: "bi-check-circle-fill",
    failed: "bi-x-circle-fill",
    skipped: "bi-slash-circle",
  };
  bodyEl.innerHTML = `
    <table class="contacted-table campaign-detail-table">
      <thead><tr><th style="width:20px;"></th><th>Lead</th><th>Recipient</th><th>Status</th><th>Sent</th></tr></thead>
      <tbody>
        ${leads
          .map((l) => {
            const openInfo = l.open_count != null ? `${l.open_count} open(s)${l.click_count ? `, ${l.click_count} click(s)` : ""}` : "";
            return `
          <tr class="campaign-lead-row" data-lead-row-toggle="${l.id}" data-lead-id="${l.lead_id}">
            <td><i class="bi bi-chevron-right campaign-row-chevron" data-chevron="${l.id}"></i></td>
            <td>${l.lead_name}</td>
            <td>${l.recipient_email || "—"}</td>
            <td><span class="contacted-status-pill campaign-lead-${l.status}"><i class="bi ${CAMPAIGN_LEAD_STATUS_ICON[l.status] || "bi-circle"}"></i> ${l.status}</span></td>
            <td>${l.sent_at || "—"}</td>
          </tr>
          <tr class="campaign-lead-detail-row" id="campaign-detail-${l.id}" style="display:none;">
            <td colspan="5">
              <div class="campaign-lead-detail">
                ${l.sent_subject ? `<div><b>Subject:</b> ${l.sent_subject}</div>` : ""}
                ${openInfo ? `<div><b>Engagement:</b> ${openInfo}</div>` : ""}
                ${l.first_opened_at ? `<div><b>First opened:</b> ${l.first_opened_at}</div>` : ""}
                ${l.error ? `<div style="color:var(--danger);"><b>Error:</b> ${l.error}</div>` : ""}
                ${
                  l.status === "failed"
                    ? `<button type="button" class="small-btn danger-btn" data-action="skip-campaign-lead" data-lead-row-id="${l.id}" style="margin-top:4px;"><i class="bi bi-skip-forward-fill"></i> Skip this lead and resume campaign</button>`
                    : ""
                }
                ${l.website ? `<div><b>Website:</b> ${l.website}</div>` : ""}
                ${l.phone ? `<div><b>Phone:</b> ${l.phone}</div>` : ""}
                ${l.address ? `<div><b>Address:</b> ${l.address}</div>` : ""}
                <div><b>Queued:</b> ${l.created_at}</div>
              </div>
              <div class="settings-divider"></div>
              <div class="campaign-full-panel-wrap" data-full-expand-container="${l.id}">
                <p class="hint" style="padding:8px 0;">Loading Inspection / Content / Website details for this lead…</p>
              </div>
            </td>
          </tr>`;
          })
          .join("")}
      </tbody>
    </table>
  `;

  bodyEl.querySelectorAll("[data-lead-row-toggle]").forEach((row) => {
    row.addEventListener("click", async () => {
      const id = row.dataset.leadRowToggle;
      const leadId = row.dataset.leadId;
      const detailRow = document.getElementById(`campaign-detail-${id}`);
      const chevron = bodyEl.querySelector(`[data-chevron="${id}"]`);
      const isOpen = detailRow.style.display !== "none";
      detailRow.style.display = isOpen ? "none" : "table-row";
      chevron.classList.toggle("bi-chevron-right", isOpen);
      chevron.classList.toggle("bi-chevron-down", !isOpen);

      const container = document.querySelector(`[data-full-expand-container="${id}"]`);
      if (!isOpen && container && !container.dataset.loaded) {
        container.dataset.loaded = "1";
        try {
          const lead = await api(`/api/leads/${leadId}`).then((r) => r.json());
          container.innerHTML = buildExpandPanelHtml(lead);
          await wireLeadExpandPanel(container, Number(leadId), lead);
        } catch (err) {
          container.innerHTML = `<p class="hint" style="color:var(--danger);">Could not load this lead's details: ${err.message}</p>`;
        }
      }
    });
  });

  bodyEl.querySelectorAll("[data-action=\"skip-campaign-lead\"]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const leadRowId = btn.dataset.leadRowId;
      const confirmed = await openModal({
        title: "Skip this lead?",
        message: "This lead won't be retried - the campaign resumes and continues with the rest of the queue.",
        confirmText: "Skip & resume",
        danger: true,
      });
      if (!confirmed) return;
      await api(`/api/campaigns/${campaign.id}/leads/${leadRowId}/skip`, { method: "POST" });
      showToast("Lead skipped - campaign resumed", "success");
      loadCampaignDetail(campaign.id);
    });
  });
}

const signatureEditor = document.getElementById("signatureEditor");
const signatureSourceInput = document.getElementById("signatureSourceInput");
const signatureResult = document.getElementById("signatureResult");
let signatureSourceMode = false;

function showSignatureResult(kind, text) {
  signatureResult.style.display = "block";
  signatureResult.className = `settings-result ${kind}`;
  signatureResult.textContent = text;
}

function getSignatureHtml() {
  return signatureSourceMode ? signatureSourceInput.value : signatureEditor.innerHTML;
}
function setSignatureHtml(html) {
  signatureEditor.innerHTML = html || "";
  signatureSourceInput.value = html || "";
}

document.querySelectorAll("[data-sig-cmd]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (signatureSourceMode) return; // formatting commands only make sense in WYSIWYG mode
    signatureEditor.focus();
    document.execCommand(btn.dataset.sigCmd, false, null);
  });
});

document.querySelectorAll("[data-sig-action]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const action = btn.dataset.sigAction;
    if (action === "toggle-source") {
      if (!signatureSourceMode) {
        signatureSourceInput.value = signatureEditor.innerHTML;
      } else {
        signatureEditor.innerHTML = signatureSourceInput.value;
      }
      signatureSourceMode = !signatureSourceMode;
      signatureEditor.style.display = signatureSourceMode ? "none" : "block";
      signatureSourceInput.style.display = signatureSourceMode ? "block" : "none";
      return;
    }
    if (signatureSourceMode) return;
    if (action === "link") {
      const selection = window.getSelection();
      const hasSelection = selection && selection.toString().length > 0;
      const url = await openModal({ title: "Insert link", inputLabel: "URL", inputValue: "https://" });
      if (!url) return;
      signatureEditor.focus();
      if (hasSelection) {
        document.execCommand("createLink", false, url);
      } else {
        document.execCommand("insertHTML", false, `<a href="${url}">${url}</a>`);
      }
    } else if (action === "image") {
      const url = await openModal({ title: "Insert image", inputLabel: "Image URL", inputValue: "https://" });
      if (!url) return;
      signatureEditor.focus();
      document.execCommand("insertHTML", false, `<img src="${url}" alt="" />`);
    }
  });
});

async function loadSignature() {
  try {
    const res = await api("/api/settings/signature");
    const data = await res.json();
    setSignatureHtml(data.signature || "");
  } catch (err) {
    console.error("Failed to load signature:", err);
  }
}

async function loadProviderPreferences() {
  try {
    const res = await api("/api/settings/ai-provider-preferences");
    const data = await res.json();
    document.getElementById("providerPrefContentSelect").value = data.contentProvider || "";
    document.getElementById("providerPrefInspectionSelect").value = data.inspectionProvider || "";
  } catch (err) {
    console.error("Failed to load AI provider preferences:", err);
  }
}

navSettingsAccount.addEventListener("click", async () => {
  signatureResult.style.display = "none";
  document.getElementById("profileResult").style.display = "none";
  document.getElementById("profileNewUsername").value = "";
  document.getElementById("profileNewPassword").value = "";
  document.getElementById("profileCurrentPassword").value = "";
  state.lastNavSection = "settings";
  setContentView("settings-account");
  await loadDailyCap();
  await loadSignature();
  await loadProviderPreferences();
});

document.getElementById("providerPrefSaveBtn").addEventListener("click", async () => {
  const resultEl = document.getElementById("providerPrefResult");
  const res = await api("/api/settings/ai-provider-preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contentProvider: document.getElementById("providerPrefContentSelect").value,
      inspectionProvider: document.getElementById("providerPrefInspectionSelect").value,
    }),
  });
  const data = await res.json();
  resultEl.style.display = "block";
  resultEl.className = `settings-result ${res.ok ? "ok" : "bad"}`;
  resultEl.textContent = res.ok ? "Defaults saved." : data.error;
});

document.getElementById("profileSaveBtn").addEventListener("click", async () => {
  const newUsername = document.getElementById("profileNewUsername").value.trim();
  const newPassword = document.getElementById("profileNewPassword").value;
  const currentPassword = document.getElementById("profileCurrentPassword").value;
  const resultEl = document.getElementById("profileResult");
  const btn = document.getElementById("profileSaveBtn");

  function showResult(kind, text) {
    resultEl.style.display = "block";
    resultEl.className = `settings-result ${kind}`;
    resultEl.textContent = text;
  }

  if (!currentPassword) {
    showResult("bad", "Enter your current password to confirm this change.");
    return;
  }
  if (!newUsername && !newPassword) {
    showResult("bad", "Enter a new username and/or a new password.");
    return;
  }

  btn.disabled = true;
  try {
    const res = await api("/api/settings/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword, newUsername: newUsername || undefined, newPassword: newPassword || undefined }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not update profile");

    document.getElementById("profileNewUsername").value = "";
    document.getElementById("profileNewPassword").value = "";
    document.getElementById("profileCurrentPassword").value = "";
    showResult("ok", `Saved - your username is now "${data.username}".`);
    showToast("Profile updated", "success");
    await loadWhoami(); // refresh the displayed username in the topbar, if shown anywhere
  } catch (err) {
    showResult("bad", err.message);
    showToast(`Could not update profile: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("signatureSaveBtn").addEventListener("click", async () => {
  const btn = document.getElementById("signatureSaveBtn");
  btn.disabled = true;
  try {
    const res = await api("/api/settings/signature", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signature: getSignatureHtml() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not save signature");
    invalidateSignatureCache();
    showSignatureResult("ok", "Signature saved - used on every outreach message and campaign email from now on.");
    showToast("Signature saved", "success");
  } catch (err) {
    showSignatureResult("bad", err.message);
    showToast(`Could not save signature: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("signatureResetBtn").addEventListener("click", async () => {
  const confirmed = await openModal({
    title: "Reset signature to default?",
    message: "This replaces your current signature with the original default text.",
    confirmText: "Reset",
    danger: true,
  });
  if (!confirmed) return;

  try {
    await api("/api/settings/signature", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signature: `Kind Regards,<br>&nbsp;&nbsp;&nbsp;<b>Saeed Iqbal</b><br>&nbsp;&nbsp;&nbsp;Ceo | Xeven Pixels<br>&nbsp;&nbsp;&nbsp;<a href="https://xevenpixels.com">https://xevenpixels.com</a><br>&nbsp;&nbsp;&nbsp;contact@xevenpixels.com`,
      }),
    });
    await loadSignature();
    showSignatureResult("ok", "Reset to default.");
    showToast("Signature reset to default", "success");
  } catch (err) {
    showSignatureResult("bad", err.message);
  }
});

navSettingsApi.addEventListener("click", async () => {
  newKeyLabel.value = "";
  newKeyValue.value = "";
  hideSettingsResult();
  state.lastNavSection = "settings";
  setContentView("settings-api");
  await loadApiKeys();

  const usageContainer = document.getElementById("settingsUsage-google_places");
  if (usageContainer) {
    usageContainer.innerHTML = `<h3 class="settings-subheading">Usage</h3>` + buildProviderUsageSectionHtml("settings-google_places", true);
    await loadAndRenderProviderUsage("google_places", "settings-google_places", true);
  }
});

async function loadDailyCap() {
  try {
    const res = await api("/api/settings/daily-cap");
    const data = await res.json();
    document.getElementById("dailyCapInput").value = data.dailyLeadCap;
  } catch (err) {
    console.error("Failed to load daily cap:", err);
  }
}

async function loadPageSizePreference() {
  try {
    const res = await api("/api/settings/page-size");
    const data = await res.json();
    state.pageSize = data.pageSize;
    document.getElementById("pageSizeSelect").value = String(data.pageSize);
  } catch (err) {
    console.error("Failed to load page size preference:", err);
  }
}

document.getElementById("pageSizeSelect").addEventListener("change", async (e) => {
  const value = Number(e.target.value);
  state.pageSize = value;
  state.page = 1;
  try {
    await api("/api/settings/page-size", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pageSize: value }),
    });
    showToast(`Now showing ${value} records per page`, "success");
  } catch (err) {
    console.error("Failed to save page size preference:", err);
  }
  await loadLeads();
});

document.getElementById("dailyCapSaveBtn").addEventListener("click", async () => {
  const input = document.getElementById("dailyCapInput");
  const btn = document.getElementById("dailyCapSaveBtn");
  btn.disabled = true;
  try {
    const res = await api("/api/settings/daily-cap", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dailyLeadCap: Number(input.value) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not save");
    showSettingsResult("ok", `Daily cap set to ${data.dailyLeadCap}.`);
    showToast(`Daily lead cap set to ${data.dailyLeadCap}`, "success");
    await refreshQuota();
  } catch (err) {
    showSettingsResult("err", err.message);
    showToast(`Could not save daily cap: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
  }
});

// ---------- Backup & restore ----------
const backupResult = document.getElementById("backupResult");
function showBackupResult(kind, text) {
  backupResult.style.display = "block";
  backupResult.className = `settings-result ${kind}`;
  backupResult.textContent = text;
}

document.getElementById("backupExportBtn").addEventListener("click", async () => {
  const btn = document.getElementById("backupExportBtn");
  btn.disabled = true;
  try {
    const res = await api("/api/backup/export");
    if (!res.ok) throw new Error("Export failed");
    const blob = await res.blob();
    const disposition = res.headers.get("Content-Disposition") || "";
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : "xeven-leads-backup.json";

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showBackupResult("ok", "Backup downloaded.");
    showToast("Backup downloaded", "success");
  } catch (err) {
    showBackupResult("err", err.message);
    showToast(`Backup export failed: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("backupImportInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const confirmed = await openModal({
    title: "Import this backup?",
    message: `Importing "${file.name}" will merge its niches, catch logs, and leads into your account. Nothing already here gets deleted or overwritten - only new records get added.`,
    confirmText: "Import",
  });
  e.target.value = ""; // reset the file input regardless of the choice
  if (!confirmed) return;

  showBackupResult("ok", "Reading file…");
  try {
    const text = await file.text();
    const backup = JSON.parse(text);

    const res = await api("/api/backup/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(backup),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Import failed");

    const s = data.stats;
    showBackupResult(
      "ok",
      `Imported: ${s.niches} new niche(s), ${s.catchLogs} new catch log(s), ${s.leads} new lead(s), ${s.apiKeys} new API key(s).`
    );
    showToast(`Backup imported: ${s.leads} new lead(s) added`, "success");

    // Refresh everything that could have changed
    await loadNichesAndLogs();
    await loadDailyCap();
    await loadTheme();
    await refreshQuota();
    if (state.contentView === "board") await loadLeads();
  } catch (err) {
    showBackupResult("err", err.message.includes("JSON") ? "That file doesn't look like a valid backup (couldn't parse it)." : err.message);
    showToast(`Backup import failed: ${err.message}`, "error");
  }
});

// ---------- Legend info popup (Status/Needs color key) ----------
const legendInfoBtn = document.getElementById("legendInfoBtn");
const legendOverlay = document.getElementById("legendOverlay");
const legendCloseBtn = document.getElementById("legendCloseBtn");

legendInfoBtn.addEventListener("click", () => {
  legendOverlay.style.display = "flex";
});
function closeLegendModal() {
  legendOverlay.style.display = "none";
}
legendCloseBtn.addEventListener("click", closeLegendModal);
legendOverlay.addEventListener("click", (e) => {
  if (e.target === legendOverlay) closeLegendModal();
});

// ---------- Theme system (light/dark + per-color overrides, per-account) ----------
const THEME_VAR_LABELS = {
  "--bg": "Page background",
  "--panel": "Panel background",
  "--panel-raised": "Input/raised background",
  "--border": "Borders",
  "--text": "Text",
  "--text-muted": "Muted text",
  "--accent": "Accent (buttons, highlights)",
  "--accent-dim": "Accent (dim)",
  "--good": "Success / Won",
  "--warn": "Warning / Shortlisted",
  "--danger": "Danger / Rejected",
};

const DARK_THEME_DEFAULTS = {
  "--bg": "#12100e",
  "--panel": "#1b1815",
  "--panel-raised": "#221e1a",
  "--border": "#33302a",
  "--text": "#ece7dd",
  "--text-muted": "#948d80",
  "--accent": "#ff6a3d",
  "--accent-dim": "#7a3820",
  "--good": "#7fb88a",
  "--warn": "#e0b355",
  "--danger": "#d95d5d",
};

const LIGHT_THEME_DEFAULTS = {
  "--bg": "#f5f3ef",
  "--panel": "#ffffff",
  "--panel-raised": "#f0ede7",
  "--border": "#ddd7cc",
  "--text": "#1c1a17",
  "--text-muted": "#6b6459",
  "--accent": "#bd4a2a",
  "--accent-dim": "#f0c4b0",
  "--good": "#297e48",
  "--warn": "#94640d",
  "--danger": "#b83b3b",
};

let currentTheme = { mode: "dark", colors: { ...DARK_THEME_DEFAULTS } };

function applyTheme(theme) {
  const mode = theme && theme.mode === "light" ? "light" : "dark";
  const defaults = mode === "light" ? LIGHT_THEME_DEFAULTS : DARK_THEME_DEFAULTS;
  const overrides = (theme && theme.colors) || {};
  const merged = { ...defaults, ...overrides };
  const root = document.documentElement;
  for (const [key, val] of Object.entries(merged)) {
    root.style.setProperty(key, val);
  }
  currentTheme = { mode, colors: merged };
  syncThemeShortcutBtn();
}

function syncThemeShortcutBtn() {
  const btn = document.getElementById("themeShortcutBtn");
  if (!btn) return;
  const isLight = currentTheme.mode === "light";
  btn.innerHTML = `<i class="bi ${isLight ? "bi-sun-fill" : "bi-moon-stars-fill"}"></i>`;
  btn.title = isLight ? "Switch to dark mode" : "Switch to light mode";
}

document.getElementById("themeShortcutBtn").addEventListener("click", async () => {
  const newMode = currentTheme.mode === "light" ? "dark" : "light";
  const defaults = newMode === "light" ? LIGHT_THEME_DEFAULTS : DARK_THEME_DEFAULTS;
  currentTheme = { mode: newMode, colors: { ...defaults } };
  applyTheme(currentTheme);
  try {
    await api("/api/theme", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: currentTheme.mode, colors: currentTheme.colors }),
    });
  } catch (err) {
    console.error("Failed to save theme mode:", err);
  }
});

async function loadTheme() {
  try {
    const res = await api("/api/theme");
    const data = await res.json();
    applyTheme(data.theme);
  } catch (err) {
    console.error("Failed to load theme, using default:", err);
    applyTheme(null);
  }
}

const navSettingsColors = document.getElementById("navSettingsColors");
const themeColorGrid = document.getElementById("themeColorGrid");
const themeResult = document.getElementById("themeResult");
const themeSaveBtn = document.getElementById("themeSaveBtn");
const themeResetBtn = document.getElementById("themeResetBtn");

function renderThemeEditor() {
  document.querySelectorAll(".theme-mode-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === currentTheme.mode);
  });

  themeColorGrid.innerHTML = Object.entries(THEME_VAR_LABELS)
    .map(
      ([cssVar, label]) => `
      <div class="theme-color-item">
        <input type="color" data-var="${cssVar}" value="${currentTheme.colors[cssVar]}" />
        <label>${label}</label>
      </div>`
    )
    .join("");

  themeColorGrid.querySelectorAll("input[type='color']").forEach((input) => {
    input.addEventListener("input", () => {
      const cssVar = input.dataset.var;
      currentTheme.colors[cssVar] = input.value;
      document.documentElement.style.setProperty(cssVar, input.value);
    });
  });
}

document.querySelectorAll(".theme-mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.mode;
    const defaults = mode === "light" ? LIGHT_THEME_DEFAULTS : DARK_THEME_DEFAULTS;
    currentTheme = { mode, colors: { ...defaults } };
    applyTheme(currentTheme);
    renderThemeEditor();
  });
});

navSettingsColors.addEventListener("click", async () => {
  themeResult.style.display = "none";
  state.lastNavSection = "settings";
  setContentView("settings-colors");
  await loadTheme();
  renderThemeEditor();
});

themeSaveBtn.addEventListener("click", async () => {
  themeSaveBtn.disabled = true;
  try {
    const res = await api("/api/theme", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: currentTheme.mode, colors: currentTheme.colors }),
    });
    if (!res.ok) throw new Error("Could not save theme");
    themeResult.style.display = "block";
    themeResult.className = "settings-result ok";
    themeResult.textContent = "Saved.";
    showToast("Theme saved", "success");
  } catch (err) {
    themeResult.style.display = "block";
    themeResult.className = "settings-result err";
    themeResult.textContent = err.message;
    showToast(`Could not save theme: ${err.message}`, "error");
  } finally {
    themeSaveBtn.disabled = false;
  }
});

themeResetBtn.addEventListener("click", async () => {
  try {
    await api("/api/theme", { method: "DELETE" });
    await loadTheme();
    renderThemeEditor();
    themeResult.style.display = "block";
    themeResult.className = "settings-result ok";
    themeResult.textContent = "Reset to default.";
    showToast("Theme reset to default", "success");
  } catch (err) {
    console.error("Failed to reset theme:", err);
    showToast(`Could not reset theme: ${err.message}`, "error");
  }
});

// ---------- Current user + admin team panel ----------
const usernameTag = document.getElementById("usernameTag");
const navSettingsTeam = document.getElementById("navSettingsTeam");
const navSettingsLimits = document.getElementById("navSettingsLimits");
const usersList = document.getElementById("usersList");
const newUsername = document.getElementById("newUsername");
const newUserPassword = document.getElementById("newUserPassword");
const newUserIsAdmin = document.getElementById("newUserIsAdmin");
const adminResult = document.getElementById("adminResult");
const adminCreateBtn = document.getElementById("adminCreateBtn");

let currentUserId = null;

function showAdminResult(kind, text) {
  adminResult.style.display = "block";
  adminResult.className = `settings-result ${kind}`;
  adminResult.textContent = text;
}
function hideAdminResult() {
  adminResult.style.display = "none";
}

function userRowHtml(u) {
  const isSelf = u.id === currentUserId;
  return `
    <div class="user-row" data-user-id="${u.id}">
      <div class="user-row-main">
        <span class="user-row-name">${u.username}${u.role === "admin" ? '<span class="user-role-badge">admin</span>' : ""}</span>
        <span class="user-row-meta">joined ${(u.createdAt || "").slice(0, 10)}</span>
      </div>
      ${isSelf ? "" : `<button type="button" class="small-btn danger-btn" data-action="delete-user" data-id="${u.id}">Remove</button>`}
    </div>`;
}

async function loadUsers() {
  usersList.innerHTML = `<div class="api-keys-empty">Loading…</div>`;
  try {
    const res = await api("/api/users");
    const rows = await res.json();
    usersList.innerHTML = rows.map(userRowHtml).join("");
  } catch (err) {
    usersList.innerHTML = `<div class="api-keys-empty">Could not load accounts.</div>`;
  }
}

async function loadWhoami() {
  try {
    const res = await api("/api/whoami");
    const data = await res.json();
    currentUserId = data.userId;
    usernameTag.textContent = `${data.username} (${data.role})`;
    navSettingsTeam.style.display = data.role === "admin" ? "flex" : "none";
  } catch (err) {
    console.error("Failed to load current user:", err);
  }
}

navSettingsTeam.addEventListener("click", async () => {
  newUsername.value = "";
  newUserPassword.value = "";
  newUserIsAdmin.checked = false;
  hideAdminResult();
  state.lastNavSection = "settings";
  setContentView("settings-team");
  await loadUsers();
});

// ---------- Limits Usage page ----------
// The exact free-tier numbers below are Google's commonly-published figures
// as of mid-2026 - Google has changed these multiple times (e.g. a 50-80%
// cut in December 2025), and can again without notice. These are shown as
// an approximate reference point, not a guarantee - the "this month" usage
// numbers next to them are real and pulled from your own account.
const USAGE_LIMITS_INFO = [
  {
    title: "Google Places API",
    icon: "bi-geo-alt-fill",
    provider: "google_places",
    usedFor: "Hunting for new leads - every search that finds businesses in the Hunt board uses this API.",
    keyLink: "https://console.cloud.google.com/google/maps-apis/credentials",
    keyLinkLabel: "console.cloud.google.com (Maps Platform credentials)",
    notes: [
      "Billed via a monthly free credit (not a flat request count) - Essentials-tier fields (name, address, phone, website) are the cheapest; adding ratings pulls in Pro-tier pricing.",
      "A reasonable rule of thumb: a few thousand Essentials-tier searches per month comfortably fits inside the free credit for most solo/small-team use - exact math depends on which fields you request.",
    ],
    link: "https://mapsplatform.google.com/pricing/",
    linkLabel: "Current official Places API pricing",
  },
  {
    title: "Groq API",
    icon: "bi-lightning-charge-fill",
    provider: "groq",
    usedFor: "First provider tried in the AI fallback chain for both business analysis (Inspect) and outreach content generation - fast, generous free tier.",
    keyLink: "https://console.groq.com/keys",
    keyLinkLabel: "console.groq.com/keys",
    notes: [
      "Free tier (as commonly published mid-2026): roughly 500-14,400 requests/day depending on the model, with no credit card required. Runs open-source models (Llama, Qwen, GPT-OSS, and others) rather than a proprietary model.",
      "Each Inspect run uses about 1 request; each piece of generated outreach content (per platform) uses about 1 request.",
    ],
    link: "https://console.groq.com/docs/rate-limits",
    linkLabel: "Current official Groq rate limits",
  },
  {
    title: "Gemini API",
    icon: "bi-stars",
    provider: "gemini",
    usedFor: "Second provider in the AI fallback chain (used if Groq is unavailable or rate-limited) - business analysis and content generation.",
    keyLink: "https://aistudio.google.com/apikey",
    keyLinkLabel: "aistudio.google.com/apikey",
    notes: [
      "Free tier (Gemini 2.5 Flash, as commonly published mid-2026): roughly 10-15 requests/minute and 250-1,500 requests/day. Google has changed these figures more than once without notice, so treat this as a ballpark, not a guarantee.",
      "Each Inspect run uses about 1 request; each piece of generated outreach content (per platform) uses about 1 request.",
    ],
    link: "https://ai.google.dev/gemini-api/docs/rate-limits",
    linkLabel: "Current official Gemini rate limits",
  },
  {
    title: "DeepSeek API",
    icon: "bi-cpu-fill",
    provider: "deepseek",
    usedFor: "Last provider in the AI fallback chain (used only if both Groq and Gemini are unavailable) - business analysis and content generation.",
    keyLink: "https://platform.deepseek.com/api_keys",
    keyLinkLabel: "platform.deepseek.com/api_keys",
    notes: [
      "Not a recurring free tier - new accounts get a one-time free token grant (no credit card), after which it switches to pay-as-you-go at very low per-token rates. Best used as a fallback held in reserve rather than a primary provider.",
    ],
    link: "https://api-docs.deepseek.com/quick_start/pricing",
    linkLabel: "Current official DeepSeek pricing",
  },
  {
    title: "PageSpeed Insights",
    icon: "bi-speedometer2",
    provider: null,
    usedFor: "Checks a business's website loading speed and mobile-friendliness during Inspect - no API key needed at this app's usage volume.",
    keyLink: null,
    keyLinkLabel: null,
    notes: [
      "Free with no API key required at the volume this app uses it (one check per Inspect run on a business's website). Google doesn't publish a hard cap for this usage level.",
    ],
    link: "https://developers.google.com/speed/docs/insights/v5/get-started",
    linkLabel: "PageSpeed Insights API docs",
  },
];

const PROVIDER_ENDPOINT_KEY = { google_places: "google_places", gemini: "gemini", groq: "groq", deepseek: "deepseek" };
const PROVIDER_SUMMARY_KEY = { google_places: "google_places", gemini: "gemini", groq: "groq", deepseek: "deepseek" };

function usageCardHtml(info, usage) {
  const summary = info.provider ? usage[PROVIDER_SUMMARY_KEY[info.provider]] : null;
  const usageLine = summary
    ? `<div class="mono" style="font-size:12px; color:var(--accent); margin-bottom:10px;">This month: ${summary.totalRequests} requests${info.provider === "google_places" ? ` · ${summary.totalLeads} leads captured` : ""}</div>`
    : "";
  const chartSectionId = `limits-${info.provider || "pagespeed"}`;
  return `
    <div class="settings-card">
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
        <i class="bi ${info.icon}" style="color:var(--accent); font-size:16px;"></i>
        <strong style="font-family:var(--font-display);">${info.title}</strong>
      </div>
      ${usageLine}
      ${info.notes.map((n) => `<p class="hint" style="margin:0 0 8px 0;">${n}</p>`).join("")}
      <p class="hint" style="margin:0 0 8px 0;"><strong style="color:var(--text);">What it's used for:</strong> ${info.usedFor}</p>
      ${info.keyLink ? `<p class="hint" style="margin:0 0 10px 0;"><strong style="color:var(--text);">Get a key:</strong> <a href="${info.keyLink}" target="_blank" rel="noopener" class="theme-link">${info.keyLinkLabel}</a></p>` : ""}
      <a href="${info.link}" target="_blank" rel="noopener" class="theme-link" style="font-size:12px;">${info.linkLabel} <i class="bi bi-box-arrow-up-right"></i></a>
      ${info.provider ? `<div style="margin-top:14px;">${buildProviderUsageSectionHtml(chartSectionId, info.provider === "google_places")}</div>` : ""}
    </div>`;
}

navSettingsLimits.addEventListener("click", async () => {
  state.lastNavSection = "settings";
  setContentView("settings-limits");
  const body = document.getElementById("limitsUsageBody");
  body.innerHTML = `<p class="hint">Loading…</p>`;
  try {
    const res = await api("/api/settings/usage-summary");
    const usage = await res.json();
    body.innerHTML =
      `<p class="hint" style="margin-bottom:16px;">Numbers marked "This month" are your real usage, pulled from your own account. The free-tier figures next to them are commonly-published reference numbers as of mid-2026 - providers have changed these before without notice, so use the linked official pages for anything you need to rely on exactly.</p>` +
      USAGE_LIMITS_INFO.map((info) => usageCardHtml(info, usage)).join("");

    for (const info of USAGE_LIMITS_INFO) {
      if (info.provider) await loadAndRenderProviderUsage(info.provider, `limits-${info.provider}`, info.provider === "google_places");
    }
  } catch (err) {
    body.innerHTML = `<p class="hint">Could not load usage data.</p>`;
  }
});

adminCreateBtn.addEventListener("click", async () => {
  const username = newUsername.value.trim();
  const password = newUserPassword.value;
  if (!username || !password) {
    showAdminResult("err", "Username and password are required.");
    return;
  }
  adminCreateBtn.disabled = true;
  try {
    const res = await api("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, role: newUserIsAdmin.checked ? "admin" : "member" }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not create account");
    showAdminResult("ok", `Account "${data.username}" created. They can log in now with the password you set.`);
    showToast(`Team account "${data.username}" created`, "success");
    newUsername.value = "";
    newUserPassword.value = "";
    newUserIsAdmin.checked = false;
    await loadUsers();
  } catch (err) {
    showAdminResult("err", err.message);
    showToast(`Could not create account: ${err.message}`, "error");
  } finally {
    adminCreateBtn.disabled = false;
  }
});

usersList.addEventListener("click", async (e) => {
  const btn = e.target.closest('[data-action="delete-user"]');
  if (!btn) return;
  const id = btn.dataset.id;
  const row = usersList.querySelector(`[data-user-id="${id}"]`);
  const username = row ? row.querySelector(".user-row-name").textContent : "this account";

  const confirmed = await openModal({
    title: `Remove ${username}?`,
    message: "This permanently deletes their account and every niche, catch log, and lead they created. This cannot be undone.",
    confirmText: "Remove",
    danger: true,
  });
  if (!confirmed) return;

  try {
    const res = await api(`/api/users/${id}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not remove account");
    showToast(`Account "${username}" removed`, "success");
    await loadUsers();
  } catch (err) {
    showAdminResult("err", err.message);
    showToast(`Could not remove account: ${err.message}`, "error");
  }
});

settingsTestNewBtn.addEventListener("click", async () => {
  const apiKey = newKeyValue.value.trim();
  if (!apiKey) {
    showSettingsResult("bad", "Paste an API key first.");
    return;
  }
  settingsTestNewBtn.disabled = true;
  settingsTestNewBtn.textContent = "Testing…";
  try {
    const res = await api("/api/settings/keys/test-value", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
    });
    const data = await res.json();
    if (data.ok) {
      showSettingsResult("ok", "Success — this key works with Places API (New).");
    } else {
      showSettingsResult("bad", data.error || "That key didn't work.");
    }
  } catch (err) {
    showSettingsResult("bad", err.message || "Test failed.");
  } finally {
    settingsTestNewBtn.disabled = false;
    settingsTestNewBtn.textContent = "Test";
  }
});

settingsSaveNewBtn.addEventListener("click", async () => {
  const label = newKeyLabel.value.trim() || "Untitled key";
  const apiKey = newKeyValue.value.trim();
  if (!apiKey) {
    showSettingsResult("bad", "Paste an API key first.");
    return;
  }
  settingsSaveNewBtn.disabled = true;
  settingsSaveNewBtn.textContent = "Saving…";
  try {
    const res = await api("/api/settings/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label, apiKey }),
    });
    const data = await res.json();
    if (!res.ok) {
      showSettingsResult("bad", data.error || "Could not save this key.");
      return;
    }
    showSettingsResult("ok", `Saved "${data.label}" (${data.masked}).`);
    showToast(`API key "${data.label}" saved`, "success");
    newKeyLabel.value = "";
    newKeyValue.value = "";
    await loadApiKeys();
  } catch (err) {
    showSettingsResult("bad", err.message || "Could not save this key.");
    showToast(`Could not save key: ${err.message}`, "error");
  } finally {
    settingsSaveNewBtn.disabled = false;
    settingsSaveNewBtn.textContent = "Test & Save";
  }
});

apiKeysList.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  const id = btn.dataset.id;

  if (action === "activate-key") {
    await api(`/api/settings/keys/${id}/activate`, { method: "POST" });
    hideSettingsResult();
    showToast("Active API key updated", "success");
    await loadApiKeys();
    return;
  }

  if (action === "test-key") {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Testing…";
    try {
      const res = await api(`/api/settings/keys/${id}/test`, { method: "POST" });
      const data = await res.json();
      showSettingsResult(data.ok ? "ok" : "bad", data.ok ? "Success — this key still works." : data.error || "This key no longer works.");
      showToast(data.ok ? "Key test succeeded" : `Key test failed: ${data.error || "no longer works"}`, data.ok ? "success" : "error");
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
    return;
  }

  if (action === "delete-key") {
    const row = btn.closest(".api-key-row");
    const label = row.querySelector(".api-key-label").textContent;
    const confirmed = await openModal({
      title: `Delete key "${label}"?`,
      message: "This cannot be undone. If this was the active key, hunting will stop working until another key is added or activated.",
      confirmText: "Delete",
      danger: true,
    });
    if (!confirmed) return;
    await api(`/api/settings/keys/${id}`, { method: "DELETE" });
    hideSettingsResult();
    showToast(`API key "${label}" deleted`, "success");
    await loadApiKeys();
    return;
  }
});

// ---------- Modal system (replaces browser prompt/confirm) ----------
const modalOverlay = document.getElementById("modalOverlay");
const modalTitle = document.getElementById("modalTitle");
const modalMessage = document.getElementById("modalMessage");
const modalInputWrap = document.getElementById("modalInputWrap");
const modalInputLabel = document.getElementById("modalInputLabel");
const modalInput = document.getElementById("modalInput");
const modalCancelBtn = document.getElementById("modalCancelBtn");
const modalConfirmBtn = document.getElementById("modalConfirmBtn");

let modalResolve = null;

function openModal({ title, message = null, inputLabel = null, inputValue = "", confirmText = "Confirm", danger = false }) {
  modalTitle.textContent = title;

  if (message) {
    modalMessage.textContent = message;
    modalMessage.style.display = "block";
  } else {
    modalMessage.style.display = "none";
  }

  if (inputLabel) {
    modalInputWrap.style.display = "flex";
    modalInputLabel.textContent = inputLabel;
    modalInput.value = inputValue;
  } else {
    modalInputWrap.style.display = "none";
  }

  modalConfirmBtn.textContent = confirmText;
  modalConfirmBtn.classList.toggle("danger-btn", danger);
  modalOverlay.style.display = "flex";
  if (inputLabel) setTimeout(() => modalInput.focus(), 30);

  return new Promise((resolve) => {
    modalResolve = resolve;
  });
}

function closeModal(result) {
  modalOverlay.style.display = "none";
  if (modalResolve) {
    modalResolve(result);
    modalResolve = null;
  }
}

modalCancelBtn.addEventListener("click", () => closeModal(null));
modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) closeModal(null);
});
modalConfirmBtn.addEventListener("click", () => {
  const hasInput = modalInputWrap.style.display !== "none";
  closeModal(hasInput ? modalInput.value.trim() : true);
});
modalInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    modalConfirmBtn.click();
  }
});

// Escape closes whatever's currently open - the confirm/prompt modal takes
// priority, otherwise any open dropdown-style popup gets closed. Doesn't
// touch the sidebar accordion sections (Hunt/Reach Out/Pinned/Reports),
// since those are persistent navigation, not transient popups.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (modalOverlay.style.display !== "none") {
    closeModal(null);
    return;
  }
  document
    .querySelectorAll(".theme-dropdown.open, [data-export-menu].open, #exportViewMenu.open, .row-status-dropdown.open")
    .forEach((el) => el.classList.remove("open"));
});

// ---------- DOM refs ----------
const searchForm = document.getElementById("searchForm");
const huntBtn = document.getElementById("huntBtn");
const searchStatus = document.getElementById("searchStatus");
const recordsBody = document.getElementById("recordsBody");
const emptyState = document.getElementById("emptyState");
const quotaRemainingEl = document.getElementById("quotaRemaining");
const quotaRingFill = document.getElementById("quotaRingFill");

const filterSearch = document.getElementById("filterSearch");
const clearScopeBtn = document.getElementById("clearScopeBtn");
const scopeLine = document.getElementById("scopeLine");

const needDropdown = document.getElementById("needDropdown");
const needDropdownTrigger = document.getElementById("needDropdownTrigger");
const needDropdownPanel = document.getElementById("needDropdownPanel");
const needDropdownLabel = document.getElementById("needDropdownLabel");

const sortDropdown = document.getElementById("sortDropdown");
const sortDropdownTrigger = document.getElementById("sortDropdownTrigger");
const sortDropdownPanel = document.getElementById("sortDropdownPanel");
const sortDropdownLabel = document.getElementById("sortDropdownLabel");

const quickNicheDropdown = document.getElementById("quickNicheDropdown");
const quickNicheDropdownTrigger = document.getElementById("quickNicheDropdownTrigger");
const quickNicheDropdownPanel = document.getElementById("quickNicheDropdownPanel");
const quickNicheDropdownLabel = document.getElementById("quickNicheDropdownLabel");

const quickCityDropdown = document.getElementById("quickCityDropdown");
const quickCityDropdownTrigger = document.getElementById("quickCityDropdownTrigger");
const quickCityDropdownPanel = document.getElementById("quickCityDropdownPanel");
const quickCityDropdownLabel = document.getElementById("quickCityDropdownLabel");

const boardFilters = document.getElementById("boardFilters");

const scrapeBtn = document.getElementById("scrapeBtn");
const scrapePanel = document.getElementById("scrapePanel");
const scrapeStopBtn = document.getElementById("scrapeStopBtn");
const scrapeRefreshBtn = document.getElementById("scrapeRefreshBtn");
const scrapeStatusLine = document.getElementById("scrapeStatusLine");
const outreachTree = document.getElementById("outreachTree");
const pinnedTree = document.getElementById("pinnedTree");

const paginationRow = document.getElementById("paginationRow");
const pageInfo = document.getElementById("pageInfo");
const prevPageBtn = document.getElementById("prevPageBtn");
const nextPageBtn = document.getElementById("nextPageBtn");

const filterState = { status: "", need: "", inspected: false };
const SORT_OPTIONS = [
  { value: "created_at", label: "Latest first", color: "#948d80" },
  { value: "name", label: "Name (A-Z)", color: "#7fa8d9" },
  { value: "rating", label: "Rating (high-low)", color: "#7fb88a" },
  { value: "needs_count", label: "Most needed first", color: "#ff6a3d" },
];

const catchLogNameInput = document.getElementById("catchLogName");

const nichesTree = document.getElementById("nichesTree");
const newNicheBtnTree = document.getElementById("newNicheBtnTree");

const huntFormPanel = document.getElementById("huntFormPanel");
const boardPanel = document.getElementById("boardPanel");
const reportsPanel = document.getElementById("reportsPanel");
const newHuntLeafBtn = document.getElementById("newHuntLeafBtn");

// Themed niche dropdown
const nicheDropdown = document.getElementById("nicheDropdown");
const nicheDropdownTrigger = document.getElementById("nicheDropdownTrigger");
const nicheDropdownPanel = document.getElementById("nicheDropdownPanel");
const nicheDropdownList = document.getElementById("nicheDropdownList");
const nicheDropdownLabel = document.getElementById("nicheDropdownLabel");
const nicheDropdownNewBtn = document.getElementById("nicheDropdownNewBtn");

const RING_CIRCUMFERENCE = 106.8;

const TAG_CLASS_MAP = {
  "Website Design": "website",
  "GMB Optimization": "gmb",
  "Local SEO": "seo",
  "Review Generation": "review",
  "Reputation Management": "rep",
};

const STATUS_COLORS = [
  { value: "", label: "All statuses", color: "#948d80" },
  { value: "new", label: "New", color: "#7fa8d9" },
  { value: "shortlisted", label: "Shortlisted", color: "#e0b355" },
  { value: "contacted", label: "Contacted", color: "#ff6a3d" },
  { value: "engaged", label: "Engaged", color: "#c586e0" },
  { value: "converted", label: "Converted", color: "#4fd1c5" },
  { value: "won", label: "Won", color: "#7fb88a" },
  { value: "rejected", label: "Rejected", color: "#d95d5d" },
];

const NEED_COLORS = [
  { value: "", label: "All needs", color: "#948d80" },
  { value: "Website Design", label: "Website Design", color: "#d95d5d" },
  { value: "GMB Optimization", label: "GMB Optimization", color: "#e0b355" },
  { value: "Local SEO", label: "Local SEO", color: "#7fa8d9" },
  { value: "Review Generation", label: "Review Generation", color: "#7fb88a" },
  { value: "Reputation Management", label: "Reputation Management", color: "#ff6a3d" },
];

const state = {
  niches: [],
  catchLogs: [],
  activeCatchLogId: null,
  activeNicheId: null, // quick-filter: show all cities within this niche (board mode only)
  openNicheIds: new Set(),
  selectedNicheId: null, // for the Hunt form's niche dropdown

  contentView: "huntForm", // "huntForm" | "board" | "reports" - which content panel is shown
  contactedPlatform: "hostinger", // "hostinger" | "gmail" - which platform's data the Contacted pages show
  mode: "board", // "board" | "outreach"
  page: 1,
  pageSize: 50,
  sortBy: "created_at",
  sortDir: null, // null = use the column's sensible default direction

  outreach: {
    nicheId: null,
    catchLogId: null,
    status: "shortlisted",
  },
  outreachOpenNicheIds: new Set(),
  outreachOpenCityIds: new Set(), // "nicheId:catchLogId" -> expanded to show status leaves
  outreachSummaries: new Map(), // nicheId -> [{catchLogId, catchLogName, shortlisted, contacted, won}]

  pinned: {
    catchLogId: null, // when set, board shows only pinned leads in this catch log
  },
  pinnedOpenNicheIds: new Set(),

  expandedLeadId: null, // which lead's Inspect/Generate panel is currently open (Reach Out only)
  currentLeadsById: new Map(), // id -> full lead object, for the expand panel to reference
};

function setContentView(view) {
  state.contentView = view;
  const ALL_VIEWS = {
    huntForm: huntFormPanel,
    board: boardPanel,
    reports: reportsPanel,
    "settings-api": document.getElementById("settingsApiView"),
    "settings-gemini": document.getElementById("settingsGeminiView"),
    "settings-groq": document.getElementById("settingsGroqView"),
    "settings-deepseek": document.getElementById("settingsDeepseekView"),
    "settings-colors": document.getElementById("settingsColorsView"),
    "settings-team": document.getElementById("settingsTeamView"),
    "settings-account": document.getElementById("settingsAccountView"),
    "settings-limits": document.getElementById("settingsLimitsView"),
    "contacted-setup": document.getElementById("contactedSetupView"),
    "contacted-tracking": document.getElementById("contactedTrackingView"),
    "contacted-history": document.getElementById("contactedHistoryView"),
    "contacted-reports": document.getElementById("contactedReportsView"),
    "contacted-alerts": document.getElementById("contactedAlertsView"),
    "contacted-campaigns": document.getElementById("contactedCampaignsView"),
    "contacted-campaign-detail": document.getElementById("contactedCampaignDetailView"),
  };
  Object.entries(ALL_VIEWS).forEach(([name, el]) => {
    if (!el) return;
    // Toggle a class instead of setting inline style.display - an inline
    // style always overrides the stylesheet regardless of specificity, so
    // forcing display:block here was silently breaking board-panel's own
    // "display: flex" CSS (needed for its records-wrap to correctly
    // compute a bounded, scrollable height instead of growing to fit all
    // content unboundedly).
    el.classList.toggle("view-hidden", name !== view);
  });

  document.querySelectorAll(".nav-section-header").forEach((btn) => {
    btn.classList.toggle("active-view", btn.dataset.section === view || (view === "board" && btn.dataset.section === state.lastNavSection));
  });
  document.querySelectorAll(".nav-leaf[data-goto]").forEach((leaf) => {
    leaf.classList.toggle("active", leaf.dataset.goto === view);
  });

  if (view === "reports") {
    loadReportsFilterOptions();
    loadReports();
  }
}

function tagClass(tag) {
  return TAG_CLASS_MAP[tag] || "low";
}

// ---------- Left panel collapse (sticky when open, per request) ----------
const leftCol = document.getElementById("leftCol");
const layoutEl = document.querySelector("main.layout");
const collapseToggleBtn = document.getElementById("collapseToggleBtn");

collapseToggleBtn.addEventListener("click", () => {
  const collapsed = leftCol.classList.toggle("collapsed");
  layoutEl.classList.toggle("panel-collapsed", collapsed);
  collapseToggleBtn.title = collapsed ? "Expand panel" : "Collapse panel";
});

// ---------- Filters bar collapse toggle ----------
document.getElementById("filtersToggleBtn").addEventListener("click", () => {
  boardFilters.classList.toggle("collapsed");
});

// ---------- Export current view (CSV/XLSX/PDF, same filters as the board) ----------
const exportViewMenu = document.getElementById("exportViewMenu");
exportViewMenu.querySelector('[data-action="toggle-export"]').addEventListener("click", (e) => {
  e.stopPropagation();
  const wasOpen = exportViewMenu.classList.contains("open");
  document.querySelectorAll("[data-export-menu].open, #exportViewMenu.open").forEach((m) => m.classList.remove("open"));
  if (!wasOpen) exportViewMenu.classList.add("open");
});
document.addEventListener("click", (e) => {
  if (!exportViewMenu.contains(e.target)) exportViewMenu.classList.remove("open");
});
exportViewMenu.querySelectorAll("[data-export-view]").forEach((link) => {
  link.addEventListener("click", (e) => {
    e.preventDefault();
    const format = link.dataset.exportView;
    const params = new URLSearchParams();
    params.set("sortBy", state.sortBy);
    if (state.sortDir) params.set("sortDir", state.sortDir);

    if (state.mode === "outreach") {
      if (state.outreach.catchLogId) {
        params.set("catchLogId", state.outreach.catchLogId);
        params.set("status", state.outreach.status);
      }
    } else {
      params.set("status", "new");
      if (filterSearch.value) params.set("search", filterSearch.value);
      if (filterState.need) params.set("need", filterState.need);
      if (state.activeCatchLogId) params.set("catchLogId", state.activeCatchLogId);
      else if (state.activeNicheId) params.set("nicheId", state.activeNicheId);
    }

    window.location.href = `/api/leads/export/${format}?${params.toString()}`;
    exportViewMenu.classList.remove("open");
    showToast(`Exporting current view as ${format.toUpperCase()}…`, "info");
  });
});

// ---------- Contact deep-scrape (separate Python microservice) ----------
let scrapePollTimer = null;

function updateScrapeProgress(status) {
  const c = status.counts || {};
  const total = c.total || 0;
  const done = c.done || 0;
  const scraping = c.scraping || 0;
  const failed = c.failed || 0;
  const pending = c.pending || 0;

  document.getElementById("scrapeTotal").textContent = total;
  document.getElementById("scrapeRequests").textContent = status.requests_made || 0;
  document.getElementById("scrapeDone").textContent = done;
  document.getElementById("scrapeScraping").textContent = scraping;
  document.getElementById("scrapeFailed").textContent = failed;
  document.getElementById("scrapePending").textContent = pending;

  const segDone = document.getElementById("scrapeSegDone");
  const segScraping = document.getElementById("scrapeSegScraping");
  const segFailed = document.getElementById("scrapeSegFailed");
  const segPending = document.getElementById("scrapeSegPending");

  if (total === 0) {
    segDone.style.width = "0%";
    segScraping.style.width = "0%";
    segFailed.style.width = "0%";
    segPending.style.width = "100%";
  } else {
    segDone.style.width = (done / total) * 100 + "%";
    segScraping.style.width = (scraping / total) * 100 + "%";
    segFailed.style.width = (failed / total) * 100 + "%";
    segPending.style.width = (pending / total) * 100 + "%";
  }

  scrapeStopBtn.style.display = status.jobRunning ? "inline-block" : "none";

  if (status.jobRunning) {
    scrapeStatusLine.textContent = status.stop_requested
      ? "Stopping — finishing requests already in flight…"
      : "Scraping — checking each business's website for contact info…";
  } else if (status.merged) {
    scrapeStatusLine.textContent = `Done. ${status.mergedCount} record(s) updated with whatever contact info was found.`;
  } else {
    scrapeStatusLine.textContent = "";
  }
}

async function pollScrapeStatus() {
  const catchLogId = scrapeBtn.dataset.catchLogId;
  if (!catchLogId) return;

  try {
    const res = await api(`/api/catch-logs/${catchLogId}/scrape/status`);
    const status = await res.json();

    if (!status.active) {
      clearInterval(scrapePollTimer);
      scrapePollTimer = null;
      if (status.merged) {
        updateScrapeProgress(status);
        await loadLeads(); // refresh so new social icons show up
      }
      return;
    }

    updateScrapeProgress(status);
  } catch (err) {
    console.error("Failed to poll scrape status:", err);
    clearInterval(scrapePollTimer);
    scrapePollTimer = null;
    scrapeStatusLine.textContent = "Lost connection to the scraper service.";
  }
}

const scrapeStartBtn = document.getElementById("scrapeStartBtn");

// Clicking the icon only shows/hides the panel and checks the CURRENT
// status (read-only) - it never starts a scrape on its own. This also
// means switching between catch logs and reopening the panel always shows
// that specific catch log's real state instead of stale numbers left over
// from whatever was viewed before.
scrapeBtn.addEventListener("click", async () => {
  const isOpen = scrapePanel.style.display !== "none";
  if (isOpen) {
    scrapePanel.style.display = "none";
    if (scrapePollTimer) {
      clearInterval(scrapePollTimer);
      scrapePollTimer = null;
    }
    return;
  }

  scrapePanel.style.display = "block";
  scrapeStatusLine.textContent = "Checking current status…";
  await pollScrapeStatus();
  // If a job is already running for this catch log (e.g. the panel was
  // closed and reopened, or another tab started it), resume live polling.
  if (scrapePollTimer === null) {
    const catchLogId = scrapeBtn.dataset.catchLogId;
    if (catchLogId) {
      try {
        const res = await api(`/api/catch-logs/${catchLogId}/scrape/status`);
        const status = await res.json();
        if (status.active && status.jobRunning) {
          scrapePollTimer = setInterval(pollScrapeStatus, 2500);
        }
      } catch (err) {
        console.error("Failed to check scrape status on open:", err);
      }
    }
  }
});

scrapeStartBtn.addEventListener("click", async () => {
  const catchLogId = scrapeBtn.dataset.catchLogId;
  if (!catchLogId) return;

  scrapeStatusLine.textContent = "Starting…";
  scrapeStartBtn.disabled = true;

  try {
    // Scrapes exactly what the current view shows - same filters as the
    // board itself (Hunt is always status=new, plus whatever search/need/
    // inspected filters are currently active), not indiscriminately every
    // lead ever caught in this catch log.
    const params = new URLSearchParams();
    params.set("status", "new");
    if (filterSearch.value) params.set("search", filterSearch.value);
    if (filterState.need) params.set("need", filterState.need);
    if (filterState.inspected) params.set("inspected", "1");

    const res = await api(`/api/catch-logs/${catchLogId}/scrape/start?${params.toString()}`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not start scrape");

    scrapeStatusLine.textContent = `Scraping ${data.queued} business(es)…`;
    if (scrapePollTimer) clearInterval(scrapePollTimer);
    scrapePollTimer = setInterval(pollScrapeStatus, 2500);
    await pollScrapeStatus();
  } catch (err) {
    scrapeStatusLine.textContent = err.message;
  } finally {
    scrapeStartBtn.disabled = false;
  }
});

scrapeStopBtn.addEventListener("click", async () => {
  const catchLogId = scrapeBtn.dataset.catchLogId;
  if (!catchLogId) return;
  scrapeStopBtn.disabled = true;
  try {
    await api(`/api/catch-logs/${catchLogId}/scrape/stop`, { method: "POST" });
  } catch (err) {
    console.error("Failed to stop scrape:", err);
  } finally {
    scrapeStopBtn.disabled = false;
  }
});

scrapeRefreshBtn.addEventListener("click", async () => {
  // Refresh should genuinely clear what's shown, not just silently leave
  // stale numbers from a previous completed/stopped run - zero the
  // display first, then repopulate it with whatever's actually true right
  // now (a live job's real numbers if one is running, or empty if not).
  ["scrapeTotal", "scrapeRequests", "scrapeDone", "scrapeScraping", "scrapeFailed", "scrapePending"].forEach((id) => {
    document.getElementById(id).textContent = "0";
  });
  scrapeStatusLine.textContent = "Refreshing…";
  await pollScrapeStatus();
});

// ---------- Sidebar nav sections (Hunt / Reach Out collapsible; Reports single page) ----------
document.querySelectorAll(".nav-section-header").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const section = btn.dataset.section;

    // If the sidebar itself is collapsed to icon-only, clicking any section
    // icon expands it back out first - a collapsed sidebar can't usefully
    // show a nested Niche/City tree, so there's no reason to click an icon
    // there except to want the full panel back.
    if (leftCol.classList.contains("collapsed")) {
      leftCol.classList.remove("collapsed");
      layoutEl.classList.remove("panel-collapsed");
      collapseToggleBtn.title = "Collapse panel";
    }

    if (section === "reports") {
      state.lastNavSection = "reports";
      setContentView("reports");
      return;
    }

    // Hunt / Reach Out headers toggle their section open/closed (sidebar
    // accordion), independent of which content view is currently showing.
    const navSection = btn.closest(".nav-section");
    const willOpen = !navSection.classList.contains("open");

    // Accordion behavior: only one section (Hunt / Reach Out / Settings)
    // stays open at a time - opening one closes the others automatically.
    document.querySelectorAll(".nav-section.open").forEach((s) => {
      if (s !== navSection) s.classList.remove("open");
    });
    navSection.classList.toggle("open", willOpen);

    if (section === "reachout" && navSection.classList.contains("open")) {
      await renderOutreachTree();
    }
    if (section === "pinned" && navSection.classList.contains("open")) {
      await renderPinnedTree();
    }
  });
});

newHuntLeafBtn.addEventListener("click", () => {
  state.lastNavSection = "hunt";
  setContentView("huntForm");
});

function setBoardMode(mode) {
  state.mode = mode;
  state.page = 1;
  if (mode === "outreach") {
    boardFilters.style.display = "none"; // irrelevant in outreach mode - scope is already fixed by the tree click
    boardPanel.style.borderTop = `3px solid ${statusColorFor(state.outreach.status)}`;
  } else {
    boardFilters.style.removeProperty("display"); // let the .collapsed class (toggled by the funnel button) govern visibility
    boardPanel.style.borderTop = "";
  }
  updateScopeLine();
  loadLeads();
}

// ---------- Quota ----------
async function refreshQuota() {
  const res = await api("/api/search/quota");
  const data = await res.json();
  quotaRemainingEl.textContent = data.remaining;
  const fraction = data.cap > 0 ? data.remaining / data.cap : 0;
  quotaRingFill.style.strokeDashoffset = RING_CIRCUMFERENCE * (1 - fraction);
}

// ---------- Niche dropdown (Hunt form) ----------
nicheDropdownTrigger.addEventListener("click", () => {
  const wasOpen = nicheDropdown.classList.contains("open");
  [nicheDropdown, needDropdown, sortDropdown, quickNicheDropdown, quickCityDropdown].forEach((d) => d.classList.remove("open"));
  if (!wasOpen) nicheDropdown.classList.add("open");
});

function renderNicheDropdown() {
  if (state.niches.length === 0) {
    nicheDropdownList.innerHTML = `<div class="theme-dropdown-item" style="color:var(--text-muted);cursor:default;">No niches yet</div>`;
  } else {
    nicheDropdownList.innerHTML = state.niches
      .map(
        (n) => `<div class="theme-dropdown-item ${n.id === state.selectedNicheId ? "selected" : ""}" data-niche-id="${n.id}">${n.name}</div>`
      )
      .join("");
  }

  if (state.selectedNicheId) {
    const niche = state.niches.find((n) => n.id === state.selectedNicheId);
    nicheDropdownLabel.textContent = niche ? niche.name : "Select a niche…";
  } else {
    nicheDropdownLabel.textContent = "Select a niche…";
  }
}

nicheDropdownList.addEventListener("click", (e) => {
  const item = e.target.closest("[data-niche-id]");
  if (!item) return;
  state.selectedNicheId = Number(item.dataset.nicheId);
  renderNicheDropdown();
  nicheDropdown.classList.remove("open");
});

nicheDropdownNewBtn.addEventListener("click", async () => {
  nicheDropdown.classList.remove("open");
  const name = await openModal({ title: "New niche", inputLabel: "Niche name", confirmText: "Create" });
  if (name) {
    const res = await api("/api/niches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || "Could not create niche");
      return;
    }
    await loadNichesAndLogs();
    state.selectedNicheId = data.id;
    renderNicheDropdown();
  }
});

// ---------- Filter dropdowns (custom-built, not native <select>, so option
// colors render consistently in every browser - Chrome/Safari/macOS in
// particular often ignore CSS on native <option> elements entirely) ----------
function buildFilterDropdown({ options, trigger, panel, label, currentValue, onSelect }) {
  panel.innerHTML = options
    .map(
      (opt) => `
      <div class="theme-dropdown-item filter-item ${opt.value === currentValue ? "selected" : ""}" data-value="${opt.value}">
        <span class="filter-dot" style="background:${opt.color}"></span>${opt.label}
      </div>`
    )
    .join("");

  const selected = options.find((o) => o.value === currentValue);
  label.textContent = selected ? selected.label : options[0].label;

  panel.querySelectorAll("[data-value]").forEach((el) => {
    el.addEventListener("click", () => {
      onSelect(el.dataset.value);
      trigger.closest(".theme-dropdown").classList.remove("open");
    });
  });
}

function renderNeedDropdown() {
  buildFilterDropdown({
    options: NEED_COLORS,
    trigger: needDropdownTrigger,
    panel: needDropdownPanel,
    label: needDropdownLabel,
    currentValue: filterState.need,
    onSelect: (value) => {
      filterState.need = value;
      renderNeedDropdown();
      state.page = 1;
      loadLeads();
    },
  });
}

function renderSortDropdown() {
  buildFilterDropdown({
    options: SORT_OPTIONS,
    trigger: sortDropdownTrigger,
    panel: sortDropdownPanel,
    label: sortDropdownLabel,
    currentValue: state.sortBy,
    onSelect: (value) => {
      state.sortBy = value;
      state.page = 1;
      renderSortDropdown();
      loadLeads();
    },
  });
}

function renderQuickNicheDropdown() {
  const options = [
    { value: "", label: "All niches", color: "#948d80" },
    ...state.niches.map((n) => ({ value: String(n.id), label: n.name, color: "#7fa8d9" })),
  ];
  buildFilterDropdown({
    options,
    trigger: quickNicheDropdownTrigger,
    panel: quickNicheDropdownPanel,
    label: quickNicheDropdownLabel,
    currentValue: state.activeNicheId ? String(state.activeNicheId) : "",
    onSelect: (value) => {
      state.activeNicheId = value ? Number(value) : null;
      state.activeCatchLogId = null; // switching niche clears any specific-city scope
      state.page = 1;
      renderQuickNicheDropdown();
      renderQuickCityDropdown();
      updateScopeLine();
      loadLeads();
    },
  });
}

function renderQuickCityDropdown() {
  const cities = state.activeNicheId
    ? state.catchLogs.filter((l) => l.niche_id === state.activeNicheId)
    : [];
  const options = [
    { value: "", label: state.activeNicheId ? "All cities in niche" : "All cities", color: "#948d80" },
    ...cities.map((c) => ({ value: String(c.id), label: c.name, color: "#7fb88a" })),
  ];
  buildFilterDropdown({
    options,
    trigger: quickCityDropdownTrigger,
    panel: quickCityDropdownPanel,
    label: quickCityDropdownLabel,
    currentValue: state.activeCatchLogId ? String(state.activeCatchLogId) : "",
    onSelect: (value) => {
      state.activeCatchLogId = value ? Number(value) : null;
      state.page = 1;
      renderQuickCityDropdown();
      updateScopeLine();
      loadLeads();
    },
  });
}

const ALL_TOP_DROPDOWNS = [nicheDropdown, needDropdown, sortDropdown, quickNicheDropdown, quickCityDropdown];

[needDropdown, sortDropdown, quickNicheDropdown, quickCityDropdown].forEach((dd) => {
  const trigger = dd.querySelector(".theme-dropdown-trigger");
  trigger.addEventListener("click", () => {
    const wasOpen = dd.classList.contains("open");
    ALL_TOP_DROPDOWNS.forEach((d) => d.classList.remove("open"));
    if (!wasOpen) dd.classList.add("open");
  });
});
document.addEventListener("click", (e) => {
  ALL_TOP_DROPDOWNS.forEach((d) => {
    if (!d.contains(e.target)) d.classList.remove("open");
  });
});

// ---------- Niches + catch logs ----------
async function loadNichesAndLogs() {
  const [nichesRes, logsRes] = await Promise.all([api("/api/niches"), api("/api/catch-logs")]);
  state.niches = await nichesRes.json();
  state.catchLogs = await logsRes.json();

  if (!state.selectedNicheId && state.niches.length > 0) {
    state.selectedNicheId = state.niches[0].id;
  }

  renderNicheDropdown();
  renderNichesTree();
  renderQuickNicheDropdown();
  renderQuickCityDropdown();
}

const EXPORT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13"><path d="M12 3v12"/><path d="M7.5 10.5 12 15l4.5-4.5"/><path d="M4.5 19.5h15"/></svg>`;

function exportMenuHtml(kind, id) {
  // kind: "niche" -> csv/xlsx/pdf ; "log" -> csv/pdf
  const base = kind === "niche" ? `/api/niches/${id}/export` : `/api/catch-logs/${id}/export`;
  const links =
    kind === "niche"
      ? `<a href="${base}/csv">CSV</a><a href="${base}/xlsx">XLSX</a><a href="${base}/pdf">PDF</a>`
      : `<a href="${base}/csv">CSV</a><a href="${base}/pdf">PDF</a>`;
  return `
    <div class="export-menu" data-export-menu>
      <button class="icon-btn" data-action="toggle-export" title="Export">${EXPORT_SVG}</button>
      <div class="export-list">${links}</div>
    </div>`;
}

function actionsMenuHtml(kind, id) {
  // kind: "niche" -> csv/xlsx/pdf export options ; "log" -> csv/pdf
  const base = kind === "niche" ? `/api/niches/${id}/export` : `/api/catch-logs/${id}/export`;
  const exportLinks =
    kind === "niche"
      ? `<a href="${base}/csv">Export CSV</a><a href="${base}/xlsx">Export XLSX</a><a href="${base}/pdf">Export PDF</a>`
      : `<a href="${base}/csv">Export CSV</a><a href="${base}/pdf">Export PDF</a>`;
  const renameAction = kind === "niche" ? "rename-niche" : "rename-log";
  const deleteAction = kind === "niche" ? "delete-niche" : "delete-log";
  return `
    <div class="export-menu actions-menu" data-export-menu>
      <button class="icon-btn" data-action="toggle-export" title="Actions"><i class="bi bi-three-dots-vertical"></i></button>
      <div class="export-list actions-list">
        ${exportLinks}
        <button type="button" data-action="${renameAction}" data-id="${id}"><i class="bi bi-pencil"></i> Rename</button>
        <button type="button" data-action="${deleteAction}" data-id="${id}" class="danger-item"><i class="bi bi-trash"></i> Delete</button>
      </div>
    </div>`;
}

function renderNichesTree() {
  if (state.niches.length === 0) {
    nichesTree.innerHTML = `<div class="empty-state">No niches yet. Create one with "+ New" or by running a search.</div>`;
    return;
  }

  nichesTree.innerHTML = state.niches
    .map((niche) => {
      const logs = state.catchLogs.filter((l) => l.niche_id === niche.id);
      const isOpen = state.openNicheIds.has(niche.id);
      const logsHtml = logs
        .map(
          (log) => `
        <div class="catchlog-row ${log.id === state.activeCatchLogId ? "active" : ""}" data-log-id="${log.id}">
          <div class="catchlog-name">${log.name}</div>
          <span class="catchlog-meta">${log.lead_count}R</span>
          ${actionsMenuHtml("log", log.id)}
        </div>`
        )
        .join("");

      const isActiveParent = logs.some((l) => l.id === state.activeCatchLogId) || niche.id === state.activeNicheId;
      return `
      <div class="niche-block ${isOpen ? "open" : ""} ${isActiveParent ? "active-parent" : ""}" data-niche-id="${niche.id}">
        <div class="niche-row" data-action="toggle-niche" data-id="${niche.id}">
          <span class="niche-caret">▶</span>
          <span class="niche-name">${niche.name}</span>
          <span class="niche-count">${logs.length}L | ${niche.lead_count}R</span>
          ${actionsMenuHtml("niche", niche.id)}
        </div>
        <div class="catchlog-list">${logsHtml || '<div class="catchlog-row"><span class="catchlog-meta">No catch logs yet</span></div>'}</div>
      </div>`;
    })
    .join("");
}

// toggle export dropdowns, closing others when one opens
nichesTree.addEventListener("click", (e) => {
  const exportLink = e.target.closest(".export-list a");
  if (exportLink) {
    const format = exportLink.textContent.trim().replace("Export ", "");
    showToast(`Exporting as ${format}…`, "info");
    return; // let the anchor's own href navigation proceed normally
  }

  const toggle = e.target.closest('[data-action="toggle-export"]');
  if (toggle) {
    const menu = toggle.closest("[data-export-menu]");
    const list = menu.querySelector(".export-list");
    const wasOpen = menu.classList.contains("open");
    document.querySelectorAll("[data-export-menu].open").forEach((m) => {
      m.classList.remove("open");
      m.querySelector(".export-list").style.cssText = ""; // clear any fixed-position override
    });
    if (!wasOpen) {
      // Position as fixed (viewport-relative) instead of relying on the
      // default CSS absolute positioning - an absolutely-positioned popover
      // gets visually clipped by the scrollable sidebar tree's
      // "overflow-y: auto" regardless of z-index, since ancestor overflow
      // clips descendants no matter how high their z-index is. Fixed
      // positioning, calculated from the button's real screen coordinates,
      // escapes that clipping entirely.
      const rect = toggle.getBoundingClientRect();
      list.style.position = "fixed";
      list.style.top = `${rect.bottom + 4}px`;
      list.style.right = `${window.innerWidth - rect.right}px`;
      menu.classList.add("open");
    }
    e.stopPropagation();
  }
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("[data-export-menu]")) {
    document.querySelectorAll("[data-export-menu].open").forEach((m) => {
      m.classList.remove("open");
      m.querySelector(".export-list").style.cssText = "";
    });
  }
});

nichesTree.addEventListener("click", async (e) => {
  const target = e.target.closest("[data-action]");
  if (!target || target.dataset.action === "toggle-export") return;
  const action = target.dataset.action;
  const id = target.dataset.id;

  if (action === "toggle-niche") {
    const nicheId = Number(id);
    if (state.openNicheIds.has(nicheId)) state.openNicheIds.delete(nicheId);
    else state.openNicheIds.add(nicheId);
    renderNichesTree();
    return;
  }

  if (action === "rename-niche") {
    const niche = state.niches.find((n) => n.id === Number(id));
    const newName = await openModal({ title: "Rename niche", inputLabel: "Niche name", inputValue: niche.name, confirmText: "Save" });
    if (newName) {
      const res = await api(`/api/niches/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      if (!res.ok) {
        const data = await res.json();
        showToast(data.error || "Rename failed", "error");
      } else {
        showToast(`Niche renamed to "${newName}"`, "success");
      }
      await loadNichesAndLogs();
    }
    return;
  }

  if (action === "delete-niche") {
    const niche = state.niches.find((n) => n.id === Number(id));
    const confirmed = await openModal({
      title: `Delete "${niche.name}"?`,
      message: "This also deletes ALL its catch logs and every record inside them. This cannot be undone.",
      confirmText: "Delete",
      danger: true,
    });
    if (confirmed) {
      await api(`/api/niches/${id}`, { method: "DELETE" });
      showToast(`Niche "${niche.name}" deleted`, "success");
      if (state.activeCatchLogId && state.catchLogs.some((l) => l.id === state.activeCatchLogId && l.niche_id === Number(id))) {
        state.activeCatchLogId = null;
        updateScopeLine();
      }
      if (state.selectedNicheId === Number(id)) state.selectedNicheId = null;
      await loadNichesAndLogs();
      await loadLeads();
    }
    return;
  }

  if (action === "rename-log") {
    const log = state.catchLogs.find((l) => l.id === Number(id));
    const newName = await openModal({ title: "Rename catch log", inputLabel: "Catch log name", inputValue: log.name, confirmText: "Save" });
    if (newName) {
      await api(`/api/catch-logs/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      showToast(`Catch log renamed to "${newName}"`, "success");
      await loadNichesAndLogs();
      if (state.activeCatchLogId === Number(id)) updateScopeLine();
    }
    return;
  }

  if (action === "delete-log") {
    const log = state.catchLogs.find((l) => l.id === Number(id));
    const confirmed = await openModal({
      title: `Delete "${log.name}"?`,
      message: `This deletes all ${log.lead_count} record(s) in this catch log. This cannot be undone.`,
      confirmText: "Delete",
      danger: true,
    });
    if (confirmed) {
      await api(`/api/catch-logs/${id}`, { method: "DELETE" });
      showToast(`Catch log "${log.name}" deleted`, "success");
      if (state.activeCatchLogId === Number(id)) {
        state.activeCatchLogId = null;
        updateScopeLine();
      }
      await loadNichesAndLogs();
      await loadLeads();
    }
    return;
  }
});

// clicking a catch log row itself (not its buttons) sets it as the active scope
nichesTree.addEventListener("click", async (e) => {
  const row = e.target.closest(".catchlog-row");
  if (!row || e.target.closest("[data-action]") || e.target.closest("[data-export-menu]")) return;
  const logId = Number(row.dataset.logId);
  if (!logId) return;
  state.activeCatchLogId = logId;
  state.activeNicheId = null;
  state.page = 1;
  state.lastNavSection = "hunt";
  setContentView("board");
  renderNichesTree();
  renderQuickNicheDropdown();
  renderQuickCityDropdown();
  setBoardMode("board");
});

// ---------- Outreach Report tree ----------
async function getOutreachSummary(nicheId) {
  if (state.outreachSummaries.has(nicheId)) return state.outreachSummaries.get(nicheId);
  const res = await api(`/api/niches/${nicheId}/outreach-summary`);
  const summary = await res.json();
  state.outreachSummaries.set(nicheId, summary);
  return summary;
}

const OUTREACH_STATUS_LIST = [
  { key: "shortlisted", label: "Shortlisted" },
  { key: "contacted", label: "Contacted" },
  { key: "engaged", label: "Engaged" },
  { key: "converted", label: "Converted" },
  { key: "won", label: "Won" },
  { key: "rejected", label: "Rejected" },
];

// Instantly nudges a status-leaf's badge count in the currently-rendered
// Reach Out tree (if that city happens to be expanded/visible right now) -
// avoids waiting on a full tree re-fetch just to reflect a count that
// changed by exactly one.
function adjustOutreachBadgeCount(nicheId, catchLogId, status, delta) {
  const leaf = outreachTree.querySelector(
    `.status-leaf-row[data-niche-id="${nicheId}"][data-log-id="${catchLogId}"][data-status="${status}"]`
  );
  if (!leaf) return;
  const badge = leaf.querySelector(".outreach-badge");
  if (!badge) return;
  const current = parseInt(badge.textContent, 10) || 0;
  badge.textContent = Math.max(current + delta, 0);
}

async function renderOutreachTree() {
  if (state.niches.length === 0) {
    outreachTree.innerHTML = `<div class="empty-state">No niches yet. Create one under Hunt first.</div>`;
    return;
  }

  // Summaries are fetched for every niche (not just open ones) because a
  // niche needs to be hidden entirely once ALL its cities have zero leads
  // outside "new" - that decision can't be made without knowing every
  // niche's totals, regardless of which ones happen to be expanded.
  const allSummaries = await Promise.all(state.niches.map((niche) => getOutreachSummary(niche.id)));

  const blocks = state.niches
    .map((niche, i) => {
      const summary = allSummaries[i];
      const visibleCities = summary.filter((city) => city.total > 0);
      if (visibleCities.length === 0) return null; // hide this niche entirely - nothing to reach out to

      const isOpen = state.outreachOpenNicheIds.has(niche.id);
      let citiesHtml = "";
      if (isOpen) {
        citiesHtml = visibleCities
          .map((city) => {
            const cityKey = `${niche.id}:${city.catchLogId}`;
            const cityOpen = state.outreachOpenCityIds.has(cityKey);

            const statusLeaves = OUTREACH_STATUS_LIST.map(
              (s) => `
              <div class="status-leaf-row ${
                state.outreach.catchLogId === city.catchLogId && state.outreach.status === s.key && state.mode === "outreach"
                  ? "active"
                  : ""
              }" data-niche-id="${niche.id}" data-log-id="${city.catchLogId}" data-status="${s.key}">
                <span class="outreach-badge ${s.key}">${city[s.key]}</span>
                <span class="status-leaf-label">${s.label}</span>
              </div>`
            ).join("");

            const isCityActiveParent = state.mode === "outreach" && state.outreach.catchLogId === city.catchLogId;
            return `
            <div class="catchlog-block ${cityOpen ? "open" : ""}">
              <div class="catchlog-row outreach-city-row ${isCityActiveParent ? "active-parent" : ""}" data-action="toggle-outreach-city" data-niche-id="${niche.id}" data-log-id="${city.catchLogId}">
                <span class="niche-caret small">▶</span>
                <div class="catchlog-name">${city.catchLogName}</div>
                <div class="catchlog-meta">${city.total} total</div>
              </div>
              <div class="status-leaf-list">${statusLeaves}</div>
            </div>`;
          })
          .join("");
      }

      return `
        <div class="niche-block ${isOpen ? "open" : ""} ${state.mode === "outreach" && state.outreach.nicheId === niche.id ? "active-parent" : ""}" data-niche-id="${niche.id}">
          <div class="niche-row" data-action="toggle-outreach-niche" data-id="${niche.id}">
            <div class="niche-row-main">
              <span class="niche-caret">▶</span>
              <span class="niche-name">${niche.name}</span>
              <span class="niche-count">${visibleCities.length} cit${visibleCities.length === 1 ? "y" : "ies"}</span>
            </div>
          </div>
          <div class="catchlog-list">${citiesHtml}</div>
        </div>`;
    })
    .filter(Boolean);

  outreachTree.innerHTML = blocks.length
    ? blocks.join("")
    : `<div class="empty-state">No leads have moved out of Hunt yet. Shortlist or otherwise update a lead's status to see it here.</div>`;
}

// ---------- Pinned tree (Niche -> City -> pinned leads) ----------
async function renderPinnedTree() {
  try {
    const res = await api("/api/leads/pinned/list");
    const leads = await res.json();

    if (leads.length === 0) {
      pinnedTree.innerHTML = `<div class="empty-state">No pinned leads yet. Pin a lead from its Inspect panel in Reach Out.</div>`;
      return;
    }

    // Group client-side: niche_id -> { name, cities: { catch_log_id -> { name, count } } }
    const nicheMap = new Map();
    for (const lead of leads) {
      if (!nicheMap.has(lead.niche_id)) nicheMap.set(lead.niche_id, { name: lead.niche_name, cities: new Map() });
      const niche = nicheMap.get(lead.niche_id);
      if (!niche.cities.has(lead.catch_log_id)) niche.cities.set(lead.catch_log_id, { name: lead.city_name, count: 0 });
      niche.cities.get(lead.catch_log_id).count++;
    }

    pinnedTree.innerHTML = Array.from(nicheMap.entries())
      .map(([nicheId, niche]) => {
        const isOpen = state.pinnedOpenNicheIds.has(nicheId);
        const citiesHtml = Array.from(niche.cities.entries())
          .map(
            ([catchLogId, city]) => `
            <div class="catchlog-row ${state.mode === "pinned" && state.pinned.catchLogId === catchLogId ? "active" : ""}" data-action="toggle-pinned-city" data-log-id="${catchLogId}">
              <div class="catchlog-name">${city.name}</div>
              <span class="catchlog-meta">${city.count} pinned</span>
            </div>`
          )
          .join("");

        return `
          <div class="niche-block ${isOpen ? "open" : ""}" data-niche-id="${nicheId}">
            <div class="niche-row" data-action="toggle-pinned-niche" data-id="${nicheId}">
              <span class="niche-caret">▶</span>
              <span class="niche-name">${niche.name}</span>
              <span class="niche-count">${niche.cities.size} cit${niche.cities.size === 1 ? "y" : "ies"}</span>
            </div>
            <div class="catchlog-list">${citiesHtml}</div>
          </div>`;
      })
      .join("");
  } catch (err) {
    pinnedTree.innerHTML = `<div class="empty-state">Could not load pinned leads.</div>`;
  }
}

pinnedTree.addEventListener("click", async (e) => {
  const nicheToggle = e.target.closest('[data-action="toggle-pinned-niche"]');
  if (nicheToggle) {
    const id = Number(nicheToggle.dataset.id);
    if (state.pinnedOpenNicheIds.has(id)) state.pinnedOpenNicheIds.delete(id);
    else state.pinnedOpenNicheIds.add(id);
    await renderPinnedTree();
    return;
  }

  const cityRow = e.target.closest('[data-action="toggle-pinned-city"]');
  if (cityRow) {
    state.pinned.catchLogId = Number(cityRow.dataset.logId);
    state.mode = "pinned";
    state.page = 1;
    await renderPinnedTree();
    setContentView("board");
    updateScopeLine();
    await loadLeads();
  }
});

outreachTree.addEventListener("click", async (e) => {
  const toggleNiche = e.target.closest('[data-action="toggle-outreach-niche"]');
  if (toggleNiche) {
    const nicheId = Number(toggleNiche.dataset.id);
    if (state.outreachOpenNicheIds.has(nicheId)) state.outreachOpenNicheIds.delete(nicheId);
    else state.outreachOpenNicheIds.add(nicheId);
    await renderOutreachTree();
    return;
  }

  const toggleCity = e.target.closest('[data-action="toggle-outreach-city"]');
  if (toggleCity) {
    const cityKey = `${toggleCity.dataset.nicheId}:${toggleCity.dataset.logId}`;
    if (state.outreachOpenCityIds.has(cityKey)) state.outreachOpenCityIds.delete(cityKey);
    else state.outreachOpenCityIds.add(cityKey);
    await renderOutreachTree();
    return;
  }

  const statusLeaf = e.target.closest(".status-leaf-row");
  if (statusLeaf) {
    state.outreach.nicheId = Number(statusLeaf.dataset.nicheId);
    state.outreach.catchLogId = Number(statusLeaf.dataset.logId);
    state.outreach.status = statusLeaf.dataset.status;
    state.page = 1;
    state.lastNavSection = "reachout";
    setContentView("board");
    await renderOutreachTree();
    setBoardMode("outreach");
  }
});

newNicheBtnTree.addEventListener("click", async () => {
  const name = await openModal({ title: "New niche", inputLabel: "Niche name", confirmText: "Create" });
  if (name) {
    const res = await api("/api/niches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || "Could not create niche");
      return;
    }
    await loadNichesAndLogs();
  }
});

function currentScrapeCatchLogId() {
  if (state.mode === "outreach") return state.outreach.catchLogId || null;
  return state.activeCatchLogId || null;
}

function updateScrapeButtonVisibility() {
  const id = currentScrapeCatchLogId();
  const previousId = scrapeBtn.dataset.catchLogId;

  scrapeBtn.style.display = id ? "inline-flex" : "none";
  scrapeBtn.dataset.catchLogId = id || "";

  // Switched to a different catch log (or none) - close the panel and stop
  // polling so we never show one city's counts while looking at another.
  if (String(previousId || "") !== String(id || "")) {
    scrapePanel.style.display = "none";
    if (scrapePollTimer) {
      clearInterval(scrapePollTimer);
      scrapePollTimer = null;
    }
  }
}

function updateScopeLine() {
  updateScrapeButtonVisibility();

  if (state.mode === "pinned") {
    scopeLine.innerHTML = state.pinned.catchLogId ? `<strong>Pinned</strong> — showing pinned leads for this city` : `<strong>Pinned</strong> — pick a city from the sidebar`;
    return;
  }

  if (state.mode === "outreach") {
    const log = state.outreach.catchLogId ? findOutreachCatchLog(state.outreach.catchLogId) : null;
    if (!log) {
      scopeLine.innerHTML = `<a class="breadcrumb-link" data-action="crumb-reachout-root">Reach Out</a> — pick a niche and city`;
    } else {
      const statusLabel =
        OUTREACH_STATUS_LIST.find((s) => s.key === state.outreach.status)?.label || state.outreach.status;
      scopeLine.innerHTML = `
        <a class="breadcrumb-link" data-action="crumb-reachout-root">Reach Out</a> /
        <a class="breadcrumb-link" data-action="crumb-reachout-niche" data-niche-id="${state.outreach.nicheId}">${log.nicheName}</a> /
        <a class="breadcrumb-link" data-action="crumb-reachout-city" data-niche-id="${state.outreach.nicheId}" data-log-id="${state.outreach.catchLogId}">${log.catchLogName}</a> /
        <strong>${statusLabel}</strong>`;
    }
    return;
  }

  if (state.activeCatchLogId) {
    const log = state.catchLogs.find((l) => l.id === state.activeCatchLogId);
    const niche = log ? state.niches.find((n) => n.id === log.niche_id) : null;
    scopeLine.innerHTML = `
      <a class="breadcrumb-link" data-action="crumb-hunt-root">Hunt</a> /
      <a class="breadcrumb-link" data-action="crumb-hunt-niche" data-niche-id="${niche ? niche.id : ""}">${niche ? niche.name : "?"}</a> /
      <strong>${log ? log.name : "?"}</strong>`;
    clearScopeBtn.style.display = "inline-block";
    return;
  }

  if (state.activeNicheId) {
    const niche = state.niches.find((n) => n.id === state.activeNicheId);
    scopeLine.innerHTML = `<a class="breadcrumb-link" data-action="crumb-hunt-root">Hunt</a> / <strong>${niche ? niche.name : "?"} (all cities)</strong>`;
    clearScopeBtn.style.display = "inline-block";
    return;
  }

  scopeLine.innerHTML = `<a class="breadcrumb-link" data-action="crumb-hunt-root">Hunt</a> / <strong>All records</strong>`;
  clearScopeBtn.style.display = "none";
}

scopeLine.addEventListener("click", async (e) => {
  const link = e.target.closest(".breadcrumb-link");
  if (!link) return;
  const action = link.dataset.action;

  if (action === "crumb-hunt-root") {
    state.activeCatchLogId = null;
    state.activeNicheId = null;
  } else if (action === "crumb-hunt-niche") {
    state.activeCatchLogId = null;
    state.activeNicheId = Number(link.dataset.nicheId) || null;
  } else if (action === "crumb-reachout-root") {
    state.outreach.catchLogId = null;
    state.outreach.nicheId = null;
  } else if (action === "crumb-reachout-niche") {
    state.outreach.catchLogId = null;
  } else if (action === "crumb-reachout-city") {
    state.outreach.status = "shortlisted";
  }
  state.page = 1;
  updateScopeLine();
  renderNichesTree();
  renderQuickNicheDropdown();
  renderQuickCityDropdown();
  await renderOutreachTree();
  await loadLeads();
});

function findOutreachCatchLog(catchLogId) {
  for (const [nicheId, summary] of state.outreachSummaries.entries()) {
    const match = summary.find((s) => s.catchLogId === catchLogId);
    if (match) {
      const niche = state.niches.find((n) => n.id === nicheId);
      return { nicheName: niche ? niche.name : "?", catchLogName: match.catchLogName };
    }
  }
  return null;
}

clearScopeBtn.addEventListener("click", async () => {
  state.activeCatchLogId = null;
  state.activeNicheId = null;
  state.page = 1;
  updateScopeLine();
  renderNichesTree();
  renderQuickNicheDropdown();
  renderQuickCityDropdown();
  await loadLeads();
});

document.getElementById("showAllRecordsBtn").addEventListener("click", () => clearScopeBtn.click());

// Refresh buttons on each sidebar section - refetches that section's data
// without navigating away from wherever the user currently is.
document.querySelectorAll("[data-refresh-section]").forEach((btn) => {
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const section = btn.dataset.refreshSection;
    btn.classList.add("spinning");
    try {
      if (section === "hunt") {
        await loadNichesAndLogs();
        if (state.mode !== "outreach" && state.mode !== "pinned") await loadLeads();
      } else if (section === "reachout") {
        state.outreachSummaries.clear();
        await renderOutreachTree();
        if (state.mode === "outreach") await loadLeads();
      } else if (section === "pinned") {
        await renderPinnedTree();
        if (state.mode === "pinned") await loadLeads();
      } else if (section === "reports") {
        await loadReports();
      } else if (section === "contacted") {
        await refreshCurrentContactedView();
      }
      showToast("Refreshed", "success");
    } catch (err) {
      showToast("Could not refresh", "error");
    } finally {
      setTimeout(() => btn.classList.remove("spinning"), 600);
    }
  });
});

document.getElementById("resetFiltersBtn").addEventListener("click", async () => {
  filterSearch.value = "";
  filterState.need = "";
  filterState.inspected = false;
  document.getElementById("inspectedFilterBtn").classList.remove("active");
  state.sortBy = "created_at";
  state.sortDir = null;
  state.activeNicheId = null;
  state.activeCatchLogId = null;
  state.page = 1;
  updateScopeLine();
  renderNichesTree();
  renderQuickNicheDropdown();
  renderQuickCityDropdown();
  renderNeedDropdown();
  renderSortDropdown();
  await loadLeads();
  showToast("Filters reset", "success");
});

document.getElementById("inspectedFilterBtn").addEventListener("click", async (e) => {
  filterState.inspected = !filterState.inspected;
  e.currentTarget.classList.toggle("active", filterState.inspected);
  state.page = 1;
  await loadLeads();
});

// ---------- Leads board ----------
function mapsLinkFor(lead) {
  if (lead.place_id) return `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(lead.place_id)}`;
  if (lead.address) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lead.address)}`;
  return null;
}

// Click-to-chat link only - not a verified "is on WhatsApp" check (no free API
// can confirm that ahead of time). WhatsApp itself reports back if the number
// isn't reachable once the user actually opens the chat.
function whatsappLinkFor(phone) {
  if (!phone) return null;
  const digits = phone.replace(/[^\d]/g, "");
  if (digits.length < 8) return null;
  return `https://wa.me/${digits}`;
}

const WHATSAPP_SVG = `<i class="bi bi-whatsapp"></i>`;

// Light-mode variants of each status color - the dark-mode colors above are
// tuned to pop against a near-black background and fail real accessibility
// contrast (as low as 1.68:1) when used as text against a light/white
// surface. Each of these was verified to reach at least 4.5:1 (WCAG AA for
// normal text) against a white panel while keeping the same hue.
// ========== Lead expand panel: Inspect + Generate content (Reach Out only) ==========
let inspectPollTimer = null;
let genPollTimer = null;
const CHECK_ICONS = { pass: "bi-check-circle-fill", fail: "bi-x-circle-fill", warn: "bi-exclamation-circle-fill" };
const PLATFORMS = [
  { key: "email", icon: "bi-envelope-fill" },
  { key: "facebook", icon: "bi-facebook" },
  { key: "instagram", icon: "bi-instagram" },
  { key: "linkedin", icon: "bi-linkedin" },
  { key: "tiktok", icon: "bi-tiktok" },
  { key: "whatsapp", icon: "bi-whatsapp" },
];
const CONTENT_TONES = [
  "Personalized Observation",
  "Problem → Solution",
  "Compliment + Opportunity",
  "Curiosity / Pattern Interrupt",
  "Case Study / Social Proof",
  "Value-First / Free Audit",
  "Question-Based Conversation",
];
const CONTENT_LENGTHS = ["Detailed", "Medium", "Short", "Concise"];

const CONTENT_LANGUAGES = [
  { value: "English", label: "English", flag: "🇬🇧" },
  { value: "French", label: "French", flag: "🇫🇷" },
  { value: "Spanish", label: "Spanish", flag: "🇪🇸" },
  { value: "German", label: "German", flag: "🇩🇪" },
  { value: "Portuguese", label: "Portuguese", flag: "🇵🇹" },
  { value: "Arabic", label: "Arabic", flag: "🇸🇦" },
  { value: "Chinese", label: "Chinese", flag: "🇨🇳" },
  { value: "Hebrew", label: "Hebrew", flag: "🇮🇱" },
  { value: "Hungarian", label: "Hungarian", flag: "🇭🇺" },
  { value: "Russian", label: "Russian", flag: "🇷🇺" },
  { value: "Italian", label: "Italian", flag: "🇮🇹" },
  { value: "Bengali", label: "Bengali", flag: "🇧🇩" },
  { value: "Urdu", label: "Urdu", flag: "🇵🇰" },
  { value: "Pashto", label: "Pashto", flag: "🇦🇫" },
];

// "" (Auto) uses the normal fallback chain (Groq -> Gemini -> DeepSeek).
// Picking a specific provider uses ONLY that one, with no fallback - so
// the user's explicit choice is respected exactly, not silently swapped
// for a different provider if the chosen one is unavailable.
const AI_PROVIDER_OPTIONS = [
  { value: "", label: "Auto", icon: "bi-shuffle" },
  { value: "groq", label: "Groq", icon: "bi-lightning-charge-fill" },
  { value: "gemini", label: "Gemini", icon: "bi-stars" },
  { value: "deepseek", label: "DeepSeek", icon: "bi-cpu-fill" },
];

function closeAllLeadExpansions() {
  if (inspectPollTimer) {
    clearInterval(inspectPollTimer);
    inspectPollTimer = null;
  }
  if (genPollTimer) {
    clearInterval(genPollTimer);
    genPollTimer = null;
  }
  document.querySelectorAll(".lead-expand-row").forEach((el) => el.remove());
  state.expandedLeadId = null;
}

function scoreColor(score) {
  if (score >= 70) return "var(--good)";
  if (score >= 40) return "var(--warn)";
  return "var(--danger)";
}

function scoreRingSvg(score, size) {
  const r = (size - 8) / 2;
  const circumference = 2 * Math.PI * r;
  const offset = circumference * (1 - score / 100);
  return `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle class="score-ring-mini-bg" cx="${size / 2}" cy="${size / 2}" r="${r}"></circle>
      <circle class="score-ring-mini-fill" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="${scoreColor(score)}" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"></circle>
    </svg>`;
}

function checklistItemHtml(c) {
  return `<div class="check-item-mini ${c.status}"><i class="bi ${CHECK_ICONS[c.status] || CHECK_ICONS.warn}"></i><div>${c.label}${c.detail ? `<span class="check-detail-mini">${c.detail}</span>` : ""}</div></div>`;
}

const PROVIDER_ICON_INFO = {
  groq: { icon: "bi-lightning-charge-fill", label: "Groq" },
  gemini: { icon: "bi-stars", label: "Gemini" },
  deepseek: { icon: "bi-cpu-fill", label: "DeepSeek" },
};
function providerHintIconHtml(provider) {
  if (!provider || !PROVIDER_ICON_INFO[provider]) return "";
  const info = PROVIDER_ICON_INFO[provider];
  return `<i class="bi ${info.icon} provider-hint-icon" title="Generated using ${info.label}"></i>`;
}

// Shows the AI provider's icon + name if the writeup was AI-generated, or
// a simple, honest label if it wasn't (checklist/scores are still fully
// accurate either way - this is just about where the strengths/weaknesses
// narrative came from).
function analysisSourceHintHtml(provider) {
  if (provider && PROVIDER_ICON_INFO[provider]) {
    const info = PROVIDER_ICON_INFO[provider];
    return `<span class="analysis-source-hint"><i class="bi ${info.icon}"></i> ${info.label}</span>`;
  }
  return `<span class="analysis-source-hint muted"><i class="bi bi-geo-alt-fill"></i> Based on business place info</span>`;
}

function renderInspectSectionBody(analysis, lead) {
  if (!analysis || analysis.status === "pending") {
    return `<div class="inspect-empty">No inspection has been run yet for this business. Click the search icon above to start.</div>`;
  }

  if (analysis.status === "running") {
    return `<div class="inspect-progress"><span class="inspect-spinner"></span> ${analysis.currentStep || "Working…"}</div>`;
  }

  if (analysis.status === "failed") {
    return `<div class="inspect-empty" style="color:var(--danger);">Inspection failed: ${analysis.error || "unknown error"}</div>`;
  }

  if (analysis.status === "stopped") {
    return `<div class="inspect-empty">Inspection was stopped before completing. Click the search icon to try again.</div>`;
  }

  // status === "done"
  const categories = [
    { label: "Website Health", score: analysis.websiteScore },
    { label: "GMB & Local SEO", score: analysis.gmbScore },
    { label: "Social Presence", score: analysis.socialScore },
    { label: "Reputation", score: analysis.reputationScore },
  ];

  return `
    <div class="score-header-mini">
      <div class="score-ring-mini">${scoreRingSvg(analysis.overallScore, 60)}<div class="score-ring-mini-text">${analysis.overallScore}</div></div>
      <div>
        <div style="font-family:var(--font-display); font-weight:600; font-size:13px;">Overall score: ${analysis.overallScore}/100</div>
        <div style="font-size:11.5px; color:var(--text-muted); display:flex; align-items:center; gap:8px;">Last checked ${analysis.updatedAt || ""} ${analysisSourceHintHtml(analysis.provider)}</div>
      </div>
    </div>
    <div class="category-grid-mini">
      ${categories
        .map(
          (c) => `
        <div>
          <div class="category-item-mini-head"><span>${c.label}</span><b style="color:${scoreColor(c.score ?? 0)}">${c.score ?? 0}/100</b></div>
          <div class="category-bar-track-mini"><div class="category-bar-fill-mini" style="width:${c.score ?? 0}%; background:${scoreColor(c.score ?? 0)};"></div></div>
        </div>`
        )
        .join("")}
    </div>
    <div class="checklist-mini">${analysis.checklist.map(checklistItemHtml).join("")}</div>
    ${
      analysis.strengths.length || analysis.weaknesses.length
        ? `
    <div class="sw-grid-mini">
      <div class="sw-col-mini strengths"><h4><i class="bi bi-arrow-up-circle-fill"></i> Strengths</h4><ul class="sw-list-mini">${analysis.strengths.map((s) => `<li>${s}</li>`).join("")}</ul></div>
      <div class="sw-col-mini weaknesses"><h4><i class="bi bi-arrow-down-circle-fill"></i> Weaknesses</h4><ul class="sw-list-mini">${analysis.weaknesses.map((s) => `<li>${s}</li>`).join("")}</ul></div>
    </div>`
        : ""
    }
    ${
      analysis.suggestedServices.length
        ? `<div class="service-chip-row-mini">${analysis.suggestedServices.map((s) => `<span class="service-chip-mini">${s}</span>`).join("")}</div>`
        : ""
    }
  `;
}

async function loadAndRenderInspect(leadId, bodyEl) {
  try {
    const res = await api(`/api/leads/${leadId}/inspect/status`);
    const analysis = await res.json();
    bodyEl.innerHTML = renderInspectSectionBody(analysis);

    if (analysis.status === "running") {
      if (!inspectPollTimer) {
        inspectPollTimer = setInterval(() => loadAndRenderInspect(leadId, bodyEl), 1500);
      }
    } else if (inspectPollTimer) {
      clearInterval(inspectPollTimer);
      inspectPollTimer = null;
    }
  } catch (err) {
    bodyEl.innerHTML = `<div class="inspect-empty" style="color:var(--danger);">Could not load inspection status.</div>`;
  }
}

// Shared by both "Generate All" and single-platform "Regenerate" - checks
// the content-type before assuming JSON, since if something in front of
// the app (a proxy, CDN, or firewall) ever returns its own error page
// instead of forwarding the request, res.json() throws a cryptic parse
// error ("Unexpected token '<'") that hides what actually came back.
async function callGenerationStart(leadId, body) {
  const res = await api(`/api/leads/${leadId}/generate-content/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const rawText = await res.text();
    return {
      ok: false,
      error: `Got a non-JSON response (HTTP ${res.status}, content-type: ${contentType || "none"}) - this usually means something in front of the app (a proxy, CDN, or firewall) intercepted the request. Raw response (first 300 chars): ${rawText.slice(0, 300).replace(/</g, "&lt;")}`,
    };
  }
  const data = await res.json();
  if (!res.ok) return { ok: false, error: data.error || "Could not start generation." };
  return { ok: true };
}

let websiteMetaCache = null;
async function getWebsiteMeta() {
  if (websiteMetaCache) return websiteMetaCache;
  const res = await api("/api/settings/site-generator-meta");
  websiteMetaCache = await res.json();
  return websiteMetaCache;
}

function siteHistoryItemHtml(site) {
  const url = `${window.location.origin}/site/${site.slug}`;
  const styleLabel = websiteMetaCache?.designStyles?.find((s) => s.value === site.design_style)?.label || site.design_style;
  const colorLabel = websiteMetaCache?.colorPresets?.find((c) => c.value === site.color_preset)?.label || site.color_preset;
  if (site.status === "done") {
    return `
      <div class="site-history-item" data-site-id="${site.id}">
        <div class="site-history-info">
          <i class="bi bi-check-circle-fill" style="color:var(--good);"></i>
          <span>${styleLabel} · ${colorLabel}</span>
        </div>
        <div class="site-history-actions">
          <input type="text" readonly value="${url}" data-site-url-input>
          <button type="button" data-action="copy-site-url" title="Copy link"><i class="bi bi-clipboard"></i></button>
          <a href="${url}" target="_blank" rel="noopener" title="View site"><i class="bi bi-box-arrow-up-right"></i></a>
          <button type="button" data-action="delete-site" data-site-id="${site.id}" title="Delete" class="danger-item-mini"><i class="bi bi-trash"></i></button>
        </div>
      </div>`;
  }
  if (site.status === "failed") {
    return `<div class="site-history-item"><span style="color:var(--danger);"><i class="bi bi-x-circle-fill"></i> ${styleLabel} failed: ${site.error || "unknown error"}</span></div>`;
  }
  return `<div class="site-history-item"><span><i class="bi bi-hourglass-split"></i> ${styleLabel} - ${site.current_step || "starting…"}</span></div>`;
}

async function initWebsitePanel(panel, leadId, lead) {
  panel.innerHTML = `<p class="hint">Loading…</p>`;
  const meta = await getWebsiteMeta();

  panel.innerHTML = `
    <p class="hint" style="margin-bottom:14px;">Generates a free, no-index landing page you can send alongside cold outreach - a full custom page (not just copy), with real photos and working mobile navigation. Takes a bit longer than outreach content since it's a whole page.</p>

    <label class="site-field-label">
      Business name
      <input type="text" data-site-business-name value="${lead.name || ""}">
    </label>
    <label class="site-field-label">
      Niche / what they do
      <input type="text" data-site-niche value="${lead.niche_name || ""}">
    </label>
    <label class="site-field-label">
      Services offered <small class="optional">(optional - comma separated, e.g. "Exterior wash, Interior detail, Waxing")</small>
      <input type="text" data-site-services placeholder="Leave blank and the AI will infer typical services for this niche">
    </label>
    <label class="site-field-label">
      Call-to-action goal <small class="optional">(optional)</small>
      <input type="text" data-site-cta-goal placeholder="e.g. Book Appointment, Get a Free Quote, Request a Consult">
    </label>

    <label class="site-field-label">
      Design style
      <select data-site-style-select>
        ${meta.designStyles.map((s) => `<option value="${s.value}" title="${s.description}">${s.label} — ${s.description}</option>`).join("")}
      </select>
    </label>

    <div class="site-field-label" style="margin-bottom:6px;">Color palette</div>
    <div class="site-color-grid">
      ${meta.colorPresets
        .map(
          (c, i) => `
        <button type="button" class="site-color-swatch ${c.value === "surprise" ? "surprise-swatch" : ""} ${i === 0 ? "active" : ""}" data-color-value="${c.value}" title="${c.label}">
          ${c.value === "surprise" ? '<i class="bi bi-shuffle"></i>' : c.swatch.map((hex) => `<span style="background:${hex};"></span>`).join("")}
        </button>`
        )
        .join("")}
    </div>

    <button type="button" data-action="generate-website" class="site-generate-btn"><i class="bi bi-magic"></i> Generate Website</button>
    <button type="button" data-action="stop-website" class="site-generate-btn" style="display:none; background:transparent; color:var(--danger); border:1px solid var(--danger);">Stop</button>

    <div data-site-progress style="display:none;" class="inspect-progress"><span class="inspect-spinner"></span> <span data-site-progress-text></span></div>

    <div data-site-history style="margin-top:16px;"></div>
  `;

  let selectedStyle = meta.designStyles[0].value;
  let selectedColor = meta.colorPresets[0].value;
  let activeSiteId = null;
  let sitePollTimer = null;

  panel.querySelector("[data-site-style-select]").addEventListener("change", (e) => {
    selectedStyle = e.target.value;
  });
  panel.querySelectorAll(".site-color-swatch").forEach((sw) => {
    sw.addEventListener("click", () => {
      panel.querySelectorAll(".site-color-swatch").forEach((s) => s.classList.remove("active"));
      sw.classList.add("active");
      selectedColor = sw.dataset.colorValue;
    });
  });

  async function refreshHistory() {
    const res = await api(`/api/leads/${leadId}/generated-sites`);
    const sites = await res.json();
    const historyEl = panel.querySelector("[data-site-history]");
    historyEl.innerHTML = sites.length ? sites.map(siteHistoryItemHtml).join("") : "";
    return sites;
  }
  await refreshHistory();

  async function pollSite() {
    if (!activeSiteId) return;
    const res = await api(`/api/leads/generate-website/status/${activeSiteId}`);
    const status = await res.json();
    const progressText = panel.querySelector("[data-site-progress-text]");
    if (status.status === "running") {
      progressText.textContent = status.currentStep || "Working…";
    } else {
      clearInterval(sitePollTimer);
      sitePollTimer = null;
      panel.querySelector("[data-site-progress]").style.display = "none";
      panel.querySelector('[data-action="generate-website"]').style.display = "inline-flex";
      panel.querySelector('[data-action="stop-website"]').style.display = "none";
      await refreshHistory();
      if (status.status === "done") showToast("Website generated", "success");
      else if (status.status === "failed") showToast(`Website generation failed: ${status.error}`, "error");
    }
  }

  panel.addEventListener("click", async (e) => {
    const action = e.target.closest("[data-action]")?.dataset.action;

    if (action === "generate-website") {
      const businessName = panel.querySelector("[data-site-business-name]").value.trim();
      const niche = panel.querySelector("[data-site-niche]").value.trim();
      if (!businessName) {
        showToast("Enter a business name first", "error");
        return;
      }
      const res = await api(`/api/leads/${leadId}/generate-website/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          niche,
          city: lead.city_name || "",
          businessName,
          designStyle: selectedStyle,
          colorPreset: selectedColor,
          services: panel.querySelector("[data-site-services]").value.trim() || null,
          ctaGoal: panel.querySelector("[data-site-cta-goal]").value.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || "Could not start generation", "error");
        return;
      }
      activeSiteId = data.siteId;
      panel.querySelector("[data-site-progress]").style.display = "flex";
      panel.querySelector('[data-action="generate-website"]').style.display = "none";
      panel.querySelector('[data-action="stop-website"]').style.display = "inline-flex";
      await refreshHistory();
      if (sitePollTimer) clearInterval(sitePollTimer);
      sitePollTimer = setInterval(pollSite, 1500);
      await pollSite();
      return;
    }

    if (action === "stop-website") {
      if (activeSiteId) await api(`/api/leads/generate-website/stop/${activeSiteId}`, { method: "POST" });
      if (sitePollTimer) clearInterval(sitePollTimer);
      panel.querySelector("[data-site-progress]").style.display = "none";
      panel.querySelector('[data-action="generate-website"]').style.display = "inline-flex";
      panel.querySelector('[data-action="stop-website"]').style.display = "none";
      await refreshHistory();
      return;
    }

    if (action === "copy-site-url") {
      const input = e.target.closest(".site-history-item").querySelector("[data-site-url-input]");
      await navigator.clipboard.writeText(input.value);
      showToast("Link copied", "success");
      return;
    }

    if (action === "delete-site") {
      const siteId = e.target.closest("[data-action]").dataset.siteId;
      const confirmed = await openModal({ title: "Delete this generated site?", message: "This cannot be undone.", confirmText: "Delete", danger: true });
      if (!confirmed) return;
      await api(`/api/leads/generated-sites/${siteId}`, { method: "DELETE" });
      await refreshHistory();
      showToast("Site deleted", "success");
      return;
    }
  });
}

function buildExpandPanelHtml(lead) {
  return `
    <div class="expand-section" data-owner-name-section>
      <label class="site-field-label" style="margin:0;">
        Owner/contact name <small class="optional">(optional - used for "Hi [name]" in outreach; falls back to the business name if left blank)</small>
        <div style="display:flex; gap:6px; margin-top:5px;">
          <input type="text" data-owner-name-input value="${lead.owner_name || ""}" placeholder="e.g. Sarah Mueller" style="flex:1;">
          <button type="button" class="small-btn" data-action="save-owner-name">Save</button>
        </div>
      </label>
    </div>

    <div class="expand-section" data-inspect-section>
      <div class="expand-section-head">
        <span class="expand-section-title"><i class="bi bi-clipboard-data"></i> Business Inspection</span>
        <div class="expand-actions">
          <button type="button" data-action="pin-lead" class="pin-btn ${lead.pinned ? "pinned" : ""}" title="${lead.pinned ? "Unpin" : "Pin"} this lead">
            <i class="bi ${lead.pinned ? "bi-pin-angle-fill" : "bi-pin-angle"}"></i> ${lead.pinned ? "Pinned" : "Pin"}
          </button>
          <button type="button" data-action="inspect-start" title="Start inspection"><i class="bi bi-search"></i> Inspect</button>
          <button type="button" data-action="inspect-refresh" title="Refresh"><i class="bi bi-arrow-clockwise"></i></button>
          <button type="button" data-action="inspect-stop" title="Stop"><i class="bi bi-stop-circle"></i></button>
        </div>
      </div>
      <div data-inspect-body></div>
    </div>

    <div class="expand-section" data-generate-section>
      <div class="expand-section-head">
        <span class="expand-section-title"><i class="bi bi-chat-left-text"></i> Generate Outreach Content <span data-gen-provider-hint></span></span>
      </div>
      <div class="gen-controls-mini">
        <select class="gen-tone-select" data-tone-select>
          <option value="">Select a tone/format…</option>
          ${CONTENT_TONES.map((t) => `<option value="${t}">${t}</option>`).join("")}
        </select>
        <select class="gen-tone-select" data-length-select style="flex:0 0 130px; min-width:110px;">
          ${CONTENT_LENGTHS.map((l) => `<option value="${l}" ${l === "Medium" ? "selected" : ""}>${l}</option>`).join("")}
        </select>
        <select class="gen-tone-select" data-language-select style="flex:0 0 160px; min-width:140px;">
          ${CONTENT_LANGUAGES.map((l) => `<option value="${l.value}" ${l.value === "English" ? "selected" : ""}>${l.flag} ${l.label}</option>`).join("")}
        </select>
      </div>
      <div class="gen-extras-row gen-combined-row">
        <span class="gen-provider-row-label">Add organically:</span>
        <button type="button" class="gen-extra-toggle" data-extra="cta" title="Weave in a clear call-to-action"><i class="bi bi-megaphone-fill"></i> CTA</button>
        <button type="button" class="gen-extra-toggle" data-extra="meeting" title="Invite them to a short meeting/call"><i class="bi bi-calendar-event-fill"></i> Meeting</button>
        <button type="button" class="gen-extra-toggle" data-extra="website" title="Reference a demo/reference website"><i class="bi bi-globe2"></i> Website</button>
        <span class="gen-row-divider"></span>
        <span class="gen-provider-row-label">AI provider:</span>
        ${AI_PROVIDER_OPTIONS.map(
          (p) =>
            `<button type="button" class="ai-provider-tab ${p.value === "" ? "active" : ""}" data-ai-provider="${p.value}" title="${p.label}"><i class="bi ${p.icon}"></i> ${p.label}</button>`
        ).join("")}
      </div>
      <div class="gen-extra-link-row" data-extra-link="meeting" style="display:none;">
        <input type="text" data-meeting-link-input placeholder="Meeting booking link (e.g. https://cal.com/you/15min) - optional" />
      </div>
      <div class="gen-extra-link-row" data-extra-link="website" style="display:none;">
        <input type="text" data-website-link-input placeholder="Demo/reference website link - optional" />
      </div>
      <div class="gen-provider-row">
        <button type="button" data-action="generate-all" style="background:var(--accent); color:#1a1310; border:none; border-radius:6px; padding:7px 14px; font-size:12px; font-weight:600; cursor:pointer;">
          <i class="bi bi-stars"></i> Generate Content
        </button>
        <button type="button" data-action="generate-stop" title="Stop" style="display:none;"><i class="bi bi-stop-circle"></i></button>
      </div>
      <div class="platform-tabs">
        ${PLATFORMS.map((p) => {
          const isAvailable = getAvailablePlatforms(lead).includes(p.key);
          return `<button type="button" class="platform-tab ${p.key === "email" ? "active" : ""} ${isAvailable ? "" : "platform-tab-unavailable"}" data-platform="${p.key}" title="${isAvailable ? p.key : `${p.key} - no contact info found for this lead, but you can still view/generate it manually`}"><i class="bi ${p.icon}"></i><span class="platform-tab-dot" data-platform-dot="${p.key}"></span></button>`;
        }).join("")}
      </div>
      <div data-gen-progress style="display:none;" class="inspect-progress"><span class="inspect-spinner"></span> <span data-gen-progress-text></span></div>
      <div class="gen-subject-row" data-gen-subject-row style="display:none;">
        <input type="text" data-gen-subject-input placeholder="Subject line…" />
        <button type="button" data-action="copy-subject" title="Copy subject"><i class="bi bi-clipboard"></i></button>
        <button type="button" data-action="regenerate-subject" title="Regenerate just the subject"><i class="bi bi-arrow-repeat"></i></button>
      </div>
      <div class="gen-output-mini" data-gen-output>Pick a tone, length, and language, then click "Generate Content" - writes all 6 platforms at once in the background. Switching tabs afterward just shows what was generated for each, without using any more requests.</div>
      <div class="gen-actions-mini">
        <button type="button" data-action="copy-content"><i class="bi bi-clipboard"></i> Copy</button>
        <button type="button" data-action="regenerate-content"><i class="bi bi-arrow-repeat"></i> Regenerate this platform</button>
        <button type="button" data-action="clear-content" class="danger-btn"><i class="bi bi-trash"></i> Clear this platform</button>
      </div>
    </div>

    <div class="expand-section" data-website-section>
      <div class="expand-section-head">
        <span class="expand-section-title"><i class="bi bi-window-stack"></i> Freebie Website</span>
        <button type="button" data-action="toggle-website-panel" class="site-toggle-btn"><i class="bi bi-plus-circle"></i> Create Website</button>
      </div>
      <div data-website-panel style="display:none;"></div>
    </div>
  `;
}

async function toggleLeadExpand(leadId) {
  const row = recordsBody.querySelector(`.list-row[data-lead-row-id="${leadId}"]`);
  if (!row) return;

  if (state.expandedLeadId === leadId) {
    closeAllLeadExpansions();
    return;
  }
  closeAllLeadExpansions();
  state.expandedLeadId = leadId;

  const lead = state.currentLeadsById.get(leadId);
  const expandRow = document.createElement("div");
  expandRow.className = "list-row lead-expand-row";
  expandRow.dataset.expandForLead = leadId;
  expandRow.innerHTML = buildExpandPanelHtml(lead);
  row.after(expandRow);

  await wireLeadExpandPanel(expandRow, leadId, lead);
}

// The full Inspect / Generate Content / Freebie Website wiring for a
// lead's expand panel - deliberately independent of any specific board
// or table (only needs the already-built expandRow element, the lead ID,
// and the lead object itself), so it can be reused anywhere a lead's
// expand panel needs to appear - the Reach Out/Hunt board via
// toggleLeadExpand above, and campaign lead rows via
// toggleCampaignLeadExpand elsewhere.
async function wireLeadExpandPanel(expandRow, leadId, lead) {
  let currentPlatform = "email";
  let currentTone = "";
  let currentLength = "Medium";
  let currentLanguage = "English";
  let currentAiProvider = ""; // "" = Auto (fallback chain)
  let ctaEnabled = false;
  let meetingEnabled = false;
  let websiteEnabled = false;

  const inspectBody = expandRow.querySelector("[data-inspect-body]");
  await loadAndRenderInspect(leadId, inspectBody);

  const outreachContentRes = await api(`/api/leads/${leadId}/outreach-content`).catch(() => null);
  let savedContent = outreachContentRes && outreachContentRes.ok ? (await outreachContentRes.json()).content : [];
  const outputEl = expandRow.querySelector("[data-gen-output]");
  const toneSelect = expandRow.querySelector("[data-tone-select]");
  const lengthSelect = expandRow.querySelector("[data-length-select]");
  const languageSelect = expandRow.querySelector("[data-language-select]");
  const generateBtn = expandRow.querySelector('[data-action="generate-all"]');
  const stopBtn = expandRow.querySelector('[data-action="generate-stop"]');
  const progressEl = expandRow.querySelector("[data-gen-progress]");
  const progressTextEl = expandRow.querySelector("[data-gen-progress-text]");

  function markCompletedDots() {
    const activeLanguage = languageSelect.value || "English";
    expandRow.querySelectorAll("[data-platform-dot]").forEach((dot) => {
      const has = savedContent.some((c) => c.platform === dot.dataset.platformDot && (c.language || "English") === activeLanguage);
      dot.classList.toggle("done", has);
    });
  }

  async function showPlatform(platform) {
    currentPlatform = platform;
    expandRow.querySelectorAll(".platform-tab").forEach((t) => t.classList.toggle("active", t.dataset.platform === platform));
    const activeLanguage = languageSelect.value || "English";
    const saved = savedContent.find((c) => c.platform === platform && (c.language || "English") === activeLanguage);
    const providerHintEl = expandRow.querySelector("[data-gen-provider-hint]");
    const subjectRow = expandRow.querySelector("[data-gen-subject-row]");
    const subjectInput = expandRow.querySelector("[data-gen-subject-input]");
    subjectRow.style.display = platform === "email" ? "flex" : "none";
    if (saved) {
      const signatureHtml = await getCachedSignature();
      outputEl.innerHTML = `${renderFormattedContent(saved.content)}${signatureHtml ? `<div class="gen-output-signature">${signatureHtml}</div>` : ""}`;
      if (platform === "email") subjectInput.value = saved.subject || "";
      if (saved.tone) {
        toneSelect.value = saved.tone;
        currentTone = saved.tone;
      }
      if (saved.length) {
        lengthSelect.value = saved.length;
        currentLength = saved.length;
      }
      providerHintEl.innerHTML = providerHintIconHtml(saved.provider);
    } else {
      outputEl.innerHTML = `Not generated yet for ${platform} in ${activeLanguage}. Pick a tone and length, then click "Generate Content" - or switch to a language/platform combination that's already been generated.`;
      if (platform === "email") subjectInput.value = "";
      providerHintEl.innerHTML = "";
    }
    markCompletedDots();
  }
  languageSelect.addEventListener("change", () => showPlatform(currentPlatform));
  showPlatform("email");

  expandRow.querySelectorAll(".ai-provider-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      expandRow.querySelectorAll(".ai-provider-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      currentAiProvider = tab.dataset.aiProvider;
    });
  });

  // CTA/Meeting/Website: opt-in toggles that shape how the generated
  // content is written (organic CTA / meeting invite / website mention).
  // Meeting and Website reveal an inline link field when turned on -
  // pre-filled from the user's saved default (Account Settings) but
  // editable per-generation without needing to leave this panel.
  expandRow.querySelectorAll(".gen-extra-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const extra = btn.dataset.extra;
      if (extra === "cta") {
        ctaEnabled = !ctaEnabled;
        btn.classList.toggle("active", ctaEnabled);
      } else if (extra === "meeting") {
        meetingEnabled = !meetingEnabled;
        btn.classList.toggle("active", meetingEnabled);
        expandRow.querySelector('[data-extra-link="meeting"]').style.display = meetingEnabled ? "block" : "none";
      } else if (extra === "website") {
        websiteEnabled = !websiteEnabled;
        btn.classList.toggle("active", websiteEnabled);
        expandRow.querySelector('[data-extra-link="website"]').style.display = websiteEnabled ? "block" : "none";
      }
    });
  });
  api("/api/settings/content-links")
    .then((res) => res.json())
    .then((data) => {
      expandRow.querySelector("[data-meeting-link-input]").value = data.meetingLink || "";
      expandRow.querySelector("[data-website-link-input]").value = data.websiteLink || "";
    })
    .catch(() => {});

  async function pollGenerationStatus() {
    const res = await api(`/api/leads/${leadId}/generate-content/status`);
    const job = await res.json();

    if (job.status === "running") {
      progressTextEl.textContent = job.currentStep || "Working…";
      return;
    }

    // Finished (done/failed/stopped) - stop polling and refresh the panel
    clearInterval(genPollTimer);
    genPollTimer = null;
    progressEl.style.display = "none";
    generateBtn.style.display = "inline-flex";
    stopBtn.style.display = "none";

    const contentRes = await api(`/api/leads/${leadId}/outreach-content`).catch(() => null);
    savedContent = contentRes && contentRes.ok ? (await contentRes.json()).content : savedContent;
    markCompletedDots();
    showPlatform(currentPlatform);

    const failedCount = Object.keys(job.failedPlatforms || {}).length;
    if (job.status === "stopped") {
      showToast("Content generation stopped", "info");
    } else if (job.completedPlatforms.length > 0 && failedCount > 0) {
      showToast(`Generated ${job.completedPlatforms.length}/6 platforms - ${failedCount} failed (check individual platforms)`, "error");
    } else if (job.completedPlatforms.length > 0) {
      showToast(`Generated content for ${job.completedPlatforms.length} platform(s)`, "success");
    } else {
      const firstError = Object.values(job.failedPlatforms || {})[0];
      showToast(`Content generation failed: ${firstError || "unknown error"}`, "error");
      // Also shown persistently in the output area (not just the toast,
      // which auto-dismisses) so the real underlying error is actually
      // readable and reportable, not just glimpsed for a few seconds.
      if (!savedContent.find((c) => c.platform === currentPlatform)) {
        outputEl.innerHTML = `<div style="color:var(--danger);">${firstError || "Content generation failed - unknown error."}</div>`;
      }
    }
  }

  async function startGeneration(platforms) {
    currentTone = toneSelect.value;
    currentLength = lengthSelect.value;
    currentLanguage = languageSelect.value;
    if (!currentTone) {
      showToast("Pick a tone/format first", "error");
      return;
    }

    const result = await callGenerationStart(leadId, {
      tone: currentTone,
      length: currentLength,
      language: currentLanguage,
      aiProvider: currentAiProvider || undefined,
      platforms,
      cta: ctaEnabled || undefined,
      meeting: meetingEnabled || undefined,
      meetingLink: meetingEnabled ? expandRow.querySelector("[data-meeting-link-input]").value.trim() || undefined : undefined,
      website: websiteEnabled || undefined,
      websiteLink: websiteEnabled ? expandRow.querySelector("[data-website-link-input]").value.trim() || undefined : undefined,
    });
    if (!result.ok) {
      showToast(result.error, "error");
      outputEl.innerHTML = `<div style="color:var(--danger);">${result.error}</div>`;
      return;
    }

    progressEl.style.display = "flex";
    generateBtn.style.display = "none";
    stopBtn.style.display = "inline-flex";
    progressTextEl.textContent = "Starting…";

    // Remember whichever meeting/website links were just used as the new
    // default, so the next lead's panel starts pre-filled with them too.
    if (meetingEnabled || websiteEnabled) {
      const meetingLinkVal = expandRow.querySelector("[data-meeting-link-input]").value.trim();
      const websiteLinkVal = expandRow.querySelector("[data-website-link-input]").value.trim();
      api("/api/settings/content-links", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meetingLink: meetingLinkVal, websiteLink: websiteLinkVal }),
      }).catch(() => {});
    }

    await pollGenerationStatus();
    if (!genPollTimer) genPollTimer = setInterval(pollGenerationStatus, 1500);
  }

  expandRow.addEventListener("click", async (e) => {
    const action = e.target.closest("[data-action]")?.dataset.action;

    if (action === "toggle-website-panel") {
      const panel = expandRow.querySelector("[data-website-panel]");
      const btn = e.target.closest("[data-action]");
      const isOpen = panel.style.display !== "none";
      if (isOpen) {
        panel.style.display = "none";
        btn.innerHTML = `<i class="bi bi-plus-circle"></i> Create Website`;
      } else {
        panel.style.display = "block";
        btn.innerHTML = `<i class="bi bi-dash-circle"></i> Hide`;
        if (!panel.dataset.loaded) {
          panel.dataset.loaded = "1";
          await initWebsitePanel(panel, leadId, lead);
        }
      }
      return;
    }

    if (action === "save-owner-name") {
      const input = expandRow.querySelector("[data-owner-name-input]");
      const value = input.value.trim();
      await api(`/api/leads/${leadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerName: value || null }),
      });
      lead.owner_name = value || null;
      showToast("Owner name saved", "success");
      return;
    }

    if (action === "pin-lead") {
      const btn = e.target.closest("[data-action]");
      const newPinned = !lead.pinned;
      await api(`/api/leads/${leadId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: newPinned }),
      });
      lead.pinned = newPinned;
      btn.classList.toggle("pinned", newPinned);
      btn.innerHTML = `<i class="bi ${newPinned ? "bi-pin-angle-fill" : "bi-pin-angle"}"></i> ${newPinned ? "Pinned" : "Pin"}`;
      showToast(newPinned ? "Lead pinned" : "Lead unpinned", "success");
      return;
    }

    if (action === "inspect-start") {
      try {
        const res = await api(`/api/leads/${leadId}/inspect/start`, { method: "POST" });
        if (!res.ok) {
          const data = await res.json();
          showToast(data.error || "Could not start inspection", "error");
          return;
        }
        showToast("Inspection started", "info");
        await loadAndRenderInspect(leadId, inspectBody);
      } catch (err) {
        showToast("Could not start inspection", "error");
      }
      return;
    }

    if (action === "inspect-refresh") {
      await loadAndRenderInspect(leadId, inspectBody);
      return;
    }

    if (action === "inspect-stop") {
      await api(`/api/leads/${leadId}/inspect/stop`, { method: "POST" });
      showToast("Inspection stopped", "info");
      await loadAndRenderInspect(leadId, inspectBody);
      return;
    }

    // Generates all 6 platforms in one background job - per spec, no need
    // to click Generate again when switching platform tabs afterward.
    if (action === "generate-all") {
      const availablePlatforms = getAvailablePlatforms(lead);
      const targetPlatforms = availablePlatforms.length ? availablePlatforms : ["email"];
      if (availablePlatforms.length && availablePlatforms.length < PLATFORMS.length) {
        const skipped = PLATFORMS.map((p) => p.key).filter((p) => !availablePlatforms.includes(p));
        showToast(`Generating for ${availablePlatforms.join(", ")} - skipping ${skipped.join(", ")} (no contact info found)`, "info");
      }
      await startGeneration(targetPlatforms);
      return;
    }

    if (action === "generate-stop") {
      await api(`/api/leads/${leadId}/generate-content/stop`, { method: "POST" });
      return;
    }

    if (action === "copy-content") {
      const activeLanguage = languageSelect.value || "English";
      const saved = savedContent.find((c) => c.platform === currentPlatform && (c.language || "English") === activeLanguage);
      const signatureHtml = await getCachedSignature();
      const bodyText = stripMarkdownFormatting(saved?.content || "");
      const signatureText = htmlToPlainText(signatureHtml);
      navigator.clipboard?.writeText(signatureText ? `${bodyText}\n\n${signatureText}` : bodyText);
      showToast("Copied to clipboard", "success");
      return;
    }

    if (action === "regenerate-content") {
      await startGeneration([currentPlatform]);
      return;
    }

    if (action === "copy-subject") {
      const subjectInput = expandRow.querySelector("[data-gen-subject-input]");
      navigator.clipboard?.writeText(subjectInput.value || "");
      showToast("Subject copied", "success");
      return;
    }

    if (action === "regenerate-subject") {
      const btn = e.target.closest("[data-action]");
      const subjectInput = expandRow.querySelector("[data-gen-subject-input]");
      btn.classList.add("spinning");
      try {
        const res = await api(`/api/leads/${leadId}/regenerate-subject`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ language: languageSelect.value || "English", aiProvider: currentAiProvider || undefined }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Could not regenerate subject");
        subjectInput.value = data.subject;
        const activeLanguage = languageSelect.value || "English";
        const saved = savedContent.find((c) => c.platform === "email" && (c.language || "English") === activeLanguage);
        if (saved) saved.subject = data.subject;
        showToast("Subject regenerated", "success");
      } catch (err) {
        showToast(err.message, "error");
      } finally {
        btn.classList.remove("spinning");
      }
      return;
    }

    if (action === "clear-content") {
      const confirmed = await openModal({
        title: `Clear ${currentPlatform} content?`,
        message: `This deletes the saved ${languageSelect.value || "English"} content for this platform - other languages are unaffected. This cannot be undone.`,
        confirmText: "Clear",
        danger: true,
      });
      if (!confirmed) return;
      const activeLanguage = languageSelect.value || "English";
      await api(`/api/leads/${leadId}/outreach-content/${currentPlatform}?language=${encodeURIComponent(activeLanguage)}`, { method: "DELETE" });
      savedContent = savedContent.filter((c) => !(c.platform === currentPlatform && (c.language || "English") === activeLanguage));
      markCompletedDots();
      showPlatform(currentPlatform);
      showToast(`Cleared ${currentPlatform} content (${activeLanguage})`, "success");
      return;
    }

    // Platform tabs now only switch which platform's already-generated
    // content is shown - they no longer trigger new generation, per spec.
    const platformTab = e.target.closest(".platform-tab");
    if (platformTab) {
      showPlatform(platformTab.dataset.platform);
    }
  });
}

recordsBody.addEventListener("click", (e) => {
  if (e.target.closest(".lead-expand-row")) return; // clicks inside the expand panel itself are handled separately
  if (e.target.closest(".row-status-dropdown, .row-actions, a, button")) return; // don't hijack interactive elements
  const row = e.target.closest(".list-row[data-lead-row-id]");
  if (!row) return;
  toggleLeadExpand(Number(row.dataset.leadRowId));
});

const STATUS_COLORS_LIGHT = {
  new: "#3274c3",
  shortlisted: "#976d16",
  contacted: "#e03400",
  engaged: "#ac47d7",
  converted: "#1c7d74",
  won: "#40824d",
  rejected: "#d83b3b",
};

function statusColorFor(value) {
  const found = STATUS_COLORS.find((s) => s.value === value);
  if (!found) return "#948d80";
  if (currentTheme.mode === "light" && STATUS_COLORS_LIGHT[value]) return STATUS_COLORS_LIGHT[value];
  return found.color;
}

// Custom themed dropdown for the per-row status cell, same reasoning as the
// filter dropdowns above: native <option> colors don't render reliably
// across browsers, so build our own so the color always shows.
function rowStatusDropdownHtml(lead) {
  const color = statusColorFor(lead.status);
  const items = STATUS_COLORS.filter((s) => s.value !== "")
    .map(
      (s) => `
      <div class="theme-dropdown-item filter-item ${s.value === lead.status ? "selected" : ""}" data-value="${s.value}">
        <span class="filter-dot" style="background:${s.color}"></span>${s.label}
      </div>`
    )
    .join("");

  return `
    <div class="theme-dropdown row-status-dropdown" data-lead-id="${lead.id}">
      <button type="button" class="row-status-trigger" style="--status-color:${color};">
        <span class="filter-dot" style="background:${color}"></span>
        <span class="row-status-label">${lead.status}</span>
        <span class="theme-dropdown-caret">▾</span>
      </button>
      <div class="theme-dropdown-panel row-status-panel">${items}</div>
    </div>`;
}

// Single delegated listener for every row's status dropdown - attached once
// (not inside renderLeads) since recordsBody itself persists across re-renders.
recordsBody.addEventListener("click", (e) => {
  const trigger = e.target.closest(".row-status-trigger");
  if (trigger) {
    e.stopPropagation();
    const dd = trigger.closest(".row-status-dropdown");
    const wasOpen = dd.classList.contains("open");
    document.querySelectorAll(".row-status-dropdown.open").forEach((d) => d.classList.remove("open"));
    if (!wasOpen) dd.classList.add("open");
    return;
  }

  const item = e.target.closest(".row-status-panel [data-value]");
  if (item) {
    const dd = item.closest(".row-status-dropdown");
    const leadId = dd.dataset.leadId;
    const value = item.dataset.value;
    const color = statusColorFor(value);
    const oldValue = dd.querySelector(".row-status-label").textContent;

    // Update in place immediately - snappier than a full re-render, and the
    // rest of the row (needs/rating/etc.) doesn't depend on status anyway.
    dd.querySelector(".row-status-label").textContent = value;
    dd.querySelector(".row-status-trigger").style.setProperty("--status-color", color);
    dd.querySelectorAll("[data-value]").forEach((el) => el.classList.toggle("selected", el.dataset.value === value));
    dd.classList.remove("open");

    // A status change that moves a lead out of the currently-viewed scope
    // should make the row vanish right away, not after a network
    // round-trip - remove it instantly, let the background refresh below
    // correct S/N numbering. This applies in Reach Out (moving to a
    // different pipeline stage) and in Hunt (any status change moves the
    // lead out of Hunt entirely, since Hunt only ever shows "new" leads).
    const leavesCurrentView =
      (state.mode === "outreach" && value !== state.outreach.status) || (state.mode !== "outreach" && value !== "new");
    if (leavesCurrentView) {
      const row = dd.closest(".list-row");
      if (row) row.remove();
      if (!recordsBody.querySelector(".list-row")) emptyState.style.display = "block";
    }

    // Badge counts in the sidebar tree also update instantly instead of
    // waiting on a full re-fetch - decrement the old status's badge,
    // increment the new one's, right in the currently-rendered DOM.
    if (state.mode === "outreach") {
      adjustOutreachBadgeCount(state.outreach.nicheId, state.outreach.catchLogId, oldValue, -1);
      adjustOutreachBadgeCount(state.outreach.nicheId, state.outreach.catchLogId, value, 1);
    }

    api(`/api/leads/${leadId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: value }),
    })
      .then(async () => {
        showToast(`Status updated to "${value}"`, "success");
        // The outreach summary cache affects a different section (Reach
        // Out's hide-empty-niches logic) than whichever mode this status
        // change happened in, so it always needs invalidating here -
        // otherwise navigating to Reach Out later would show stale
        // hide/show decisions from before this status change.
        state.outreachSummaries.clear();
        // Still refresh from the server shortly after, to correct S/N
        // numbering and catch any edge case the optimistic update missed -
        // this happens invisibly in the background, not blocking what the
        // user already sees.
        if (state.mode === "outreach") {
          await renderOutreachTree();
          await loadLeads();
        } else if (leavesCurrentView) {
          await loadLeads();
          await loadNichesAndLogs();
        }
      })
      .catch((err) => {
        console.error("Failed to update lead status:", err);
        showToast(`Failed to update status: ${err.message}`, "error");
      });
  }
});

document.addEventListener("click", (e) => {
  if (!e.target.closest(".row-status-dropdown")) {
    document.querySelectorAll(".row-status-dropdown.open").forEach((d) => d.classList.remove("open"));
  }
});

const LOCATION_PIN_SVG = `<i class="bi bi-geo-alt-fill"></i>`;

// Order matches the requested spec: Email, FB, Insta, Phone, LinkedIn, TikTok
const SOCIAL_ICON_META = {
  location: { icon: "bi-geo-alt-fill", bg: "#6b6459" },
  email: { icon: "bi-envelope-fill", bg: "#5a5550" },
  facebook: { icon: "bi-facebook", bg: "#3b5998" },
  instagram: { icon: "bi-instagram", bg: "#c8347a" },
  phone: { icon: "bi-telephone-fill", bg: "#4caf6d" },
  linkedin: { icon: "bi-linkedin", bg: "#0a66c2" },
  tiktok: { icon: "bi-tiktok", bg: "#111" },
};

function socialBadge(key) {
  const meta = SOCIAL_ICON_META[key];
  return `<span class="social-badge" style="background:${meta.bg}"><i class="bi ${meta.icon}"></i></span>`;
}

// Maps each content-generation platform to what "available" means for
// that lead - email/facebook/instagram/linkedin/tiktok need their matching
// socials entry; whatsapp needs a phone number (WhatsApp messages go to a
// number, not a separate handle), checking both the scraped socials.phone
// and the Google Places phone field since either is a real reachable number.
function getAvailablePlatforms(lead) {
  const socials = lead.socials || {};
  const checks = {
    email: !!socials.email,
    facebook: !!socials.facebook,
    instagram: !!socials.instagram,
    linkedin: !!socials.linkedin,
    tiktok: !!socials.tiktok,
    whatsapp: !!(socials.phone || lead.phone),
  };
  return Object.entries(checks)
    .filter(([, available]) => available)
    .map(([platform]) => platform);
}

function socialLinksHtml(lead) {
  const socials = lead.socials || {};
  const items = [];

  const mapLink = mapsLinkFor(lead);
  if (mapLink) {
    items.push(`<a href="${mapLink}" target="_blank" rel="noopener" class="social-icon" title="${lead.address || "View on map"}">${socialBadge("location")}</a>`);
  }
  if (socials.email) {
    items.push(`<a href="mailto:${socials.email}" class="social-icon" title="Email: ${socials.email}">${socialBadge("email")}</a>`);
  }
  if (socials.facebook) {
    items.push(`<a href="${socials.facebook}" target="_blank" rel="noopener" class="social-icon" title="Facebook">${socialBadge("facebook")}</a>`);
  }
  if (socials.instagram) {
    items.push(`<a href="${socials.instagram}" target="_blank" rel="noopener" class="social-icon" title="Instagram">${socialBadge("instagram")}</a>`);
  }
  // Uses the scraper's own tel: link finding, not the Google-Places phone
  // already shown in the Contact column - this icon specifically means "we
  // independently confirmed a click-to-call link on their own website."
  if (socials.phone) {
    items.push(`<a href="tel:${socials.phone.replace(/\s+/g, "")}" class="social-icon" title="Call ${socials.phone} (found on their website)">${socialBadge("phone")}</a>`);
  }
  if (socials.linkedin) {
    items.push(`<a href="${socials.linkedin}" target="_blank" rel="noopener" class="social-icon" title="LinkedIn">${socialBadge("linkedin")}</a>`);
  }
  if (socials.tiktok) {
    items.push(`<a href="${socials.tiktok}" target="_blank" rel="noopener" class="social-icon" title="TikTok">${socialBadge("tiktok")}</a>`);
  }

  return items.join("") || `<span class="no-website">—</span>`;
}

// Fixed set of need categories, always rendered as dots - "active" (colored)
// if this lead has that tag, dim/outline if not. Order matches tagClass().
const NEED_DOT_TYPES = [
  { label: "Website Design", cssClass: "website", icon: "bi-globe" },
  { label: "GMB Optimization", cssClass: "gmb", icon: "bi-geo-alt-fill" },
  { label: "Local SEO", cssClass: "seo", icon: "bi-search" },
  { label: "Review Generation", cssClass: "review", icon: "bi-star-fill" },
  { label: "Reputation Management", cssClass: "rep", icon: "bi-shield-check" },
];

function needsDotsHtml(lead) {
  return `<div class="needs-dots">${NEED_DOT_TYPES.map(
    ({ label, cssClass, icon }) =>
      `<i class="bi ${icon} need-icon ${lead.needs.includes(label) ? "active " + cssClass : ""}" title="${label}${lead.needs.includes(label) ? "" : " (not applicable)"}"></i>`
  ).join("")}</div>`;
}

function renderLeads(leads) {
  recordsBody.innerHTML = "";
  state.currentLeadsById = new Map(leads.map((l) => [l.id, l]));
  closeAllLeadExpansions();

  if (leads.length === 0) {
    emptyState.style.display = "block";
    return;
  }
  emptyState.style.display = "none";

  const startIndex = (state.page - 1) * state.pageSize;

  leads.forEach((lead, index) => {
    const row = document.createElement("div");
    row.className = "list-row expandable";
    row.dataset.leadRowId = lead.id;

    const websiteHtml = lead.website
      ? `<a href="${lead.website}" target="_blank" rel="noopener">${(() => {
          try {
            return new URL(lead.website).hostname;
          } catch {
            return lead.website;
          }
        })()}</a>`
      : `<span class="no-website">no website</span>`;
    const phoneHtml = lead.phone
      ? `<span class="contact-line">${lead.phone}<a class="call-icon" href="tel:${lead.phone.replace(/\s+/g, "")}" title="Call ${lead.phone}"><i class="bi bi-telephone-fill"></i></a></span>`
      : `<span class="no-website">no phone listed</span>`;

    const ratingHtml = lead.rating
      ? `<span class="rating-val">${lead.rating.toFixed(1)} <small>(${lead.review_count ?? 0})</small></span>`
      : `<span class="rating-val" title="Rating Not Pulled — ratings cost extra API quota, so they're only fetched when 'Include ratings' is checked on a hunt"><small>RNP</small></span>`;

    row.innerHTML = `
      <div class="col-sn">${startIndex + index + 1}</div>
      <div>
        <div class="lead-name-row">
          <span class="lead-name" title="${lead.name}">${lead.name}</span>
        </div>
      </div>
      <div class="city-cell" title="${lead.city_name || ""}">${lead.city_name || "—"}</div>
      <div><div class="contact-row">${websiteHtml}<br/>${phoneHtml}</div></div>
      <div>${needsDotsHtml(lead)}</div>
      <div><div class="social-row">${socialLinksHtml(lead)}</div></div>
      <div>${ratingHtml}</div>
      <div>${rowStatusDropdownHtml(lead)}</div>
      <div class="row-actions">
        <button data-action="delete" data-id="${lead.id}" title="Remove"><i class="bi bi-trash"></i></button>
        ${
          lead.has_analysis || lead.has_content
            ? `<i class="bi bi-check-circle-fill row-done-hint" title="${lead.has_analysis ? "Inspected" : ""}${lead.has_analysis && lead.has_content ? " · " : ""}${lead.has_content ? "Content generated" : ""}"></i>`
            : ""
        }
      </div>
    `;
    recordsBody.appendChild(row);
  });

  recordsBody.querySelectorAll('[data-action="delete"]').forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const id = e.target.closest("[data-id]").dataset.id;
      const confirmed = await openModal({
        title: "Remove this record?",
        message: "This deletes the lead permanently. This cannot be undone.",
        confirmText: "Remove",
        danger: true,
      });
      if (!confirmed) return;

      // Remove instantly instead of waiting on the network round-trip -
      // the delete call and the follow-up refreshes happen in the
      // background afterward, not blocking what the user sees.
      const row = e.target.closest(".list-row");
      if (row) row.remove();
      if (!recordsBody.querySelector(".list-row")) emptyState.style.display = "block";

      api(`/api/leads/${id}`, { method: "DELETE" })
        .then(() => {
          showToast("Record removed", "success");
          loadLeads(); // corrects S/N numbering and pagination counts shortly after
          loadNichesAndLogs();
        })
        .catch((err) => {
          console.error("Failed to delete lead:", err);
          showToast(`Failed to remove record: ${err.message}`, "error");
        });
    });
  });
}

function updatePaginationControls(total, totalPages) {
  if (total === 0) {
    paginationRow.style.display = "none";
    return;
  }
  paginationRow.style.display = "flex";
  pageInfo.textContent = `Page ${state.page} of ${totalPages} (${total} total)`;
  prevPageBtn.disabled = state.page <= 1;
  nextPageBtn.disabled = state.page >= totalPages;
}

prevPageBtn.addEventListener("click", () => {
  if (state.page > 1) {
    state.page--;
    loadLeads();
  }
});
nextPageBtn.addEventListener("click", () => {
  state.page++;
  loadLeads();
});

async function loadLeads() {
  const params = new URLSearchParams();
  params.set("page", state.page);
  params.set("pageSize", state.pageSize);
  params.set("sortBy", state.sortBy);
  if (state.sortDir) params.set("sortDir", state.sortDir);

  if (state.mode === "outreach") {
    if (!state.outreach.catchLogId) {
      renderLeads([]);
      updatePaginationControls(0, 1);
      return;
    }
    params.set("catchLogId", state.outreach.catchLogId);
    params.set("status", state.outreach.status);
  } else if (state.mode === "pinned") {
    if (!state.pinned.catchLogId) {
      renderLeads([]);
      updatePaginationControls(0, 1);
      return;
    }
    params.set("catchLogId", state.pinned.catchLogId);
    params.set("pinned", "1");
  } else {
    // Hunt only ever shows fresh, untouched leads - the moment a status
    // changes away from "new" (via Reach Out), it should disappear from
    // here permanently and only be reachable from Reach Out going forward.
    params.set("status", "new");
    if (filterSearch.value) params.set("search", filterSearch.value);
    if (filterState.need) params.set("need", filterState.need);
    if (filterState.inspected) params.set("inspected", "1");
    if (state.activeCatchLogId) {
      params.set("catchLogId", state.activeCatchLogId);
    } else if (state.activeNicheId) {
      params.set("nicheId", state.activeNicheId);
    }
  }

  const res = await api(`/api/leads?${params.toString()}`);
  const data = await res.json();
  renderLeads(data.leads);
  updatePaginationControls(data.total, data.totalPages);
}

// ---------- Search / hunt ----------
searchForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  if (!state.selectedNicheId) {
    searchStatus.textContent = "Pick a niche first (or create a new one).";
    searchStatus.className = "search-status error";
    return;
  }

  huntBtn.disabled = true;
  searchStatus.textContent = "Hunting…";
  searchStatus.className = "search-status";

  const keyword = document.getElementById("keyword").value.trim();
  const location = document.getElementById("location").value.trim();
  const maxResults = Number(document.getElementById("maxResults").value) || 20;
  const includeRatings = document.getElementById("includeRatings").checked;
  const catchLogName = catchLogNameInput.value.trim();

  const payload = {
    keyword,
    location,
    maxResults,
    includeRatings,
    catchLogName,
    nicheId: state.selectedNicheId,
  };

  try {
    const res = await api("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || "Search failed");

    searchStatus.textContent = `Pulled ${data.pulled} distinct leads into "${data.catchLogName}". ${data.remainingToday} left in today's quota.`;
    searchStatus.className = "search-status ok";
    showToast(`Hunted ${data.pulled} new lead${data.pulled === 1 ? "" : "s"} into "${data.catchLogName}"`, "success");

    state.activeCatchLogId = data.catchLogId;
    catchLogNameInput.value = "";

    await loadNichesAndLogs();
    state.openNicheIds.add(data.nicheId);
    renderNichesTree();
    updateScopeLine();
    await loadLeads();
    await refreshQuota();
  } catch (err) {
    searchStatus.textContent = err.message;
    searchStatus.className = "search-status error";
    showToast(`Hunt failed: ${err.message}`, "error");
  } finally {
    huntBtn.disabled = false;
  }
});

// ---------- Filters ----------
let filterDebounce;
filterSearch.addEventListener("input", () => {
  clearTimeout(filterDebounce);
  filterDebounce = setTimeout(() => {
    state.page = 1;
    loadLeads();
  }, 250);
});

// ---------- Reports page ----------
const reportsRangeDropdown = document.getElementById("reportsRangeDropdown");
const reportsRangeDropdownTrigger = document.getElementById("reportsRangeDropdownTrigger");
const reportsRangeDropdownPanel = document.getElementById("reportsRangeDropdownPanel");
const reportsRangeDropdownLabel = document.getElementById("reportsRangeDropdownLabel");
const reportsNicheDropdown = document.getElementById("reportsNicheDropdown");
const reportsNicheDropdownTrigger = document.getElementById("reportsNicheDropdownTrigger");
const reportsNicheDropdownPanel = document.getElementById("reportsNicheDropdownPanel");
const reportsNicheDropdownLabel = document.getElementById("reportsNicheDropdownLabel");
const reportsCityDropdown = document.getElementById("reportsCityDropdown");
const reportsCityDropdownTrigger = document.getElementById("reportsCityDropdownTrigger");
const reportsCityDropdownPanel = document.getElementById("reportsCityDropdownPanel");
const reportsCityDropdownLabel = document.getElementById("reportsCityDropdownLabel");
const reportsStatGrid = document.getElementById("reportsStatGrid");

const REPORT_RANGE_OPTIONS = [
  { value: "1d", label: "1D", color: "#948d80" },
  { value: "7d", label: "Last 7 days", color: "#7fa8d9" },
  { value: "1m", label: "Last 30 days", color: "#e0b355" },
  { value: "3m", label: "Last 3 months", color: "#ff6a3d" },
  { value: "6m", label: "Last 6 months", color: "#c586e0" },
  { value: "1y", label: "Last year", color: "#7fb88a" },
  { value: "all", label: "All time", color: "#4fd1c5" },
];

// Defaults per spec: 1 Day / All niches / All cities
const reportsFilters = { range: "1d", nicheId: "", cityId: "" };
let reportsNichesCities = { niches: [], cities: [] };

document.getElementById("reportsExportCsvBtn").addEventListener("click", () => {
  const params = new URLSearchParams();
  params.set("range", reportsFilters.range);
  if (reportsFilters.nicheId) params.set("niche", reportsFilters.nicheId);
  if (reportsFilters.cityId) params.set("city", reportsFilters.cityId);
  params.set("nicheLabel", reportsNicheDropdownLabel.textContent.trim());
  params.set("cityLabel", document.getElementById("reportsCityDropdownLabel").textContent.trim());
  window.open(`/api/reports/export/csv?${params.toString()}`, "_blank");
});

document.getElementById("reportsExportPdfBtn").addEventListener("click", async () => {
  const btn = document.getElementById("reportsExportPdfBtn");
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<i class="bi bi-hourglass-split"></i> Exporting…`;

  try {
    // Chart.js canvases only exist in the browser - capture each as a PNG
    // data URL here and send it to the server to embed in the PDF, rather
    // than trying to re-render charts server-side.
    const chartConfigs = [
      { id: "reportsLineChart", title: "Status trend over time" },
      { id: "reportsPieChart", title: "Pipeline distribution" },
      { id: "reportsDonutChart", title: "Status breakdown" },
      { id: "reportsStatusComparisonChart", title: "All statuses compared" },
    ];
    const chartImages = chartConfigs
      .map((c) => {
        const canvas = document.getElementById(c.id);
        if (!canvas || canvas.width === 0) return null;
        try {
          return { title: c.title, dataUrl: canvas.toDataURL("image/png") };
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const params = new URLSearchParams();
    params.set("range", reportsFilters.range);
    if (reportsFilters.nicheId) params.set("niche", reportsFilters.nicheId);
    if (reportsFilters.cityId) params.set("city", reportsFilters.cityId);

    const res = await api(`/api/reports/export/pdf?${params.toString()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nicheLabel: reportsNicheDropdownLabel.textContent.trim(),
        cityLabel: document.getElementById("reportsCityDropdownLabel").textContent.trim(),
        chartImages,
      }),
    });
    if (!res.ok) throw new Error("Could not generate the PDF");

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `xeven-leads-reports-${reportsFilters.range}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast("PDF exported", "success");
  } catch (err) {
    showToast(`Could not export PDF: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
});

let pieChartInstance = null;
let donutChartInstance = null;
let lineChartInstance = null;
let statusComparisonChartInstance = null;

function renderReportsRangeDropdown() {
  buildFilterDropdown({
    options: REPORT_RANGE_OPTIONS,
    trigger: reportsRangeDropdownTrigger,
    panel: reportsRangeDropdownPanel,
    label: reportsRangeDropdownLabel,
    currentValue: reportsFilters.range,
    onSelect: (value) => {
      reportsFilters.range = value;
      renderReportsRangeDropdown();
      loadReports();
    },
  });
}

function renderReportsNicheDropdown() {
  const options = [
    { value: "", label: "All niches", color: "#948d80" },
    ...reportsNichesCities.niches.map((n) => ({ value: String(n.id), label: n.name, color: "#7fa8d9" })),
  ];
  buildFilterDropdown({
    options,
    trigger: reportsNicheDropdownTrigger,
    panel: reportsNicheDropdownPanel,
    label: reportsNicheDropdownLabel,
    currentValue: reportsFilters.nicheId,
    onSelect: (value) => {
      reportsFilters.nicheId = value;
      reportsFilters.cityId = ""; // changing niche resets the (now possibly invalid) city selection
      renderReportsNicheDropdown();
      renderReportsCityDropdown();
      loadReports();
    },
  });
}

function renderReportsCityDropdown() {
  const filteredCities = reportsFilters.nicheId
    ? reportsNichesCities.cities.filter((c) => String(c.niche_id) === String(reportsFilters.nicheId))
    : reportsNichesCities.cities;
  const options = [
    { value: "", label: "All cities", color: "#948d80" },
    ...filteredCities.map((c) => ({ value: String(c.id), label: c.name, color: "#7fb88a" })),
  ];
  buildFilterDropdown({
    options,
    trigger: reportsCityDropdownTrigger,
    panel: reportsCityDropdownPanel,
    label: reportsCityDropdownLabel,
    currentValue: reportsFilters.cityId,
    onSelect: (value) => {
      reportsFilters.cityId = value;
      renderReportsCityDropdown();
      loadReports();
    },
  });
}

[reportsRangeDropdownTrigger, reportsNicheDropdownTrigger, reportsCityDropdownTrigger].forEach((trigger, i) => {
  const dd = [reportsRangeDropdown, reportsNicheDropdown, reportsCityDropdown][i];
  trigger.addEventListener("click", () => {
    const wasOpen = dd.classList.contains("open");
    [reportsRangeDropdown, reportsNicheDropdown, reportsCityDropdown].forEach((d) => d.classList.remove("open"));
    if (!wasOpen) dd.classList.add("open");
  });
});
document.addEventListener("click", (e) => {
  [reportsRangeDropdown, reportsNicheDropdown, reportsCityDropdown].forEach((d) => {
    if (!d.contains(e.target)) d.classList.remove("open");
  });
});

const REPORT_STATUS_META = [
  { key: "new", label: "New", color: "#7fa8d9" },
  { key: "shortlisted", label: "Shortlisted", color: "#e0b355" },
  { key: "contacted", label: "Contacted", color: "#ff6a3d" },
  { key: "engaged", label: "Engaged", color: "#c586e0" },
  { key: "converted", label: "Converted", color: "#4fd1c5" },
  { key: "won", label: "Won", color: "#7fb88a" },
  { key: "rejected", label: "Rejected", color: "#d95d5d" },
];

function renderReportsStatGrid(summary) {
  const cards = [
    { label: "Total Hunted", value: summary.total, color: "#ece7dd" },
    ...REPORT_STATUS_META.map((s) => ({ label: s.label, value: summary.byStatus[s.key] || 0, color: s.color })),
  ];
  reportsStatGrid.innerHTML = cards
    .map(
      (c) => `
    <div class="report-stat-card">
      <span class="report-stat-value" style="color:${c.color}">${c.value}</span>
      <span class="report-stat-label">${c.label}</span>
    </div>`
    )
    .join("");
}

function destroyReportsCharts() {
  [pieChartInstance, donutChartInstance, lineChartInstance, statusComparisonChartInstance].forEach((c) => c && c.destroy());
  pieChartInstance = null;
  donutChartInstance = null;
  lineChartInstance = null;
  statusComparisonChartInstance = null;
}

function showChartsError(message) {
  ["reportsPieChart", "reportsDonutChart", "reportsLineChart", "reportsStatusComparisonChart"].forEach((id) => {
    const canvas = document.getElementById(id);
    if (!canvas || !canvas.parentElement) return;
    let errorEl = canvas.parentElement.querySelector(".chart-error-msg");
    if (!errorEl) {
      errorEl = document.createElement("div");
      errorEl.className = "chart-error-msg";
      canvas.parentElement.appendChild(errorEl);
    }
    errorEl.textContent = message;
    canvas.style.display = "none";
  });
}

function clearChartsError() {
  document.querySelectorAll(".chart-error-msg").forEach((el) => el.remove());
  ["reportsPieChart", "reportsDonutChart", "reportsLineChart"].forEach((id) => {
    const canvas = document.getElementById(id);
    if (canvas) canvas.style.display = "";
  });
}

// Chart grid lines were a fixed light-white tint, invisible against a
// light-mode chart card - adapt based on the currently active theme.
function chartGridColor() {
  return currentTheme.mode === "light" ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.05)";
}

function renderReportsCharts(summary, timeseries) {
  if (typeof Chart === "undefined") {
    showChartsError(
      "Charts couldn't load - the Chart.js library was blocked or failed to load from the CDN (cdnjs.cloudflare.com). Try disabling ad-blockers/privacy extensions for this site, or check your network/firewall settings. The numbers above and the table below are unaffected."
    );
    return;
  }
  clearChartsError();

  const labels = REPORT_STATUS_META.map((s) => s.label);
  const data = REPORT_STATUS_META.map((s) => summary.byStatus[s.key] || 0);
  const colors = REPORT_STATUS_META.map((s) => s.color);
  const dataTotal = data.reduce((a, b) => a + b, 0);

  destroyReportsCharts();

  const commonOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: "bottom", labels: { color: currentTheme.colors["--text"], font: { size: 11 }, boxWidth: 10 } },
    },
  };

  // Pie/donut tooltips show both the raw count and the % share of the
  // total, not just the raw value Chart.js shows by default.
  const pieDonutOptions = {
    ...commonOptions,
    plugins: {
      ...commonOptions.plugins,
      tooltip: {
        callbacks: {
          label: (ctx) => {
            const value = ctx.parsed;
            const pct = dataTotal > 0 ? ((value / dataTotal) * 100).toFixed(1) : "0.0";
            return `${ctx.label}: ${value} (${pct}%)`;
          },
        },
      },
    },
  };

  // The reports panel may have just been switched from display:none to
  // visible in this same tick - a canvas measured before the browser has
  // actually laid out its now-visible container comes back as 0x0, and
  // Chart.js silently renders nothing. Two nested requestAnimationFrame
  // calls guarantee at least one full layout+paint has happened first.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      try {
        const pieCtx = document.getElementById("reportsPieChart");
        const donutCtx = document.getElementById("reportsDonutChart");
        const lineCtx = document.getElementById("reportsLineChart");

        pieChartInstance = new Chart(pieCtx, {
          type: "pie",
          data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: currentTheme.colors["--panel"], borderWidth: 2 }] },
          options: pieDonutOptions,
        });

        donutChartInstance = new Chart(donutCtx, {
          type: "doughnut",
          data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: currentTheme.colors["--panel"], borderWidth: 2 }] },
          options: pieDonutOptions,
        });

        const safeDays = timeseries && Array.isArray(timeseries.days) ? timeseries.days : [];
        const safeSeries = timeseries && timeseries.series ? timeseries.series : {};
        const lineLabels = safeDays.length ? safeDays : ["No data yet"];
        lineChartInstance = new Chart(lineCtx, {
          type: "line",
          data: {
            labels: lineLabels,
            datasets: REPORT_STATUS_META.map((s) => ({
              label: s.label,
              data: safeDays.length ? safeSeries[s.key] || safeDays.map(() => 0) : [0],
              borderColor: s.color,
              backgroundColor: s.color,
              borderWidth: 1.5,
              tension: 0.3,
              pointRadius: 3,
              pointHoverRadius: 5,
            })),
          },
          options: {
            ...commonOptions,
            interaction: { mode: "index", intersect: false },
            plugins: {
              ...commonOptions.plugins,
              tooltip: {
                mode: "index",
                intersect: false,
                callbacks: {
                  title: (items) => items[0]?.label || "",
                  label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.y}`,
                },
              },
            },
            scales: {
              x: { ticks: { color: currentTheme.colors["--text-muted"], font: { size: 10 } }, grid: { color: chartGridColor() } },
              y: { beginAtZero: true, ticks: { color: currentTheme.colors["--text-muted"], precision: 0 }, grid: { color: chartGridColor() } },
            },
          },
        });

        pieChartInstance.resize();
        donutChartInstance.resize();
        lineChartInstance.resize();

        // Status comparison bar chart - "All Hunted" (the grand total) sits
        // alongside every individual pipeline status so it's easy to see
        // what fraction made it to each stage at a glance.
        const comparisonCtx = document.getElementById("reportsStatusComparisonChart");
        const comparisonLabels = ["All Hunted", ...REPORT_STATUS_META.map((s) => s.label)];
        const comparisonData = [summary.total, ...data];
        const comparisonColors = ["#ece7dd", ...colors];
        const comparisonTotal = summary.total || 1; // percentages are always relative to the grand total, not the tallest bar

        statusComparisonChartInstance = new Chart(comparisonCtx, {
          type: "bar",
          data: {
            labels: comparisonLabels,
            datasets: [{ data: comparisonData, backgroundColor: comparisonColors, borderRadius: 4, maxBarThickness: 56 }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: (ctx) => {
                    const value = ctx.parsed.y;
                    const pct = ((value / comparisonTotal) * 100).toFixed(1);
                    return `${value} (${pct}% of all hunted)`;
                  },
                },
              },
            },
            scales: {
              x: { ticks: { color: currentTheme.colors["--text-muted"], font: { size: 11 } }, grid: { display: false } },
              y: { beginAtZero: true, ticks: { color: currentTheme.colors["--text-muted"], precision: 0 }, grid: { color: chartGridColor() } },
            },
          },
        });
        statusComparisonChartInstance.resize();
      } catch (err) {
        console.error("Failed to render Reports charts:", err);
        showChartsError(`Charts failed to render: ${err.message}. The numbers above and the table below are unaffected.`);
      }
    });
  });
}

const API_USAGE_LINE_COLORS = ["#ff6a3d", "#7fa8d9", "#e0b355", "#7fb88a", "#c586e0", "#4fd1c5", "#d95d5d"];
const providerChartInstances = { places: null, gemini: null };

const USAGE_RANGE_OPTIONS = [
  { value: "1d", label: "1D" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
  { value: "90d", label: "90D" },
  { value: "1y", label: "1Y" },
  { value: "all", label: "All Time" },
];

// Builds the HTML shell (table + chart canvas + duration filter) for one
// provider's usage section - unique IDs per call so the same provider's
// section can appear in more than one place at once (Limits Usage page AND
// that provider's own Settings page) without ID collisions.
function buildProviderUsageSectionHtml(uniqueSuffix, hasLeadsColumn) {
  return `
    <div class="reports-table-card">
      <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px;">
        <h3 style="margin:0;">Usage history</h3>
        <select class="gen-tone-select" id="usageRange-${uniqueSuffix}" style="width:auto; padding:5px 8px; font-size:11.5px;">
          ${USAGE_RANGE_OPTIONS.map((o) => `<option value="${o.value}" ${o.value === "1d" ? "selected" : ""}>${o.label}</option>`).join("")}
        </select>
      </div>
      <div class="table-scroll-wrap">
        <table class="reports-table">
          <thead><tr><th>Key</th><th>Total requests${hasLeadsColumn ? "" : " (all time)"}</th>${hasLeadsColumn ? "<th>Leads captured</th>" : ""}</tr></thead>
          <tbody id="usageTableBody-${uniqueSuffix}"></tbody>
        </table>
      </div>
    </div>
    <div class="reports-chart-card reports-line-card">
      <h3>Usage over time</h3>
      <canvas id="usageChart-${uniqueSuffix}"></canvas>
    </div>`;
}

async function loadAndRenderProviderUsage(provider, uniqueSuffix, hasLeadsColumn, range) {
  try {
    const rangeSelect = document.getElementById(`usageRange-${uniqueSuffix}`);
    const activeRange = range || (rangeSelect ? rangeSelect.value : "1d");
    const res = await api(`/api/settings/usage-history?provider=${provider}&range=${activeRange}`);
    const history = await res.json();
    renderProviderUsageHistory(history, {
      tbodyEl: document.getElementById(`usageTableBody-${uniqueSuffix}`),
      canvasId: `usageChart-${uniqueSuffix}`,
      chartKey: `usage-${uniqueSuffix}`,
      hasLeadsColumn,
    });

    if (rangeSelect && !rangeSelect.dataset.wired) {
      rangeSelect.dataset.wired = "1";
      rangeSelect.addEventListener("change", () => loadAndRenderProviderUsage(provider, uniqueSuffix, hasLeadsColumn, rangeSelect.value));
    }
  } catch (err) {
    console.error(`Failed to load usage history for ${provider}:`, err);
  }
}

function renderProviderUsageHistory(history, { tbodyEl, canvasId, chartKey, hasLeadsColumn }) {
  if (!history.keys.length) {
    tbodyEl.innerHTML = `<tr><td colspan="${hasLeadsColumn ? 3 : 2}" class="empty-cell-row">No API keys saved yet.</td></tr>`;
  } else {
    tbodyEl.innerHTML = history.keys
      .map(
        (k) => `
      <tr>
        <td>${k.label}${k.active ? ' <span class="api-key-active-badge">● In use</span>' : ""}</td>
        <td class="mono">${k.totalRequests}</td>
        ${hasLeadsColumn ? `<td class="mono">${k.totalLeads}</td>` : ""}
      </tr>`
      )
      .join("");
  }

  if (typeof Chart === "undefined") return;
  if (providerChartInstances[chartKey]) {
    providerChartInstances[chartKey].destroy();
    providerChartInstances[chartKey] = null;
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      try {
        const ctx = document.getElementById(canvasId);
        const labels = history.days.length ? history.days : ["No data yet"];
        providerChartInstances[chartKey] = new Chart(ctx, {
          type: "line",
          data: {
            labels,
            datasets: history.keys.map((k, i) => ({
              label: k.label,
              data: history.days.length ? k.requestsSeries : [0],
              borderColor: API_USAGE_LINE_COLORS[i % API_USAGE_LINE_COLORS.length],
              backgroundColor: API_USAGE_LINE_COLORS[i % API_USAGE_LINE_COLORS.length],
              borderWidth: 1.5,
              tension: 0.3,
              pointRadius: 3,
              pointHoverRadius: 5,
            })),
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: "index", intersect: false },
            plugins: {
              legend: { position: "bottom", labels: { color: currentTheme.colors["--text"], font: { size: 11 }, boxWidth: 10 } },
              tooltip: {
                mode: "index",
                intersect: false,
                callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y} requests` },
              },
            },
            scales: {
              x: { ticks: { color: currentTheme.colors["--text-muted"], font: { size: 10 } }, grid: { color: chartGridColor() } },
              y: { beginAtZero: true, ticks: { color: currentTheme.colors["--text-muted"], precision: 0 }, grid: { color: chartGridColor() } },
            },
          },
        });
        providerChartInstances[chartKey].resize();
      } catch (err) {
        console.error("Failed to render usage history chart:", err);
      }
    });
  });
}

async function loadReportsFilterOptions() {
  try {
    const res = await api("/api/reports/niches-cities");
    reportsNichesCities = await res.json();
    renderReportsNicheDropdown();
    renderReportsCityDropdown();
  } catch (err) {
    console.error("Failed to load report filter options:", err);
  }
}

async function loadReports() {
  try {
    const params = new URLSearchParams({ range: reportsFilters.range });
    if (reportsFilters.nicheId) params.set("niche", reportsFilters.nicheId);
    if (reportsFilters.cityId) params.set("city", reportsFilters.cityId);

    const [summaryRes, timeseriesRes] = await Promise.all([
      api(`/api/reports/summary?${params.toString()}`),
      api(`/api/reports/timeseries?${params.toString()}`),
    ]);

    if (!summaryRes.ok || !timeseriesRes.ok) {
      throw new Error(`Reports API returned an error (summary: ${summaryRes.status}, timeseries: ${timeseriesRes.status})`);
    }

    const summary = await summaryRes.json();
    const timeseries = await timeseriesRes.json();

    renderReportsStatGrid(summary);
    renderReportsCharts(summary, timeseries);
  } catch (err) {
    console.error("Failed to load reports:", err);
    showChartsError(`Couldn't load report data: ${err.message}`);
  }
}

// ---------- Init ----------
(async function init() {
  hideBanner();
  console.log("Xeven Leads app.js loaded — build " + APP_VERSION);
  await loadTheme();
  const versionTag = document.getElementById("versionTag");
  if (versionTag) versionTag.textContent = "build " + APP_VERSION;
  renderNeedDropdown();
  renderSortDropdown();
  renderReportsRangeDropdown();
  renderReportsNicheDropdown();
  renderReportsCityDropdown();
  await loadWhoami();
  await loadPageSizePreference();
  const failures = [];

  setContentView("board");

  try {
    await refreshQuota();
  } catch (err) {
    console.error("Failed to load quota:", err);
    failures.push("quota");
  }

  try {
    await loadNichesAndLogs();
  } catch (err) {
    console.error("Failed to load niches/catch logs:", err);
    failures.push("niches");
  }

  updateScopeLine();

  try {
    await loadLeads();
  } catch (err) {
    console.error("Failed to load leads:", err);
    failures.push("leads");
  }

  if (failures.length > 0) {
    showBanner(
      `Couldn't load: ${failures.join(", ")}. Open the browser console (F12) for details, or check the server logs.`
    );
  }
})();
