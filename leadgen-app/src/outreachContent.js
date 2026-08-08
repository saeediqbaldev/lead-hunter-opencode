// Generates outreach content (cold email, social DMs) for a lead, using
// whatever business-analysis data is available as grounding context so the
// message references real, specific findings rather than generic filler.
// Uses the AI provider fallback chain (Groq -> Gemini -> DeepSeek) instead
// of calling one provider directly, so a single provider being rate-limited
// or briefly down doesn't fail the whole request.
const { generateWithFallback } = require("./aiProviders");

// Signature is now a per-user setting (Account Settings -> Signature),
// not hardcoded - this default only applies if a user somehow has no
// signature saved at all (shouldn't normally happen, since the DB column
// has a default value applied via migration).
const DEFAULT_SIGNATURE = `Kind Regards,<br>&nbsp;&nbsp;&nbsp;<b>Saeed Iqbal</b><br>&nbsp;&nbsp;&nbsp;Ceo | Xeven Pixels<br>&nbsp;&nbsp;&nbsp;<a href="https://xevenpixels.com">https://xevenpixels.com</a><br>&nbsp;&nbsp;&nbsp;contact@xevenpixels.com`;

const TONES = [
  "Personalized Observation",
  "Problem → Solution",
  "Compliment + Opportunity",
  "Curiosity / Pattern Interrupt",
  "Case Study / Social Proof",
  "Value-First / Free Audit",
  "Question-Based Conversation",
];

const PLATFORM_GUIDANCE = {
  email: "Format as a cold email body only (no subject line here - that's generated separately). Can be a few short paragraphs.",
  facebook: "Format as a Facebook Page message - conversational, 3-5 sentences, no subject line.",
  instagram: "Format as an Instagram DM - short, casual, friendly, 2-4 sentences, no subject line.",
  linkedin: "Format as a LinkedIn connection/message - professional but warm, 3-5 sentences, no subject line.",
  tiktok: "Format as a TikTok DM - very short, casual, energetic, 2-3 sentences, no subject line.",
  whatsapp: "Format as a WhatsApp message - short, friendly, conversational, 2-4 sentences, no subject line.",
};

const LENGTH_GUIDANCE = {
  Detailed: "Write a detailed, thorough message - several sentences or short paragraphs, covering the context fully.",
  Medium: "Write a medium-length message - a few sentences, balanced between brief and thorough.",
  Short: "Write a short message - 2-3 sentences at most, get to the point quickly.",
  Concise: "Write an extremely concise message - 1-2 sentences total, as brief as possible while still being complete and natural.",
};

const LANGUAGES = ["English", "French", "Spanish", "German", "Portuguese", "Arabic", "Chinese", "Hebrew", "Hungarian", "Russian", "Italian", "Bengali", "Urdu", "Pashto"];

// Strips common legal/corporate suffixes (LLC, Inc, GmbH, Ltd, Co, Corp,
// etc. across a few languages) and trims an overly long name down to a
// reasonable few words, so "Hartmann Dachdeckerbetrieb GmbH & Co. KG"
// becomes "Hartmann Dachdeckerbetrieb" - a name a salutation can actually
// use, rather than either the full legal mouthful or an impersonal "Hi
// there". This is only the fallback for when no owner name is on file.
function computeBusinessShortName(fullName) {
  if (!fullName) return "there";
  let name = fullName;
  // Run twice - "GmbH & Co. KG" needs both GmbH and KG stripped, and a
  // single pass can leave the second suffix behind if they're adjacent.
  for (let i = 0; i < 2; i++) {
    name = name.replace(
      /\b(LLC|L\.L\.C\.|Inc\.?|Incorporated|Ltd\.?|Limited|Corp\.?|Corporation|Co\.?|Company|GmbH|KG|OHG|e\.?K\.?|PartG|AG|SARL|SRL|BV|Pty\.?\s*Ltd\.?)\b\.?/gi,
      ""
    );
  }
  // Removing suffixes can leave orphaned connector punctuation behind
  // (e.g. "Smith & Co. KG" -> "Smith &  " once the suffixes are gone) -
  // rather than trying to regex-clean just the trailing end (which misses
  // orphans left in the middle, and can't account for truncation below
  // creating a NEW trailing artifact), filter to words that contain at
  // least one letter/number, dropping pure-punctuation leftovers entirely.
  const words = name
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
  const shortWords = words.length > 4 ? words.slice(0, 4) : words;
  const result = shortWords.join(" ").trim();
  return result || fullName;
}

function buildContentPrompt({ lead, platform, tone, length, analysis, language, cta, meeting, meetingLink, website, websiteLink }) {
  const platformGuidance = PLATFORM_GUIDANCE[platform] || PLATFORM_GUIDANCE.email;
  const lengthGuidance = LENGTH_GUIDANCE[length] || "";
  const languageInstruction =
    language && language !== "English" ? `\nWrite the ENTIRE message in ${language} - not English, ${language}. The signature will be added separately in its original form, so don't worry about that part.` : "";

  const salutationName = lead.owner_name?.trim() || computeBusinessShortName(lead.name);

  let context = `Business: ${lead.name}\nAddress them as: ${salutationName}${lead.owner_name?.trim() ? " (the owner's actual name - use it directly, e.g. \"Hi Sarah\")" : " (no owner name on file, so this is a shortened version of the business name, not a person - phrase the opening accordingly, e.g. \"Hi there\" or naturally naming the business rather than a fake personal greeting)"}\nCategory: ${lead.niche_name || "local business"}\nLocation: ${lead.city_name || lead.address || "unknown"}`;

  if (analysis && analysis.status === "done") {
    if (analysis.strengths?.length) context += `\n\nKnown strengths: ${analysis.strengths.join("; ")}`;
    if (analysis.weaknesses?.length) {
      // SSL/HTTPS issues are common, low-stakes, and easy to over-index on
      // since they're simple for the analysis pipeline to detect - but
      // they rarely move a business owner emotionally the way a real
      // growth/revenue problem does. De-prioritized here rather than
      // dropped entirely, since it's still valid supporting context.
      const nonSslWeaknesses = analysis.weaknesses.filter((w) => !/\bssl\b|\bhttps?\b/i.test(w));
      const sslWeaknesses = analysis.weaknesses.filter((w) => /\bssl\b|\bhttps?\b/i.test(w));
      if (nonSslWeaknesses.length) context += `\nKnown weaknesses/opportunities (lead with these): ${nonSslWeaknesses.join("; ")}`;
      if (sslWeaknesses.length) context += `\nMinor technical findings (mention only in passing if at all, never as the main hook - these rarely matter to a business owner the way a real growth problem does): ${sslWeaknesses.join("; ")}`;
    }
    if (analysis.suggestedServices?.length) context += `\nRelevant services to mention: ${analysis.suggestedServices.join("; ")}`;
  } else {
    context += `\n\n(No deep analysis has been run yet for this business - keep the message general but still personalized to their industry and location.)`;
  }

  // Each of these is an opt-in toggle the user picks per generation - only
  // included in the prompt when actually enabled, so the AI isn't told to
  // juggle three extra asks it wasn't asked to include.
  const extraInstructions = [];
  if (cta) {
    extraInstructions.push(
      "Include a clear, specific call-to-action woven naturally into the message (not a generic \"let's connect\") - give the reader one obvious, low-friction next step."
    );
  }
  if (meeting) {
    extraInstructions.push(
      meetingLink
        ? `Naturally invite them to a short meeting/call, and organically include this link for booking one: ${meetingLink} - don't just paste it in isolation, weave it into a sentence.`
        : "Naturally invite them to a short meeting or call as part of the message - phrase it as a low-pressure invitation, not a demand."
    );
  }
  if (website) {
    extraInstructions.push(
      websiteLink
        ? `Organically mention that a demo/reference website has been put together for them to see the kind of quality to expect, and include this link naturally in a sentence: ${websiteLink}`
        : "Organically mention that a demo or reference website example is available to show the kind of quality/style to expect, without inventing a specific URL since none was given."
    );
  }
  const extraSection = extraInstructions.length ? `\n\nAlso work these in naturally, without making the message feel like a checklist:\n${extraInstructions.map((s) => `- ${s}`).join("\n")}` : "";

  return `You are writing outreach copy on behalf of a marketing agency (Xeven Pixels), reaching out to a local business to offer to help them grow.

${context}

Tone/approach to use: "${tone}"
${platformGuidance}
${lengthGuidance ? `Length: ${lengthGuidance}` : ""}${languageInstruction}${extraSection}

Write the message now. Requirements:
- Open by addressing them as instructed above - warm and human, not a form-letter salutation
- Sound like a real person who looked at their specific business, not a template - write the way you'd actually talk to someone, with genuine warmth and a bit of personality, not stiff "corporate outreach" phrasing
- Lead with THEIR problem or opportunity, not your pitch - frame it around what it costs them to leave it as-is or what they stand to gain, before mentioning what you'd do about it
- Where it fits naturally, ground the pitch in a concrete number or figure (a realistic industry benchmark, a plausible percentage, a rough time/cost estimate) rather than vague claims like "more customers" or "better results" - specific numbers read as credible and human, not like padding
- Reference the specific context above where relevant (don't invent facts not given, and don't fabricate statistics about THIS business specifically - general industry figures are fine, made-up specifics about them are not)
- End with a natural closing line appropriate to the message${extraInstructions.length ? " (working in the items listed above)" : " (a soft, low-pressure call-to-action)"}
- Do NOT include a signature or sign-off - that will be added separately
- Plain text only - no markdown formatting of any kind (no **asterisks** for bold, no _underscores_ for italics, no # headers, no markdown links). Write it exactly as it should be read, since this goes straight into an email/DM with no markdown rendering.
- Output ONLY the message content itself, nothing else (no preamble, no explanation)`;
}

function buildSubjectPrompt({ lead, tone, language, body }) {
  const languageInstruction = language && language !== "English" ? ` Write it in ${language}.` : "";
  return `Write ONE short cold-email subject line for this outreach email, in the same "${tone}" tone/approach.${languageInstruction}

Business being contacted: ${lead.name} (${lead.niche_name || "local business"})
Email body it's paired with:
${body}

Requirements:
- Under 8 words, no clickbait, no spam-trigger phrases ("Free!!!", ALL CAPS, excessive punctuation)
- Specific to this business, not generic ("Quick question", "Following up")
- Plain text only, no markdown, no quotation marks around it
- Output ONLY the subject line itself, nothing else`;
}

async function generateOutreachContent(userId, { lead, platform, tone, length, analysis, signature, language, aiProvider, cta, meeting, meetingLink, website, websiteLink }) {
  const prompt = buildContentPrompt({ lead, platform, tone, length, analysis, language, cta, meeting, meetingLink, website, websiteLink });
  const result = await generateWithFallback(userId, prompt, { onlyProvider: aiProvider || undefined });
  if (!result.ok) return result;

  const signatureHtml = signature != null && signature !== "" ? signature : DEFAULT_SIGNATURE;
  const bodyText = result.text.trim();

  if (platform === "email") {
    const subjectResult = await generateWithFallback(userId, buildSubjectPrompt({ lead, tone, language, body: bodyText }), {
      onlyProvider: aiProvider || undefined,
    });
    const subject = subjectResult.ok ? subjectResult.text.trim().replace(/^["']|["']$/g, "") : `A quick idea for ${lead.name}`;
    return { ok: true, content: bodyText, signatureHtml, subject, provider: result.provider };
  }

  return { ok: true, content: bodyText, signatureHtml, provider: result.provider };
}

async function generateSubjectOnly(userId, { lead, tone, language, body, aiProvider }) {
  const result = await generateWithFallback(userId, buildSubjectPrompt({ lead, tone, language, body }), { onlyProvider: aiProvider || undefined });
  if (!result.ok) return result;
  return { ok: true, subject: result.text.trim().replace(/^["']|["']$/g, ""), provider: result.provider };
}

const LENGTHS = ["Detailed", "Medium", "Short", "Concise"];

const PLATFORM_LIST = ["email", "facebook", "instagram", "linkedin", "tiktok", "whatsapp"];

module.exports = { TONES, LENGTHS, LANGUAGES, PLATFORM_LIST, PLATFORM_GUIDANCE, DEFAULT_SIGNATURE, buildContentPrompt, generateOutreachContent, generateSubjectOnly };
