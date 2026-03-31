import { useState } from "react";
import { createPortal } from "react-dom";
import DraftPanel from "./DraftPanel";
import ThreadViewer from "./ThreadViewer";

function prettyDate(value) {
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return value || "";
  const now = new Date();
  const diffMs = now - dt;
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 0) return dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return dt.toLocaleDateString([], { weekday: "short" });
  return dt.toLocaleDateString([], { month: "short", day: "numeric" });
}

function senderName(sender) {
  const match = sender?.match(/^([^<]+)</);
  const name = match ? match[1].trim() : sender || "Unknown";
  return name.replace(/"/g, "");
}

/** Email address from `Name <addr@x.com>` or null if not present */
function senderEmail(sender) {
  const match = sender?.match(/<([^>]+)>/);
  return match ? match[1].trim() : null;
}

function senderInitial(sender) {
  const name = senderName(sender);
  return name.charAt(0).toUpperCase();
}

const AVATAR_COLORS = [
  "bg-violet-500", "bg-indigo-500", "bg-sky-500",
  "bg-teal-500", "bg-emerald-500", "bg-amber-500",
  "bg-rose-500", "bg-pink-500",
];

function avatarColor(sender) {
  let hash = 0;
  for (const ch of (sender || "")) hash = (hash * 31 + ch.charCodeAt(0)) & 0xffff;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export default function EmailCard({
  email,
  onSaveDraft,
  onSend,
  onDiscard,
  onComplete,
  onInform,
  onRetriage,
  onGenerateDraft
}) {
  const [showInform, setShowInform] = useState(false);
  const [reason, setReason] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [showFullText, setShowFullText] = useState(false);
  const [showReplyComposer, setShowReplyComposer] = useState(false);

  const showDraft =
    email.category === "NEEDS_REPLY" &&
    email.draft_status !== "discarded" &&
    email.draft_status !== "sent" &&
    email.draft_status !== "completed";
  const currentCategory = email.category === "NEEDS_REPLY" ? "NEEDS_REPLY" : "NOISE";
  const targetCategory = currentCategory === "NEEDS_REPLY" ? "NOISE" : "NEEDS_REPLY";
  const targetLabel = targetCategory === "NEEDS_REPLY" ? "To Do" : "Noise";
  const gmailUrl = email.thread_id
    ? `https://mail.google.com/mail/u/0/#inbox/${email.thread_id}`
    : `https://mail.google.com/mail/u/0/#inbox/${email.id}`;

  return (
    <article className="group rounded-xl border border-white/[0.06] bg-[#1a2030] transition hover:border-white/[0.12] hover:bg-[#1c2435] slide-in">
      <div
        className="w-full cursor-pointer px-4 py-3.5 text-left"
        onClick={() => setExpanded((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
      >
        <div className="flex items-start gap-3">
          <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white ${avatarColor(email.sender)}`}>
            {senderInitial(email.sender)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-sm text-white">
                <span className="font-semibold">{senderName(email.sender)}</span>
                {senderEmail(email.sender) ? (
                  <span className="font-normal text-slate-400">
                    {" "}
                    {"<"}
                    {senderEmail(email.sender)}
                    {">"}
                  </span>
                ) : (
                  email.sender &&
                  !email.sender.includes("<") && (
                    <span className="font-normal text-slate-400"> {email.sender}</span>
                  )
                )}
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRetriage(email.id);
                    }}
                    title="Re-triage email"
                    aria-label="Re-triage email"
                    className="inline-flex h-5 w-5 items-center justify-center rounded border border-white/10 bg-white/5 text-[10px] font-bold text-slate-300 opacity-0 transition group-hover:opacity-100 hover:border-indigo-400/60 hover:text-indigo-300"
                  >
                    ↻
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowInform((v) => !v);
                    }}
                    title="Report misclassification"
                    aria-label="Report misclassification"
                    className={`inline-flex h-5 w-5 items-center justify-center rounded border text-[10px] font-bold transition
                    ${showInform
                      ? "border-amber-400/60 bg-amber-400/20 text-amber-200"
                      : "border-white/10 bg-white/5 text-slate-400 opacity-0 group-hover:opacity-100 hover:border-amber-400/50 hover:text-amber-300"
                    }`}
                  >
                    !
                  </button>
                <div className="text-right text-xs text-slate-500">{prettyDate(email.date)}</div>
              </div>
            </div>
            <div className="mt-0.5 truncate text-xs text-slate-400">
              {email.subject || "(No subject)"}
            </div>
            {!expanded && (
              currentCategory === "NEEDS_REPLY" ? (
                <p className="mt-1 line-clamp-1 text-xs text-slate-500">
                  {`InboxPilot says: ${email.summary || email.snippet || ""}`}
                </p>
              ) : null
            )}
          </div>
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4">
          {currentCategory === "NEEDS_REPLY" && (
            <>
              <p className="mb-1 text-sm font-semibold text-indigo-300 leading-relaxed">
                InboxPilot says:
              </p>
              <p className="mb-3 text-sm text-slate-300 leading-relaxed">
                {email.summary || email.snippet || "No summary available."}
              </p>
            </>
          )}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <button
              onClick={() => setShowFullText((v) => !v)}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:bg-white/5 transition"
            >
              {showFullText
                ? email.thread_id
                  ? "Hide conversation"
                  : "Hide Full Text"
                : email.thread_id
                  ? "Show conversation"
                  : "Show Full Text"}
            </button>
            <a
              href={gmailUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-3 py-1.5 text-xs font-medium text-indigo-300 hover:bg-indigo-500/20 transition"
            >
              Open in Gmail
            </a>
            {showDraft && !showReplyComposer && (
              <>
                <button
                  onClick={() => setShowReplyComposer(true)}
                  className="rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-3 py-1.5 text-xs font-medium text-indigo-200 hover:bg-indigo-500/20 transition"
                >
                  Reply
                </button>
                <button
                  type="button"
                  onClick={() => onComplete(email.id)}
                  className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-500/20 transition"
                  title="Moved to Done without sending a reply"
                >
                  Complete
                </button>
              </>
            )}
          </div>
          {showFullText &&
            (email.thread_id ? (
              <div className="mb-3">
                <ThreadViewer threadId={email.thread_id} />
              </div>
            ) : (
              <div className="mb-3 max-h-64 overflow-auto rounded-lg border border-white/10 bg-[#0c0e14] p-3 text-xs leading-relaxed text-slate-300 whitespace-pre-wrap">
                {email.body || "No full text available."}
              </div>
            ))}
          {showDraft && showReplyComposer && (
            <div className="mt-1">
              <DraftPanel
                email={email}
                onSaveDraft={onSaveDraft}
                onSend={onSend}
                onDiscard={onDiscard}
                onGenerate={onGenerateDraft}
              />
            </div>
          )}
        </div>
      )}

      {showInform &&
        createPortal(
          <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 px-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="inform-modal-title"
            onClick={() => {
              setShowInform(false);
              setReason("");
            }}
          >
            <div
              className="w-full max-w-md rounded-xl border border-white/10 bg-[#171b27] p-4 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <p id="inform-modal-title" className="mb-2 text-sm font-semibold text-white">
                Move to {targetLabel}
              </p>
              {email.classification_reason ? (
                <div className="mb-3 rounded-lg border border-white/[0.06] bg-[#0c0e14] px-3 py-2.5">
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                    Why it was sorted here
                  </p>
                  <p className="text-xs leading-relaxed text-slate-300">{email.classification_reason}</p>
                </div>
              ) : null}
              <p className="mb-3 text-xs text-slate-400">
                Optional reason to improve future triage behavior.
              </p>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Optional reason (e.g. poshmark, ad)"
                className="w-full min-h-[90px] rounded-lg border border-white/10 bg-[#0c0e14] px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none"
              />
              <div className="mt-3 flex justify-end gap-2">
                <button
                  onClick={() => {
                    setShowInform(false);
                    setReason("");
                  }}
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-slate-300 hover:bg-white/5 transition"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    onInform(email.id, targetCategory, reason || `${targetLabel.toLowerCase()} recategorization`);
                    setShowInform(false);
                    setReason("");
                  }}
                  className="rounded-lg bg-amber-400 px-3 py-1.5 text-sm font-semibold text-amber-950 hover:bg-amber-300 transition"
                >
                  Move
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {expanded && email.draft_status === "sent" && (
        <div className="mx-4 mb-4 flex items-center gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-300">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
          Reply sent
        </div>
      )}
      {expanded && email.draft_status === "completed" && (
        <div className="mx-4 mb-4 flex items-center gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-300">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
          Marked complete
        </div>
      )}
      {expanded && email.draft_status === "discarded" && (
        <div className="mx-4 mb-4 flex items-center gap-2 rounded-lg border border-slate-500/25 bg-slate-500/10 px-3 py-2 text-xs font-medium text-slate-400">
          <span className="h-1.5 w-1.5 rounded-full bg-slate-500"></span>
          Draft discarded
        </div>
      )}

    </article>
  );
}
