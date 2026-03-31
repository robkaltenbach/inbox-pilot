import Datastore from "nedb-promises";

const emails = Datastore.create({ filename: "data/emails.db", autoload: true });
const tokens = Datastore.create({ filename: "data/tokens.db", autoload: true });
const feedback = Datastore.create({ filename: "data/feedback.db", autoload: true });
const settingsDb = Datastore.create({ filename: "data/settings.db", autoload: true });
const slackFlows = Datastore.create({ filename: "data/slack_flows.db", autoload: true });

emails.ensureIndex({ fieldName: "id", unique: true });
slackFlows.ensureIndex({ fieldName: "key", unique: true });
tokens.ensureIndex({ fieldName: "key", unique: true });
settingsDb.ensureIndex({ fieldName: "key", unique: true });

const TOKEN_KEY = "google_oauth";
const WATCH_KEY = "gmail_watch_state";

export async function getTokenRow() {
  return tokens.findOne({ key: TOKEN_KEY });
}

export async function upsertTokens({ access_token, refresh_token, expiry_date }) {
  const existing = await getTokenRow();
  const next = {
    key: TOKEN_KEY,
    access_token,
    refresh_token: refresh_token || existing?.refresh_token || null,
    expiry_date: expiry_date ?? null,
    updated_at: new Date().toISOString()
  };
  await tokens.update({ key: TOKEN_KEY }, { $set: next }, { upsert: true });
}

export async function clearTokens() {
  await tokens.remove({ key: TOKEN_KEY }, { multi: false });
}

export async function getWatchState() {
  return tokens.findOne({ key: WATCH_KEY });
}

export async function upsertWatchState({
  last_history_id,
  watch_expiration,
  email_address,
  source
}) {
  const next = {
    key: WATCH_KEY,
    last_history_id: String(last_history_id || ""),
    watch_expiration: watch_expiration ? Number(watch_expiration) : null,
    email_address: email_address || null,
    source: source || "unknown",
    updated_at: new Date().toISOString()
  };
  await tokens.update({ key: WATCH_KEY }, { $set: next }, { upsert: true });
}

export async function upsertEmail(email) {
  const doc = {
    ...email,
    draft_status: "pending",
    created_at: new Date().toISOString()
  };
  try {
    await emails.insert(doc);
    return true;
  } catch {
    return false;
  }
}

export async function updateEmailRaw(id, email) {
  await emails.update(
    { id },
    {
      $set: {
        thread_id: email.thread_id,
        sender: email.sender,
        subject: email.subject,
        snippet: email.snippet,
        body: email.body,
        date: email.date
      }
    }
  );
}

export async function updateEmailAnalysis(id, { category, summary, draft, classification_reason }) {
  const existing = await getEmailById(id);
  const lockedStatus =
    existing?.draft_status === "sent" ||
    existing?.draft_status === "discarded" ||
    existing?.draft_status === "completed"
      ? existing.draft_status
      : null;

  const $set = {
    category,
    summary,
    draft: draft ?? null,
    draft_status: lockedStatus ?? (draft ? "pending" : null)
  };
  if (classification_reason !== undefined) {
    $set.classification_reason = classification_reason;
  }

  await emails.update({ id }, { $set });
}

export async function setEmailManualOverride(id, { category, reason }) {
  await emails.update(
    { id },
    {
      $set: {
        category,
        manual_override: true,
        manual_override_reason: reason,
        manual_override_at: new Date().toISOString()
      }
    }
  );
}

export async function clearEmailManualOverride(id) {
  await emails.update(
    { id },
    {
      $unset: {
        manual_override: true,
        manual_override_reason: true,
        manual_override_at: true
      }
    }
  );
}

export async function updateDraft(id, draft) {
  await emails.update({ id }, { $set: { draft, draft_status: "pending" } });
}

export async function markDraftStatus(id, status) {
  await emails.update({ id }, { $set: { draft_status: status } });
}

export async function markThreadDraftStatus(threadId, status) {
  if (!threadId) return;
  await emails.update({ thread_id: threadId }, { $set: { draft_status: status } }, { multi: true });
}

export async function getEmailById(id) {
  return emails.findOne({ id });
}

export async function removeEmailById(id) {
  await emails.remove({ id }, { multi: false });
}

export async function getAllEmails() {
  return emails.find({}).sort({ date: -1 });
}

export async function getNeedsReplyEmails() {
  return emails.find({ category: "NEEDS_REPLY", draft_status: "pending" }).sort({ date: -1 });
}

export async function getWaitingOlderThan(days) {
  const threshold = Date.now() - days * 24 * 60 * 60 * 1000;
  const waiting = await emails.find({ category: "WAITING" });
  return waiting.filter((email) => {
    const ts = new Date(email.date || 0).getTime();
    return Number.isFinite(ts) && ts < threshold;
  });
}

export async function getCategoryCounts() {
  const all = await emails.find({});
  const base = { NEEDS_REPLY: 0, FYI: 0, WAITING: 0, NOISE: 0 };
  for (const email of all) {
    if (email.category && base[email.category] !== undefined) base[email.category] += 1;
  }
  return base;
}

export async function addClassificationFeedback(entry) {
  return feedback.insert({
    ...entry,
    created_at: new Date().toISOString()
  });
}

export async function getRecentFeedback(limit = 40) {
  return feedback.find({}).sort({ created_at: -1 }).limit(limit);
}

const SLACK_NOTIFY_SETTINGS_KEY = "slack_notify";

const DEFAULT_SLACK_NOTIFY = {
  notifyCategories: ["NEEDS_REPLY"],
  subjectContainsPhrases: []
};

export async function getSlackNotifySettings() {
  const row = await settingsDb.findOne({ key: SLACK_NOTIFY_SETTINGS_KEY });
  const v = row?.value;
  if (!v || typeof v !== "object") {
    return { notifyCategories: [...DEFAULT_SLACK_NOTIFY.notifyCategories], subjectContainsPhrases: [] };
  }
  const categories = Array.isArray(v.notifyCategories)
    ? [...new Set(v.notifyCategories.map((c) => String(c).toUpperCase()).filter((c) => c === "NEEDS_REPLY" || c === "NOISE"))]
    : [];
  const phrases = Array.isArray(v.subjectContainsPhrases)
    ? v.subjectContainsPhrases.map((p) => String(p).trim()).filter(Boolean)
    : [];
  return {
    notifyCategories: categories,
    subjectContainsPhrases: phrases
  };
}

/** Slack triage thread state: key = `${channel}:${parentTs}` (parent = root card message). */
export async function getSlackFlow(channel, parentTs) {
  const key = `${channel}:${parentTs}`;
  return slackFlows.findOne({ key });
}

export async function upsertSlackFlow(partial) {
  const { channel, parentTs } = partial;
  if (!channel || !parentTs) throw new Error("upsertSlackFlow requires channel and parentTs");
  const key = `${channel}:${parentTs}`;
  const existing = (await slackFlows.findOne({ key })) || {};
  const next = {
    ...existing,
    ...partial,
    key,
    updated_at: new Date().toISOString()
  };
  await slackFlows.update({ key }, { $set: next }, { upsert: true });
  return next;
}

export async function removeSlackFlow(channel, parentTs) {
  await slackFlows.remove({ key: `${channel}:${parentTs}` }, { multi: false });
}

export async function setSlackNotifySettings({ notifyCategories, subjectContainsPhrases }) {
  const cur = await getSlackNotifySettings();
  const next = {
    notifyCategories:
      notifyCategories !== undefined
        ? [...new Set(notifyCategories.map((c) => String(c).toUpperCase()).filter((c) => c === "NEEDS_REPLY" || c === "NOISE"))]
        : cur.notifyCategories,
    subjectContainsPhrases:
      subjectContainsPhrases !== undefined
        ? subjectContainsPhrases.map((p) => String(p).trim()).filter(Boolean)
        : cur.subjectContainsPhrases
  };
  await settingsDb.update(
    { key: SLACK_NOTIFY_SETTINGS_KEY },
    {
      $set: {
        key: SLACK_NOTIFY_SETTINGS_KEY,
        value: next,
        updated_at: new Date().toISOString()
      }
    },
    { upsert: true }
  );
  return next;
}
