import express from "express";
import {
  addClassificationFeedback,
  clearEmailManualOverride,
  getAllEmails,
  getEmailById,
  getNeedsReplyEmails,
  getRecentFeedback,
  getWatchState,
  markDraftStatus,
  markThreadDraftStatus,
  setEmailManualOverride,
  updateEmailRaw,
  updateDraft,
  updateEmailAnalysis,
  upsertEmail,
  upsertWatchState
} from "../db.js";
import {
  fetchEmailById,
  fetchThreadDetail,
  fetchUnreadEmails,
  getAttachmentBuffer,
  getMessageLabelIds,
  getNewInboxMessageIdsSince,
  getThreadLatestState,
  isMessageEligibleForInboxTriage,
  sendReplyDraft,
  startInboxWatch,
  stripEmailBoilerplateForLLM
} from "../services/gmail.js";
import { callLLM } from "../services/llm.js";
import { notifySlackForNewlyTriagedEmail } from "../services/slack.js";

const router = express.Router();
const FETCH_LIMIT = Number(process.env.FETCH_LIMIT || 50);

/** Tracks manual GET /fetch and Pub/Sub push triage for UI status polling */
let fetchPipelineDepth = 0;
let fetchProgressPct = 0;
let fetchPhaseLabel = "";

function beginFetchPipeline() {
  fetchPipelineDepth += 1;
  if (fetchPipelineDepth === 1) {
    fetchProgressPct = 0;
    fetchPhaseLabel = "starting";
  }
}

function endFetchPipeline() {
  fetchPipelineDepth = Math.max(0, fetchPipelineDepth - 1);
  if (fetchPipelineDepth === 0) {
    fetchProgressPct = 0;
    fetchPhaseLabel = "";
  }
}

function setFetchProgress(pct, phase) {
  fetchProgressPct = Math.min(100, Math.max(0, Math.round(pct)));
  if (phase) fetchPhaseLabel = phase;
}

const NOISE_DOMAIN_HINTS = [
  "ebay.",
  "humblebundle.",
  "poshmark.",
  "mailer.",
  "newsletter.",
  "news.",
  "updates.",
  "notifications.",
  "mobbin.",
  "dropout.tv"
];

const NOISE_KEYWORDS = [
  "newsletter",
  "unsubscribe",
  "receipt",
  "promotion",
  "sale",
  "discount",
  "deal",
  "notification",
  "security alert",
  "do not reply",
  "noreply",
  "no-reply",
  "marketing",
  "advertising",
  "promo",
  "weekly update",
  "product roundup"
];
const VALID_CATEGORIES = ["NEEDS_REPLY", "NOISE"];
const THREAD_SYNC_TIMEOUT_MS = Number(process.env.THREAD_SYNC_TIMEOUT_MS || 8000);
const GMAIL_PUSH_WEBHOOK_SECRET = process.env.GMAIL_PUSH_WEBHOOK_SECRET || "";

async function processNewEmails(incoming, log = () => {}, classifyProgress = null) {
  let inserted = 0;
  const warnings = [];
  const n = incoming.length;
  const pMin = classifyProgress?.min ?? 28;
  const pMax = classifyProgress?.max ?? 52;

  function bumpClassifyProgress(i) {
    if (n <= 0) return;
    setFetchProgress(pMin + Math.floor(((pMax - pMin) * (i + 1)) / n), "classify");
  }

  for (let i = 0; i < n; i++) {
    const email = incoming[i];
    log(`Processing email id=${email.id} subject="${(email.subject || "").slice(0, 80)}"`);
    const existing = await getEmailById(email.id);
    if (existing) {
      log("  existing email id detected -> skipping re-triage/re-summary");
      bumpClassifyProgress(i);
      continue;
    }

    const isNew = await upsertEmail(email);
    if (!isNew) {
      log("  upsert returned false -> likely duplicate race; skipping");
      bumpClassifyProgress(i);
      continue;
    }
    inserted += 1;
    log("  upsert=inserted");

    let analysis;
    try {
      analysis = await classifyAndDraft(email);
      log(`  classified => ${analysis.category}`);
    } catch (error) {
      const recentFeedback = await getRecentFeedback(30);
      analysis = applyFeedbackOverrides(email, fallbackClassification(email), recentFeedback);
      log(`  classification fallback used (${error.message}) => ${analysis.category}`);
      warnings.push({
        id: email.id,
        reason: `LLM classification fallback used: ${error.message}`
      });
    }
    analysis = enforceCategoryRules(email, analysis);
    if (analysis.category === "NOISE") analysis.summary = null;
    await updateEmailAnalysis(email.id, analysis);
    log(`  stored analysis summary="${(analysis.summary || "").slice(0, 120)}"`);
    const stored = await getEmailById(email.id);
    if (stored) await notifySlackForNewlyTriagedEmail(stored);
    bumpClassifyProgress(i);
  }

  return { inserted, warnings };
}

function clampClassificationReason(s, max = 320) {
  const t = String(s || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function parseClassification(raw) {
  const tryParse = (text) => {
    const parsed = JSON.parse(text);
    const valid = ["NEEDS_REPLY", "NOISE"];
    const reasoning = parsed.reasoning ?? parsed.classification_reason;
    return {
      category: valid.includes(parsed.category) ? parsed.category : "NOISE",
      summary: parsed.summary || "No summary available.",
      draft: parsed.draft || null,
      classification_reason: clampClassificationReason(reasoning)
    };
  };

  try {
    return tryParse(raw);
  } catch {
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) return tryParse(match[0]);
    } catch {
      // no-op
    }
    return {
      category: "NOISE",
      summary: "Unable to classify.",
      draft: null,
      classification_reason: null
    };
  }
}

function extractEmailAddress(sender = "") {
  const match = sender.match(/<([^>]+)>/);
  if (match?.[1]) return match[1].toLowerCase();
  return sender.toLowerCase();
}

function extractDomain(sender = "") {
  const email = extractEmailAddress(sender);
  const at = email.indexOf("@");
  return at >= 0 ? email.slice(at + 1) : "";
}

function looksAutomatedSender(sender = "") {
  const raw = (sender || "").toLowerCase();
  const lower = extractEmailAddress(sender);
  if (!lower.includes("@")) return true;
  if (/(no-?reply|donotreply|notifications?|mailer-daemon|support@|billing@)/.test(lower)) return true;
  if (/(^|[^a-z0-9])noreply@|@noreply\.|no_reply@|notify@|marketing@|promo@|newsletter@|digest@/i.test(raw)) {
    return true;
  }
  return NOISE_DOMAIN_HINTS.some((hint) => lower.includes(hint));
}

/** Subject/snippet/body + sender — noreply in From must match "noreply" keyword. */
function looksLikeNoiseContent(email) {
  const haystack = `${email.sender || ""} ${email.subject || ""} ${email.snippet || ""} ${email.body || ""}`.toLowerCase();
  return NOISE_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

/** Flash sales, % off, urgency CTAs — almost never a personal inbox task. */
function looksLikePromotionalBlast(email) {
  const sub = `${email.subject || ""} ${email.snippet || ""}`.toLowerCase();
  if (
    /\b\d{1,2}\s*%\s*off\b|\b\d{1,3}\s*%\s*discount\b|\bclaim\s+\d{1,2}\s*%\b|\bpromo(?:tion)?\s+code\b|\blimited[\s-]time\b|\bflash\s+sale\b|\blast\s+chance\b|\bact\s+now\b|\bbuy\s+now\b|\bclick\s+(below|here)\b|\bends\s+(today|tonight|soon)\b|\b\d+\s*h(?:our)?s?\s+left\b|\boffer\s+expires\b/.test(
      sub
    )
  ) {
    return true;
  }
  if (/🚨|⚡|🔥/.test(email.subject || "") && /\b(off|sale|deal|claim|save|discount|free)\b/i.test(sub)) {
    return true;
  }
  if (/\b(fee|trading)\s+discount\b|\btrading\s+fees?\b.*\b(off|discount|%)/i.test(sub)) {
    return true;
  }
  if (/\bwatch\b[\s\S]{0,220}\btonight\b/i.test(sub) || /\btonight on\b/i.test(sub)) {
    return true;
  }
  if (/\b(new episode|new season|streaming now|premieres? tonight|live tonight)\b/i.test(sub)) {
    return true;
  }
  if (/[\u{1F389}\u{1F973}\u{1F3AC}\u{1F4FA}]/u.test(email.subject || "")) {
    if (/\b(watch|tonight|premier|episode|show|live|streaming)\b/i.test(sub)) return true;
  }
  return false;
}

function looksLikeRealAsk(email) {
  const haystack = `${email.sender || ""} ${email.subject || ""} ${email.snippet || ""} ${email.body || ""}`.toLowerCase();
  return (
    /(\?|can you|could you|please|let me know|need your|waiting for your|review|feedback|approve|confirm|call me|text me|reply by|get back to me|schedule|book|meet|meeting|follow up|follow-up|by eod|asap)/.test(
      haystack
    ) &&
    !looksLikeNoiseContent(email)
  );
}

function looksFinancialOrImportant(email) {
  const haystack = `${email.subject || ""} ${email.snippet || ""} ${email.body || ""}`.toLowerCase();
  return /(payout|payment|invoice|billing|charge|bank|wire|refund|expense|tax|salary|payroll|contract|agreement|deadline|legal)/.test(
    haystack
  );
}

function looksHumanSender(sender = "") {
  const lower = extractEmailAddress(sender);
  if (!lower.includes("@")) return false;
  if (/(no-?reply|donotreply|notifications?|mailer-daemon)/.test(lower)) return false;
  return true;
}

function extractSenderName(sender = "") {
  const match = sender.match(/^([^<]+)</);
  return (match ? match[1] : sender || "Sender").replace(/"/g, "").trim();
}

function summaryLooksLikeGarbage(summary) {
  const s = (summary || "").toLowerCase().trim();
  if (!s.length) return true;
  if (/begin forwarded|forwarded message|original message/.test(s)) return true;
  if (/sent from my (iphone|ipad|android|galaxy)/.test(s)) return true;
  if (/please excuse any typos/.test(s)) return true;
  if ((s.match(/>/g) || []).length >= 2) return true;
  if (/\bfrom:\s+[A-Za-z].+\bdate:\s/.test(s)) return true;
  if ((s.match(/\bfrom:\s+/g) || []).length >= 2) return true;
  return false;
}

function synthesizeFallbackSummary(email) {
  const sender = extractSenderName(email.sender);
  const subj = (email.subject || "").trim();
  const cleaned = stripEmailBoilerplateForLLM(email.body || "");
  const fromSnippet = stripEmailBoilerplateForLLM(email.snippet || "");
  const source = cleaned.length > 40 ? cleaned : fromSnippet || cleaned;
  const line = source
    .split(/\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 15 && !/^On .+ wrote:/i.test(l) && !/^From:\s/i.test(l));
  let core = line || source.split(/[.!?]\s/)[0] || subj;
  core = core.replace(/\s+/g, " ").trim();
  if (core.length < 25) {
    return `${sender} emailed${subj ? ` (re: ${subj.slice(0, 90)})` : ""}.`.slice(0, 260);
  }
  return `${sender}: ${core}`.slice(0, 260);
}

function normalizeSummary(email, summary) {
  const clean = (summary || "").replace(/\s+/g, " ").trim();
  if (summaryLooksLikeGarbage(clean)) {
    return synthesizeFallbackSummary(email);
  }
  const body = stripEmailBoilerplateForLLM(email.body || "").replace(/\s+/g, " ").trim();
  const snippet = stripEmailBoilerplateForLLM(email.snippet || "").replace(/\s+/g, " ").trim();

  if (!clean) return synthesizeFallbackSummary(email);

  // If model pasted large chunks of body, compress aggressively.
  const looksVerbatim =
    (body && clean.length > 150 && body.toLowerCase().includes(clean.toLowerCase().slice(0, 100))) ||
    clean.length > 320;

  if (looksVerbatim) {
    const source = snippet || clean;
    const parts = source
      .split(/[.!?]\s/)
      .map((p) => p.trim())
      .filter(Boolean);
    const sender = extractSenderName(email.sender);
    const topic = parts[0] || "sent an update";
    const actionSentence =
      parts.find((p) => /call me|text me|reply|follow up|schedule|meet|meeting|by|asap|tuesday|wednesday|thursday|friday|monday|saturday|sunday/i.test(p)) || "";

    const assistantSummary = actionSentence
      ? `${sender} emailed about ${topic.toLowerCase()}. They asked: ${actionSentence}.`
      : `${sender} emailed about ${topic.toLowerCase()}.`;

    return assistantSummary.slice(0, 260).trim();
  }

  return clean.slice(0, 260).trim();
}

/** Model sometimes returns NEEDS_REPLY while describing an ad / no action — align category with the summary. */
function summaryImpliesPromotionalOrNoAction(summary = "") {
  const s = (summary || "").toLowerCase();
  if (s.length < 14) return false;
  const patterns = [
    /\bdoes not require (any )?action\b/,
    /\bno action (is )?required\b/,
    /\bgeneral advertisement\b/,
    /\b(?:serves as|this (?:email )?serves as|this is) (?:a )?(?:general )?(advertisement|marketing update|promotional(?:\s+email)?)\b/,
    /\b(?:purely |only )?(?:informational|for your information)\b/,
    /\bweekly update featuring\b/,
    /\b(?:newsletter|marketing|promotional)(?:-style)? (?:email|update|digest)\b/,
    /\bdoes not need (?:a )?response\b/,
    /\bnot require(?:ing)? (?:a )?response\b/,
    /\bno response (?:is )?(?:needed|required)\b/,
    /\b(?:nothing )?for you to do\b/,
    /\bno (?:follow[- ]?up|reply) (?:is )?needed\b/,
    /\bautomated (?:digest|roundup|notification)\b/,
    /\b(?:curated|featured) (?:apps|deals|products|mobile apps)\b/,
    /\bgeneral (?:advertisement|promotion|marketing)\b/,
    /\b(?:email )?is (?:just |only )?(?:an? )?(?:ad|advertisement|promotional)\b/,
    /\bsends?\s+(?:a\s+)?promotional\s+email\b/,
    /\bpromotional\s+email\s+(?:offering|with|about)\b/,
    /\b\d{1,2}\s*%\s*(?:off|discount)\b.*\b(?:fee|trade|swap|crypto)\b/,
    /\blimited[\s-]time\s+offer\b/,
    /\burgency\b.*\b(?:claim|offer|discount)\b/,
    /\b(?:swap|buy|sell|send)\s+crypto\b.*\b(?:off|discount|%)\b/,
    /\bwithout requiring (any )?action\b/,
    /\badvertising content\b/,
    /\bprimarily serves as\b.*\badvertising\b/,
    /\bprimarily serves as\b.*\bmarketing\b/,
    /\bsent an announcement\b.*\b(?:advertising|schedule|shows?)\b/,
    /\bemail\b.*\b(?:primarily |mostly )?serves as\b.*\b(?:advertising|promotion)\b/,
    /\bwithout requiring\b.*\b(?:response|action)\b/
  ];
  return patterns.some((re) => re.test(s));
}

function parseConditionalFeedbackRule(reason = "") {
  const r = String(reason || "").toLowerCase();
  const hasIf = /\bif\b/.test(r);
  const hasElse = /\bif\s+(it('| i)?s|its|it's|not)\b/.test(r) || /\bif not\b|\botherwise\b|\belse\b/.test(r);
  const mentionsNewMessage = /\bnew\s+message\b/.test(r);
  const mentionsTodo = /\b(to do|todo|needs?\s*reply|need(s)?\s+reply|important)\b/.test(r);
  const mentionsNoise = /\bnoise|not important|unimportant\b/.test(r);
  if (hasIf && hasElse && mentionsNewMessage && mentionsTodo && mentionsNoise) {
    return {
      type: "subject_contains_new_message",
      positiveCategory: "NEEDS_REPLY",
      negativeCategory: "NOISE"
    };
  }
  return null;
}

function enforceCategoryRules(email, analysis) {
  const modelNote = analysis?.classification_reason;

  // Explicit user feedback overrides should win over generic heuristics.
  if (analysis?._feedbackOverride) {
    return {
      category: analysis.category,
      summary: analysis.category === "NOISE" ? null : analysis.summary,
      draft: analysis.category === "NEEDS_REPLY" ? analysis.draft : null,
      classification_reason:
        modelNote ||
        clampClassificationReason("Past correction matched this sender or subject.")
    };
  }

  if (
    looksAutomatedSender(email.sender) ||
    looksLikeNoiseContent(email) ||
    looksLikePromotionalBlast(email)
  ) {
    return {
      category: "NOISE",
      summary: null,
      draft: null,
      classification_reason: clampClassificationReason(
        `Rule: automated sender or content signals (no substantive reply expected).${modelNote ? ` Model had: ${modelNote}` : ""}`
      )
    };
  }

  // Personal/financial emails should stay actionable.
  if (looksHumanSender(email.sender) && looksFinancialOrImportant(email)) {
    return {
      category: "NEEDS_REPLY",
      summary: analysis.summary || normalizeSummary(email, email.snippet || "Action needed on financial/important email."),
      draft: analysis.draft || null,
      classification_reason: clampClassificationReason(
        modelNote
          ? `Rule: human sender + financial/important signals. ${modelNote}`
          : "Rule: human sender + financial/important signals."
      )
    };
  }

  if (analysis.category === "NEEDS_REPLY" && summaryImpliesPromotionalOrNoAction(analysis.summary)) {
    return {
      category: "NOISE",
      summary: null,
      draft: null,
      classification_reason: clampClassificationReason(
        `Rule: summary implied no reply needed; moved to Noise.${modelNote ? ` Model had: ${modelNote}` : ""}`
      )
    };
  }

  if (analysis.category !== "NEEDS_REPLY") {
    return {
      category: "NOISE",
      summary: null,
      draft: null,
      classification_reason: modelNote || clampClassificationReason("Model classified as Noise.")
    };
  }
  if (!looksLikeRealAsk(email)) {
    return {
      category: "NOISE",
      summary: null,
      draft: null,
      classification_reason: clampClassificationReason(
        `Rule: no clear ask in subject/snippet.${modelNote ? ` Model had: ${modelNote}` : ""}`
      )
    };
  }

  return analysis;
}

function applyFeedbackOverrides(email, analysis, recentFeedback) {
  const haystack = `${email.sender || ""} ${email.subject || ""} ${email.snippet || ""} ${email.body || ""}`.toLowerCase();
  const domain = extractDomain(email.sender);
  const subjectLower = (email.subject || "").toLowerCase();

  for (const fb of recentFeedback || []) {
    if (!fb?.correct_category) continue;
    const fbCategory = fb.correct_category;
    const fbDomain = extractDomain(fb.sender || "");
    const reasonTokens = (fb.reason || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3);

    const domainMatch = fbDomain && domain && (domain === fbDomain || domain.endsWith(`.${fbDomain}`));
    const tokenMatch = reasonTokens.some((t) => haystack.includes(t));
    const senderMatch = fb.sender && haystack.includes(String(fb.sender).toLowerCase());

    const conditional = parseConditionalFeedbackRule(fb.reason || "");
    if ((domainMatch || senderMatch) && conditional?.type === "subject_contains_new_message") {
      const matchesNewMessage = /\bnew\s+message\b/.test(subjectLower);
      if (matchesNewMessage) {
        return {
          ...analysis,
          category: conditional.positiveCategory,
          summary: analysis.summary || normalizeSummary(email, email.snippet || email.subject || ""),
          draft: conditional.positiveCategory === "NEEDS_REPLY" ? analysis.draft : null,
          _feedbackOverride: true
        };
      }
      return {
        ...analysis,
        category: conditional.negativeCategory,
        summary: null,
        draft: null,
        _feedbackOverride: true
      };
    }

    if (domainMatch || tokenMatch || senderMatch) {
      if (fbCategory === "NOISE") {
        return {
          ...analysis,
          category: "NOISE",
          summary: null,
          draft: null,
          _feedbackOverride: true
        };
      }
      return {
        ...analysis,
        category: fbCategory,
        draft: fbCategory === "NEEDS_REPLY" ? analysis.draft : null,
        _feedbackOverride: true
      };
    }
  }

  return analysis;
}

async function classifyAndDraft(email) {
  const recentFeedback = await getRecentFeedback(30);
  const feedbackContext = recentFeedback
    .map((item) => `sender=${item.sender}; subject=${item.subject}; corrected=${item.correct_category}; reason=${item.reason}`)
    .join("\n");

  const system = `You are an email triage assistant. Your category and summary are ONE judgment — they must agree. A self-contradictory answer is wrong.

Return strictly valid JSON with keys:
- category: one of NEEDS_REPLY or NOISE
- summary: 1-2 sentences, max 260 characters, paraphrased (not copied from the email). Include who sent it, what it is, and (only if NEEDS_REPLY) what they want from the recipient.
- draft: reply draft text ONLY when category is NEEDS_REPLY, otherwise exactly empty string ""
- reasoning: one short sentence (max ~180 characters) explaining why you chose this category — plain English; not a second summary of the email.

How to decide (do this in order):
1) Decide category FIRST from the email alone — before you write the summary.
2) NEEDS_REPLY ONLY if a real person would reasonably owe this sender a substantive written reply OR must take a specific important non-marketing action (money, legal, security, deadline, scheduling with a human, etc.).
3) NOISE for everything else: marketing, ads, promos, show schedules, "watch tonight", newsletters, digests, receipts you don't answer, automated notifications, FYI mail, anything where no personal reply is expected.
4) If you are unsure, category is NOISE.

Non-negotiable consistency (reread your JSON before you output it):
- If category is NOISE, the summary must NOT pretend someone is waiting for a reply; describe the email accurately (e.g. promo, announcement, newsletter).
- If category is NEEDS_REPLY, the summary MUST state what they are asking for or why a reply matters. If you cannot name a real ask, category is NOISE.
- It is INVALID to output category NEEDS_REPLY while your summary says the email is advertising, promotional, marketing, an announcement only, informational only, a schedule blast, or that no response/action is required. If your summary would say that, category MUST be NOISE — fix the category, not the truth.

Financial/billing/payout/invoice/contract/legal/deadline mail from real senders stays NEEDS_REPLY when action matters. Obvious account-security messages (password reset, 2FA) can be NEEDS_REPLY when the user must act; generic marketing from the same brand is NOISE.

Summary must NEVER include:
- Signatures, "Sent from my iPhone", "Please excuse typos", or client taglines
- Forward headers ("Begin forwarded message", "From:/Date:/To:", lines starting with >)
- Quoted thread text — summarize only the substantive point in plain English

Use these user corrections as high-priority guidance:
${feedbackContext || "No user corrections yet."}`;
  const bodyForModel = stripEmailBoilerplateForLLM(email.body || "");
  const snippetForModel = stripEmailBoilerplateForLLM(email.snippet || "");
  const user = `Email:
From: ${email.sender}
Subject: ${email.subject}
Date: ${email.date}
Snippet (cleaned): ${snippetForModel}
Body (cleaned, no signatures/quoted blocks):
${bodyForModel || "(empty after cleaning — rely on subject + snippet)"}

Output only the JSON object. Category and summary must agree — if the email is promo/FYI, both must reflect that (category NOISE).`;
  const classifyTemp = Number(process.env.LLM_CLASSIFY_TEMPERATURE);
  const tempOpts =
    Number.isFinite(classifyTemp) && classifyTemp >= 0 && classifyTemp <= 2
      ? { temperature: classifyTemp }
      : { temperature: 0.25 };
  const result = await callLLM(system, user, tempOpts);
  const parsed = parseClassification(result);
  const normalized = {
    ...parsed,
    summary: normalizeSummary(email, parsed.summary)
  };
  return applyFeedbackOverrides(email, normalized, recentFeedback);
}

function fallbackClassification(email) {
  const text = `${email.subject || ""} ${email.snippet || ""} ${email.body || ""}`.toLowerCase();
  if (/(receipt|invoice|newsletter|unsubscribe|no-reply|donotreply|notification)/.test(text)) {
    return {
      category: "NOISE",
      summary: null,
      draft: null,
      classification_reason: clampClassificationReason(
        "Heuristic fallback (LLM unavailable): keyword / sender pattern matched low-priority mail."
      )
    };
  }
  return {
    category: "NEEDS_REPLY",
    summary: normalizeSummary(email, email.snippet || "Likely needs a response."),
    draft:
      "Thanks for your email. I received this and will review the details and get back to you shortly.",
    classification_reason: clampClassificationReason(
      "Heuristic fallback (LLM unavailable): assumed reply needed."
    )
  };
}

router.get("/", async (req, res) => {
  try {
    const emails = await getAllEmails();
    return res.json({ emails });
  } catch (error) {
    return res.status(500).json({ error: "Failed to load emails", detail: error.message });
  }
});

router.get("/fetch-status", (req, res) => {
  const active = fetchPipelineDepth > 0;
  return res.json({
    active,
    progress: active ? fetchProgressPct : 0,
    phase: active ? fetchPhaseLabel : ""
  });
});

router.get("/thread/:threadId", async (req, res) => {
  try {
    const { threadId } = req.params;
    if (!threadId) return res.status(400).json({ error: "threadId required" });
    const detail = await fetchThreadDetail(threadId);
    return res.json(detail);
  } catch (error) {
    return res.status(500).json({ error: "Failed to load thread", detail: error.message });
  }
});

router.get("/messages/:messageId/attachments/:attachmentId", async (req, res) => {
  try {
    const { messageId, attachmentId } = req.params;
    const filename = String(req.query.filename || "attachment").slice(0, 400);
    const mime = String(req.query.mime || "application/octet-stream").slice(0, 200);
    const { buffer } = await getAttachmentBuffer(messageId, attachmentId);
    const viewable = /^(image\/|application\/pdf)/i.test(mime);
    res.setHeader("Content-Type", mime);
    res.setHeader(
      "Content-Disposition",
      `${viewable ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(filename)}`
    );
    res.setHeader("Cache-Control", "private, max-age=3600");
    return res.send(buffer);
  } catch (error) {
    return res.status(404).json({ error: "Attachment unavailable", detail: error.message });
  }
});

router.get("/fetch", async (req, res) => {
  const startedAt = Date.now();
  const traceId = `fetch-${startedAt}`;
  const log = (msg) => {
    const elapsed = Date.now() - startedAt;
    console.log(`[${traceId}] +${elapsed}ms ${msg}`);
  };

  beginFetchPipeline();
  try {
    setFetchProgress(4, "connect");
    log(`START /api/emails/fetch limit=${FETCH_LIMIT}`);
    log("Step 1/4: Fetch unread emails from Gmail...");
    setFetchProgress(10, "fetch_unread");
    const fetched = await fetchUnreadEmails(FETCH_LIMIT);
    log(`Fetched ${fetched.length} unread email(s)`);
    setFetchProgress(22, "fetched_unread");
    let inserted = 0;
    const warnings = [];

    log("Step 2/4: Upsert and classify fetched emails...");
    setFetchProgress(24, "classify");
    const processed = await processNewEmails(fetched, log, { min: 26, max: 54 });
    inserted = processed.inserted;
    warnings.push(...processed.warnings);
    setFetchProgress(56, "classified");

    const withTimeout = async (promise, ms, label) => {
      let timer;
      try {
        return await Promise.race([
          promise,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
          })
        ]);
      } finally {
        clearTimeout(timer);
      }
    };

    log("Step 3/4: Sync thread latest-state with Gmail...");
    setFetchProgress(58, "thread_sync");
    // Sync thread states so external Gmail activity keeps lanes accurate.
    const allEmails = await getAllEmails();
    const candidates = allEmails.filter(
      (item) =>
        item.thread_id &&
        (item.category === "NEEDS_REPLY" ||
          item.draft_status === "sent" ||
          item.draft_status === "pending" ||
          item.draft_status === "completed")
    );

    // Deduplicate thread checks to avoid repeated API calls and slow fetches.
    const threadMap = new Map();
    for (const item of candidates) {
      const existing = threadMap.get(item.thread_id);
      const a = new Date(item.date || 0).getTime();
      const b = existing ? new Date(existing.date || 0).getTime() : -Infinity;
      if (!existing || a >= b) threadMap.set(item.thread_id, item);
    }

    log(`Thread sync candidates=${threadMap.size}`);
    const threadList = [...threadMap.values()];
    const tn = threadList.length;
    for (let ti = 0; ti < tn; ti++) {
      const item = threadList[ti];
      try {
        if (!item.thread_id) continue;
        log(`  thread check start thread_id=${item.thread_id} email_id=${item.id}`);
        const state = await withTimeout(
          getThreadLatestState(item.thread_id),
          THREAD_SYNC_TIMEOUT_MS,
          `Thread sync ${item.thread_id}`
        );
        if (state.latestIsSent) {
          // Every row for this thread shares one conversation — mark all sent, not just one message id.
          await markThreadDraftStatus(item.thread_id, "sent");
          log(`  thread latest is SENT -> marked thread ${item.thread_id} sent (all rows)`);
          continue;
        }

        // User marked Done without a reply — do not re-open if Gmail's latest is still that same message.
        if (
          item.draft_status === "completed" &&
          state.latest?.id &&
          state.latest.id === item.id
        ) {
          log(`  completed unchanged (latest id=${state.latest.id}) -> skip thread re-open`);
          continue;
        }

        // If latest message is incoming, this thread should be active again.
        if (state.latest) {
          await markThreadDraftStatus(item.thread_id, "pending");
          await updateEmailRaw(item.id, state.latest);
          log(`  thread latest is incoming -> marked thread ${item.thread_id} pending, refreshed ${item.id}`);

          let analysis;
          try {
            analysis = await classifyAndDraft(state.latest);
            log(`  reclassified latest thread content => ${analysis.category}`);
          } catch {
            analysis = fallbackClassification(state.latest);
            log("  reclassification fallback used");
          }
          analysis = enforceCategoryRules(state.latest, analysis);
          if (analysis.category === "NOISE") analysis.summary = null;
          await updateEmailAnalysis(item.id, analysis);
          log(`  stored thread-sync analysis for ${item.id}`);
        }
      } catch (error) {
        log(`  thread sync warning for ${item.id}: ${error.message}`);
        warnings.push({
          id: item.id,
          reason: `Could not verify sent-thread state: ${error.message}`
        });
      } finally {
        setFetchProgress(58 + Math.floor(((ti + 1) / Math.max(tn, 1)) * 17), "thread_sync");
      }
    }
    if (tn === 0) setFetchProgress(75, "threads_synced");

    log("Step 4/4: Load final email set...");
    setFetchProgress(88, "finalize");
    const emails = await getAllEmails();
    setFetchProgress(100, "done");
    log(
      `COMPLETE fetched=${fetched.length} inserted=${inserted} finalCount=${emails.length} warnings=${warnings.length}`
    );
    return res.json({ fetched: fetched.length, inserted, emails, warnings, fetchLimit: FETCH_LIMIT });
  } catch (error) {
    log(`FAILED: ${error.message}`);
    return res.status(500).json({ error: "Fetch and triage failed", detail: error.message });
  } finally {
    endFetchPipeline();
  }
});

router.post("/watch/start", async (req, res) => {
  try {
    const topicName = process.env.GMAIL_PUBSUB_TOPIC;
    const watch = await startInboxWatch(topicName);
    await upsertWatchState({
      last_history_id: watch.historyId,
      watch_expiration: watch.expiration,
      source: "watch.start"
    });
    return res.json({ ok: true, watch });
  } catch (error) {
    return res.status(500).json({ error: "Failed to start Gmail watch", detail: error.message });
  }
});

router.post("/watch/push", async (req, res) => {
  const startedAt = Date.now();
  const traceId = `push-${startedAt}`;
  const log = (msg) => {
    const elapsed = Date.now() - startedAt;
    console.log(`[${traceId}] +${elapsed}ms ${msg}`);
  };

  try {
    const providedSecret = req.query?.secret || req.get("x-webhook-secret");
    if (GMAIL_PUSH_WEBHOOK_SECRET && providedSecret !== GMAIL_PUSH_WEBHOOK_SECRET) {
      return res.status(401).json({ error: "Unauthorized push webhook" });
    }

    const envelope = req.body?.message;
    if (!envelope?.data) {
      // Pub/Sub probe or malformed event; ack to avoid retries.
      return res.status(204).send();
    }
    const decoded = JSON.parse(Buffer.from(envelope.data, "base64").toString("utf-8"));
    const incomingHistoryId = String(decoded.historyId || "");
    const emailAddress = decoded.emailAddress || null;
    log(`Push received historyId=${incomingHistoryId} email=${emailAddress || "n/a"}`);

    const watchState = await getWatchState();
    if (!watchState?.last_history_id) {
      await upsertWatchState({
        last_history_id: incomingHistoryId,
        email_address: emailAddress,
        source: "push.bootstrap"
      });
      log("No prior watch state; bootstrapped historyId and acknowledged.");
      return res.status(204).send();
    }

    let changes;
    try {
      changes = await getNewInboxMessageIdsSince(watchState.last_history_id);
    } catch (error) {
      if (error?.code === 404) {
        // History window expired; re-anchor at current push history id.
        await upsertWatchState({
          last_history_id: incomingHistoryId,
          email_address: emailAddress,
          source: "push.history-reset"
        });
        log("History window expired (404); re-anchored historyId and acknowledged.");
        return res.status(204).send();
      }
      throw error;
    }

    log(`History delta raw messageIds=${changes.messageIds.length}`);

    const filteredIds = [];
    for (const id of changes.messageIds) {
      try {
        const labels = await getMessageLabelIds(id);
        if (isMessageEligibleForInboxTriage(labels)) {
          filteredIds.push(id);
        } else {
          log(`  skip push id=${id} labels=${(labels || []).join(",")}`);
        }
      } catch (error) {
        log(`  warning: label check failed for ${id}: ${error.message}`);
      }
    }

    log(`History delta after label filter=${filteredIds.length}`);

    if (filteredIds.length === 0) {
      await upsertWatchState({
        last_history_id: changes.latestHistoryId || incomingHistoryId,
        email_address: emailAddress,
        source: "push.filtered-empty"
      });
      log("Push: no inbox triage candidates (drafts/sent-only/noise) — skipping pipeline.");
      return res.status(204).send();
    }

    beginFetchPipeline();
    try {
      setFetchProgress(6, "push_fetch_messages");
      const incomingEmails = [];
      const pn = filteredIds.length;
      for (let i = 0; i < pn; i++) {
        const id = filteredIds[i];
        try {
          incomingEmails.push(await fetchEmailById(id));
        } catch (error) {
          log(`  warning: failed to fetch message ${id}: ${error.message}`);
        }
        setFetchProgress(6 + Math.floor(((i + 1) / Math.max(pn, 1)) * 30), "push_fetch_messages");
      }

      setFetchProgress(38, "push_classify");
      const processed = await processNewEmails(incomingEmails, log, { min: 40, max: 94 });
      setFetchProgress(100, "done");
      await upsertWatchState({
        last_history_id: changes.latestHistoryId || incomingHistoryId,
        email_address: emailAddress,
        source: "push.processed"
      });
      log(
        `Push processed inserted=${processed.inserted} warnings=${processed.warnings.length} nextHistoryId=${changes.latestHistoryId || incomingHistoryId}`
      );

      return res.status(204).send();
    } finally {
      endFetchPipeline();
    }
  } catch (error) {
    log(`Push failed: ${error.message}`);
    // Return 204 to avoid noisy Pub/Sub redelivery storms while still logging.
    return res.status(204).send();
  }
});

router.post("/:id/draft", async (req, res) => {
  try {
    const { id } = req.params;
    const { draft } = req.body;
    if (typeof draft !== "string") return res.status(400).json({ error: "Invalid draft payload" });
    await updateDraft(id, draft);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: "Failed to update draft", detail: error.message });
  }
});

router.post("/:id/draft/generate", async (req, res) => {
  try {
    const { id } = req.params;
    const email = await getEmailById(id);
    if (!email) return res.status(404).json({ error: "Email not found" });

    const system = `You write concise, human-sounding email replies.
Generate only reply body text. Do not include subject line or signatures.
Tone: professional, friendly, not overly formal.
If the sender asked for a specific action/time, acknowledge it.`;
    const bodyForDraft = stripEmailBoilerplateForLLM(email.body || email.snippet || "");
    const user = `Incoming email context:
From: ${email.sender}
Subject: ${email.subject}
Summary: ${email.summary || ""}
Body (cleaned):
${bodyForDraft || "(no body)"}`;

    const draft = (await callLLM(system, user)).trim();
    await updateDraft(id, draft);
    return res.json({ ok: true, draft });
  } catch (error) {
    return res.status(500).json({ error: "Failed to generate draft", detail: error.message });
  }
});

router.post("/:id/discard", async (req, res) => {
  try {
    if (req.body?.intent !== "discard") {
      return res.status(400).json({ error: "Explicit discard intent required" });
    }
    await markDraftStatus(req.params.id, "discarded");
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: "Failed to discard draft", detail: error.message });
  }
});

router.post("/:id/complete", async (req, res) => {
  try {
    if (req.body?.intent !== "complete") {
      return res.status(400).json({ error: "Explicit complete intent required" });
    }
    const { id } = req.params;
    const email = await getEmailById(id);
    if (!email) return res.status(404).json({ error: "Email not found" });
    if (email.category !== "NEEDS_REPLY") {
      return res.status(400).json({ error: "Complete is only for To Do items" });
    }
    await markDraftStatus(id, "completed");
    await markThreadDraftStatus(email.thread_id, "completed");
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: "Failed to mark complete", detail: error.message });
  }
});

router.post("/:id/send", async (req, res) => {
  try {
    if (req.body?.intent !== "send") {
      return res.status(400).json({ error: "Explicit send intent required" });
    }
    const { id } = req.params;
    const email = await getEmailById(id);
    if (!email) return res.status(404).json({ error: "Email not found" });
    if (!email.draft) return res.status(400).json({ error: "No draft available" });

    await sendReplyDraft({
      threadId: email.thread_id,
      to: email.sender,
      subject: email.subject,
      bodyText: email.draft
    });
    await markDraftStatus(id, "sent");
    await markThreadDraftStatus(email.thread_id, "sent");
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: "Failed to send email", detail: error.message });
  }
});

router.post("/:id/inform", async (req, res) => {
  try {
    const { id } = req.params;
    const { correctCategory, reason } = req.body || {};
    if (!VALID_CATEGORIES.includes(correctCategory)) {
      return res.status(400).json({ error: "Invalid category for feedback" });
    }
    const normalizedReason =
      typeof reason === "string" && reason.trim().length > 0
        ? reason.trim()
        : `manual move to ${correctCategory}`;

    const email = await getEmailById(id);
    if (!email) return res.status(404).json({ error: "Email not found" });

    if (email.draft_status === "completed") {
      await markDraftStatus(id, correctCategory === "NEEDS_REPLY" ? "pending" : null);
    }

    await addClassificationFeedback({
      email_id: id,
      sender: email.sender,
      subject: email.subject,
      previous_category: email.category || null,
      correct_category: correctCategory,
      reason: normalizedReason
    });

    await updateEmailAnalysis(id, {
      category: correctCategory,
      summary:
        correctCategory === "NEEDS_REPLY"
          ? email.summary || normalizeSummary(email, email.snippet || "")
          : null,
      draft: correctCategory === "NEEDS_REPLY" ? email.draft || "" : null
    });
    await setEmailManualOverride(id, { category: correctCategory, reason: normalizedReason });

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: "Failed to record feedback", detail: error.message });
  }
});

router.post("/:id/retriage", async (req, res) => {
  try {
    const { id } = req.params;
    const email = await getEmailById(id);
    if (!email) return res.status(404).json({ error: "Email not found" });

    // Re-pull latest Gmail content for this specific message/thread before re-triage.
    let latest = email;
    try {
      latest = await fetchEmailById(id);
      await updateEmailRaw(id, latest);
    } catch {
      latest = email;
    }

    await clearEmailManualOverride(id);

    if (email.draft_status === "completed") {
      await markDraftStatus(id, "pending");
    }

    let analysis;
    try {
      analysis = await classifyAndDraft(latest);
    } catch {
      const recentFeedback = await getRecentFeedback(30);
      analysis = applyFeedbackOverrides(latest, fallbackClassification(latest), recentFeedback);
    }
    analysis = enforceCategoryRules(latest, analysis);
    await updateEmailAnalysis(id, analysis);

    try {
      const state = await getThreadLatestState(latest.thread_id);
      if (state.latestIsSent) {
        await markThreadDraftStatus(latest.thread_id, "sent");
      } else {
        await markThreadDraftStatus(latest.thread_id, "pending");
      }
    } catch {
      // keep classification result if thread state check fails
    }

    const updated = await getEmailById(id);
    return res.json({ ok: true, email: updated });
  } catch (error) {
    return res.status(500).json({ error: "Failed to re-triage email", detail: error.message });
  }
});

router.get("/needs-reply", async (req, res) => {
  try {
    const emails = await getNeedsReplyEmails();
    return res.json({ emails });
  } catch (error) {
    return res.status(500).json({ error: "Failed to load needs-reply list", detail: error.message });
  }
});

export default router;
