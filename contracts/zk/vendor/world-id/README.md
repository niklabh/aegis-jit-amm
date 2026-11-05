# Vendored: World ID `SemaphoreVerifier`

`SemaphoreVerifier.sol` and `ISemaphoreVerifier.sol` are copied from
[worldcoin/world-id-contracts](https://github.com/worldcoin/world-id-contracts)
(`src/SemaphoreVerifier.sol`, `src/interfaces/ISemaphoreVerifier.sol`, commit `65105be8`, MIT).
This is the Groth16 verifier World ID's identity manager calls for every `verifyProof`: the
Semaphore v3 circuit at tree depth 30, public inputs `[root, nullifierHash, signalHash,
externalNullifierHash]`, pairing check on the `ecPairing` precompile (`0x08`).

- **Single modification:** the import `"src/interfaces/ISemaphoreVerifier.sol"` became the relative
  `"./ISemaphoreVerifier.sol"` (Hardhat has no `src/` remapping). Nothing else changed.
- **Verification key integrity:** all 24 curve constants (`ALPHA_*`, `*_NEG_*`, `CONSTANT_*`,
  `PUB_*`) equal the verification key exported from the public Semaphore depth-30 trusted-setup
  zkey (`https://www.trusted-setup-pse.org/semaphore/30/semaphore.zkey`, SHA-256
  `00aaa6d8…a948`, pinned in `packages/world-id/prover/fetch-artifacts.mjs`). So a proof generated
  locally with those artifacts verifies against the exact contract World ID runs on-chain.
- It is deployed as a separate contract and called through the independently declared
  `IWorldIDSemaphoreVerifier` (`../../world-id/`), by `MockWorldIDRouter`, which plays the World ID
  Router + Identity Manager (groups, root history and expiry) for the local chain.
