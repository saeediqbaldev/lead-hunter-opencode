const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");

const router = express.Router();

function toPublicUser(row) {
  return { id: row.id, username: row.username, role: row.role, createdAt: row.created_at };
}

// GET /api/users - admin only, list every account
router.get("/", (req, res) => {
  const rows = db.prepare("SELECT * FROM users ORDER BY created_at ASC").all();
  res.json(rows.map(toPublicUser));
});

// POST /api/users { username, password, role } - admin creates a member (or another admin)
router.post("/", (req, res) => {
  const { username, password, role } = req.body || {};

  if (!username || !username.trim() || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }
  const finalRole = role === "admin" ? "admin" : "member";

  try {
    const hash = bcrypt.hashSync(password, 10);
    const info = db
      .prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)")
      .run(username.trim(), hash, finalRole);
    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
    res.json(toPublicUser(row));
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "That username is already taken" });
    }
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/users/:id - admin removes a member account (and all their data)
router.delete("/:id", (req, res) => {
  const { id } = req.params;
  if (Number(id) === req.session.userId) {
    return res.status(400).json({ error: "You can't delete your own account while logged in as it" });
  }

  const target = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  if (!target) return res.status(404).json({ error: "User not found" });

  const del = db.transaction(() => {
    const nicheIds = db.prepare("SELECT id FROM niches WHERE user_id = ?").all(id).map((r) => r.id);
    for (const nicheId of nicheIds) {
      const logIds = db.prepare("SELECT id FROM catch_logs WHERE niche_id = ?").all(nicheId).map((r) => r.id);
      for (const logId of logIds) {
        db.prepare("DELETE FROM leads WHERE catch_log_id = ?").run(logId);
      }
      db.prepare("DELETE FROM catch_logs WHERE niche_id = ?").run(nicheId);
    }
    db.prepare("DELETE FROM niches WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM api_keys WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM search_log WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM seen_places WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM users WHERE id = ?").run(id);
  });
  del();

  res.json({ deleted: true });
});

module.exports = router;
