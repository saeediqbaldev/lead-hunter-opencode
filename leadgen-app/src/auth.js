const bcrypt = require("bcryptjs");
const db = require("./db");

function login(req, res) {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }

  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid username or password" });
  }

  req.session.userId = user.id;
  req.session.role = user.role;
  req.session.username = user.username;
  return res.json({ ok: true, username: user.username, role: user.role });
}

function logout(req, res) {
  req.session.destroy(() => res.json({ ok: true }));
}

function whoami(req, res) {
  res.json({ userId: req.session.userId, username: req.session.username, role: req.session.role });
}

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    const stillExists = db.prepare("SELECT 1 FROM users WHERE id = ?").get(req.session.userId);
    if (stillExists) return next();
    return req.session.destroy(() => res.status(401).json({ error: "Your account no longer exists" }));
  }
  return res.status(401).json({ error: "Not authenticated" });
}

function requirePageAuth(req, res, next) {
  if (req.session && req.session.userId) {
    const stillExists = db.prepare("SELECT 1 FROM users WHERE id = ?").get(req.session.userId);
    if (stillExists) return next();
    return req.session.destroy(() => res.redirect("/login"));
  }
  return res.redirect("/login");
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.role === "admin") return next();
  return res.status(403).json({ error: "Admin access required" });
}

module.exports = { login, logout, whoami, requireAuth, requirePageAuth, requireAdmin };
