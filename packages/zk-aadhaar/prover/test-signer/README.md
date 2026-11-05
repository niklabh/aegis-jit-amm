# AegisJIT test signer — NOT UIDAI

Test-only RSA-2048 key and self-signed certificate used to sign **synthetic** V2 Aadhaar Secure
QR payloads for local tests and the demo. The private key is committed on purpose, so anyone can
mint test QRs (the same pattern as Anon Aadhaar's published test key).

- On-chain, `AnonAadhaarGroth16Verifier` is deployed with this key's circuit `pubkeyHash` as its
  trust root **only for local test deployments**. A production deployment must use the UIDAI
  key hash. Proofs made from this key are then rejected.
- zkAadhaar's in-browser verifier does not trust this key unless you import it, so it reports
  "Valid signature — not from a UIDAI key".
