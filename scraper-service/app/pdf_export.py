"""
Renders a list of business dicts (same shape as businesses/saved_list_items
rows) into a landscape PDF table with clickable links for website, email,
and social profiles.
"""
import io
from urllib.parse import urlparse
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import landscape, letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer

_styles = getSampleStyleSheet()
CELL = ParagraphStyle("cell", parent=_styles["Normal"], fontSize=7.5, leading=9.5)
HEADER = ParagraphStyle("header", parent=_styles["Normal"], fontSize=8.5, leading=10,
                         textColor=colors.white, fontName="Helvetica-Bold")
TITLE = ParagraphStyle("title", parent=_styles["Heading1"], fontSize=17, spaceAfter=2)
SUBTITLE = ParagraphStyle("subtitle", parent=_styles["Normal"], fontSize=10,
                           textColor=colors.grey, spaceAfter=14)

ACCENT = colors.HexColor("#3454D1")
BORDER = colors.HexColor("#E3E6EB")
STRIPE = colors.HexColor("#FAFBFD")


def _domain(url: str) -> str:
    try:
        netloc = urlparse(url).netloc or url
    except Exception:
        netloc = url
    return netloc.replace("www.", "") or url


def _text(value) -> Paragraph:
    return Paragraph(escape(str(value)) if value else "—", CELL)


def _link(url, label=None) -> Paragraph:
    if not url:
        return Paragraph("—", CELL)
    safe_url = escape(url, {'"': "&quot;"})
    safe_label = escape(label or url)
    return Paragraph(f'<link href="{safe_url}"><u><font color="#3454D1">{safe_label}</font></u></link>', CELL)


def build_pdf(rows: list[dict], title: str = "Scraped Contacts", subtitle: str | None = None) -> bytes:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=landscape(letter),
        leftMargin=26, rightMargin=26, topMargin=26, bottomMargin=26,
        title=title,
    )

    story = [Paragraph(escape(title), TITLE)]
    sub_bits = [subtitle] if subtitle else []
    sub_bits.append(f"{len(rows)} business{'es' if len(rows) != 1 else ''}")
    story.append(Paragraph(escape(" · ".join(sub_bits)), SUBTITLE))

    headers = ["Business", "Phone", "Email", "Website", "LinkedIn", "Facebook", "Instagram", "TikTok"]
    data = [[Paragraph(h, HEADER) for h in headers]]

    for r in rows:
        email = r.get("email")
        phone = r.get("phone_scraped") or r.get("phone")
        data.append([
            _text(r.get("business_name")),
            _link(f"tel:{phone}", phone) if phone else _text(None),
            _link(f"mailto:{email}", email) if email else _text(None),
            _link(r.get("website"), _domain(r.get("website"))) if r.get("website") else _text(None),
            _link(r.get("linkedin"), _domain(r.get("linkedin"))) if r.get("linkedin") else _text(None),
            _link(r.get("facebook"), _domain(r.get("facebook"))) if r.get("facebook") else _text(None),
            _link(r.get("instagram"), _domain(r.get("instagram"))) if r.get("instagram") else _text(None),
            _link(r.get("tiktok"), _domain(r.get("tiktok"))) if r.get("tiktok") else _text(None),
        ])

    if len(data) == 1:
        story.append(Spacer(1, 16))
        story.append(Paragraph("No businesses to show yet.", CELL))
    else:
        col_widths = [128, 62, 108, 96, 78, 78, 78, 78]
        table = Table(data, colWidths=col_widths, repeatRows=1)
        table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), ACCENT),
            ("GRID", (0, 0), (-1, -1), 0.5, BORDER),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, STRIPE]),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 5),
            ("RIGHTPADDING", (0, 0), (-1, -1), 5),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ]))
        story.append(table)

    doc.build(story)
    return buf.getvalue()
