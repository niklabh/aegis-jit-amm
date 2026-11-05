// SPDX-License-Identifier: MIT
import { ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import type { TrustedKey } from "@/lib/aadhaar/keys";
import { formatDate } from "@/lib/aadhaar/format";
import type { VerificationResult } from "@/lib/aadhaar/verify";
import { cn } from "@/lib/cn";

const TONES = {
  authentic: {
    icon: ShieldCheck,
    box: "bg-emerald-50 text-emerald-950 ring-emerald-600/25 dark:bg-emerald-950/50 dark:text-emerald-50 dark:ring-emerald-400/30",
    badge: "bg-emerald-600 text-white",
  },
  "untrusted-key": {
    icon: ShieldAlert,
    box: "bg-amber-50 text-amber-950 ring-amber-600/25 dark:bg-amber-950/40 dark:text-amber-50 dark:ring-amber-400/30",
    badge: "bg-amber-500 text-amber-950",
  },
  invalid: {
    icon: ShieldX,
    box: "bg-rose-50 text-rose-950 ring-rose-600/25 dark:bg-rose-950/50 dark:text-rose-50 dark:ring-rose-400/30",
    badge: "bg-rose-600 text-white",
  },
  unavailable: {
    icon: ShieldAlert,
    box: "bg-zinc-100 text-zinc-900 ring-zinc-400/30 dark:bg-zinc-900 dark:text-zinc-50 dark:ring-zinc-600/40",
    badge: "bg-zinc-700 text-white",
  },
} as const;

function validity(key: TrustedKey): string | null {
  const { notBefore, notAfter } = key.details;
  return notBefore && notAfter ? `valid ${formatDate(notBefore)} – ${formatDate(notAfter)}` : null;
}

export function VerificationBanner({
  result,
  keysCount,
}: {
  result: VerificationResult<TrustedKey>;
  keysCount: number;
}) {
  const tone = TONES[result.status];
  const Icon = tone.icon;
  const key = result.key;

  let title: string;
  let detail: string;
  switch (result.status) {
    case "authentic":
      title = "Cryptographically Verified (Authentic)";
      detail = `Signed by UIDAI — ${key?.label}${key && validity(key) ? ` (${validity(key)})` : ""}${
        key?.source === "imported" ? ", a certificate you imported" : ""
      }. The data has not been altered since UIDAI signed it.`;
      break;
    case "untrusted-key":
      title = "Valid signature — but not from a UIDAI key";
      detail =
        key?.source === "demo"
          ? "Signed by the built-in demo key. This sample is fictional and was not issued by UIDAI."
          : `Signed by “${key?.label}”, a key you imported. Only trust this if you know who controls that key.`;
      break;
    case "invalid":
      title = "Signature Verification Failed (Tampered / Invalid)";
      detail = `The data does not match its signature under any of the ${keysCount} trusted keys. It may have been altered, or it was not signed by UIDAI. Do not rely on the details below.`;
      break;
    default:
      title = "Signature could not be checked";
      detail = result.message ?? "Signature verification is unavailable in this browser.";
  }

  return (
    <div role="status" className={cn("flex gap-4 rounded-3xl p-5 ring-1 sm:p-6", tone.box)}>
      <span className={cn("grid size-12 shrink-0 place-items-center rounded-2xl shadow-sm", tone.badge)}>
        <Icon aria-hidden className="size-7" />
      </span>
      <div className="min-w-0">
        <p className="text-lg font-semibold leading-snug sm:text-xl">{title}</p>
        <p className="mt-1 text-sm leading-relaxed opacity-85">{detail}</p>
      </div>
    </div>
  );
}
