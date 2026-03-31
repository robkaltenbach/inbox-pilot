import { WebClient } from "@slack/web-api";
import { getSlackNotifySettings, upsertSlackFlow } from "../db.js";

/** Lazy client: env is loaded in index.js *after* imports are resolved, so we must not read the token at module load. */
let slackClient = null;
export function getSlack() {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return null;
  if (!slackClient) slackClient = new WebClient(token);
  return slackClient;
}

let cachedBotUserId = null;
export async function getSlackBotUserId() {
  const slack = getSlack();
  if (!slack) return null;
  if (cachedBotUserId) return cachedBotUserId;
  const auth = await slack.auth.test();
  cachedBotUserId = auth.user_id || null;
  return cachedBotUserId;
}

export const SLACK_CHUNK_SIZE = 500;

export const SLACK_ACTION_SEE_MESSAGE = "slack_see_message";
export const SLACK_ACTION_CONTINUE_READ = "slack_continue_read";
export const SLACK_ACTION_REPLY = "slack_reply";
export const SLACK_ACTION_REPLY_AI = "slack_reply_ai";
export const SLACK_ACTION_COMPLETE = "slack_complete";
export const SLACK_ACTION_SEND_AI_DRAFT = "slack_send_ai_draft";

export function slackEnabled() {
  return Boolean(process.env.SLACK_BOT_TOKEN && process.env.SLACK_CHANNEL_ID);
}

function subjectMatchesPhrases(email, phrases) {
  if (!phrases?.length) return true;
  const hay = `${email.subject || ""} ${email.sender || ""}`.toLowerCase();
  return phrases.some((p) => hay.includes(String(p).toLowerCase()));
}

/** Plain text for Slack display (light HTML strip if needed). */
export function emailBodyPlainForSlack(email) {
  let t = String(email?.body || email?.snippet || "");
  if (/<[a-z][\s\S]*>/i.test(t)) {
    t = t
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n");
  }
  return t.replace(/\r/g, "").trim();
}

function escapeCodeFence(s) {
  return s.replace(/```/g, "`\u200b`\u200b`");
}

function draftPreview(draft, max = 600) {
  const d = String(draft || "").trim() || "(no draft)";
  return d.length > max ? `${d.slice(0, max - 1)}…` : d;
}

/**
 * Parent card blocks: optional See message when body remains; always Reply, Reply with AI, Complete.
 */
export function buildNeedsReplyParentBlocks(email, { showSeeMessage, emailId }) {
  const body = emailBodyPlainForSlack(email);
  const canSeeMore = showSeeMessage && body.length > 0;

  const actions = [];
  if (canSeeMore) {
    actions.push({
      type: "button",
      text: { type: "plain_text", text: "See message" },
      action_id: SLACK_ACTION_SEE_MESSAGE,
      value: emailId
    });
  }
  actions.push(
    {
      type: "button",
      text: { type: "plain_text", text: "Reply" },
      action_id: SLACK_ACTION_REPLY,
      value: emailId
    },
    {
      type: "button",
      text: { type: "plain_text", text: "Reply with AI" },
      action_id: SLACK_ACTION_REPLY_AI,
      value: emailId
    },
    {
      type: "button",
      text: { type: "plain_text", text: "Complete" },
      action_id: SLACK_ACTION_COMPLETE,
      value: emailId
    }
  );

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `*Needs reply*\n*From:* ${email.sender}\n*Subject:* ${email.subject}\n\n` +
          `*Draft preview:*\n\`\`\`${escapeCodeFence(draftPreview(email.draft))}\`\`\``
      }
    },
    { type: "actions", elements: actions }
  ];
}

/**
 * Thread reader message: chunk text + Continue (if more) + Reply + Reply with AI + Complete.
 */
export function buildReaderChunkBlocks({ chunkText, hasMore, emailId }) {
  const safe = escapeCodeFence(chunkText || "(empty)");
  const elements = [];
  if (hasMore) {
    elements.push({
      type: "button",
      text: { type: "plain_text", text: "Continue" },
      action_id: SLACK_ACTION_CONTINUE_READ,
      value: emailId
    });
  }
  elements.push(
    {
      type: "button",
      text: { type: "plain_text", text: "Reply" },
      action_id: SLACK_ACTION_REPLY,
      value: emailId
    },
    {
      type: "button",
      text: { type: "plain_text", text: "Reply with AI" },
      action_id: SLACK_ACTION_REPLY_AI,
      value: emailId
    },
    {
      type: "button",
      text: { type: "plain_text", text: "Complete" },
      action_id: SLACK_ACTION_COMPLETE,
      value: emailId
    }
  );

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Incoming message*\n\`\`\`${safe}\`\`\``
      }
    },
    { type: "actions", elements }
  ];
}

export async function postIncomingNoiseNotification(email) {
  const slack = getSlack();
  if (!slackEnabled() || !slack) return;
  const summary = email.summary || email.snippet || "";
  const preview = summary.length > 400 ? `${summary.slice(0, 397)}…` : summary;
  await slack.chat.postMessage({
    channel: process.env.SLACK_CHANNEL_ID,
    text: `Noise: ${email.subject}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*Noise (new)*\n*From:* ${email.sender}\n*Subject:* ${email.subject}` +
            (preview ? `\n\n_${preview.replace(/\n/g, " ")}_` : "")
        }
      }
    ]
  });
}

/**
 * After a new email is classified and stored, post to Slack if enabled and filters match.
 * Never throws — logs warnings only so triage never fails on Slack.
 */
export async function notifySlackForNewlyTriagedEmail(email) {
  if (!slackEnabled() || !getSlack() || !email?.id) return;
  try {
    const { notifyCategories, subjectContainsPhrases } = await getSlackNotifySettings();
    const cat = String(email.category || "").toUpperCase();
    if (!notifyCategories.length || !notifyCategories.includes(cat)) return;
    if (!subjectMatchesPhrases(email, subjectContainsPhrases)) return;

    if (cat === "NEEDS_REPLY") {
      await postNeedsReplyInteractive(email);
    } else if (cat === "NOISE") {
      await postIncomingNoiseNotification(email);
    }
  } catch (err) {
    console.warn("[slack] notifySlackForNewlyTriagedEmail:", err.message || err);
  }
}

export async function postDigest(blocks) {
  const slack = getSlack();
  if (!slackEnabled() || !slack) throw new Error("Slack is not configured");
  return slack.chat.postMessage({
    channel: process.env.SLACK_CHANNEL_ID,
    text: "InboxPilot Morning Brief",
    blocks
  });
}

export async function postNeedsReplyInteractive(email) {
  const slack = getSlack();
  if (!slackEnabled() || !slack) return;
  const body = emailBodyPlainForSlack(email);
  const showSeeMessage = body.length > 0;

  const blocks = buildNeedsReplyParentBlocks(email, { showSeeMessage, emailId: email.id });
  const result = await slack.chat.postMessage({
    channel: process.env.SLACK_CHANNEL_ID,
    text: `Needs reply: ${email.subject}`,
    blocks
  });

  const channel = result.channel;
  const parentTs = result.ts;
  if (channel && parentTs) {
    await upsertSlackFlow({
      channel,
      parentTs,
      emailId: email.id,
      shownUntil: 0,
      readerMsgTs: null,
      awaitingReplyUser: null,
      messageFullyShown: !showSeeMessage
    });
  }
}
