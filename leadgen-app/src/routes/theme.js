const express = require("express");
const db = require("../db");

const router = express.Router();

// GET /api/theme -> this user's saved theme, or null if they haven't customized one
router.get("/", (req, res) => {
  const row = db.prepare("SELECT theme FROM users WHERE id = ?").get(req.session.userId);
  const theme = row && row.theme ? JSON.parse(row.theme) : null;
  res.json({ theme });
});

// PUT /api/theme { mode: 'light'|'dark', colors: { ...cssVarName: hex } }
router.put("/", (req, res) => {
  const { mode, colors } = req.body || {};
  if (mode !== "light" && mode !== "dark") {
    return res.status(400).json({ error: "mode must be 'light' or 'dark'" });
  }
  const theme = { mode, colors: colors || {} };
  db.prepare("UPDATE users SET theme = ? WHERE id = ?").run(JSON.stringify(theme), req.session.userId);
  res.json({ theme });
});

// DELETE /api/theme -> reset to the app's default theme for the current mode
router.delete("/", (req, res) => {
  db.prepare("UPDATE users SET theme = NULL WHERE id = ?").run(req.session.userId);
  res.json({ ok: true });
});

module.exports = router;
