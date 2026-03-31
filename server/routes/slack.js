import crypto from "node:crypto";
import express from "express";
import {
  getAllEmails,
  getEmailById,
  getSlackFlow,
  getWaitingOlderThan,
  markDraftStatus,
  markThreadDraftStatus,
  removeSlackFlow,
  updateDraft,
  upsertSlackFlow
} from "../db.js";
import { sendReplyDraft, stripEmailBoilerplateForLLM } from "../services/gmail.js";
import { callLLM } from "../services/llm.js";
import {
  SLACK_ACTION_COMPLETE,
  SLACK_ACTION_CONTINUE_READ,
  SLACK_ACTION_REPLY,
  SLACK_ACTION_REPLY_AI,
  SLACK_ACTION_SEE_MESSAGE,
  SLACK_ACTION_SEND_AI_DRAFT,
  SLACK_CHUNK_SIZE,
  buildNeedsReplyParentBlocks,
  buildReaderChunkBlocks,
  emailBodyPlainForSlack,
  getSlackBotUserId,
  getSlack,
  postDigest,
  postNeedsReplyInteractive,
  slackEnabled
} from "../services/slack.js";

const router = express.Router();

function computeDashboardLanes(all) {
  const lanes = { NEEDS_REPLY: [], NOISE: [], REPLIED: [] };
  for (const email of all || []) {
    if (email.draft_status === "sent" || email.draft_status === "completed") {
      lanes.REPLIED.push(email);
      continue;
    }
    const key = email.category === "NEEDS_REPLY" ? "NEEDS_REPLY" : "NOISE";
    lanes[key].push(email);
  }

  for (const lane of Object.keys(lanes)) {
    const byThread = new Map();
    for (const email of lanes[lane]) {
      const threadKey = email.thread_id || email.id;
      const existing = byThread.get(threadKey);
      const emailTs = new Date(email.date || 0).getTime();
      const existingTs = existing ? new Date(existing.date || 0).getTime() : -Infinity;
      if (!existing || emailTs >= existingTs) byThread.set(threadKey, email);
    }
    lanes[lane] = Array.from(byThread.values()).sort(
      (a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime()
    );
  }

  return lanes;
}

function verifySlackRequest(signingSecret, signature, timestamp, rawBody) {
  if (!signingSecret || !signature || !timestamp || rawBody == null) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 60 * 5) return false;
  const sigBasestring = `v0:${timestamp}:${rawBody}`;
  const hmac = crypto.createHmac("sha256", signingSecret).update(sigBasestring, "utf8").digest("hex");
  const expected = `v0=${hmac}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

async function generateAndSaveDraft(emailId) {
  const email = await getEmailById(emailId);
  if (!email) throw new Error("Email not found");
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
  await updateDraft(emailId, draft);
  return { email, draft };
}

function parentKeyFromPayload(payload) {
  const m = payload.message;
  if (!m) return null;
  const channel = payload.channel?.id;
  const parentTs = m.thread_ts || m.ts;
  if (!channel || !parentTs) return null;
  return { channel, parentTs };
}

async function refreshParentCard(channel, parentTs, emailId) {
  const slack = getSlack();
  const email = await getEmailById(emailId);
  if (!slack || !email) return;
  const flow = await getSlackFlow(channel, parentTs);
  const showSeeMessage = flow && !flow.messageFullyShown && emailBodyPlainForSlack(email).length > 0;
  const blocks = buildNeedsReplyParentBlocks(email, {
    showSeeMessage,
    emailId
  });
  await slack.chat.update({
    channel,
    ts: parentTs,
    text: `Needs reply: ${email.subject}`,
    blocks
  });
}

async function handleSeeMessage(payload) {
  const slack = getSlack();
  const { channel, parentTs } = parentKeyFromPayload(payload) || {};
  const action = payload.actions?.[0];
  const emailId = action?.value;
  if (!slack || !channel || !parentTs || !emailId) return;

  const email = await getEmailById(emailId);
  if (!email) return;

  const body = emailBodyPlainForSlack(email);
  const flow = (await getSlackFlow(channel, parentTs)) || { shownUntil: 0 };
  const shownUntil = Number(flow.shownUntil) || 0;

  if (flow.readerMsgTs && !flow.messageFullyShown && shownUntil > 0) {
    await slack.chat.postMessage({
      channel,
      thread_ts: parentTs,
      text: "Keep reading in this thread — use the *Continue* button on the message above."
    });
    return;
  }

  if (!body.length || shownUntil >= body.length) {
    await upsertSlackFlow({
      channel,
      parentTs,
      emailId,
      messageFullyShown: true,
      readerMsgTs: flow.readerMsgTs
    });
    await refreshParentCard(channel, parentTs, emailId);
    return;
  }

  const start = 0;
  const end = Math.min(start + SLACK_CHUNK_SIZE, body.length);
  const chunk = body.slice(start, end);
  const hasMore = end < body.length;
  const fullyShown = end >= body.length;

  const blocks = buildReaderChunkBlocks({ chunkText: chunk, hasMore, emailId });
  const posted = await slack.chat.postMessage({
    channel,
    thread_ts: parentTs,
    text: `Message (chars ${start + 1}–${end})`,
    blocks
  });

  await upsertSlackFlow({
    channel,
    parentTs,
    emailId,
    shownUntil: end,
    readerMsgTs: posted.ts || flow.readerMsgTs,
    messageFullyShown: fullyShown,
    awaitingReplyUser: null
  });

  if (fullyShown) await refreshParentCard(channel, parentTs, emailId);
}

async function handleContinueRead(payload) {
  const slack = getSlack();
  const { channel, parentTs } = parentKeyFromPayload(payload) || {};
  const action = payload.actions?.[0];
  const emailId = action?.value;
  if (!slack || !channel || !parentTs || !emailId) return;

  const email = await getEmailById(emailId);
  if (!email) return;

  const body = emailBodyPlainForSlack(email);
  const flow = await getSlackFlow(channel, parentTs);
  let start = Number(flow?.shownUntil) || 0;
  if (start >= body.length) {
    await upsertSlackFlow({ channel, parentTs, emailId, messageFullyShown: true, readerMsgTs: flow?.readerMsgTs });
    await refreshParentCard(channel, parentTs, emailId);
    return;
  }

  const end = Math.min(start + SLACK_CHUNK_SIZE, body.length);
  const chunk = body.slice(start, end);
  const hasMore = end < body.length;
  const fullyShown = end >= body.length;
  const readerTs = flow?.readerMsgTs || payload.message?.ts;

  const blocks = buildReaderChunkBlocks({ chunkText: chunk, hasMore, emailId });

  if (readerTs) {
    await slack.chat.update({
      channel,
      ts: readerTs,
      text: `Message (chars ${start + 1}–${end})`,
      blocks
    });
  } else {
    const posted = await slack.chat.postMessage({
      channel,
      thread_ts: parentTs,
      text: `Message (chars ${start + 1}–${end})`,
      blocks
    });
    await upsertSlackFlow({ channel, parentTs, emailId, readerMsgTs: posted.ts });
  }

  await upsertSlackFlow({
    channel,
    parentTs,
    emailId,
    shownUntil: end,
    readerMsgTs: readerTs || flow?.readerMsgTs,
    messageFullyShown: fullyShown,
    awaitingReplyUser: null
  });

  if (fullyShown) await refreshParentCard(channel, parentTs, emailId);
}

async function handleReplyPrompt(payload) {
  const slack = getSlack();
  const { channel, parentTs } = parentKeyFromPayload(payload) || {};
  const action = payload.actions?.[0];
  const emailId = action?.value;
  const userId = payload.user?.id;
  if (!slack || !channel || !parentTs || !emailId || !userId) return;

  await upsertSlackFlow({
    channel,
    parentTs,
    emailId,
    awaitingReplyUser: userId
  });

  await slack.chat.postMessage({
    channel,
    thread_ts: parentTs,
    text: `<@${userId}> Reply here in the thread with your message (plain text). I'll send it as your email reply.`
  });
}

async function handleReplyAI(payload) {
  const slack = getSlack();
  const { channel, parentTs } = parentKeyFromPayload(payload) || {};
  const action = payload.actions?.[0];
  const emailId = action?.value;
  if (!slack || !channel || !parentTs || !emailId) return;

  let draftText = "";
  try {
    const { draft } = await generateAndSaveDraft(emailId);
    draftText = draft;
  } catch (e) {
    await slack.chat.postMessage({
      channel,
      thread_ts: parentTs,
      text: `Could not generate a draft: ${e.message || e}`
    });
    return;
  }

  const safe = draftText.replace(/```/g, "`\u200b`\u200b`");
  await slack.chat.postMessage({
    channel,
    thread_ts: parentTs,
    text: "AI draft ready",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*AI draft*\n\`\`\`${safe}\`\`\``
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Send this reply" },
            style: "primary",
            action_id: SLACK_ACTION_SEND_AI_DRAFT,
            value: emailId
          }
        ]
      }
    ]
  });
}

async function handleSendAIDraft(payload) {
  const slack = getSlack();
  const { channel, parentTs } = parentKeyFromPayload(payload) || {};
  const action = payload.actions?.[0];
  const emailId = action?.value;
  if (!slack || !channel || !parentTs || !emailId) return;

  const email = await getEmailById(emailId);
  if (!email?.draft) {
    await slack.chat.postMessage({
      channel,
      thread_ts: parentTs,
      text: "No draft on file — generate again with *Reply with AI*."
    });
    return;
  }

  await sendReplyDraft({
    threadId: email.thread_id,
    to: email.sender,
    subject: email.subject,
    bodyText: email.draft
  });
  await markDraftStatus(emailId, "sent");
  await markThreadDraftStatus(email.thread_id, "sent");

  await slack.chat.postMessage({
    channel,
    thread_ts: parentTs,
    text: "✅ Sent via Gmail."
  });
}

async function handleComplete(payload) {
  const slack = getSlack();
  const { channel, parentTs } = parentKeyFromPayload(payload) || {};
  const action = payload.actions?.[0];
  const emailId = action?.value;
  if (!slack || !channel || !parentTs || !emailId) return;

  const email = await getEmailById(emailId);
  if (!email) return;
  if (email.category !== "NEEDS_REPLY") {
    await slack.chat.postMessage({
      channel,
      thread_ts: parentTs,
      text: "Complete only applies to Needs reply items."
    });
    return;
  }

  await markDraftStatus(emailId, "completed");
  await markThreadDraftStatus(email.thread_id, "completed");
  await removeSlackFlow(channel, parentTs);

  await slack.chat.update({
    channel,
    ts: parentTs,
    text: `✅ Completed: ${email.subject}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*✅ Completed*\n*From:* ${email.sender}\n*Subject:* ${email.subject}`
        }
      }
    ]
  });
}

async function processBlockAction(payload) {
  const action = payload.actions?.[0];
  const id = action?.action_id;
  if (!id) return;

  switch (id) {
    case SLACK_ACTION_SEE_MESSAGE:
      await handleSeeMessage(payload);
      break;
    case SLACK_ACTION_CONTINUE_READ:
      await handleContinueRead(payload);
      break;
    case SLACK_ACTION_REPLY:
      await handleReplyPrompt(payload);
      break;
    case SLACK_ACTION_REPLY_AI:
      await handleReplyAI(payload);
      break;
    case SLACK_ACTION_SEND_AI_DRAFT:
      await handleSendAIDraft(payload);
      break;
    case SLACK_ACTION_COMPLETE:
      await handleComplete(payload);
      break;
    default:
      break;
  }
}

export async function handleSlackActions(req, res) {
  const signingSecret = (process.env.SLACK_SIGNING_SECRET || "").trim();
  const sig = req.headers["x-slack-signature"];
  const ts = req.headers["x-slack-request-timestamp"];
  const raw = req.slackRawBody ?? "";
  if (!verifySlackRequest(signingSecret, sig, ts, raw)) {
    console.warn("[slack] actions: invalid signature (check SLACK_SIGNING_SECRET matches Slack app)");
    return res.status(401).send("Invalid signature");
  }

  let payload;
  try {
    payload = JSON.parse(req.body?.payload || "{}");
  } catch {
    return res.status(400).send("Bad payload");
  }

  res.status(200).send("");

  try {
    if (payload.type === "block_actions") await processBlockAction(payload);
  } catch (err) {
    console.error("[slack] actions:", err.message || err);
  }
}

export async function handleSlackEvents(req, res) {
  try {
    const signingSecret = (process.env.SLACK_SIGNING_SECRET || "").trim();
    const sig = req.headers["x-slack-signature"];
    const ts = req.headers["x-slack-request-timestamp"];
    const raw = req.slackRawBody ?? "";
    if (!signingSecret) {
      console.warn("[slack] events: SLACK_SIGNING_SECRET is missing in env");
      return res.status(401).send("Missing signing secret");
    }
    if (!verifySlackRequest(signingSecret, sig, ts, raw)) {
      console.warn("[slack] events: invalid signature (check SLACK_SIGNING_SECRET matches Slack app)");
      return res.status(401).send("Invalid signature");
    }

    const body = req.slackJson || req.body;
    if (!body || typeof body !== "object") {
      return res.status(400).send("Bad JSON");
    }

    if (body.type === "url_verification") {
      const ch = body.challenge;
      if (typeof ch !== "string" || !ch.length) {
        return res.status(400).send("Missing challenge");
      }
      return res.status(200).type("application/json").send(JSON.stringify({ challenge: ch }));
    }

    res.status(200).send("");

    if (body.event?.type !== "message" || body.event?.subtype) return;

    const ev = body.event;
    const text = typeof ev.text === "string" ? ev.text.trim() : "";
    if (!text || !ev.user || !ev.channel || !ev.thread_ts) return;

    getSlackBotUserId()
      .then(async (botId) => {
        if (botId && ev.user === botId) return;

        const flow = await getSlackFlow(ev.channel, ev.thread_ts);
        if (!flow?.awaitingReplyUser || flow.awaitingReplyUser !== ev.user) return;
        if (!flow.emailId) return;

        const email = await getEmailById(flow.emailId);
        if (!email) {
          await upsertSlackFlow({ ...flow, awaitingReplyUser: null });
          return;
        }

        const slack = getSlack();
        try {
          await sendReplyDraft({
            threadId: email.thread_id,
            to: email.sender,
            subject: email.subject,
            bodyText: text
          });
          await markDraftStatus(flow.emailId, "sent");
          await markThreadDraftStatus(email.thread_id, "sent");
          await upsertSlackFlow({ ...flow, awaitingReplyUser: null });
          if (slack) {
            await slack.chat.postMessage({
              channel: ev.channel,
              thread_ts: ev.thread_ts,
              text: "✅ Your reply was sent via Gmail."
            });
          }
        } catch (err) {
          if (slack) {
            await slack.chat.postMessage({
              channel: ev.channel,
              thread_ts: ev.thread_ts,
              text: `Could not send: ${err.message || err}`
            });
          }
        }
      })
      .catch((err) => console.error("[slack] events:", err.message || err));
  } catch (err) {
    console.error("[slack] events handler:", err.message || err);
    if (!res.headersSent) {
      return res.status(500).send("Internal error");
    }
  }
}

router.post("/digest", async (req, res) => {
  try {
    if (!slackEnabled()) return res.status(400).json({ error: "Slack not configured" });
    const all = await getAllEmails();
    const lanes = computeDashboardLanes(all);
    const needsReply = lanes.NEEDS_REPLY;
    const waitingNudges = await getWaitingOlderThan(3);

    const blocks = [
      {
        type: "header",
        text: { type: "plain_text", text: "📬 InboxPilot Morning Brief" }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            `*Needs Reply:* ${lanes.NEEDS_REPLY.length}\n` +
            `*Noise:* ${lanes.NOISE.length}\n` +
            `*Done:* ${lanes.REPLIED.length}`
        }
      }
    ];

    if (needsReply.length) {
      blocks.push({ type: "divider" });
      for (const email of needsReply) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Needs Reply*\nFrom: ${email.sender}\nSubject: ${email.subject}`
          },
          accessory: {
            type: "button",
            text: { type: "plain_text", text: "View Draft" },
            url: "http://localhost:5173"
          }
        });
      }
    }

    if (waitingNudges.length) {
      blocks.push({ type: "divider" });
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: "*Follow-up nudges (Waiting > 3 days)*" }
      });
      for (const email of waitingNudges) {
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: `• ${email.subject} (${email.sender}) might need a follow-up.` }
        });
      }
    }

    await postDigest(blocks);
    for (const email of needsReply) {
      await postNeedsReplyInteractive(email);
    }
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: "Failed to send Slack digest", detail: error.message });
  }
});

export default router;
