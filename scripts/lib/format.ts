// SPDX-License-Identifier: MIT
// Terminal table helpers shared by the demo / deployment scripts.
const { ethers } = require("hardhat");

export const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", magenta: "\x1b[35m",
};
export const fmtUsdc = (v: bigint, dp = 2) => Number(ethers.formatUnits(v, 6)).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const fmtWeth = (v: bigint, dp = 4) => Number(ethers.formatUnits(v, 18)).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-8)}`;
export const pct = (num: bigint, den: bigint, dp = 2) => (Number((num * 10n ** 8n) / den) / 1e6).toFixed(dp) + "%";
export const n = (v: bigint | number | null) => (v === null ? "n/a" : Number(v).toLocaleString("en-US"));
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

export function table(title: string, rows: Array<[string, string]>) {
  const w0 = Math.max(...rows.map((r) => visible(r[0]).length));
  const w1 = Math.max(...rows.map((r) => visible(r[1]).length), visible(title).length - w0 - 3);
  const line = (l: string, m: string, r: string) => `${l}${"─".repeat(w0 + 2)}${m}${"─".repeat(w1 + 2)}${r}`;
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visible(s).length));
  console.log(line("┌", "─", "┐"));
  console.log(`│ ${pad(C.bold + title + C.reset, w0 + w1 + 3)} │`);
  console.log(line("├", "┬", "┤"));
  for (const [k, v] of rows) console.log(`│ ${pad(C.dim + k + C.reset, w0)} │ ${pad(v, w1)} │`);
  console.log(line("└", "┴", "┘"));
}

export function grid(headers: string[], rows: string[][]) {
  const w = headers.map((h, i) => Math.max(visible(h).length, ...rows.map((r) => visible(r[i]).length)));
  const pad = (s: string, len: number, right = false) => right ? " ".repeat(len - visible(s).length) + s : s + " ".repeat(len - visible(s).length);
  const sep = (l: string, m: string, r: string) => l + w.map((x) => "─".repeat(x + 2)).join(m) + r;
  console.log(sep("┌", "┬", "┐"));
  console.log("│" + headers.map((h, i) => ` ${C.bold}${pad(h, w[i])}${C.reset} `).join("│") + "│");
  console.log(sep("├", "┼", "┤"));
  for (const r of rows) console.log("│" + r.map((c, i) => ` ${pad(c, w[i], i > 0)} `).join("│") + "│");
  console.log(sep("└", "┴", "┘"));
}

export const banner = (s: string) => console.log(`\n${C.bold}${C.cyan}━━ ${s} ${"━".repeat(Math.max(0, 86 - s.length))}${C.reset}`);
