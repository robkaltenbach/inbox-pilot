import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, ChevronDown, ListTodo, SquareArrowOutUpRight, VolumeX } from "lucide-react";
import { api } from "./api";
import EmailCard from "./components/EmailCard";
import FetchTriageButton from "./components/FetchTriageButton";
import LanePieChart from "./components/LanePieChart";

const CATEGORIES = ["NEEDS_REPLY", "NOISE", "REPLIED"];

const LANE_META = {
  NEEDS_REPLY: {
    label: "To Do",
    Icon: ListTodo,
    iconClass: "text-rose-400",
    badge: "bg-rose-500/15 text-rose-300 border-rose-500/25",
    accent: "border-l-rose-500",
  },
  NOISE: {
    label: "Noise",
    Icon: VolumeX,
    iconClass: "text-slate-500",
    badge: "bg-slate-500/15 text-slate-400 border-slate-500/25",
    accent: "border-l-slate-600",
  },
  REPLIED: {
    label: "Done",
    Icon: CheckCircle2,
    iconClass: "text-emerald-400",
    badge: "bg-emerald-500/15 text-emerald-300 border-emerald-500/25",
    accent: "border-l-emerald-500",
  },
};

export default function App() {
  const [emails, setEmails] = useState([]);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fetchBusy, setFetchBusy] = useState(false);
  const [remoteFetchActive, setRemoteFetchActive] = useState(false);
  const [fetchProgressPct, setFetchProgressPct] = useState(0);
  const [retriageBusy, setRetriageBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const prevRemoteFetchRef = useRef(false);
  const [selectedCategory, setSelectedCategory] = useState("NEEDS_REPLY");
  const [searchQuery, setSearchQuery] = useState("");
  const [lastFetchAt, setLastFetchAt] = useState(null);
  const [slackNotifyCategories, setSlackNotifyCategories] = useState(["NEEDS_REPLY"]);
  const [slackNotifyPhrases, setSlackNotifyPhrases] = useState("");
  const [slackNotifySaved, setSlackNotifySaved] = useState(false);
  const [outputsOpen, setOutputsOpen] = useState(false);
  const outputsMenuRef = useRef(null);
  const [gmailModalOpen, setGmailModalOpen] = useState(false);
  const [gmailInboxes, setGmailInboxes] = useState([]);

  const grouped = useMemo(() => {
    const map = { NEEDS_REPLY: [], NOISE: [], REPLIED: [] };
    for (const email of emails) {
      if (email.draft_status === "sent" || email.draft_status === "completed") {
        map.REPLIED.push(email);
        continue;
      }
      const key = email.category === "NEEDS_REPLY" ? "NEEDS_REPLY" : "NOISE";
      map[key].push(email);
    }

    // Deduplicate by thread so the dashboard shows one card per conversation.
    for (const key of Object.keys(map)) {
      const byThread = new Map();
      for (const email of map[key]) {
        const threadKey = email.thread_id || email.id;
        const existing = byThread.get(threadKey);
        const emailTs = new Date(email.date || 0).getTime();
        const existingTs = existing ? new Date(existing.date || 0).getTime() : -Infinity;
        if (!existing || emailTs >= existingTs) byThread.set(threadKey, email);
      }
      map[key] = Array.from(byThread.values()).sort(
        (a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime()
      );
    }

    return map;
  }, [emails]);

  const filteredEmails = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return emails.filter((email) => {
      const haystack = [
        email.sender,
        email.subject,
        email.summary,
        email.snippet,
        email.body,
        email.category,
        email.draft
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [emails, searchQuery]);

  async function refresh() {
    const [status, emailData] = await Promise.all([api.authStatus(), api.listEmails()]);
    setConnected(status.connected);
    setEmails(emailData.emails || []);
  }

  useEffect(() => {
    refresh().catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    api
      .getSlackNotifySettings()
      .then((s) => {
        setSlackNotifyCategories(Array.isArray(s.notifyCategories) ? s.notifyCategories : ["NEEDS_REPLY"]);
        setSlackNotifyPhrases(
          Array.isArray(s.subjectContainsPhrases) ? s.subjectContainsPhrases.join(", ") : ""
        );
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!outputsOpen) return;
    const close = (e) => {
      if (outputsMenuRef.current && !outputsMenuRef.current.contains(e.target)) {
        setOutputsOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [outputsOpen]);

  useEffect(() => {
    if (prevRemoteFetchRef.current && !remoteFetchActive) {
      refresh()
        .then(() => setLastFetchAt(new Date()))
        .catch(() => {});
    }
    prevRemoteFetchRef.current = remoteFetchActive;
  }, [remoteFetchActive]);

  useEffect(() => {
    if (!connected) {
      setRemoteFetchActive(false);
      setFetchProgressPct(0);
      return;
    }
    let cancelled = false;
    const poll = () => {
      api
        .fetchStatus()
        .then((s) => {
          if (!cancelled) {
            const on = Boolean(s.active);
            setRemoteFetchActive(on);
            setFetchProgressPct(on && typeof s.progress === "number" ? s.progress : 0);
          }
        })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, 160);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [connected]);

  async function runAction(fn) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err.message || "Action failed");
    } finally {
      setBusy(false);
    }
  }

  async function runFetchPipeline() {
    setFetchBusy(true);
    setError("");
    try {
      await api.fetchAndTriage();
      await refresh();
      setLastFetchAt(new Date());
    } catch (err) {
      setError(err.message || "Fetch failed");
    } finally {
      setFetchBusy(false);
    }
  }

  const visualPipelineActive = fetchBusy || remoteFetchActive || retriageBusy;
  const fetchIndeterminate = retriageBusy && !fetchBusy && !remoteFetchActive;
  const fetchLiquidProgress =
    visualPipelineActive && !fetchIndeterminate ? fetchProgressPct : 0;

  async function openGmailModal() {
    setError("");
    try {
      const data = await api.authConnections();
      setConnected(Boolean(data.connected));
      setGmailInboxes(Array.isArray(data.inboxes) ? data.inboxes : []);
    } catch (err) {
      setError(err.message || "Unable to load Gmail connection details");
      setGmailInboxes([]);
    }
    setGmailModalOpen(true);
  }

  const totalEmails = emails.length;
  const searchActive = searchQuery.trim().length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden pb-9">

      {/* ── Top header ── */}
      <header className="z-30 grid h-14 shrink-0 grid-cols-[16rem_1fr_auto] items-center gap-4 border-b border-white/[0.07] bg-[#0c0e14]/95 px-5 backdrop-blur">
        <div className="flex items-center gap-3">
          <img src="/images/logo.png" alt="InboxPilot" className="h-7 w-auto brightness-0 invert" />
        </div>

        <div
          className="hidden md:flex items-center rounded-lg border border-white/[0.05] bg-white/[0.02] px-3 py-1.5"
          style={{
            WebkitMaskImage: "linear-gradient(to right, black 0%, black 78%, transparent 100%)",
            maskImage: "linear-gradient(to right, black 0%, black 78%, transparent 100%)"
          }}
        >
          <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5 text-slate-500" stroke="currentColor" strokeWidth="1.7">
            <circle cx="9" cy="9" r="5.5" />
            <path d="M13.5 13.5L17 17" strokeLinecap="round" />
          </svg>
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search all triaged emails"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            name="inboxpilot-search"
            className="ml-2 w-full bg-transparent text-xs text-slate-300 placeholder:text-slate-600 outline-none"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="inline-flex h-5 w-5 items-center justify-center rounded text-slate-500 hover:bg-white/[0.06] hover:text-slate-300 transition"
              title="Clear search"
              aria-label="Clear search"
            >
              <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth="1.8">
                <path d="M5 5L15 15M15 5L5 15" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <FetchTriageButton
            active={visualPipelineActive}
            progress={fetchLiquidProgress}
            indeterminate={fetchIndeterminate}
            title={
              retriageBusy && !fetchBusy && !remoteFetchActive
                ? "Re-triaging email…"
                : "Fetch & triage unread mail"
            }
            disabled={!connected || busy || fetchBusy || remoteFetchActive}
            onClick={runFetchPipeline}
          />

          <div className="relative" ref={outputsMenuRef}>
            <button
              type="button"
              onClick={() => setOutputsOpen((v) => !v)}
              title="Outputs & integrations"
              aria-expanded={outputsOpen}
              aria-haspopup="menu"
              className="inline-flex h-9 items-center gap-1 rounded-lg border border-white/[0.07] bg-white/[0.04] px-2.5 text-slate-300 hover:bg-white/[0.08] transition"
            >
              <SquareArrowOutUpRight className="h-4 w-4" strokeWidth={2} aria-hidden />
              <ChevronDown className={`h-3.5 w-3.5 opacity-70 transition ${outputsOpen ? "rotate-180" : ""}`} aria-hidden />
            </button>
            {outputsOpen ? (
              <div
                role="menu"
                className="absolute right-0 top-[calc(100%+6px)] z-[100] w-[min(100vw-2rem,20rem)] rounded-xl border border-white/[0.1] bg-[#141824] p-3 shadow-2xl shadow-black/40"
                onMouseDown={(e) => e.stopPropagation()}
              >
                <p className="mb-2 px-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Outputs
                </p>
                <div className="rounded-lg border border-white/[0.06] bg-[#0e1018] p-3">
                  <p className="text-xs font-semibold text-white">Slack</p>
                  <p className="mt-1 text-[10px] leading-snug text-slate-500">
                    Bot token and channel ID in server env. New mail posts follow rules below.
                  </p>
                  <p className="mt-3 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                    New mail → channel
                  </p>
                  <div className="mt-2 space-y-2">
                    <label className="flex cursor-pointer items-center gap-2 text-[11px] text-slate-400">
                      <input
                        type="checkbox"
                        checked={slackNotifyCategories.includes("NEEDS_REPLY")}
                        onChange={() => {
                          setSlackNotifySaved(false);
                          setSlackNotifyCategories((prev) =>
                            prev.includes("NEEDS_REPLY")
                              ? prev.filter((c) => c !== "NEEDS_REPLY")
                              : [...prev, "NEEDS_REPLY"]
                          );
                        }}
                        className="rounded border-white/20 bg-[#13161f] text-indigo-500"
                      />
                      To Do (needs reply)
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 text-[11px] text-slate-400">
                      <input
                        type="checkbox"
                        checked={slackNotifyCategories.includes("NOISE")}
                        onChange={() => {
                          setSlackNotifySaved(false);
                          setSlackNotifyCategories((prev) =>
                            prev.includes("NOISE") ? prev.filter((c) => c !== "NOISE") : [...prev, "NOISE"]
                          );
                        }}
                        className="rounded border-white/20 bg-[#13161f] text-indigo-500"
                      />
                      Noise
                    </label>
                  </div>
                  <label className="mt-2 block text-[10px] font-medium text-slate-500">
                    Only if subject or sender contains (optional)
                    <input
                      value={slackNotifyPhrases}
                      onChange={(e) => {
                        setSlackNotifySaved(false);
                        setSlackNotifyPhrases(e.target.value);
                      }}
                      placeholder="Comma-separated, e.g. invoice, ACME"
                      className="mt-1 w-full rounded-md border border-white/[0.08] bg-[#13161f] px-2 py-1.5 text-[11px] text-slate-200 placeholder:text-slate-600"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={async () => {
                      setSlackNotifySaved(false);
                      try {
                        await api.saveSlackNotifySettings({
                          notifyCategories: slackNotifyCategories,
                          subjectContainsPhrases: slackNotifyPhrases
                            .split(",")
                            .map((p) => p.trim())
                            .filter(Boolean)
                        });
                        setSlackNotifySaved(true);
                        setTimeout(() => setSlackNotifySaved(false), 2000);
                      } catch (e) {
                        setError(e.message || "Could not save Slack settings");
                      }
                    }}
                    className="mt-2 w-full rounded-lg border border-white/[0.08] bg-white/[0.04] py-1.5 text-[11px] font-medium text-slate-300 hover:bg-white/[0.07]"
                  >
                    Save Slack rules
                  </button>
                  {slackNotifySaved ? (
                    <p className="mt-1.5 text-[10px] text-emerald-500/90">Saved.</p>
                  ) : null}
                  <div className="mt-3 border-t border-white/[0.06] pt-3">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setOutputsOpen(false);
                        runAction(() => api.sendSlackDigest());
                      }}
                      className="w-full rounded-lg border border-indigo-500/35 bg-indigo-500/10 py-2 text-[11px] font-semibold text-indigo-200 hover:bg-indigo-500/15 disabled:opacity-40"
                    >
                      Send digest now
                    </button>
                  </div>
                </div>
                <p className="mt-2 px-0.5 text-[10px] text-slate-600">More outputs — later.</p>
              </div>
            ) : null}
          </div>

          <button
            onClick={openGmailModal}
            title="Gmail connection settings"
            aria-label="Gmail connection settings"
            className="relative inline-flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.12] bg-white/[0.04] hover:bg-white/[0.08] transition"
          >
            <img src="/images/Gmail-logo.png" alt="Gmail" className="h-5 w-auto object-contain" />
            <span
              className={`absolute right-0 top-0 h-2.5 w-2.5 rounded-full border border-[#0c0e14] ${
                connected ? "bg-emerald-400" : "bg-rose-400"
              }`}
            />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">

        {/* ── Sidebar ── */}
        <aside className="w-64 shrink-0 overflow-y-auto border-r border-white/[0.07] bg-[#0e1018] px-3 py-4">
          <p className="mb-3 px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-600">
            Triage
          </p>
          <nav className="space-y-0.5">
            {CATEGORIES.map((category) => {
              const meta = LANE_META[category];
              const LaneIcon = meta.Icon;
              const active = selectedCategory === category;
              const count = grouped[category]?.length || 0;
              return (
                <button
                  key={category}
                  onClick={() => setSelectedCategory(category)}
                  className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition
                    ${active
                      ? "bg-white/[0.07] text-white"
                      : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"
                    }`}
                >
                  <div className="flex items-center gap-2.5">
                    <LaneIcon
                      className={`h-4 w-4 shrink-0 ${meta.iconClass}`}
                      strokeWidth={2}
                      aria-hidden
                    />
                    <span className="font-medium">{meta.label}</span>
                  </div>
                  {count > 0 && (
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${meta.badge}`}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          <div className="mt-6 border-t border-white/[0.06] pt-4">
            <p className="mb-3 px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-600">
              At a glance
            </p>
            <div className="px-1">
              <LanePieChart
                segments={CATEGORIES.map((cat) => ({
                  key: cat,
                  label: LANE_META[cat].label,
                  value: grouped[cat]?.length || 0,
                }))}
              />
            </div>
          </div>

          <div className="mt-4 border-t border-white/[0.06] pt-4 px-3">
            <p className="text-[11px] text-slate-600">
              {totalEmails} message{totalEmails !== 1 ? "s" : ""} total
            </p>
            <p className="mt-1.5 text-[10px] leading-snug text-slate-500">
              {lastFetchAt
                ? `Last fetch ${lastFetchAt.toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}`
                : "Last fetch —"}
            </p>
          </div>
        </aside>

        {/* ── Main content ── */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-[#10131b]">
          <div className="border-b border-white/[0.07] px-6 py-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold text-white">
                    {searchActive ? "Search Results" : LANE_META[selectedCategory].label}
                  </h2>
                  {searchActive && (
                    <div className="inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 text-[11px] text-slate-300">
                      <span className="text-slate-400">you are searching for</span>
                      <span className="font-medium text-white">"{searchQuery}"</span>
                      <button
                        onClick={() => setSearchQuery("")}
                        className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded text-slate-400 hover:bg-white/[0.08] hover:text-slate-200"
                        title="Clear search"
                        aria-label="Clear search"
                      >
                        <svg viewBox="0 0 20 20" fill="none" className="h-3 w-3" stroke="currentColor" strokeWidth="1.8">
                          <path d="M5 5L15 15M15 5L5 15" strokeLinecap="round" />
                        </svg>
                      </button>
                    </div>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-slate-500">
                  {searchActive
                    ? `${filteredEmails.length} result${filteredEmails.length !== 1 ? "s" : ""}`
                    : `${grouped[selectedCategory]?.length || 0} message${
                        grouped[selectedCategory]?.length !== 1 ? "s" : ""
                      }`}
                </p>
              </div>
            </div>
          </div>

          <div className="flex-1 bg-[#11151f] px-6 py-4">
            {notice && (
              <div className="mb-4 flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
                <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4 text-emerald-300" stroke="currentColor" strokeWidth="2">
                  <path d="M4.5 10.5L8 14l7.5-8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {notice}
              </div>
            )}
            {error && (
              <div className="mb-4 flex items-center gap-2 rounded-xl border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
                <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4 text-rose-400" stroke="currentColor" strokeWidth="1.8">
                  <path d="M10 3.5L17 16.5H3L10 3.5z" strokeLinejoin="round" />
                  <path d="M10 7.5v4.5M10 14.5h.01" strokeLinecap="round" />
                </svg>
                {error}
              </div>
            )}

            {(searchActive ? filteredEmails : grouped[selectedCategory] || []).length > 0 ? (
              <div className={`rounded-xl border border-white/[0.05] bg-[#151a26] p-3 border-l-2 pl-4 space-y-2 ${LANE_META[selectedCategory].accent}`}>
                {(searchActive ? filteredEmails : grouped[selectedCategory] || []).map((email) => (
                  <EmailCard
                    key={email.id}
                    email={email}
                    onSaveDraft={(id, draft) => runAction(() => api.updateDraft(id, draft))}
                    onSend={(id, draft) =>
                      runAction(async () => {
                        await api.updateDraft(id, draft);
                        await api.sendDraft(id);
                      })
                    }
                    onDiscard={(id) => runAction(() => api.discardDraft(id))}
                    onGenerateDraft={async (id) => {
                      const data = await api.generateDraft(id);
                      return data.draft || "";
                    }}
                    onRetriage={async (id) => {
                      setRetriageBusy(true);
                      setError("");
                      try {
                        await api.retriageEmail(id);
                        await refresh();
                        setNotice("Email re-triaged successfully.");
                        setTimeout(() => setNotice(""), 2500);
                      } catch (err) {
                        setError(err.message || "Re-triage failed");
                      } finally {
                        setRetriageBusy(false);
                      }
                    }}
                    onInform={(id, correctCategory, reason) =>
                      runAction(async () => {
                        await api.informClassification(id, correctCategory, reason);
                      })
                    }
                    onRemove={(id) =>
                      runAction(async () => {
                        await api.removeFromInboxPilot(id);
                      })
                    }
                    onComplete={(id) =>
                      runAction(async () => {
                        await api.markComplete(id);
                        setNotice("Marked complete.");
                        setTimeout(() => setNotice(""), 2500);
                      })
                    }
                  />
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full border border-white/[0.07] bg-white/[0.03]">
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5 text-slate-600">
                    <path d="M10 10V3m0 7l-3-3m3 3l3-3" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M3 13v2a2 2 0 002 2h10a2 2 0 002-2v-2" strokeLinecap="round"/>
                  </svg>
                </div>
                <p className="text-sm font-medium text-slate-500">Nothing here</p>
                <p className="mt-1 text-xs text-slate-700">This lane is clear.</p>
              </div>
            )}
          </div>
        </main>
      </div>

      {/* ── Footer ── */}
      <footer className="fixed bottom-0 left-0 right-0 z-20 flex h-9 items-center justify-center border-t border-indigo-500/20 bg-[#0e1018]/95 backdrop-blur text-xs text-slate-500">
        Made by{" "}
        <a
          href="https://contra.com/robkaltenbach"
          target="_blank"
          rel="noreferrer"
          className="ml-1 font-medium text-indigo-400 hover:text-indigo-300 transition"
        >
          @robkaltenbach
        </a>
      </footer>

      {gmailModalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4">
          <div className="w-full max-w-md rounded-xl border border-white/[0.12] bg-[#141824] p-4 shadow-2xl shadow-black/50">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">Connected inboxes</h3>
              <button
                onClick={() => setGmailModalOpen(false)}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-white/[0.07] hover:text-slate-200"
                aria-label="Close inbox modal"
              >
                <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" stroke="currentColor" strokeWidth="1.8">
                  <path d="M5 5L15 15M15 5L5 15" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            {connected ? (
              <div>
                {gmailInboxes.length > 0 ? (
                  <div className="space-y-2">
                    {gmailInboxes.map((inbox) => (
                      <div
                        key={inbox.id}
                        className="rounded-lg border border-white/[0.07] bg-[#0f1320] px-3 py-2"
                      >
                        <p className="text-xs font-medium text-white">{inbox.label}</p>
                        <p className="mt-0.5 text-[10px] text-slate-500">
                          {inbox.watchActive ? "Inbox watch active" : "Inbox watch pending"}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="rounded-lg border border-white/[0.07] bg-[#0f1320] px-3 py-2 text-xs text-slate-300">
                    Gmail is connected.
                  </p>
                )}

                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setGmailModalOpen(false);
                    runAction(() => api.disconnectGmail());
                  }}
                  className="mt-4 w-full rounded-lg border border-rose-500/35 bg-rose-500/10 py-2 text-xs font-semibold text-rose-200 hover:bg-rose-500/15 disabled:opacity-40"
                >
                  Log out of Gmail
                </button>
              </div>
            ) : (
              <div>
                <p className="text-xs text-slate-300">No Gmail inbox is connected yet.</p>
                <button
                  type="button"
                  onClick={() => {
                    setGmailModalOpen(false);
                    window.location.href = "/auth/google";
                  }}
                  className="mt-4 w-full rounded-lg border border-emerald-500/35 bg-emerald-500/10 py-2 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/15"
                >
                  Connect Gmail
                </button>
              </div>
            )}
          </div>
        </div>
      ) : null}

    </div>
  );
}
