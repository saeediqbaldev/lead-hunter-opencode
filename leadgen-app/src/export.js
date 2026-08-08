const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");

const LEAD_COLUMNS = [
  "S/N",
  "Business Name",
  "City",
  "Address",
  "Maps Link",
  "Phone",
  "WhatsApp Link",
  "Website",
  "Social Links",
  "Rating",
  "Reviews",
  "Needs",
  "Status",
  "Notes",
];

function mapsLinkFor(lead) {
  if (lead.place_id) return `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(lead.place_id)}`;
  if (lead.address) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lead.address)}`;
  return "";
}

function whatsappLinkFor(phone) {
  if (!phone) return "";
  const digits = phone.replace(/[^\d]/g, "");
  if (digits.length < 8) return "";
  return `https://wa.me/${digits}`;
}

function needsText(lead) {
  const needs = Array.isArray(lead.needs) ? lead.needs : [];
  return needs.join("; ");
}

function socialLinksText(lead) {
  const socials = lead.socials || {};
  return Object.entries(socials)
    .map(([platform, url]) => `${platform}: ${url}`)
    .join(" | ");
}

function leadToRow(lead, index) {
  return [
    index + 1,
    lead.name,
    lead.city_name || "",
    lead.address || "",
    mapsLinkFor(lead),
    lead.phone || "",
    whatsappLinkFor(lead.phone),
    lead.website || "",
    socialLinksText(lead),
    lead.rating ?? "",
    lead.review_count ?? "",
    needsText(lead),
    lead.status,
    lead.notes || "",
  ];
}

function sanitizeFilename(name) {
  return String(name).replace(/[^a-z0-9\-_ ]/gi, "").trim().replace(/\s+/g, "_").slice(0, 80) || "export";
}

// Keep in sync with public/app.js's APP_VERSION - used in export filenames
// per the requested "Niche-City-Date-AppVersion" naming convention.
const APP_VERSION = "2026.08.08-15.1";

// Builds a filename like "CarWash-Bali-2026-07-31-11.9" (niche and/or city
// are omitted from the name if not applicable, e.g. a "current view" export
// spanning multiple niches/cities).
function buildExportFilename({ niche, city } = {}) {
  const parts = [];
  if (niche) parts.push(sanitizeFilename(niche));
  if (city) parts.push(sanitizeFilename(city));
  parts.push(new Date().toISOString().slice(0, 10));
  parts.push(APP_VERSION);
  return parts.join("-");
}

// ---------- CSV ----------
// Plain http(s) URLs in a CSV cell are auto-recognized as clickable links by
// Excel and Google Sheets when opened - that's the extent "clickable" can
// mean in a real CSV file (no embedded hyperlink objects exist in CSV itself).
function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (/[",\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

function buildCsvSection(title, leads) {
  const lines = [];
  lines.push(csvEscape(title));
  lines.push(LEAD_COLUMNS.map(csvEscape).join(","));
  leads.forEach((lead, i) => lines.push(leadToRow(lead, i).map(csvEscape).join(",")));
  return lines.join("\n");
}

function buildCatchLogCsv(catchLogName, leads) {
  return buildCsvSection(catchLogName, leads) + "\n";
}

function buildNicheCsv(nicheName, catchLogsWithLeads) {
  const sections = catchLogsWithLeads.map((cl) => buildCsvSection(`Catch Log: ${cl.name}`, cl.leads));
  return `Niche: ${nicheName}\n\n` + sections.join("\n\n") + "\n";
}

// ---------- XLSX (true multi-sheet workbook - one real sheet per catch log) ----------
async function buildNicheXlsx(nicheName, catchLogsWithLeads) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Xeven Leads";

  const usedNames = new Set();
  for (const cl of catchLogsWithLeads) {
    let base = cl.name.replace(/[:\\/?*\[\]]/g, "").slice(0, 28) || "Sheet";
    let sheetName = base;
    let n = 2;
    while (usedNames.has(sheetName)) {
      sheetName = `${base.slice(0, 25)} (${n})`;
      n++;
    }
    usedNames.add(sheetName);

    const sheet = workbook.addWorksheet(sheetName);
    sheet.addRow(LEAD_COLUMNS);
    sheet.getRow(1).font = { bold: true };

    cl.leads.forEach((lead, i) => {
      const values = leadToRow(lead, i);
      const row = sheet.addRow(values);
      const mapsUrl = values[4];
      const waUrl = values[6];
      const websiteUrl = values[7];
      if (mapsUrl) row.getCell(5).value = { text: "Open Map", hyperlink: mapsUrl };
      if (waUrl) row.getCell(7).value = { text: "Chat", hyperlink: waUrl };
      if (websiteUrl) row.getCell(8).value = { text: websiteUrl, hyperlink: websiteUrl };
    });

    sheet.columns.forEach((col) => {
      col.width = 22;
    });
  }

  if (workbook.worksheets.length === 0) {
    workbook.addWorksheet("No data").addRow(["This niche has no catch logs yet."]);
  }

  return workbook.xlsx.writeBuffer();
}

// ---------- PDF ----------
// ---------- PDF: real table layout with clickable social icon glyphs ----------
const SOCIAL_ICON_META = {
  email: { letter: "@", color: "#5a5550" },
  facebook: { letter: "f", color: "#3b5998" },
  instagram: { letter: "IG", color: "#c8347a" },
  phone: { letter: "\u260E", color: "#4caf6d" }, // phone glyph
  linkedin: { letter: "in", color: "#0a66c2" },
  tiktok: { letter: "TT", color: "#111111" },
};
const SOCIAL_ORDER = ["email", "facebook", "instagram", "phone", "linkedin", "tiktok"];

const TABLE_COLS = [
  { key: "sn", label: "S/N", width: 26 },
  { key: "business", label: "Business", width: 118 },
  { key: "city", label: "City", width: 62 },
  { key: "phone", label: "Phone", width: 82 },
  { key: "website", label: "Website", width: 100 },
  { key: "social", label: "Social", width: 100 },
  { key: "rating", label: "Rating", width: 48 },
  { key: "status", label: "Status", width: 62 },
];

const ROW_HEIGHT = 30;
const HEADER_HEIGHT = 20;
const TABLE_LEFT = 36;

function drawTableHeader(doc, y) {
  let x = TABLE_LEFT;
  doc.rect(TABLE_LEFT, y, TABLE_COLS.reduce((s, c) => s + c.width, 0), HEADER_HEIGHT).fill("#2b2723");
  doc.fillColor("#fff").fontSize(8).font("Helvetica-Bold");
  for (const col of TABLE_COLS) {
    doc.text(col.label, x + 4, y + 6, { width: col.width - 8, lineBreak: false });
    x += col.width;
  }
  doc.font("Helvetica");
  return y + HEADER_HEIGHT;
}

function drawSocialIcons(doc, lead, x, y) {
  const socials = lead.socials || {};
  let cx = x;
  const size = 14;
  for (const key of SOCIAL_ORDER) {
    let url = null;
    if (key === "phone") {
      if (socials.phone) url = `tel:${String(socials.phone).replace(/\s+/g, "")}`;
    } else if (socials[key]) {
      url = socials[key];
    }
    if (!url) continue;

    const meta = SOCIAL_ICON_META[key];
    doc.roundedRect(cx, y, size, size, 3).fill(meta.color);
    doc
      .fillColor("#fff")
      .fontSize(6)
      .text(meta.letter, cx, y + size / 2 - 3, { width: size, align: "center", lineBreak: false });
    doc.link(cx, y, size, size, url); // clickable region over the icon
    cx += size + 3;
    if (cx > x + 96) break; // stay within the Social column's width
  }
}

function drawTableRow(doc, lead, index, y) {
  const rowColor = index % 2 === 0 ? "#ffffff" : "#f6f4f0";
  const totalWidth = TABLE_COLS.reduce((s, c) => s + c.width, 0);
  doc.rect(TABLE_LEFT, y, totalWidth, ROW_HEIGHT).fill(rowColor);
  doc.strokeColor("#ddd7cc").lineWidth(0.5).rect(TABLE_LEFT, y, totalWidth, ROW_HEIGHT).stroke();

  let x = TABLE_LEFT;
  const textY = y + 8;

  // S/N
  doc.fillColor("#333").fontSize(8).text(String(index + 1), x + 4, textY, { width: TABLE_COLS[0].width - 8 });
  x += TABLE_COLS[0].width;

  // Business (clickable to Maps)
  const maps = mapsLinkFor(lead);
  doc.fillColor(maps ? "#1a4d8f" : "#111").fontSize(8).text(lead.name || "", x + 4, textY, {
    width: TABLE_COLS[1].width - 8,
    height: ROW_HEIGHT - 10,
    ellipsis: true,
  });
  if (maps) doc.link(x, y, TABLE_COLS[1].width, ROW_HEIGHT, maps);
  x += TABLE_COLS[1].width;

  // City
  doc.fillColor("#555").text(lead.city_name || "", x + 4, textY, { width: TABLE_COLS[2].width - 8, ellipsis: true });
  x += TABLE_COLS[2].width;

  // Phone (clickable tel:)
  if (lead.phone) {
    doc.fillColor("#1a4d8f").text(lead.phone, x + 4, textY, { width: TABLE_COLS[3].width - 8, ellipsis: true });
    doc.link(x, y, TABLE_COLS[3].width, ROW_HEIGHT, `tel:${lead.phone.replace(/\s+/g, "")}`);
  } else {
    doc.fillColor("#999").text("-", x + 4, textY, { width: TABLE_COLS[3].width - 8 });
  }
  x += TABLE_COLS[3].width;

  // Website (clickable)
  if (lead.website) {
    let host = lead.website;
    try {
      host = new URL(lead.website).hostname;
    } catch {
      // keep raw string
    }
    doc.fillColor("#1a4d8f").text(host, x + 4, textY, { width: TABLE_COLS[4].width - 8, ellipsis: true });
    doc.link(x, y, TABLE_COLS[4].width, ROW_HEIGHT, lead.website);
  } else {
    doc.fillColor("#999").text("-", x + 4, textY, { width: TABLE_COLS[4].width - 8 });
  }
  x += TABLE_COLS[4].width;

  // Social icons (clickable glyphs, not text)
  drawSocialIcons(doc, lead, x + 4, y + (ROW_HEIGHT - 14) / 2);
  x += TABLE_COLS[5].width;

  // Rating
  const ratingText = lead.rating ? `${lead.rating.toFixed(1)}${lead.review_count ? ` (${lead.review_count})` : ""}` : "n/a";
  doc.fillColor("#333").text(ratingText, x + 4, textY, { width: TABLE_COLS[6].width - 8 });
  x += TABLE_COLS[6].width;

  // Status
  doc.fillColor("#333").text(lead.status || "", x + 4, textY, { width: TABLE_COLS[7].width - 8, ellipsis: true });
}

function drawLeadsTable(doc, title, leads) {
  doc.fontSize(14).fillColor("#111").font("Helvetica-Bold").text(title, TABLE_LEFT, doc.y);
  doc.font("Helvetica");
  doc.moveDown(0.5);

  if (leads.length === 0) {
    doc.fontSize(9).fillColor("#666").text("No records in this catch log.", TABLE_LEFT);
    doc.moveDown();
    return;
  }

  const pageBottom = doc.page.height - doc.page.margins.bottom;
  let y = drawTableHeader(doc, doc.y);

  leads.forEach((lead, i) => {
    if (y + ROW_HEIGHT > pageBottom) {
      doc.addPage();
      y = drawTableHeader(doc, doc.page.margins.top);
    }
    drawTableRow(doc, lead, i, y);
    y += ROW_HEIGHT;
  });

  doc.y = y + 14;
}

function buildCatchLogPdf(catchLogName, leads) {
  const doc = new PDFDocument({ margin: 36, size: "A4", layout: "landscape" });
  drawLeadsTable(doc, catchLogName, leads);
  doc.end();
  return doc;
}

function buildNichePdf(nicheName, catchLogsWithLeads) {
  const doc = new PDFDocument({ margin: 36, size: "A4", layout: "landscape" });
  doc.fontSize(18).fillColor("#111").font("Helvetica-Bold").text(`Niche: ${nicheName}`, TABLE_LEFT, doc.y);
  doc.font("Helvetica");
  doc.moveDown();

  catchLogsWithLeads.forEach((cl, idx) => {
    if (idx > 0) doc.addPage();
    drawLeadsTable(doc, `Catch Log: ${cl.name}`, cl.leads);
  });

  doc.end();
  return doc;
}

// ---------- Reports page export (CSV + PDF, including embedded chart images) ----------
function buildReportsCsv(summary, timeseries, meta = {}) {
  const lines = [];
  lines.push(`Xeven Leads - Reports export`);
  lines.push(`Range,${meta.rangeLabel || summary.range || "all"}`);
  lines.push(`Niche,${meta.nicheLabel || "All niches"}`);
  lines.push(`City,${meta.cityLabel || "All cities"}`);
  lines.push(`Generated,${new Date().toISOString()}`);
  lines.push("");
  lines.push("Status,Count");
  lines.push(`All Hunted,${summary.total}`);
  for (const [status, count] of Object.entries(summary.byStatus || {})) {
    lines.push(`${status},${count}`);
  }

  if (Array.isArray(timeseries) && timeseries.length) {
    lines.push("");
    const statusKeys = Object.keys(timeseries[0]).filter((k) => k !== "date");
    lines.push(`Date,${statusKeys.join(",")}`);
    for (const row of timeseries) {
      lines.push(`${row.date},${statusKeys.map((k) => row[k] ?? 0).join(",")}`);
    }
  }

  return lines.join("\n");
}

// chartImages: [{ title, dataUrl }] - dataUrls are PNG data URLs captured
// client-side from the actual rendered Chart.js canvases (charts only exist
// in the browser; this is the simplest reliable way to get them into a
// server-generated PDF without re-implementing charting server-side).
function buildReportsPdf(summary, timeseries, chartImages = [], meta = {}) {
  const doc = new PDFDocument({ margin: 36, size: "A4" });

  doc.fontSize(20).fillColor("#111").font("Helvetica-Bold").text("Xeven Leads - Reports", { align: "left" });
  doc.fontSize(10).font("Helvetica").fillColor("#555");
  doc.text(`Range: ${meta.rangeLabel || summary.range || "all"}    Niche: ${meta.nicheLabel || "All niches"}    City: ${meta.cityLabel || "All cities"}`);
  doc.text(`Generated: ${new Date().toLocaleString()}`);
  doc.moveDown(1);

  // Stats summary table
  doc.fontSize(13).fillColor("#111").font("Helvetica-Bold").text("Pipeline summary");
  doc.moveDown(0.3);
  const statRows = [["All Hunted", String(summary.total)], ...Object.entries(summary.byStatus || {}).map(([k, v]) => [k, String(v)])];
  const colWidth = 240;
  const rowH = 20;
  let y = doc.y;
  doc.fontSize(9).font("Helvetica");
  statRows.forEach(([label, value], i) => {
    const rowY = y + i * rowH;
    if (rowY > 750) return; // stop if it would run off the first page - full detail is in the CSV export
    doc.rect(36, rowY, colWidth, rowH).strokeColor("#ddd").lineWidth(0.5).stroke();
    doc.fillColor("#333").text(label, 42, rowY + 5, { width: colWidth - 80 });
    doc.fillColor("#111").font("Helvetica-Bold").text(value, 36 + colWidth - 60, rowY + 5, { width: 50, align: "right" });
    doc.font("Helvetica");
  });
  doc.y = y + statRows.length * rowH + 20;

  // Embedded chart images - one per page for clean, readable sizing
  for (const chart of chartImages) {
    if (!chart.dataUrl || !chart.dataUrl.startsWith("data:image/")) continue;
    doc.addPage();
    doc.fontSize(13).fillColor("#111").font("Helvetica-Bold").text(chart.title || "Chart");
    doc.moveDown(0.5);
    try {
      const base64 = chart.dataUrl.split(",")[1];
      const imgBuffer = Buffer.from(base64, "base64");
      doc.image(imgBuffer, 36, doc.y, { fit: [520, 380] });
    } catch {
      doc.fontSize(10).fillColor("#a55").text("(Could not embed this chart image)");
    }
  }

  doc.end();
  return doc;
}

module.exports = {
  buildCatchLogCsv,
  buildNicheCsv,
  buildNicheXlsx,
  buildCatchLogPdf,
  buildNichePdf,
  buildReportsCsv,
  buildReportsPdf,
  sanitizeFilename,
  buildExportFilename,
};
