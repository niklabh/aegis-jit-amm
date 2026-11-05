// SPDX-License-Identifier: MIT
declare module "snarkjs" {
  export const groth16: {
    fullProve(input: Record<string, unknown>, wasm: string, zkey: string): Promise<{
      proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] };
      publicSignals: string[];
    }>;
    verify(vkey: unknown, publicSignals: string[], proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }): Promise<boolean>;
  };
  export const zKey: {
    exportVerificationKey(zkey: string): Promise<Record<string, unknown>>;
  };
}
