// SPDX-License-Identifier: MIT
import type { TrustedKey } from "@/lib/aadhaar/keys";
import type { ParsedSecureQr } from "@/lib/aadhaar/parse";
import type { VerificationResult } from "@/lib/aadhaar/verify";

export type ScanSource = "camera" | "image" | "sample";

/** Everything shown on the results screen. Held in memory only, dropped on "Scan another". */
export interface ScanOutcome {
  parsed: ParsedSecureQr;
  verification: VerificationResult<TrustedKey>;
  photoUrl: string | null;
  photoError: string | null;
  source: ScanSource;
  engine: string | null;
  keysCount: number;
  /** Epoch ms of the scan; ages are computed relative to it. */
  scannedAt: number;
}

export interface Notice {
  tone: "info" | "warning" | "error";
  text: string;
}
