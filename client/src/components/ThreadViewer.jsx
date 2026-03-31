import { useEffect, useState } from "react";
import DOMPurify from "dompurify";
import { api } from "../api";

function prettyDate(value) {
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return value || "";
  return dt.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function senderName(sender) {
  const match = sender?.match(/^([^<]+)</);
  const name = match ? match[1].trim() : sender || "Unknown";
  return name.replace(/"/g, "");
}

function formatBytes(n) {
  if (n == null || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

let purifyHooksReady = false;
function ensurePurifyHooks() {
  if (purifyHooksReady) return;
  DOMPurify.addHook("uponSanitizeAttribute", (_node, data) => {
    if (data.attrName === "style" && data.attrValue) {
      let v = data.attrValue
        .replace(/color\s*:\s*[^;]+;?/gi, "")
        .replace(/background(?:-color)?\s*:\s*[^;]+;?/gi, "")
        .replace(/;\s*;/g, ";")
        .replace(/^;+|;+$/g, "")
        .trim();
      if (!v) data.keepAttr = false;
      else data.attrValue = v;
    }
    if (data.attrName === "color" || data.attrName === "bgcolor") {
      data.keepAttr = false;
    }
  });
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A" && node.getAttribute("target") === "_blank") {
      node.setAttribute("rel", "noopener noreferrer");
    }
  });
  purifyHooksReady = true;
}

function sanitizeEmailHtml(html) {
  ensurePurifyHooks();
  if (!html) return "";
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ["target", "rel", "class", "id", "align", "valign", "border", "cellpadding", "cellspacing"],
    FORBID_TAGS: ["font"]
  });
}

const AVATAR_COLORS = [
  "bg-violet-500",
  "bg-indigo-500",
  "bg-sky-500",
  "bg-teal-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-pink-500"
];

function avatarColor(sender) {
  let hash = 0;
  for (const ch of sender || "") hash = (hash * 31 + ch.charCodeAt(0)) & 0xffff;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function senderInitial(sender) {
  return senderName(sender).charAt(0).toUpperCase();
}

export default function ThreadViewer({ threadId }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: null, data: null });
    api
      .getThread(threadId)
      .then((data) => {
        if (!cancelled) setState({ loading: false, error: null, data });
      })
      .catch((err) => {
        if (!cancelled) setState({ loading: false, error: err.message || "Failed to load thread", data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  if (state.loading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-[#0c0e14] px-3 py-4 text-sm text-slate-400">
        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-500 border-t-indigo-400" />
        Loading conversation…
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-3 text-sm text-rose-200">
        {state.error}
      </div>
    );
  }

  const messages = state.data?.messages || [];
  if (messages.length === 0) {
    return (
      <div className="rounded-lg border border-white/10 bg-[#0c0e14] px-3 py-3 text-sm text-slate-400">
        No messages in this thread.
      </div>
    );
  }

  const threadSubject = messages[0]?.subject || "(No subject)";

  return (
    <div className="space-y-3">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{threadSubject}</p>
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={`overflow-hidden rounded-xl border ${
            msg.isSent ? "border-indigo-500/25 bg-indigo-500/[0.06]" : "border-white/[0.08] bg-[#0c0e14]"
          }`}
        >
          <div className="flex items-start gap-3 border-b border-white/[0.06] px-3 py-2.5">
            <div
              className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${avatarColor(msg.from)}`}
            >
              {senderInitial(msg.from)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="truncate text-sm font-semibold text-slate-100">{senderName(msg.from)}</span>
                <span className="shrink-0 text-xs text-slate-500">{prettyDate(msg.date)}</span>
              </div>
              {msg.to ? <div className="mt-0.5 truncate text-xs text-slate-500">To: {msg.to}</div> : null}
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {msg.isSent ? (
                  <span className="rounded border border-indigo-400/40 bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-200">
                    Sent
                  </span>
                ) : null}
              </div>
            </div>
          </div>
          <div className="max-h-[min(70vh,560px)] overflow-auto px-3 py-3">
            {msg.html ? (
              <div
                className="email-html-body"
                dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(msg.html) }}
              />
            ) : (
              <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-slate-300">
                {msg.plain || msg.snippet || "(Empty message)"}
              </pre>
            )}
            {msg.attachments?.length > 0 ? (
              <ul className="mt-3 space-y-1.5 border-t border-white/[0.06] pt-3">
                <li className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Attachments</li>
                {msg.attachments.map((a) => (
                  <li key={`${msg.id}-${a.attachmentId}`}>
                    <a
                      href={api.attachmentUrl(msg.id, a.attachmentId, {
                        filename: a.filename,
                        mime: a.mimeType
                      })}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-indigo-300 underline decoration-indigo-400/50 underline-offset-2 hover:text-indigo-200"
                    >
                      {a.filename}
                    </a>
                    {a.size ? (
                      <span className="ml-2 text-xs text-slate-500">({formatBytes(a.size)})</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
