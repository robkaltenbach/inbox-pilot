import { Hourglass, Inbox } from "lucide-react";

/**
 * Fetch / triage: Inbox when idle; hourglass (animated) while active, crossfaded.
 * `indeterminate`: no server progress — pulse fill (e.g. single-email re-triage).
 */
export default function FetchTriageButton({
  active,
  progress = 0,
  indeterminate = false,
  disabled,
  onClick,
  title = "Fetch & triage unread mail"
}) {
  const pct = active && !indeterminate ? Math.min(100, Math.max(0, Number(progress) || 0)) : 0;
  const iconClass = active ? "text-white" : "text-indigo-200/90 group-hover:text-white";
  const fillClass =
    active && indeterminate
      ? "fetch-progress-fill-indeterminate pointer-events-none absolute inset-x-0 bottom-0 overflow-hidden"
      : "fetch-progress-fill pointer-events-none absolute inset-x-0 bottom-0 overflow-hidden";

  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-busy={active}
      aria-valuenow={active && !indeterminate ? Math.round(pct) : undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      disabled={disabled}
      onClick={onClick}
      className="group relative h-9 w-9 shrink-0 overflow-hidden rounded-lg border border-indigo-500/35 bg-[#12151f] shadow-inner transition hover:border-indigo-400/60 hover:bg-[#161a26] disabled:pointer-events-none disabled:opacity-40"
    >
      <div className={fillClass} style={active && !indeterminate ? { height: `${pct}%` } : undefined}>
        <div className="absolute inset-0 bg-gradient-to-t from-indigo-900 via-indigo-600 to-indigo-400/60" />
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/35 to-transparent"
          aria-hidden
        />
      </div>

      <span className="relative z-10 flex h-full w-full items-center justify-center text-current">
        <span className="relative h-5 w-5 shrink-0">
          <Inbox
            className={`fetch-fetch-icon-layer absolute inset-0 h-5 w-5 pointer-events-none drop-shadow-sm transition-opacity duration-300 ease-in-out ${iconClass} ${
              active ? "opacity-0" : "opacity-100"
            }`}
            strokeWidth={2}
            aria-hidden
          />
          <Hourglass
            className={`fetch-fetch-icon-layer absolute inset-0 h-5 w-5 pointer-events-none drop-shadow-sm transition-opacity duration-300 ease-in-out ${iconClass} ${
              active ? "opacity-100 fetch-hourglass-spin" : "opacity-0"
            }`}
            strokeWidth={2}
            aria-hidden
          />
        </span>
      </span>
    </button>
  );
}
