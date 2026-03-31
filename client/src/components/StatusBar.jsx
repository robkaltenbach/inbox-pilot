export default function StatusBar({ connected, onFetch, onDigest, busy }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#bac095] bg-white/80 p-4 shadow-md backdrop-blur">
      <div>
        <p className="text-xs uppercase tracking-[0.2em] text-[#636B2F]">Dashboard</p>
        <h2 className="text-2xl font-semibold text-[#3D4127]">Email Triage</h2>
      </div>
      <div className="flex items-center gap-2">
        <div className="rounded-full bg-[#bac095]/30 px-3 py-2 text-sm">
          Gmail:{" "}
          <span className={connected ? "font-semibold text-emerald-700" : "font-semibold text-rose-700"}>
            {connected ? "Connected" : "Not connected"}
          </span>
        </div>
        {!connected && (
          <a
            href="/auth/google"
            className="rounded-lg bg-[#636B2F] px-3 py-2 text-sm font-medium text-white hover:bg-[#4f5725]"
          >
            Connect Gmail
          </a>
        )}
        <button
          onClick={onFetch}
          disabled={busy || !connected}
          className="rounded-lg bg-[#3D4127] px-3 py-2 text-sm font-medium text-white hover:bg-[#2b2f1c] disabled:opacity-50"
        >
          Fetch & Triage
        </button>
        <button
          onClick={onDigest}
          disabled={busy}
          className="rounded-lg bg-[#d4de95] px-3 py-2 text-sm font-medium text-[#3D4127] hover:bg-[#bfcb80] disabled:opacity-50"
        >
          Send Slack Digest
        </button>
      </div>
    </div>
  );
}
