// SPDX-License-Identifier: MIT
"use client";

import { FileKey, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { formatDate, truncateMiddle } from "@/lib/aadhaar/format";
import { importedKeyStore, type TrustedKey } from "@/lib/aadhaar/keys";
import { KeyParseError } from "@/lib/aadhaar/x509";
import { cn } from "@/lib/cn";

interface KeyManagerProps {
  open: boolean;
  /** Epoch ms captured when the dialog was opened, for "current / expired" labels. */
  now: number;
  keys: TrustedKey[];
  onClose: () => void;
}

function validityLabel(key: TrustedKey, now: number): { text: string; tone: string } | null {
  const { notBefore, notAfter } = key.details;
  if (!notBefore || !notAfter) return null;
  const range = `${formatDate(notBefore)} – ${formatDate(notAfter)}`;
  if (now > notAfter.getTime()) {
    return { text: `${range} · expired, still checked for QR codes signed earlier`, tone: "text-zinc-500 dark:text-zinc-400" };
  }
  if (now < notBefore.getTime()) return { text: `${range} · not yet valid`, tone: "text-amber-700 dark:text-amber-300" };
  return { text: `${range} · current`, tone: "text-emerald-700 dark:text-emerald-300" };
}

function KeyRow({ keyInfo, now }: { keyInfo: TrustedKey; now: number }) {
  const validity = validityLabel(keyInfo, now);
  const badge =
    keyInfo.source === "demo"
      ? { text: "Demo", tone: "bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-100" }
      : keyInfo.trust === "uidai"
        ? {
            text: keyInfo.source === "imported" ? "Imported · official" : "UIDAI",
            tone: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/50 dark:text-emerald-100",
          }
        : { text: "Imported", tone: "bg-zinc-200 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-100" };

  return (
    <li className="flex items-start gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium">{keyInfo.label}</p>
          <span className={cn("rounded-full px-2 py-0.5 text-[0.7rem] font-semibold", badge.tone)}>{badge.text}</span>
        </div>
        {validity && <p className={cn("mt-0.5 text-xs", validity.tone)}>{validity.text}</p>}
        <p className="mt-0.5 truncate font-mono text-[0.7rem] text-zinc-500" title={keyInfo.fingerprint}>
          SHA-256 {truncateMiddle(keyInfo.fingerprint, 17, 17)}
        </p>
        {keyInfo.note && <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{keyInfo.note}</p>}
      </div>
      {keyInfo.source === "imported" && (
        <button
          type="button"
          onClick={() => importedKeyStore.remove(keyInfo.id)}
          className="rounded-lg p-2 text-zinc-500 hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-950"
          aria-label={`Remove ${keyInfo.label}`}
        >
          <Trash2 aria-hidden className="size-4" />
        </button>
      )}
    </li>
  );
}

export function KeyManager({ open, now, keys, onClose }: KeyManagerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [pem, setPem] = useState("");
  const [official, setOfficial] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Validity labels use the time the dialog opened, refreshed after each import.
  const [lastImportAt, setLastImportAt] = useState(0);
  const clock = Math.max(now, lastImportAt);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const importKeys = async (input: string | Uint8Array, fallbackLabel?: string) => {
    setBusy(true);
    setStatus(null);
    try {
      const { added, skipped, modulusBits } = await importedKeyStore.add(input, { official, fallbackLabel });
      setLastImportAt(Date.now());
      const parts = [];
      if (added) parts.push(`Added ${added} key${added > 1 ? "s" : ""}${official ? " as official UIDAI" : ""}.`);
      if (skipped) parts.push(`${skipped} already trusted.`);
      if (modulusBits.some((bits) => bits !== 2048)) parts.push("Note: UIDAI keys are RSA-2048; this key has a different size.");
      setStatus({ tone: "ok", text: parts.join(" ") });
      if (added) {
        setPem("");
        setOfficial(false);
      }
    } catch (error) {
      setStatus({
        tone: "error",
        text: error instanceof KeyParseError ? error.message : "That certificate could not be read.",
      });
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (pem.trim()) void importKeys(pem);
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void importKeys(new Uint8Array(await file.arrayBuffer()), file.name.replace(/\.[^.]+$/, ""));
  };

  const groups = [
    { title: "Official UIDAI certificates", items: keys.filter((k) => k.source === "built-in") },
    { title: "Imported", items: keys.filter((k) => k.source === "imported") },
    { title: "Demo", items: keys.filter((k) => k.source === "demo") },
  ].filter((g) => g.items.length > 0);

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      aria-labelledby="keys-title"
      className="m-auto max-h-[90dvh] w-[min(40rem,calc(100vw-1.5rem))] overflow-clip rounded-3xl bg-white p-0 text-zinc-900 shadow-2xl ring-1 ring-black/10 backdrop:bg-zinc-950/55 backdrop:backdrop-blur-sm dark:bg-zinc-900 dark:text-zinc-100 dark:ring-white/10"
    >
      <div className="flex max-h-[90dvh] flex-col">
        <header className="flex items-start gap-3 border-b border-zinc-100 p-5 dark:border-zinc-800">
          <div className="min-w-0 flex-1">
            <h2 id="keys-title" className="text-lg font-semibold">
              Trusted signing keys
            </h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              Every key is tried. Only official UIDAI keys can produce the green “Authentic” result; keys inside a QR
              code are never trusted.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-2 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
            aria-label="Close"
          >
            <X aria-hidden className="size-5" />
          </button>
        </header>

        <div className="overflow-y-auto px-5">
          {groups.map((group) => (
            <section key={group.title} className="pt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                {group.title} ({group.items.length})
              </h3>
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {group.items.map((key) => (
                  <KeyRow key={key.id} keyInfo={key} now={clock} />
                ))}
              </ul>
            </section>
          ))}

          <form onSubmit={onSubmit} className="my-5 rounded-2xl bg-zinc-50 p-4 ring-1 ring-zinc-200 dark:bg-zinc-950/50 dark:ring-zinc-800">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <FileKey aria-hidden className="size-4 text-zinc-500" />
              Import a certificate
            </h3>
            <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
              PEM text or a .cer / .crt / .pem / .der file. Public keys only — stored in this browser, never uploaded.
            </p>
            <label htmlFor="pem-input" className="sr-only">
              Certificate or public key (PEM)
            </label>
            <textarea
              id="pem-input"
              value={pem}
              onChange={(event) => setPem(event.target.value)}
              rows={4}
              spellCheck={false}
              placeholder={"-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----"}
              className="mt-3 w-full resize-y rounded-xl bg-white p-3 font-mono text-xs ring-1 ring-zinc-200 focus:outline-2 focus:outline-indigo-500 dark:bg-zinc-900 dark:ring-zinc-700"
            />
            <label className="mt-3 flex items-start gap-2 text-xs text-zinc-700 dark:text-zinc-300">
              <input
                type="checkbox"
                checked={official}
                onChange={(event) => setOfficial(event.target.checked)}
                className="mt-0.5 size-4 accent-indigo-600"
              />
              <span>
                This is an official UIDAI certificate — I downloaded it from uidai.gov.in and checked its SHA-256
                fingerprint. QR codes it verifies will be shown as <strong>Authentic</strong>.
              </span>
            </label>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="submit"
                disabled={busy || !pem.trim()}
                className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                Import
              </button>
              <label className="cursor-pointer rounded-xl px-4 py-2 text-sm font-medium ring-1 ring-zinc-300 hover:bg-white dark:ring-zinc-700 dark:hover:bg-zinc-800">
                Choose file…
                <input type="file" accept=".cer,.crt,.pem,.der,.txt" className="sr-only" onChange={onFile} />
              </label>
            </div>
            {status && (
              <p
                role="status"
                className={cn(
                  "mt-3 text-xs",
                  status.tone === "ok" ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300",
                )}
              >
                {status.text}
              </p>
            )}
          </form>
        </div>
      </div>
    </dialog>
  );
}
