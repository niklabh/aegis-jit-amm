# aegis-world-id — World ID-compatible local tree + prover

Local stand-in for the parts of World ID that live off-chain: a Semaphore v3 identity tree at
depth 30 (World ID's depth) and a Groth16 prover over the **public Semaphore depth-30 trusted-setup
artifacts**. Their verification key equals the constants in World ID's on-chain
`SemaphoreVerifier` (vendored at `contracts/zk/vendor/world-id/`), so proofs made here verify on the
exact contract World ID runs. The project plays the signup sequencer: it publishes the tree root to
`MockWorldIDRouter`, and takers prove membership bound to their address.

```bash
npm install
node prover/fetch-artifacts.mjs          # semaphore.wasm (1.3 MB) + semaphore.zkey (4.5 MB), SHA-256 pinned, into ../../.cache/semaphore/30
npx tsx prover/cli.ts status             # { artifacts, treeDepth }
npx tsx prover/cli.ts root               # local tree root + member commitments
npx tsx prover/cli.ts external-nullifier --app-id app_staging_aegis_jit_mumbai --action aegis-jit-fee-tier
npx tsx prover/cli.ts prove --identity human --signal 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC --external-nullifier <uint>
```

Conventions (World ID on-chain template, `ByteHasher.hashToField = keccak256 >> 8`):

- `signalHash = hashToField(abi.encodePacked(address))` — the signal is the taker's address
- `externalNullifierHash = hashToField(abi.encodePacked(hashToField(appId), action))`
- public signals `[root, nullifierHash, signalHash, externalNullifierHash]`, proof packed
  `[a0, a1, b01, b00, b11, b10, c0, c1]` (IDKit / World ID packing)

Identities are deterministic from a seed (`Identity("aegis-jit/world-id/<seed>")`) so tests, the
demo and the dashboard rebuild the same tree. World App holds random identities; everything else is
identical. MIT.
