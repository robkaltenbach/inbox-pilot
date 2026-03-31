const toJson = async (resp) => {
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.detail ? `${data.error}: ${data.detail}` : data.error || "Request failed");
  return data;
};

export const api = {
  authStatus: () => fetch("/auth/status").then(toJson),
  authConnections: () => fetch("/auth/connections").then(toJson),
  disconnectGmail: () =>
    fetch("/auth/disconnect", {
      method: "POST"
    }).then(toJson),
  fetchAndTriage: () => fetch("/api/emails/fetch").then(toJson),
  fetchStatus: () => fetch("/api/emails/fetch-status").then(toJson),
  listEmails: () => fetch("/api/emails").then(toJson),
  getThread: (threadId) => fetch(`/api/emails/thread/${encodeURIComponent(threadId)}`).then(toJson),
  attachmentUrl: (messageId, attachmentId, { filename = "file", mime = "application/octet-stream" } = {}) => {
    const q = new URLSearchParams({ filename, mime });
    return `/api/emails/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}?${q}`;
  },
  updateDraft: (id, draft) =>
    fetch(`/api/emails/${id}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft })
    }).then(toJson),
  generateDraft: (id) =>
    fetch(`/api/emails/${id}/draft/generate`, {
      method: "POST"
    }).then(toJson),
  sendDraft: (id) =>
    fetch(`/api/emails/${id}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "send" })
    }).then(toJson),
  discardDraft: (id) =>
    fetch(`/api/emails/${id}/discard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "discard" })
    }).then(toJson),
  markComplete: (id) =>
    fetch(`/api/emails/${id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "complete" })
    }).then(toJson),
  informClassification: (id, correctCategory, reason) =>
    fetch(`/api/emails/${id}/inform`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ correctCategory, reason })
    }).then(toJson),
  removeFromInboxPilot: (id) =>
    fetch(`/api/emails/${id}/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "remove" })
    }).then(toJson),
  retriageEmail: (id) =>
    fetch(`/api/emails/${id}/retriage`, {
      method: "POST"
    }).then(toJson),
  sendSlackDigest: () =>
    fetch("/api/slack/digest", {
      method: "POST"
    }).then(toJson),
  getSlackNotifySettings: () => fetch("/api/settings/slack-notify").then(toJson),
  saveSlackNotifySettings: (body) =>
    fetch("/api/settings/slack-notify", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(toJson)
};
