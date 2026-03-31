import { useState } from "react";

export default function DraftPanel({ email, onSaveDraft, onSend, onDiscard, onGenerate }) {
  const [draft, setDraft] = useState(email.draft || "");
  const [generating, setGenerating] = useState(false);
  const [generateMessage, setGenerateMessage] = useState("");
  const [generateError, setGenerateError] = useState("");

  async function handleGenerate() {
    setGenerateError("");
    setGenerateMessage("");
    setGenerating(true);
    try {
      const nextDraft = await onGenerate(email.id);
      if (typeof nextDraft === "string" && nextDraft.trim()) {
        setDraft(nextDraft);
        setGenerateMessage("Draft generated. Review before sending.");
      } else {
        setGenerateError("AI did not return draft text. Try again.");
      }
    } catch (error) {
      setGenerateError(error?.message || "Failed to generate draft.");
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-4 slide-in">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-indigo-400"></span>
          <span className="text-xs font-semibold uppercase tracking-widest text-indigo-300">
            Reply Draft
          </span>
        </div>
        <button
          onClick={handleGenerate}
          disabled={generating}
          className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-3 py-1.5 text-xs font-medium text-indigo-200 hover:bg-indigo-500/20 disabled:opacity-50 transition"
          title="Generate draft text with AI (does not send)"
        >
          <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth="1.7">
            <path d="M10 3l1.6 3.8L15 8.4l-3.4 1.6L10 14l-1.6-4L5 8.4l3.4-1.6L10 3z" />
          </svg>
          {generating ? "Generating..." : "Generate with AI"}
        </button>
      </div>
      <p className="mb-2 text-[11px] text-slate-500">Generates draft text only. You still click Send Reply manually.</p>
      <textarea
        className="w-full min-h-[120px] resize-y rounded-lg border border-white/10 bg-[#0c0e14] p-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/40 transition"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Reply to sender..."
      />
      {generateMessage && <p className="mt-2 text-xs text-emerald-300">{generateMessage}</p>}
      {generateError && <p className="mt-2 text-xs text-rose-300">{generateError}</p>}
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={() => onSend(email.id, draft)}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 transition"
        >
          Send Reply
        </button>
        <button
          onClick={() => onSaveDraft(email.id, draft)}
          className="rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-slate-300 hover:bg-white/10 transition"
        >
          Save Draft
        </button>
        <button
          onClick={() => onDiscard(email.id)}
          className="ml-auto rounded-lg px-3 py-2 text-sm font-medium text-rose-400 hover:bg-rose-500/10 transition"
        >
          Discard
        </button>
      </div>
    </div>
  );
}
