/**
 * Donut pie for To Do / Noise / Done using conic-gradient (no chart deps).
 * Colors align with lane accents (rose / slate / emerald).
 */
const COLORS = {
  NEEDS_REPLY: "#fb7185",
  NOISE: "#64748b",
  REPLIED: "#34d399",
};

export default function LanePieChart({ segments }) {
  const total = segments.reduce((s, x) => s + x.value, 0);

  if (total === 0) {
    return (
      <div className="flex flex-col items-center gap-3">
        <div
          className="relative h-[7.5rem] w-[7.5rem] shrink-0 rounded-full border border-white/[0.06] bg-[#1a1f2e]"
          aria-hidden
        >
          <div className="absolute inset-[22%] flex items-center justify-center rounded-full bg-[#13161f]">
            <span className="text-lg font-semibold tabular-nums text-slate-500">0</span>
          </div>
        </div>
        <ul className="w-full space-y-1.5 px-0.5">
          {segments.map((seg) => (
            <li
              key={seg.key}
              className="flex items-center justify-between gap-2 text-[11px] text-slate-500"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className="h-2 w-2 shrink-0 rounded-sm"
                  style={{ backgroundColor: COLORS[seg.key] }}
                />
                <span className="truncate">{seg.label}</span>
              </span>
              <span className="tabular-nums text-slate-600">0</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  let acc = 0;
  const gradientParts = [];
  for (const seg of segments) {
    if (seg.value <= 0) continue;
    const startDeg = (acc / total) * 360;
    acc += seg.value;
    const endDeg = (acc / total) * 360;
    gradientParts.push(`${COLORS[seg.key]} ${startDeg}deg ${endDeg}deg`);
  }

  const background = `conic-gradient(from -90deg, ${gradientParts.join(", ")})`;

  return (
    <div className="flex flex-col items-center gap-3">
      <div
        className="relative h-[7.5rem] w-[7.5rem] shrink-0 rounded-full shadow-inner"
        style={{ background }}
        role="img"
        aria-label={`Inbox mix: ${segments
          .filter((s) => s.value > 0)
          .map((s) => `${s.label} ${s.value}`)
          .join(", ")}`}
      >
        <div className="absolute inset-[22%] flex items-center justify-center rounded-full bg-[#13161f] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
          <span className="text-lg font-semibold tabular-nums text-white">{total}</span>
        </div>
      </div>
      <ul className="w-full space-y-1.5 px-0.5">
        {segments.map((seg) => (
          <li
            key={seg.key}
            className="flex items-center justify-between gap-2 text-[11px] text-slate-400"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                className="h-2 w-2 shrink-0 rounded-sm"
                style={{ backgroundColor: COLORS[seg.key] }}
              />
              <span className="truncate">{seg.label}</span>
            </span>
            <span className="tabular-nums text-slate-300">{seg.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
