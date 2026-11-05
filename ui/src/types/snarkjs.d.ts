// SPDX-License-Identifier: MIT
declare module "snarkjs" {
  export const groth16: {
    /** wasm / zkey: URL (browser) or file path (Node) */
    fullProve(input: Record<string, unknown>, wasm: string, zkey: string): Promise<{
      proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] };
      publicSignals: string[];
    }>;
  };
}
