const { generateWithFallback } = require("./aiProviders");
const db = require("./db");

// Ten palettes, each with clearly-labeled roles (background / primary /
// accent / dark) so they can be handed to the AI as "brand-authoritative"
// hex codes, exactly as the tested prompt expects when color_palette is
// provided. "surprise" is a special value meaning: don't pass a palette
// at all, let the AI pick one that fits the chosen style + industry.
const COLOR_PRESETS = {
  emerald: { label: "Emerald & Amber", swatch: ["#1B6B4F", "#E8A23D", "#FAFAF8"], roles: { background: "#FAFAF8", primary: "#1B6B4F", accent: "#E8A23D", dark: "#0F4A35" } },
  midnight: { label: "Midnight & Coral", swatch: ["#161A2B", "#FF6A57", "#F4F2ED"], roles: { background: "#F4F2ED", primary: "#161A2B", accent: "#FF6A57", dark: "#0A0C16" } },
  terracotta: { label: "Terracotta & Sand", swatch: ["#B5502F", "#D9B26A", "#FBF6EE"], roles: { background: "#FBF6EE", primary: "#B5502F", accent: "#D9B26A", dark: "#5C2E1A" } },
  ocean: { label: "Ocean & Citrus", swatch: ["#0E5C73", "#F2B441", "#F3FAFB"], roles: { background: "#F3FAFB", primary: "#0E5C73", accent: "#F2B441", dark: "#08404F" } },
  plum: { label: "Plum & Gold", swatch: ["#5B2A5E", "#D4A24E", "#F8F4F5"], roles: { background: "#F8F4F5", primary: "#5B2A5E", accent: "#D4A24E", dark: "#401C42" } },
  slate: { label: "Slate & Lime", swatch: ["#38424A", "#9BC53D", "#F5F6F5"], roles: { background: "#F5F6F5", primary: "#38424A", accent: "#9BC53D", dark: "#232A2F" } },
  rose: { label: "Rose & Charcoal", swatch: ["#2B2724", "#E8879B", "#FAF6F4"], roles: { background: "#FAF6F4", primary: "#2B2724", accent: "#E8879B", dark: "#1A1715" } },
  forest: { label: "Forest & Copper", swatch: ["#1E3B2C", "#C1703F", "#F5F3EC"], roles: { background: "#F5F3EC", primary: "#1E3B2C", accent: "#C1703F", dark: "#122419" } },
  electric: { label: "Electric & Ink", swatch: ["#0A0A0F", "#3ED0F0", "#161620"], roles: { background: "#0A0A0F", primary: "#F2F2F5", accent: "#3ED0F0", dark: "#000000" } },
  blush: { label: "Blush & Sage", swatch: ["#8CA187", "#F0C9C9", "#FBF8F5"], roles: { background: "#FBF8F5", primary: "#8CA187", accent: "#F0C9C9", dark: "#4A5A47" } },
  surprise: { label: "Surprise me (AI picks)", swatch: ["#CFCFCF", "#9C9C9C", "#6A6A6A"], roles: null },
};

// The 8 named design languages from the tested prompt - each a design
// language, not a niche; the business-specific flavor comes from the AI's
// choice of imagery/icons/signature element, not from picking a different
// style per industry.
const DESIGN_STYLES = {
  minimal: { label: "Minimal", description: "Generous whitespace, one accent color, oversized stat as hero anchor" },
  modern: { label: "Modern", description: "Glassmorphism cards, gradient-mesh backgrounds, a floating live-data card" },
  creative: { label: "Creative / Bold", description: "Asymmetric grids, oversized type, hover-reveal gallery" },
  elegant: { label: "Elegant / Luxe", description: "Serif display type, editorial photography, understated reveal" },
  organic: { label: "Organic / Warm", description: "Earthy palette, hand-drawn dividers, a curved flow graphic" },
  corporate: { label: "Corporate / Professional", description: "Structured grid, trust badges, a dispatch-ticket style hero card" },
  playful: { label: "Playful", description: "Bright accents, rounded blobs, sticker-style callouts" },
  dark: { label: "Dark / Gallery", description: "Near-black canvas, vivid accent, poster-style type, portfolio grid" },
};

function slugifyPart(text) {
  return (
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 40) || "site"
  );
}

// Base slug has no random suffix, per spec - readable, predictable URLs.
// Collision handling (appending -2, -3, ...) happens separately in
// resolveUniqueSlug, once the caller knows this exact base is taken.
function buildBaseSlug(niche, city, businessName) {
  return [slugifyPart(niche), slugifyPart(city), slugifyPart(businessName)].filter(Boolean).join("/");
}

function resolveUniqueSlug(baseSlug) {
  const existing = db.prepare("SELECT slug FROM generated_sites WHERE slug = ? OR slug LIKE ?").all(baseSlug, `${baseSlug}-%`);
  if (existing.length === 0) return baseSlug;
  const taken = new Set(existing.map((r) => r.slug));
  if (!taken.has(baseSlug)) return baseSlug; // the exact base is free, only numbered variants exist
  let n = 2;
  while (taken.has(`${baseSlug}-${n}`)) n++;
  return `${baseSlug}-${n}`;
}

// The stable "role" half of the prompt - the full system prompt supplied
// and already tested by the user, kept verbatim so the validated behavior
// carries over exactly. Only the business-specific context block (below)
// changes per generation.
const SYSTEM_PROMPT = `## ROLE
Senior conversion-focused web designer at Xeven Pixels. Given structured business info, output ONE complete, self-contained, production-ready HTML file - fully responsive, visually distinctive, built to convert. Never generic - every page must feel custom-designed for that specific business.

## NAMED STYLES (use the one given in business info below)
Each is a design language, not a niche - business-specific flavor comes from imagery/icons/one signature element you design fresh for that business.
- Minimal: whitespace, monochrome + one accent, light sans display type, no heavy shadows. Signature: one oversized stat/line as hero anchor instead of a graphic.
- Modern: geometric sans, gradient-mesh/blurred-blob accents, glassmorphism cards, rounded UI. Signature: a floating "live" UI card in the hero (a real data point for this business).
- Creative / Bold: asymmetric grids, oversized often-uppercase type, high-contrast duotone, masonry/broken-grid images. Signature: interactive hover-reveal gallery of the business's actual work.
- Elegant / Luxe: serif display + refined sans body, muted jewel-tone/metallic accents, large editorial photography, breathing room. Signature: one slow, understated reveal (thin gold divider, subtle badge) - never loud.
- Organic / Warm: earthy palette (clay/sand/sage/olive/terracotta), rounded soft shapes, hand-drawn wave/arc dividers. Signature: a curved SVG divider or radial "flow" graphic echoing the business's rhythm.
- Corporate / Professional: structured grid, navy/charcoal + one accent, spec-sheet comparison blocks, trust badges. Signature: a "live ticket/dispatch" card in the hero mimicking a real document from that trade.
- Playful: bright multi-color accents, rounded blobs, sticker/badge callouts, friendly rounded sans. Signature: small illustrated mascot-style icons (abstract objects, never cartoon people).
- Dark / Gallery: near-black canvas, one or two vivid accents, poster-style uppercase type, high contrast. Signature: interactive portfolio masonry grid with hover captions.
If told to pick freely, choose the style whose signature move most naturally fits a real object/ritual/document from that industry.

## FIXED PAGE STRUCTURE (this order, always)
1. Sticky header: logo/name, nav links, phone chip (desktop), primary CTA, working mobile hamburger menu.
2. Hero: headline + subhead, primary + secondary CTA, trust row (avatars + a number), one real image + one signature graphic.
3. About: who they are, story/credibility, 3 trust bullets, one supporting image.
4. Services: grid of actual services, each with icon + benefit-driven description + micro-CTA link.
5. Why Choose Us: 4-card benefit grid answering a real pre-purchase objection.
6. Social Proof strip: 4-5 hard numbers (years in business, clients served, rating, response time, etc).
7. Reviews: 3 testimonials (star rating, quote, name+context) - realistic placeholders clearly marked as such if none given.
8. Case Studies: 3 cards, tag + short result-driven story + 2 hard numbers each.
9. Lead Form: split layout - reassurance copy + 3 bullets left, form (name/phone-email/service dropdown/message) + CTA button right.
10. Footer: brand blurb + socials, nav column, services column, legal column (Privacy/Terms + 1-2 industry policies), bottom bar with copyright and "Crafted by Xeven Pixels".
Sections 2-9 together must answer the 5 Ws: Who (About), What (Services), Why (Why Choose Us + Reviews), Where/When (contact/hours/footer), How to act now (CTA + Lead Form).

## HARD TECHNICAL RULES - learned from real bugs, never skip
1. No class-name collisions: never reuse a generic class (.lead, .info, .card) for both a section wrapper and an inner element - namespace section-specific classes (.hero-copy, .about-copy).
2. No overlapping elements at any breakpoint: any floating/absolute card must have positive insets clamped inside its parent, never negative offsets hanging outside it. Check mentally at 1440/980/375px.
3. No horizontal overflow: overflow-x:hidden is a safety net, not the fix - the real fix is rule 2. Grids must collapse to fewer columns at 980px and 600px.
4. Fully working mobile nav: links hide below ~980px, a hamburger toggles a slide-down panel (all nav links + contact + primary CTA) via real JS classList.toggle, not CSS :hover. Auto-close on link tap.
5. Real, reliably-loading images: use https://loremflickr.com/{width}/{height}/{comma-keywords}?lock={unique-number}, keywords from the business's actual industry/services. Descriptive alt text on every image. Never source.unsplash.com or guessed Unsplash CDN IDs.
6. All icons as inline SVG, no icon-font dependency, must visually match what they represent.
7. Distinct Google Font display/body pairing per project, fitting the chosen style.
8. Accessible basics: sufficient contrast, one h1 in hero, h2 per section, focusable interactive elements, alt text, aria-label on icon-only buttons.
9. Sensitive industries (healthcare/mental health/fitness/finance): keep testimonials/case studies general (process/consistency/outcomes) - no clinical claims, diagnosis language, before/after body-image framing, or guaranteed-results language.
10. One self-contained file: all CSS/JS inline, no build step, no framework dependency beyond Google Fonts.

## OUTPUT
Respond with ONLY the complete HTML file, starting <!DOCTYPE html> and ending </html>. No code fences, no commentary - just the raw file.`;

function buildBusinessContextBlock(ctx) {
  const lines = [
    `business_name: ${ctx.businessName}`,
    `industry: ${ctx.niche}`,
    `location: ${ctx.city}`,
    `style_preference: ${DESIGN_STYLES[ctx.designStyle]?.label || "surprise me"}`,
  ];
  if (ctx.services) lines.push(`services: ${ctx.services}`);
  if (ctx.ctaGoal) lines.push(`cta_goal: ${ctx.ctaGoal}`);
  if (ctx.phone) lines.push(`contact_phone: ${ctx.phone}`);
  if (ctx.address) lines.push(`contact_address: ${ctx.address}`);
  if (ctx.socials && Object.keys(ctx.socials).length) {
    lines.push(`social_handles: ${Object.entries(ctx.socials).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
  }
  if (ctx.strengths) lines.push(`known_strengths (use these for About/Why Choose Us, don't invent contradicting facts): ${ctx.strengths}`);

  const preset = ctx.colorPreset && ctx.colorPreset !== "surprise" ? COLOR_PRESETS[ctx.colorPreset] : null;
  if (preset) {
    lines.push(
      `color_palette (brand-authoritative - derive the style's tokens from these, do not substitute your own): background ${preset.roles.background}, primary ${preset.roles.primary}, accent ${preset.roles.accent}, dark ${preset.roles.dark}`
    );
  } else {
    lines.push(`color_palette: not provided - choose one that fits the style and industry`);
  }

  lines.push(`\nFooter must read "Crafted by Xeven Pixels" and link to https://xevenpixels.com`);

  return lines.join("\n");
}

async function generateFullPage(userId, ctx) {
  const prompt = `${SYSTEM_PROMPT}\n\n## BUSINESS INFO FOR THIS REQUEST\n\n${buildBusinessContextBlock(ctx)}`;
  // A full 10-section page with inline SVGs/CSS/JS is a much bigger,
  // slower generation than a short copy snippet - both the timeout and
  // the token budget need real headroom. Safe to go long here since this
  // always runs inside the async job runner, never blocking the
  // browser-facing request.
  //
  // maxTokens is provider-specific: Groq's free tier for openai/gpt-oss-120b
  // caps at 8,000 tokens-per-minute for the WHOLE request (prompt + output
  // combined) - this prompt alone runs close to 2,000-2,500 tokens, so
  // Groq's reserved output budget has to stay well under the remainder or
  // every request fails outright with a 413-style "request too large"
  // error before generation even starts. Gemini and DeepSeek don't share
  // that specific ceiling, so they get a much larger budget for a more
  // complete page when either of them ends up being the one used.
  const result = await generateWithFallback(userId, prompt, {
    timeoutMs: 90000,
    maxTokens: { groq: 5200, gemini: 12000, deepseek: 12000 },
  });
  if (!result.ok) return result;

  let html = result.text.trim();
  // Strip markdown code fences if the model wrapped its output despite
  // being told not to - a cheap, harmless safety net.
  html = html.replace(/^```html\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");

  if (!/<!DOCTYPE html>/i.test(html)) {
    return { ok: false, error: "AI response didn't look like a complete HTML page - try again." };
  }

  return { ok: true, html, provider: result.provider };
}

module.exports = {
  COLOR_PRESETS,
  DESIGN_STYLES,
  buildBaseSlug,
  resolveUniqueSlug,
  buildBusinessContextBlock,
  generateFullPage,
};
