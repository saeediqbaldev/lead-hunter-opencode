const express = require("express");
const bcrypt = require("bcryptjs");
const asyncHandler = require("../asyncHandler");
const { testApiKey: testPlacesKey } = require("../placesApi");
const { testApiKey: testGeminiKey } = require("../gemini");
const { groqClient, deepseekClient } = require("../openaiCompatible");
const apiKeys = require("../apiKeys");
const db = require("../db");

const router = express.Router();

// GET /api/settings/profile -> the logged-in user's own username/role
router.get("/profile", (req, res) => {
  const row = db.prepare("SELECT username, role FROM users WHERE id = ?").get(req.session.userId);
  res.json({ username: row.username, role: row.role });
});

// PUT /api/settings/profile { currentPassword, newUsername?, newPassword? }
// Self-service account update - available to every user, admin included.
// Requires the current password to confirm identity before changing
// anything, same as any normal "change my account" flow.
router.put("/profile", (req, res) => {
  const { currentPassword, newUsername, newPassword } = req.body || {};
  if (!currentPassword) {
    return res.status(400).json({ error: "Enter your current password to confirm this change." });
  }
  if (!newUsername?.trim() && !newPassword) {
    return res.status(400).json({ error: "Enter a new username and/or a new password." });
  }
  if (newPassword && newPassword.length < 6) {
    return res.status(400).json({ error: "New password must be at least 6 characters." });
  }

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.userId);
  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    return res.status(401).json({ error: "Current password is incorrect." });
  }

  const finalUsername = newUsername?.trim() || user.username;

  try {
    if (newPassword) {
      const hash = bcrypt.hashSync(newPassword, 10);
      db.prepare("UPDATE users SET username = ?, password_hash = ? WHERE id = ?").run(finalUsername, hash, req.session.userId);
    } else {
      db.prepare("UPDATE users SET username = ? WHERE id = ?").run(finalUsername, req.session.userId);
    }
    req.session.username = finalUsername; // keep the session in sync so whoami reflects the change immediately
    res.json({ username: finalUsername });
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "That username is already taken." });
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /api/settings/daily-cap -> this user's own daily lead cap
router.get("/daily-cap", (req, res) => {
  const row = db.prepare("SELECT daily_lead_cap FROM users WHERE id = ?").get(req.session.userId);
  res.json({ dailyLeadCap: (row && row.daily_lead_cap) || 300 });
});

// PUT /api/settings/daily-cap { dailyLeadCap }
router.put("/daily-cap", (req, res) => {
  const value = Number(req.body.dailyLeadCap);
  if (!Number.isFinite(value) || value < 1 || value > 5000) {
    return res.status(400).json({ error: "Enter a number between 1 and 5000" });
  }
  db.prepare("UPDATE users SET daily_lead_cap = ? WHERE id = ?").run(Math.round(value), req.session.userId);
  res.json({ dailyLeadCap: Math.round(value) });
});

const ALLOWED_PAGE_SIZES = [50, 100, 150, 200, 250, 300];

// GET /api/settings/page-size -> this user's saved records-per-page preference
router.get("/page-size", (req, res) => {
  const row = db.prepare("SELECT page_size FROM users WHERE id = ?").get(req.session.userId);
  res.json({ pageSize: (row && row.page_size) || 50 });
});

// PUT /api/settings/page-size { pageSize }
router.put("/page-size", (req, res) => {
  const value = Number(req.body.pageSize);
  if (!ALLOWED_PAGE_SIZES.includes(value)) {
    return res.status(400).json({ error: `pageSize must be one of ${ALLOWED_PAGE_SIZES.join(", ")}` });
  }
  db.prepare("UPDATE users SET page_size = ? WHERE id = ?").run(value, req.session.userId);
  res.json({ pageSize: value });
});

// GET /api/settings/content-links -> this user's saved default meeting/website links
router.get("/content-links", (req, res) => {
  const row = db.prepare("SELECT meeting_link, website_link FROM users WHERE id = ?").get(req.session.userId);
  res.json({ meetingLink: row.meeting_link || "", websiteLink: row.website_link || "" });
});

// PUT /api/settings/content-links { meetingLink?, websiteLink? }
router.put("/content-links", (req, res) => {
  const { meetingLink, websiteLink } = req.body || {};
  db.prepare("UPDATE users SET meeting_link = ?, website_link = ? WHERE id = ?").run(meetingLink || null, websiteLink || null, req.session.userId);
  res.json({ meetingLink: meetingLink || "", websiteLink: websiteLink || "" });
});

const { DEFAULT_SIGNATURE } = require("../outreachContent");

// GET /api/settings/site-generator-meta -> design styles and color presets
// available, for populating the "Create Website" picker UI
router.get("/site-generator-meta", (req, res) => {
  const { DESIGN_STYLES, COLOR_PRESETS } = require("../websiteGenerator");
  res.json({
    designStyles: Object.entries(DESIGN_STYLES).map(([value, v]) => ({ value, ...v })),
    colorPresets: Object.entries(COLOR_PRESETS).map(([value, v]) => ({ value, label: v.label, swatch: v.swatch })),
  });
});

// GET /api/settings/signature -> this user's saved outreach signature
router.get("/signature", (req, res) => {
  const row = db.prepare("SELECT signature FROM users WHERE id = ?").get(req.session.userId);
  res.json({ signature: row && row.signature != null ? row.signature : DEFAULT_SIGNATURE });
});

// PUT /api/settings/signature { signature }
router.put("/signature", (req, res) => {
  const value = typeof req.body.signature === "string" ? req.body.signature : "";
  if (value.length > 2000) {
    return res.status(400).json({ error: "Signature is too long (max 2000 characters)." });
  }
  db.prepare("UPDATE users SET signature = ? WHERE id = ?").run(value, req.session.userId);
  res.json({ signature: value });
});

// GET /api/settings/ai-provider-preferences -> the default AI provider to
// pre-select for content generation and inspection separately (empty
// string means "Auto" / fallback chain). Per-generation choices in the UI
// still override this - it's just what gets pre-selected each time.
router.get("/ai-provider-preferences", (req, res) => {
  const row = db.prepare("SELECT preferred_content_provider, preferred_inspection_provider FROM users WHERE id = ?").get(req.session.userId);
  res.json({
    contentProvider: row?.preferred_content_provider || "",
    inspectionProvider: row?.preferred_inspection_provider || "",
  });
});

router.put("/ai-provider-preferences", (req, res) => {
  const VALID = ["", "groq", "gemini", "deepseek"];
  const { contentProvider, inspectionProvider } = req.body || {};
  if (contentProvider !== undefined && !VALID.includes(contentProvider)) return res.status(400).json({ error: "Invalid contentProvider" });
  if (inspectionProvider !== undefined && !VALID.includes(inspectionProvider)) return res.status(400).json({ error: "Invalid inspectionProvider" });

  db.prepare(
    `UPDATE users SET
      preferred_content_provider = COALESCE(?, preferred_content_provider),
      preferred_inspection_provider = COALESCE(?, preferred_inspection_provider)
     WHERE id = ?`
  ).run(contentProvider ?? null, inspectionProvider ?? null, req.session.userId);

  const row = db.prepare("SELECT preferred_content_provider, preferred_inspection_provider FROM users WHERE id = ?").get(req.session.userId);
  res.json({ contentProvider: row.preferred_content_provider || "", inspectionProvider: row.preferred_inspection_provider || "" });
});

function maskKey(key) {
  if (!key) return null;
  if (key.length <= 8) return "•".repeat(key.length);
  return `${key.slice(0, 4)}${"•".repeat(Math.max(key.length - 8, 4))}${key.slice(-4)}`;
}

function toPublicRow(row) {
  return {
    id: row.id,
    label: row.label,
    masked: maskKey(row.key_value),
    active: !!row.is_active,
    requestsMade: row.requests_made || 0,
    leadsCaught: row.leads_caught || 0,
    createdAt: row.created_at,
  };
}

// Shared CRUD logic for a provider's API keys - both Google Places and
// Gemini keys go through the exact same save/test/activate/delete/list
// flow, just scoped to their own provider and their own key-testing
// function. Mounted twice below instead of duplicating this route set.
function createKeyRoutes(provider, testFn, envFallbackVar) {
  const sub = express.Router();

  sub.get("/", (req, res) => {
    const rows = apiKeys.listKeys(req.session.userId, provider).map(toPublicRow);
    const activeRow = rows.find((r) => r.active);
    const isAdmin = req.session.role === "admin";
    res.json({
      keys: rows,
      activeId: activeRow ? activeRow.id : null,
      envFallbackAvailable: envFallbackVar && isAdmin ? !!process.env[envFallbackVar] : false,
    });
  });

  sub.post("/test-value", asyncHandler(async (req, res) => {
    const { apiKey } = req.body || {};
    if (!apiKey || !apiKey.trim()) {
      return res.status(400).json({ ok: false, error: "Enter an API key first." });
    }
    const result = await testFn(apiKey.trim());
    res.json(result);
  }));

  sub.post("/", asyncHandler(async (req, res) => {
    const { label, apiKey } = req.body || {};
    if (!apiKey || !apiKey.trim()) {
      return res.status(400).json({ error: "apiKey is required" });
    }
    const trimmedKey = apiKey.trim();
    const trimmedLabel = (label && label.trim()) || "Untitled key";

    const result = await testFn(trimmedKey);
    if (!result.ok) {
      return res.status(400).json({ error: result.error || "Key test failed", tested: true });
    }

    const row = apiKeys.insertKey(req.session.userId, trimmedLabel, trimmedKey, provider);
    res.json(toPublicRow(row));
  }));

  sub.post("/:id/test", asyncHandler(async (req, res) => {
    const row = apiKeys.getKeyById(req.session.userId, req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: "Key not found" });
    const result = await testFn(row.key_value);
    res.json(result);
  }));

  sub.post("/:id/activate", (req, res) => {
    const row = apiKeys.getKeyById(req.session.userId, req.params.id);
    if (!row) return res.status(404).json({ error: "Key not found" });
    apiKeys.setActive(req.session.userId, row.id, provider);
    res.json({ ok: true, activeId: row.id });
  });

  sub.delete("/:id", (req, res) => {
    const row = apiKeys.getKeyById(req.session.userId, req.params.id);
    if (!row) return res.status(404).json({ error: "Key not found" });
    apiKeys.deleteKey(req.session.userId, row.id);
    res.json({ ok: true });
  });

  return sub;
}

// Google Places keys (existing behavior, paths unchanged: /api/settings/keys/...)
router.use("/keys", createKeyRoutes("google_places", testPlacesKey, "GOOGLE_PLACES_API_KEY"));

// Gemini keys (new: /api/settings/gemini-keys/...) - used for business
// deep-analysis and outreach content generation.
router.use("/gemini-keys", createKeyRoutes("gemini", testGeminiKey, null));

// Groq keys (new: /api/settings/groq-keys/...) and DeepSeek keys (new:
// /api/settings/deepseek-keys/...) - both used as fallback AI providers
// alongside Gemini for business analysis and content generation.
router.use("/groq-keys", createKeyRoutes("groq", groqClient.testApiKey, null));
router.use("/deepseek-keys", createKeyRoutes("deepseek", deepseekClient.testApiKey, null));

// GET /api/settings/usage-summary -> this month's usage totals for both
// providers, for the "Limits Usage" page.
router.get("/usage-summary", (req, res) => {
  const providers = ["google_places", "gemini", "groq", "deepseek"];
  const result = {};
  for (const p of providers) {
    result[p] = apiKeys.currentMonthUsage(req.session.userId, p);
  }
  res.json(result);
});

// GET /api/settings/usage-history?provider=gemini|groq|deepseek|google_places
// -> all-time totals per key + a daily timeseries, same shape the Reports
// page's chart already uses, reused here for the Limits Usage page's
// per-provider charts (and embedded on each provider's own Settings page).
const USAGE_RANGE_DAYS = { "1d": 1, "7d": 7, "30d": 30, "60d": 60, "90d": 90, "1y": 365, all: null };

router.get("/usage-history", (req, res) => {
  const provider = ["google_places", "gemini", "groq", "deepseek"].includes(req.query.provider) ? req.query.provider : "gemini";
  const range = USAGE_RANGE_DAYS.hasOwnProperty(req.query.range) ? req.query.range : "1d";
  const days = USAGE_RANGE_DAYS[range];

  const allTime = apiKeys.allTimeUsage(req.session.userId, provider);
  const daily = apiKeys.dailyUsageHistory(req.session.userId, days, provider);

  const dayLabels = Array.from(new Set(daily.map((d) => d.usage_date))).sort();
  const byKey = {};
  for (const row of allTime) {
    byKey[row.id] = {
      id: row.id,
      label: row.label,
      active: !!row.is_active,
      totalRequests: row.requests_made || 0,
      totalLeads: row.leads_caught || 0,
      requestsSeries: dayLabels.map(() => 0),
    };
  }
  daily.forEach((row) => {
    const entry = byKey[row.api_key_id];
    if (!entry) return;
    const dayIndex = dayLabels.indexOf(row.usage_date);
    if (dayIndex === -1) return;
    entry.requestsSeries[dayIndex] = row.requests_made || 0;
  });

  res.json({ days: dayLabels, keys: Object.values(byKey), range });
});

module.exports = router;
