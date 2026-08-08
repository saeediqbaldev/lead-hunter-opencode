const express = require("express");
const db = require("../db");
const { buildNicheCsv, buildNichePdf, buildNicheXlsx, buildExportFilename } = require("../export");
const { capitalizeWords } = require("../textUtils");

const router = express.Router();

function parseLeadRow(row) {
  return {
    ...row,
    needs: row.needs ? JSON.parse(row.needs) : [],
    socials: row.socials ? JSON.parse(row.socials) : {},
  };
}

function getCatchLogsWithLeads(nicheId) {
  const logs = db
    .prepare("SELECT * FROM catch_logs WHERE niche_id = ? ORDER BY created_at ASC")
    .all(nicheId);
  return logs.map((log) => ({
    name: log.name,
    leads: db
      .prepare("SELECT * FROM leads WHERE catch_log_id = ? ORDER BY created_at ASC")
      .all(log.id)
      .map(parseLeadRow)
      .map((lead) => ({ ...lead, city_name: log.name })),
  }));
}

function getOwnedNiche(userId, nicheId) {
  return db.prepare("SELECT * FROM niches WHERE id = ? AND user_id = ?").get(nicheId, userId);
}

// GET /api/niches -> this user's niches with catch-log and lead counts
router.get("/", (req, res) => {
  const rows = db
    .prepare(
      `
    SELECT n.id, n.name, n.created_at,
           COUNT(DISTINCT cl.id) AS catch_log_count,
           COUNT(l.id) AS lead_count
    FROM niches n
    LEFT JOIN catch_logs cl ON cl.niche_id = n.id
    LEFT JOIN leads l ON l.catch_log_id = cl.id
    WHERE n.user_id = ?
    GROUP BY n.id
    ORDER BY n.name ASC
  `
    )
    .all(req.session.userId);
  res.json(rows);
});

// POST /api/niches { name }
router.post("/", (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "name is required" });
  const capitalizedName = capitalizeWords(name.trim());

  try {
    const info = db.prepare("INSERT INTO niches (user_id, name) VALUES (?, ?)").run(req.session.userId, capitalizedName);
    res.json({ id: info.lastInsertRowid, name: capitalizedName, catch_log_count: 0, lead_count: 0 });
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "A niche with this name already exists" });
    }
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/niches/:id { name }
router.patch("/:id", (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "name is required" });
  const capitalizedName = capitalizeWords(name.trim());

  const existing = getOwnedNiche(req.session.userId, req.params.id);
  if (!existing) return res.status(404).json({ error: "Niche not found" });

  try {
    db.prepare("UPDATE niches SET name = ? WHERE id = ?").run(capitalizedName, req.params.id);
    res.json({ ...existing, name: capitalizedName });
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "A niche with this name already exists" });
    }
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/niches/:id -> cascades to its catch logs and their leads
router.delete("/:id", (req, res) => {
  const { id } = req.params;
  const existing = getOwnedNiche(req.session.userId, id);
  if (!existing) return res.status(404).json({ error: "Niche not found" });

  const del = db.transaction(() => {
    const logIds = db
      .prepare("SELECT id FROM catch_logs WHERE niche_id = ?")
      .all(id)
      .map((r) => r.id);
    for (const logId of logIds) {
      db.prepare("DELETE FROM leads WHERE catch_log_id = ?").run(logId);
    }
    db.prepare("DELETE FROM catch_logs WHERE niche_id = ?").run(id);
    db.prepare("DELETE FROM seen_places WHERE niche_id = ?").run(id);
    db.prepare("DELETE FROM niches WHERE id = ?").run(id);
  });
  del();

  res.json({ deleted: true });
});

// GET /api/niches/:id/export/csv - flattened single CSV, sectioned by catch log
router.get("/:id/export/csv", (req, res) => {
  const niche = getOwnedNiche(req.session.userId, req.params.id);
  if (!niche) return res.status(404).json({ error: "Niche not found" });

  const catchLogsWithLeads = getCatchLogsWithLeads(req.params.id);
  const csv = buildNicheCsv(niche.name, catchLogsWithLeads);

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${buildExportFilename({ niche: niche.name })}.csv"`);
  res.send(csv);
});

// GET /api/niches/:id/export/xlsx - true multi-sheet workbook, one sheet per catch log
router.get("/:id/export/xlsx", async (req, res) => {
  const niche = getOwnedNiche(req.session.userId, req.params.id);
  if (!niche) return res.status(404).json({ error: "Niche not found" });

  const catchLogsWithLeads = getCatchLogsWithLeads(req.params.id);
  const buffer = await buildNicheXlsx(niche.name, catchLogsWithLeads);

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${buildExportFilename({ niche: niche.name })}.xlsx"`);
  res.send(buffer);
});

// GET /api/niches/:id/export/pdf
router.get("/:id/export/pdf", (req, res) => {
  const niche = getOwnedNiche(req.session.userId, req.params.id);
  if (!niche) return res.status(404).json({ error: "Niche not found" });

  const catchLogsWithLeads = getCatchLogsWithLeads(req.params.id);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${buildExportFilename({ niche: niche.name })}.pdf"`);
  const doc = buildNichePdf(niche.name, catchLogsWithLeads);
  doc.pipe(res);
});

// GET /api/niches/:id/outreach-summary
router.get("/:id/outreach-summary", (req, res) => {
  const niche = getOwnedNiche(req.session.userId, req.params.id);
  if (!niche) return res.status(404).json({ error: "Niche not found" });

  const logs = db
    .prepare("SELECT id, name FROM catch_logs WHERE niche_id = ? ORDER BY created_at ASC")
    .all(req.params.id);

  const countStmt = db.prepare(
    "SELECT COUNT(*) AS c FROM leads WHERE catch_log_id = ? AND status = ?"
  );

  const summary = logs.map((log) => {
    const shortlisted = countStmt.get(log.id, "shortlisted").c;
    const contacted = countStmt.get(log.id, "contacted").c;
    const engaged = countStmt.get(log.id, "engaged").c;
    const converted = countStmt.get(log.id, "converted").c;
    const won = countStmt.get(log.id, "won").c;
    const rejected = countStmt.get(log.id, "rejected").c;
    return {
      catchLogId: log.id,
      catchLogName: log.name,
      shortlisted,
      contacted,
      engaged,
      converted,
      won,
      rejected,
      total: shortlisted + contacted + engaged + converted + won + rejected,
    };
  });

  res.json(summary);
});

module.exports = router;
