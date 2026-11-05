// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AEGIS_TEST_SIGNER_CERT_PEM } from "@/lib/aadhaar/aegis-test-signer";

describe("AegisJIT test signer certificate", () => {
  it("embedded copy matches prover/test-signer/aegis-test-signer.cert.pem", () => {
    const file = readFileSync(join(__dirname, "..", "prover", "test-signer", "aegis-test-signer.cert.pem"), "utf8").trim();
    expect(AEGIS_TEST_SIGNER_CERT_PEM).toBe(file);
  });
});
