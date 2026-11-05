// SPDX-License-Identifier: MIT
import type { QrTimestamp, SecureQrData } from "./parse";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

export function maskAadhaar(last4: string | null): string {
  return `XXXX XXXX ${last4 ?? "XXXX"}`;
}

export function genderLabel(code: string): string {
  switch (code.trim().toUpperCase()) {
    case "M":
      return "Male";
    case "F":
      return "Female";
    case "T":
      return "Transgender";
    default:
      return code || "—";
  }
}

export interface DobInfo {
  display: string;
  age: number | null;
}

/** Aadhaar DOB is "DD-MM-YYYY" (sometimes "DD/MM/YYYY", or just a year). */
export function describeDob(dob: string, today: Date = new Date()): DobInfo {
  const value = dob.trim();
  const full = /^(\d{2})[-/.](\d{2})[-/.](\d{4})$/.exec(value);
  if (full) {
    const [day, month, year] = [full[1], full[2], full[3]].map(Number);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      let age = today.getFullYear() - year;
      const m = today.getMonth() + 1;
      if (m < month || (m === month && today.getDate() < day)) age--;
      return {
        display: `${pad(day)} ${MONTHS[month - 1]} ${year}`,
        age: age >= 0 && age < 150 ? age : null,
      };
    }
  }
  if (/^\d{4}$/.test(value)) {
    const age = today.getFullYear() - Number(value);
    return { display: `${value} (year of birth)`, age: age >= 0 && age < 150 ? age : null };
  }
  return { display: value || "—", age: null };
}

export function formatQrTimestamp(t: QrTimestamp): string {
  return `${pad(t.day)} ${MONTHS[t.month - 1]} ${t.year}, ${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)} IST`;
}

export function formatDate(date: Date): string {
  return `${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** Address in the order printed on Aadhaar letters, without repeated parts. */
export function composeAddress(d: SecureQrData): string {
  const parts = [
    d.careOf,
    d.house,
    d.street,
    d.landmark,
    d.location,
    d.vtc,
    d.postOffice ? `PO: ${d.postOffice}` : "",
    d.subDistrict,
    d.district,
    d.state,
  ]
    .map((p) => p.trim())
    .filter(Boolean);
  const unique = parts.filter((p, i) => parts.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i);
  const text = unique.join(", ");
  if (!d.pincode) return text;
  return text ? `${text} – ${d.pincode}` : d.pincode;
}

export function truncateMiddle(value: string, head = 12, tail = 12): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}
