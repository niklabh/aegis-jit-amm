// SPDX-License-Identifier: MIT
// Small presentational helpers shared by the World ID and ZK Aadhaar passes.
export const short = (h: string, n = 10) => (h.length > 2 * n + 2 ? `${h.slice(0, n + 2)}…${h.slice(-n)}` : h);

export function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="mt-4 border-t border-slate-800 pt-3">
      <div className="text-xs font-semibold text-slate-300 mb-2"><span className="text-emerald-400 mr-2">{n}</span>{title}</div>
      {children}
    </div>
  );
}

export function Badge({ tone, children }: { tone: "good" | "warn" | "bad" | "neutral"; children: React.ReactNode }) {
  const c = { good: "border-emerald-700 text-emerald-300", warn: "border-amber-700 text-amber-300", bad: "border-rose-700 text-rose-300", neutral: "border-slate-700 text-slate-300" }[tone];
  return <span className={`text-[11px] px-2 py-0.5 rounded border ${c}`}>{children}</span>;
}
