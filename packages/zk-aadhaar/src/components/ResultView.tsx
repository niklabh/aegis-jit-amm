// SPDX-License-Identifier: MIT
"use client";

import { ImageOff, RotateCcw, TriangleAlert } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { bytesToHex } from "@/lib/aadhaar/bytes";
import {
  composeAddress,
  describeDob,
  formatDate,
  formatQrTimestamp,
  genderLabel,
  maskAadhaar,
  truncateMiddle,
} from "@/lib/aadhaar/format";
import type { SecureQrData } from "@/lib/aadhaar/parse";
import { cn } from "@/lib/cn";
import type { ScanOutcome } from "@/lib/outcome";
import { CopyButton } from "./CopyButton";
import { VerificationBanner } from "./VerificationBanner";

function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  const empty = children === "" || children === null || children === undefined;
  return (
    <div className={cn("min-w-0", wide && "sm:col-span-2")}>
      <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className={cn("mt-0.5 break-words text-[0.95rem]", empty && "text-zinc-400 dark:text-zinc-500")}>
        {empty ? "—" : children}
      </dd>
    </div>
  );
}

function Card({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section
      className={cn(
        "rounded-3xl bg-white p-5 shadow-sm ring-1 ring-zinc-200 sm:p-6 dark:bg-zinc-900 dark:ring-zinc-800",
        className,
      )}
    >
      <h3 className="mb-4 text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
      {children}
    </section>
  );
}

function HexValue({ label, hex }: { label: string; hex: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</p>
      <div className="mt-1 flex items-center gap-2">
        <code
          title={hex}
          className="min-w-0 flex-1 truncate rounded-lg bg-zinc-100 px-2.5 py-1.5 font-mono text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
        >
          {truncateMiddle(hex, 14, 14)}
        </code>
        <CopyButton value={hex} label={label} />
      </div>
    </div>
  );
}

function mobileText(d: SecureQrData): string {
  if (d.maskedMobile) return d.maskedMobile;
  return d.hasMobile ? "Linked (number not included)" : "Not linked";
}

function emailText(d: SecureQrData): string {
  if (d.maskedEmail) return d.maskedEmail;
  return d.hasEmail ? "Linked (address not included)" : "Not linked";
}

export function ResultView({ outcome, onScanAnother }: { outcome: ScanOutcome; onScanAnother: () => void }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { parsed, verification } = outcome;
  const d = parsed.data;
  const dob = describeDob(d.dob, new Date(outcome.scannedAt));
  const invalid = verification.status === "invalid";
  const key = verification.key;

  useEffect(() => {
    // Lead with the verification banner; move focus for screen readers without jumping.
    window.scrollTo({ top: 0 });
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <article aria-labelledby="result-heading" className="mx-auto max-w-5xl space-y-5">
      <VerificationBanner result={verification} keysCount={outcome.keysCount} />

      {parsed.warnings.map((warning) => (
        <p
          key={warning}
          className="flex gap-3 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-600/20 dark:bg-amber-950/40 dark:text-amber-100"
        >
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          {warning}
        </p>
      ))}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,23rem)]">
        <div className="space-y-5">
          <section
            className={cn(
              "rounded-3xl bg-white p-5 shadow-sm ring-1 sm:p-6 dark:bg-zinc-900",
              invalid ? "ring-2 ring-rose-300 dark:ring-rose-800" : "ring-zinc-200 dark:ring-zinc-800",
            )}
          >
            <div className="flex flex-col items-center gap-5 text-center sm:flex-row sm:items-center sm:text-left">
              {outcome.photoUrl ? (
                // A data: URL decoded on-device; next/image adds nothing here.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={outcome.photoUrl}
                  alt={`Photograph embedded in the Secure QR${d.name ? ` for ${d.name}` : ""}`}
                  width={136}
                  height={136}
                  className={cn(
                    "size-34 shrink-0 rounded-2xl bg-zinc-100 object-cover shadow-sm ring-1 ring-black/10",
                    invalid && "opacity-80 grayscale-[35%]",
                  )}
                />
              ) : (
                <div className="grid size-34 shrink-0 place-items-center rounded-2xl bg-zinc-100 text-zinc-400 ring-1 ring-black/5 dark:bg-zinc-800">
                  <div className="flex flex-col items-center gap-1 px-2 text-xs">
                    <ImageOff aria-hidden className="size-6" />
                    {outcome.photoError ?? "No photo in QR"}
                  </div>
                </div>
              )}
              <div className="min-w-0">
                <h2
                  id="result-heading"
                  ref={headingRef}
                  tabIndex={-1}
                  className="break-words text-2xl font-semibold tracking-tight outline-none sm:text-3xl"
                >
                  {d.name || "Name not present"}
                </h2>
                <p className="mt-1 font-mono text-sm tracking-[0.2em] text-zinc-500 dark:text-zinc-400">
                  {maskAadhaar(d.aadhaarLast4)}
                </p>
                <div className="mt-3 flex flex-wrap justify-center gap-2 sm:justify-start">
                  <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium dark:bg-zinc-800">
                    {dob.display}
                    {dob.age !== null && ` · ${dob.age} yrs`}
                  </span>
                  <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium dark:bg-zinc-800">
                    {genderLabel(d.gender)}
                  </span>
                </div>
              </div>
            </div>

            <dl className="mt-6 grid grid-cols-1 gap-x-6 gap-y-4 border-t border-zinc-100 pt-5 sm:grid-cols-2 dark:border-zinc-800">
              <Field label="Name">{d.name}</Field>
              <Field label="Date of birth">
                {d.dob ? `${dob.display}${dob.age !== null ? ` (age ${dob.age})` : ""}` : ""}
              </Field>
              <Field label="Gender">{d.gender ? genderLabel(d.gender) : ""}</Field>
              <Field label="Aadhaar number">
                <span className="font-mono">{maskAadhaar(d.aadhaarLast4)}</span>
                <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                  Secure QR codes only carry the last 4 digits
                </span>
              </Field>
              <Field label="Mobile">{mobileText(d)}</Field>
              <Field label="Email">{emailText(d)}</Field>
              <Field label="QR generated" wide>
                {d.generatedAt ? formatQrTimestamp(d.generatedAt) : ""}
              </Field>
            </dl>
          </section>

          <Card title="Residential address">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
              <Field label="Care of">{d.careOf}</Field>
              <Field label="House / building">{d.house}</Field>
              <Field label="Street">{d.street}</Field>
              <Field label="Landmark">{d.landmark}</Field>
              <Field label="Locality">{d.location}</Field>
              <Field label="Village / town / city">{d.vtc}</Field>
              <Field label="Post office">{d.postOffice}</Field>
              <Field label="Sub-district">{d.subDistrict}</Field>
              <Field label="District">{d.district}</Field>
              <Field label="State">{d.state}</Field>
              <Field label="PIN code">{d.pincode}</Field>
              <Field label="Full address" wide>
                {composeAddress(d)}
              </Field>
            </dl>
          </Card>
        </div>

        <Card title="Cryptographic details" className="h-fit">
          <div className="space-y-4">
            <dl className="grid gap-4">
              <Field label="Signed by">
                {key ? (
                  <>
                    {key.label}
                    <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                      {key.trust === "uidai" ? "Official UIDAI certificate" : key.source === "demo" ? "Demo key (not UIDAI)" : "Imported key (not marked official)"}
                      {key.details.notBefore && key.details.notAfter
                        ? ` · ${formatDate(key.details.notBefore)} – ${formatDate(key.details.notAfter)}`
                        : ""}
                    </span>
                  </>
                ) : verification.status === "unavailable" ? (
                  "Not checked"
                ) : (
                  <span className="text-rose-700 dark:text-rose-300">No trusted key matches</span>
                )}
              </Field>
              <Field label="Algorithm">SHA256withRSA · RSASSA-PKCS1-v1_5 · 2048-bit</Field>
            </dl>
            <HexValue label={`Signature (${parsed.signature.length} bytes)`} hex={bytesToHex(parsed.signature)} />
            {verification.signedDataSha256 && (
              <HexValue label="SHA-256 of signed data" hex={verification.signedDataSha256} />
            )}
            <dl className="grid grid-cols-2 gap-4 border-t border-zinc-100 pt-4 dark:border-zinc-800">
              <Field label="QR format">{d.version === "legacy" ? "Legacy (2019)" : d.version}</Field>
              <Field label="Keys checked">
                {verification.keysTried} of {outcome.keysCount}
              </Field>
              <Field label="Payload">
                {parsed.compressedLength.toLocaleString("en-IN")} B → {parsed.decompressedLength.toLocaleString("en-IN")} B
              </Field>
              <Field label="Read via">
                {outcome.source === "sample" ? "Built-in sample" : `${outcome.source === "camera" ? "Camera" : "Image"} · ${outcome.engine}`}
              </Field>
            </dl>
            <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
              The signature covers every byte of the decompressed QR data before it. Changing any field — even one
              digit — makes verification fail.
            </p>
          </div>
        </Card>
      </div>

      <div className="sticky bottom-4 z-10 flex justify-center pt-2">
        <button
          type="button"
          onClick={onScanAnother}
          className="inline-flex items-center gap-2 rounded-full bg-indigo-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-600/25 transition hover:bg-indigo-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500"
        >
          <RotateCcw aria-hidden className="size-4" />
          Scan another
        </button>
      </div>
    </article>
  );
}
