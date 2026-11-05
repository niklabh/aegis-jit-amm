# Vendored: Anon Aadhaar v2 Groth16 verifier

`Verifier.sol` is copied **unmodified** from `@anon-aadhaar/contracts@2.4.3` (`src/Verifier.sol`).
It is the snarkjs-generated BN254 Groth16 verifier for the Anon Aadhaar v2 circuit (9 public
signals) and calls the `ecPairing` precompile (`0x08`).

- Licence: **GPL-3.0** (snarkjs verifier template, © 0KIMS association), as stated in its header.
  It is deployed as a separate contract and called through an independently written interface
  (`IAnonAadhaarPairingVerifier` in `../../AnonAadhaarGroth16Verifier.sol`, MIT).
- Integrity: the 26 verification-key constants in this file equal the verification key exported
  from the official `circuit_final.zkey` (SHA-256 `0d443ea8…c492`, see
  `packages/zk-aadhaar/prover/fetch-artifacts.mjs`).
