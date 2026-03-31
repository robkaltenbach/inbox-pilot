import { google } from "googleapis";
import { getTokenRow, upsertTokens } from "../db.js";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.compose"
];

function decodeHtmlEntities(text = "") {
  return text
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parseHeader(headers, name) {
  const value = headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";
  return decodeHtmlEntities(value);
}

function decodeBase64Url(input = "") {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf-8");
}

function extractPlainText(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return decodeBase64Url(payload.body.data);
  if (payload.parts?.length) {
    for (const part of payload.parts) {
      const text = extractPlainText(part);
      if (text) return text;
    }
  }
  return "";
}

function cleanEmailText(text = "") {
  return text
    .replace(/\r/g, "")
    .replace(/^>.*$/gm, "") // quoted lines
    .replace(/On\s.+?wrote:\s*/gim, "") // classic quoted reply separator
    .replace(/From:.*\nTo:.*\nSubject:.*$/gims, "") // forwarded header chunks
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Strip signatures, forwards, and quoted headers for LLM summarization (does not replace stored body). */
export function stripEmailBoilerplateForLLM(raw = "") {
  let s = String(raw).replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  s = s.replace(/\nSent from my [^\n]+/gi, "\n");
  s = s.replace(/\nSent from Yahoo Mail[^\n]*/gi, "\n");
  s = s.replace(/\nGet Outlook for [^\n]+/gi, "\n");
  s = s.replace(/\nSent from Mail for Windows[^\n]*/gi, "\n");
  s = s.replace(/\nPlease excuse any typos[^\n]*/gi, "\n");
  s = s.replace(/\nConfidentiality Notice:[\s\S]*$/gim, "");
  s = s.replace(/\n_{5,}[\s\S]*$/g, "");

  const forwardBoundary =
    /\n(?:-{3,}\s*Forwarded message\s*-{3,}|_{3,}\s*Forwarded message\s*_{3,}|Begin forwarded message:?\s*\n)/i;
  const origBoundary = /\n-{2,}\s*Original Message\s*-{2,}\s*\n/i;

  let m = s.match(forwardBoundary);
  if (m && m.index !== undefined) {
    const before = s.slice(0, m.index).trim();
    const after = s.slice(m.index + m[0].length);
    if (before.length >= 60) s = before;
    else {
      s = after
        .replace(/^>.*$/gm, "")
        .replace(/^From:\s*.+$/gim, "")
        .replace(/^Sent:\s*.+$/gim, "")
        .replace(/^Date:\s*.+$/gim, "")
        .replace(/^To:\s*.+$/gim, "")
        .replace(/^Subject:\s*.+$/gim, "")
        .replace(/^Cc:\s*.+$/gim, "")
        .trim();
    }
  }

  m = s.match(origBoundary);
  if (m && m.index !== undefined) s = s.slice(0, m.index).trim();

  s = s.replace(/^>.*$/gm, "");
  s = s.replace(/^From:\s.+$/gim, "");
  s = s.replace(/^Date:\s.+$/gim, "");
  s = s.replace(/^To:\s.+$/gim, "");
  s = s.replace(/^Subject:\s.+$/gim, "");
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s.slice(0, 16000);
}

function extractTextFromMessage(message) {
  const payload = message?.payload;
  return cleanEmailText(decodeHtmlEntities(extractPlainText(payload) || message?.snippet || ""));
}

export function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

export function getAuthUrl(state) {
  const oauth2Client = getOAuthClient();
  const options = {
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES
  };
  if (state) options.state = state;
  return oauth2Client.generateAuthUrl(options);
}

export async function exchangeCodeForTokens(code) {
  const oauth2Client = getOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  await upsertTokens(tokens);
  return tokens;
}

export async function getAuthedGmailClient() {
  const tokenRow = await getTokenRow();
  if (!tokenRow) throw new Error("Google account not connected");

  const oauth2Client = getOAuthClient();
  oauth2Client.setCredentials({
    access_token: tokenRow.access_token,
    refresh_token: tokenRow.refresh_token,
    expiry_date: tokenRow.expiry_date
  });

  oauth2Client.on("tokens", async (tokens) => {
    await upsertTokens(tokens);
  });

  if (tokenRow.expiry_date && Date.now() > tokenRow.expiry_date - 60_000) {
    const { credentials } = await oauth2Client.refreshAccessToken();
    await upsertTokens(credentials);
    oauth2Client.setCredentials(credentials);
  }

  return google.gmail({ version: "v1", auth: oauth2Client });
}

export async function fetchUnreadEmails(limit = 50) {
  const gmail = await getAuthedGmailClient();
  const listResp = await gmail.users.messages.list({
    userId: "me",
    maxResults: limit,
    q: "is:unread"
  });

  const messages = listResp.data.messages || [];
  const results = [];

  for (const msg of messages) {
    const detail = await gmail.users.messages.get({
      userId: "me",
      id: msg.id,
      format: "full"
    });
    const payload = detail.data.payload;
    const headers = payload?.headers || [];
    const threadId = detail.data.threadId;
    let threadBody = extractTextFromMessage(detail.data);

    if (threadId) {
      const threadResp = await gmail.users.threads.get({
        userId: "me",
        id: threadId,
        format: "full"
      });
      const threadMessages = threadResp.data.messages || [];
      const combined = threadMessages
        .map((m) => extractTextFromMessage(m))
        .filter(Boolean)
        .join("\n\n---\n\n");
      if (combined) threadBody = combined;
    }

    results.push({
      id: detail.data.id,
      thread_id: threadId,
      sender: parseHeader(headers, "From"),
      subject: parseHeader(headers, "Subject"),
      snippet: decodeHtmlEntities(detail.data.snippet || ""),
      body: threadBody || detail.data.snippet || "",
      date: parseHeader(headers, "Date") || new Date().toISOString()
    });
  }

  return results;
}

export async function fetchEmailById(messageId) {
  const gmail = await getAuthedGmailClient();
  const detail = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full"
  });

  const payload = detail.data.payload;
  const headers = payload?.headers || [];
  const threadId = detail.data.threadId;
  let threadBody = extractTextFromMessage(detail.data);

  if (threadId) {
    const threadResp = await gmail.users.threads.get({
      userId: "me",
      id: threadId,
      format: "full"
    });
    const threadMessages = threadResp.data.messages || [];
    const combined = threadMessages
      .map((m) => extractTextFromMessage(m))
      .filter(Boolean)
      .join("\n\n---\n\n");
    if (combined) threadBody = combined;
  }

  return {
    id: detail.data.id,
    thread_id: threadId,
    sender: parseHeader(headers, "From"),
    subject: parseHeader(headers, "Subject"),
    snippet: decodeHtmlEntities(detail.data.snippet || ""),
    body: threadBody || detail.data.snippet || "",
    date: parseHeader(headers, "Date") || new Date().toISOString()
  };
}

export async function sendReplyDraft({ threadId, to, subject, bodyText }) {
  const gmail = await getAuthedGmailClient();
  const raw = Buffer.from(
    [
      `To: ${to}`,
      `Subject: Re: ${subject || ""}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      bodyText
    ].join("\n")
  )
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw,
      threadId
    }
  });
}

export async function getThreadLatestState(threadId) {
  if (!threadId) return { latestIsSent: false, latest: null };
  const gmail = await getAuthedGmailClient();
  const threadResp = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "full"
  });
  const threadMessages = threadResp.data.messages || [];
  if (!threadMessages.length) return { latestIsSent: false, latest: null };

  const latest = [...threadMessages].sort(
    (a, b) => Number(a.internalDate || 0) - Number(b.internalDate || 0)
  )[threadMessages.length - 1];
  const headers = latest.payload?.headers || [];
  const latestParsed = {
    id: latest.id,
    thread_id: latest.threadId,
    sender: parseHeader(headers, "From"),
    subject: parseHeader(headers, "Subject"),
    snippet: decodeHtmlEntities(latest.snippet || ""),
    body: extractTextFromMessage(latest),
    date: parseHeader(headers, "Date") || new Date(Number(latest.internalDate || Date.now())).toISOString()
  };

  return {
    latestIsSent: (latest.labelIds || []).includes("SENT"),
    latest: latestParsed
  };
}

export async function startInboxWatch(topicName) {
  if (!topicName) throw new Error("Missing GMAIL_PUBSUB_TOPIC");
  const gmail = await getAuthedGmailClient();
  const resp = await gmail.users.watch({
    userId: "me",
    requestBody: {
      topicName,
      labelFilterAction: "include",
      labelIds: ["INBOX"]
    }
  });
  return {
    historyId: String(resp.data.historyId || ""),
    expiration: resp.data.expiration ? Number(resp.data.expiration) : null
  };
}

/** Lightweight label check — avoids triaging drafts / sent-only noise from history. */
export async function getMessageLabelIds(messageId) {
  const gmail = await getAuthedGmailClient();
  const { data } = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "metadata"
  });
  return data.labelIds || [];
}

/** True if this is a real message still in Inbox worth triaging (not a draft compose, not trash/spam). */
export function isMessageEligibleForInboxTriage(labelIds = []) {
  if (!labelIds.includes("INBOX")) return false;
  if (labelIds.includes("DRAFT")) return false;
  if (labelIds.includes("TRASH") || labelIds.includes("SPAM")) return false;
  return true;
}

export async function getNewInboxMessageIdsSince(startHistoryId) {
  if (!startHistoryId) return { messageIds: [], latestHistoryId: null };
  const gmail = await getAuthedGmailClient();
  const ids = new Set();
  let pageToken = undefined;
  let latestHistoryId = String(startHistoryId);

  do {
    const resp = await gmail.users.history.list({
      userId: "me",
      startHistoryId: String(startHistoryId),
      historyTypes: ["messageAdded"],
      labelId: "INBOX",
      maxResults: 200,
      pageToken
    });

    if (resp.data.historyId) latestHistoryId = String(resp.data.historyId);
    for (const entry of resp.data.history || []) {
      for (const item of entry.messagesAdded || []) {
        const id = item?.message?.id;
        if (id) ids.add(id);
      }
    }
    pageToken = resp.data.nextPageToken || undefined;
  } while (pageToken);

  return { messageIds: [...ids], latestHistoryId };
}

function extractHtmlFromPayload(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.parts?.length) {
    const htmlParts = payload.parts.filter((p) => p.mimeType === "text/html");
    for (const part of htmlParts) {
      const inner = extractHtmlFromPayload(part);
      if (inner) return inner;
    }
    for (const part of payload.parts) {
      const inner = extractHtmlFromPayload(part);
      if (inner) return inner;
    }
  }
  return "";
}

/** Keep only the current message body; drop Gmail/Outlook quoted thread (like Gmail’s collapsed reply). */
function stripQuotedHtml(html) {
  if (!html || typeof html !== "string") return "";
  let s = html;
  s = s.replace(/<div[^>]*class="[^"]*gmail_quote[^"]*"[^>]*>[\s\S]*/gi, "");
  s = s.replace(/<div[^>]*class="[^"]*gmail_extra[^"]*"[^>]*>[\s\S]*/gi, "");
  s = s.replace(/<div[^>]*class="[^"]*gmail_attr[^"]*"[^>]*>[\s\S]*/gi, "");
  s = s.replace(/<div[^>]*id="divRplyFwdMsg"[^>]*>[\s\S]*/i, "");
  s = s.replace(/<div[^>]*style="[^"]*border:none;\s*border-top[^"]*"[^>]*>[\s\S]*/i, "");
  s = s.replace(/<div[^>]*style="[^"]*border:none;border-top[^"]*"[^>]*>[\s\S]*/i, "");
  s = s.replace(/<blockquote[^>]*type="cite"[^>]*>[\s\S]*/i, "");
  s = s.replace(/<blockquote[^>]*>[\s\S]*$/i, "");
  return s.trim();
}

function stripQuotedPlainText(text) {
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^>+/.test(line)) break;
    if (/^On .+ wrote:$/i.test(t)) break;
    if (/^On .+ wrote:$/i.test(line)) break;
    if (/^-----Original Message-----$/i.test(t)) break;
    if (/^________________________________$/i.test(t)) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

function gatherAttachments(payload, messageId, out = []) {
  if (!payload) return out;
  if (payload.filename && payload.body?.attachmentId) {
    out.push({
      messageId,
      attachmentId: payload.body.attachmentId,
      filename: decodeHtmlEntities(payload.filename),
      mimeType: payload.mimeType || "application/octet-stream",
      size: payload.body.size || 0
    });
  }
  if (payload.parts?.length) {
    for (const part of payload.parts) {
      gatherAttachments(part, messageId, out);
    }
  }
  return out;
}

/**
 * Full thread for UI: ordered messages with HTML body, plain fallback, Gmail attachment refs (fetch via API proxy).
 */
export async function fetchThreadDetail(threadId) {
  if (!threadId) return { threadId: null, messages: [] };
  const gmail = await getAuthedGmailClient();
  const threadResp = await gmail.users.threads.get({
    userId: "me",
    id: threadId,
    format: "full"
  });
  const threadMessages = threadResp.data.messages || [];
  const sorted = [...threadMessages].sort(
    (a, b) => Number(a.internalDate || 0) - Number(b.internalDate || 0)
  );

  const messages = [];
  for (const m of sorted) {
    const id = m.id;
    const headers = m.payload?.headers || [];
    const from = parseHeader(headers, "From");
    const to = parseHeader(headers, "To");
    const subject = parseHeader(headers, "Subject");
    const date =
      parseHeader(headers, "Date") || new Date(Number(m.internalDate || Date.now())).toISOString();
    const labels = m.labelIds || [];
    const htmlRaw = extractHtmlFromPayload(m.payload);
    const plainRaw = extractPlainText(m.payload) || "";
    const htmlStripped = htmlRaw ? stripQuotedHtml(htmlRaw) : "";
    const plainStripped = stripQuotedPlainText(plainRaw) || plainRaw;
    const html = htmlStripped.length > 0 ? htmlStripped : htmlRaw || null;
    const plain = plainStripped.length > 0 ? plainStripped : plainRaw;
    const attachments = gatherAttachments(m.payload, id, []);

    messages.push({
      id,
      threadId: m.threadId || threadId,
      internalDate: Number(m.internalDate || 0),
      from,
      to,
      subject,
      date,
      snippet: decodeHtmlEntities(m.snippet || ""),
      html: html || null,
      plain: plain || null,
      labels,
      isSent: labels.includes("SENT"),
      attachments
    });
  }

  return { threadId, messages };
}

export async function getAttachmentBuffer(messageId, attachmentId) {
  const gmail = await getAuthedGmailClient();
  const res = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId,
    id: attachmentId
  });
  const raw = res.data.data;
  if (!raw) return { buffer: Buffer.alloc(0), size: 0 };
  const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
  const buffer = Buffer.from(normalized, "base64");
  return { buffer, size: res.data.size ?? buffer.length };
}
