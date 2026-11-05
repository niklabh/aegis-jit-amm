# AegisJIT — Custom-Opcode AMM & Self-Custodial JIT Liquidity Vault

Built on **1inch Aqua** and **1inch SwapVM** for ETHGlobal Mumbai 2026.

AegisJIT lets a Maker keep 100% of their capital in ERC-4626 yield vaults, in their own wallet,
while quoting deep liquidity to takers. Three custom SwapVM opcodes do the work inside the
interpreter loop:

| Opcode | Instruction | What it does |
|--------|-------------|--------------|
| `0x2A` | **ZKIdentityGuard** | Modular verifier router: verifies a **World ID** proof (type 1, `WorldIDAdapter` → World ID Router) or a **ZK Aadhaar** proof (type 2, `AnonAadhaarAdapter` → Anon Aadhaar Groth16) from the taker's calldata (STATICCALL). It either gates the order (strict mode) or tiers the taker as *verified human* vs *unverified bot* (tiered mode). Both pathways land in the same 0x7A discount. |
| `0x9A` | **JITVaultReserves** | Reads the Maker's **live** ERC-4626 backing and caps any single execution at **λ** (e.g. 25%) of it. It also adds virtual depth (`boost`) without locking extra capital. View-safe. |
| `0x7A` | **VolatilitySurgeFee** | Applies a size- and flow-aware LVR fee: base fee below a utilization threshold, surge fee above it, measured on cumulative in-window flow so split trades can't dodge it. Verified humans pay half the base fee. |

It also integrates **zkAadhaar**, an offline Aadhaar Secure-QR scanner/parser/RSA verifier,
with the official **Anon Aadhaar v2** circuit. A taker proves "over 18, resident of state X"
with a **real Groth16 (BN254) proof**, verified on-chain via the `ecPairing` precompile (0x08)
inside `0x2A`, without revealing anything else.

Takers can instead present a **World ID** proof of personhood (`verifierType = 1`): `WorldIDAdapter`
calls the World ID Router's `verifyProof` with the signal bound to the taker's address, and the
same `0x2A → 0x7A` path grants the same retail fee tier. Global biometric proof-of-personhood and
sovereign Indian regional verification are two doors into one fee logic.

## Judge quick-start

```bash
yarn && (cd packages/zk-aadhaar && npm install) && (cd packages/world-id && npm install) && (cd ui && npm install)
node packages/zk-aadhaar/prover/fetch-artifacts.mjs   # once: official Anon Aadhaar v2 artifacts, ~620 MB, SHA-256 pinned
node packages/world-id/prover/fetch-artifacts.mjs     # once: Semaphore depth-30 artifacts (World ID's verifier key), ~5.7 MB, pinned

npx hardhat test && forge test                        # 111 Hardhat tests (10 REAL Anon Aadhaar + 8 REAL World ID proofs) + 19 Foundry properties
npx hardhat run scripts/demo-mumbai.ts                # CLI demo: real Aadhaar proof (1A) + real World ID proof (1B) + gas breakdowns
./scripts/start-local-demo.sh                         # node + local prover + artifacts + seed + UI at http://127.0.0.1:5173
cd ui && npm run smoke                                # headless, both ZK Pass tabs: World ID Semaphore proof + Aadhaar QR → RSA → Groth16 → on-chain verify → swap()
```

Without the artifacts, the real-proof tests **skip with a warning** and the demo falls back to
the mock verifiers, with a banner saying so. Each real Aadhaar proof takes ~13 s in Node and a
few GB of RAM; a World ID (Semaphore depth-30) proof takes ~0.4 s.

---

## Architecture

```
 ┌──────────────────────── client (browser tab + local prover on 127.0.0.1) ────────────────────────┐
 │ Aadhaar Secure QR ─▶ zkAadhaar: digits → BigInt → gunzip → fields | photo | 256-B signature      │
 │   (upload / test QR)   RSA-2048 PKCS#1 v1.5 check vs pinned UIDAI certs (Web Crypto, in-browser) │
 │                     ─▶ prover: Anon Aadhaar v2 circuit (RSA + SHA-256 in-circuit) · snarkjs      │
 │                         public: pubkeyHash, epoch nullifier, timestamp, ageAbove18, state, seed, │
 │                                 signalHash = keccak(taker) >> 3      → groth16Proof uint256[8]   │
 │                     ─▶ takerData = takerTraits ‖ [len ‖ nullifier ‖ revealArray ‖ (ts, proof)]   │
 └───────────────────────────────────────────────────┬─────────────────────────────────────────────┘
                                                     │ swap / quote
 ┌──────────────────────────────── AegisSwapVMRouter (SwapVM + AquaOpcodes) ───────────────────────┐
 │ 0x0D Deadline                                                                                    │
 │ 0x2A ZKIdentityGuard ─staticcall▶ type 2: AnonAadhaarAdapter (epoch seed, freshness, signal)     │
 │      │                              │   └▶ AnonAadhaarGroth16Verifier → Verifier.sol → ecPairing │
 │      │                              └▶ type 1: WorldIDAdapter (signalHash = taker, ext. nullifier)│
 │      │                                  └▶ IWorldID router: verifyProof(root, 1, …, proof[8])    │
 │      └─ verified ⇒ ctx.vm.dispatch := _dispatchVerifiedHuman; nullifier → beneficiary binding     │
 │ 0x9A JITVaultReserves ─staticcall▶ ERC-4626 vaults (λ cap on live backing, virtual offsets)      │
 │ 0x0B/0x2B/0x0A RequireMinRate band (two-sided floor)                                             │
 │ 0x7A VolatilitySurgeFee (rolling-window surge; human base-fee discount via dispatcher)           │
 │ 0x11 XYCSwap                                                                                     │
 └──────────────┬──────────────────────────────────────────────────────────────┬────────────────────┘
                │ AQUA.pull / push (virtual balances)                           │ Maker hooks
                ▼                                                               ▼
          ┌──────────┐ ◀── ship(strategy) ── Maker EOA (holds vault shares) ── AegisJITVaultHook:
          │   Aqua   │                                                          withdraw amountOut JIT,
          └──────────┘                                                          re-deposit amountIn
                                                    avUSDC / avWETH MockERC4626Vault (yield-bearing)
```

**Program** (compiled identically by `src/aegisProgramBuilder.ts` and `contracts/AegisJITStrategy.sol`):

```
[0] 0x0D Deadline              strategy expiry
    (Aqua balances)            preloaded by the router — not an opcode
[1] 0x2A ZKIdentityGuard       tier / gate the taker (World ID or ZK Aadhaar proof)
[2] 0x9A JITVaultReserves      λ cap + virtual offsets — wraps everything below
[3] 0x0B JumpIfTokenIn ─┐      two-sided hard price floor:
[4] 0x2B RequireMinRate │A→B     never sell WETH < 2,000 USDC
[5] 0x0A Jump ──────────┼─┐
[6] 0x2B RequireMinRate ◀┘│B→A   never buy WETH > 3,000 USDC
[7] 0x7A VolatilitySurgeFee◀┘  dynamic LVR fee (human discount via dispatcher)
[8] 0x11 XYCSwap               constant product over virtual reserves
```

Every instruction uses SwapVM framing `[opcode:1][argsLength:1][args]`. The full design is in
**[docs/SPEC.md](docs/SPEC.md)**, including the deviations from the original brief and why.

## Opcode byte-layout specification

Integers are big-endian and tightly packed. Fee rates use SwapVM's `BPS = 1e9` (= 100%).
λ, boost and utilization use 1e4 (= 100% / 1.0x).

### `0x2A ZKIdentityGuard` — 46 bytes
| Offset | Size | Type | Field | Notes |
|---:|---:|---|---|---|
| 0 | 1 | `uint8` | `verifierTypes` | accepted proof types, bitmask: `1` World ID, `2` ZK Aadhaar, `3` either |
| 1 | 1 | `uint8` | `mode` | `0` strict (reverts `ZKVerificationFailed()`), `1` tiered (never reverts) |
| 2 | 4 | `uint32` | `requiredStateCode` | `0` = any; else must equal Aadhaar `revealArray[3]` (type 2 only) |
| 6 | 20 | `address` | `worldIdVerifier` | `IZKVerifier` for type 1 (`WorldIDAdapter`); zero iff bit `1` unset |
| 26 | 20 | `address` | `aadhaarVerifier` | `IZKVerifier` for type 2 (`AnonAadhaarAdapter`); zero iff bit `2` unset |

Taker payload (consumed with `tryChopTakerArgs`), typed by its first byte:
`[uint16 L][verifierType:1][nullifier:32][revealArray:4×32 — type 2 only][proof]`.
- **Type 1, World ID:** `nullifier` = World ID `nullifierHash`, `proof` =
  `abi.encode(merkleRoot, uint256[8])` (or `(merkleRoot, recipient, uint256[8])` via a trusted
  forwarder). The adapter calls `IWorldID.verifyProof(root, groupId = 1, hashToField(taker),
  nullifierHash, externalNullifierHash, proof)` under STATICCALL.
- **Type 2, ZK Aadhaar:** `revealArray = [ageAbove18, gender, pincode, state]`, `proof` =
  `abi.encode(timestamp, uint256[8])` (or with `recipient`). `revealArray[0]` must be 1 and the
  state must match.

The taker is verified iff the Maker accepts the type, the adapter returns `true` for
`ctx.query.taker`, and the per-verifier nullifier binding allows it. Binding the proof to the
taker stops a bot replaying a human's proof; binding the nullifier to the first address stops one
human farming the discount from many wallets.

### `0x9A JITVaultReserves` — 82 bytes
| Offset | Size | Type | Field | Notes |
|---:|---:|---|---|---|
| 0 | 20 | `address` | `vaultA` | ERC-4626 for the lower-address token, or `0` = Aqua balance |
| 20 | 20 | `address` | `vaultB` | ERC-4626 for the higher-address token, or `0` |
| 40 | 4 | `uint32` | `lambdaBps` | per-execution exposure cap, `(0, 10000]` |
| 44 | 6 | `uint48` | `virtualBoostBps` | `>= 10000`; virtual offset = `(boost − 1) · ref` |
| 50 | 16 | `uint128` | `refA` | Maker's committed Aqua allocation of tokenA |
| 66 | 16 | `uint128` | `refB` | Maker's committed Aqua allocation of tokenB |

`capOut = min(λ · convertToAssets(balanceOf(maker)), aquaBalanceOut)`. The opcode reverts
`JITExposureCapExceeded(amountOut, capOut)` above the cap. Only STATICCALLs, zero SSTORE.

### `0x7A VolatilitySurgeFee` — 20 bytes
| Offset | Size | Type | Field | Notes |
|---:|---:|---|---|---|
| 0 | 4 | `uint32` | `baseFeeBps` | 1e9 = 100%; halved for verified humans |
| 4 | 4 | `uint32` | `maxSurgeFeeBps` | marginal rate above threshold; `base <= max <= 50%` |
| 8 | 8 | `uint64` | `impactThresholdBps` | utilization of `balanceIn` (1e4 = 100%) where surge begins |
| 16 | 4 | `uint32` | `decayWindowSec` | flow-accumulation window (`0` = stateless) |

`fee(g) = ceil((g·b + max(0, g − G0)·(max − base)) / 1e9)`, where `G0` is the threshold minus
the flow already in the window. exactOut uses the closed-form inverse plus an integer fix-up,
which yields the minimal gross input.

## Invariants proved in `test/AegisJIT.test.ts`

| # | Invariant | How |
|---|---|---|
| 1 | **quote == swap** | 10 direction/tier/mode cases on non-trivial window state, plus a real STATICCALL via `StaticQuoter` |
| 2 | **Symmetry** | `exactIn(X)→Y`, `exactOut(Y)→X'`: `X' ≤ X`, `X − X' ≤ 2 wei` (measured on the coarse 6-dp side) |
| 3 | **Sub-additivity** | 2 × ½ never beats 1 × full, exactIn and exactOut, both tiers and directions |
| 4 | **Monotonicity** | strictly increasing output; average price never improves with size |
| 5 | **ZK tier differentiation** | human > bot on the same trade; discount is exactly 50% of base; replayed, forged, under-18 and wrong-state proofs get no discount; strict mode reverts; a World ID proof and a ZK Aadhaar proof get the identical tier (`test/WorldIDAdapter.test.ts`) |
| 6 | **JIT protection** | a 500k whale is blocked; the maximum single execution is exactly λ of the vault; the cap tracks live vault withdrawals and yield |
| + | Round-trip safety, self-custody (vault == Aqua book, no idle tokens), TS == Solidity builder parity, and an independent off-chain model of the math |

Mutation-checked: making the fee stateless makes 9 sub-additivity tests fail, and disabling
the verified-human dispatcher makes the tier tests fail.

## ETHGlobal Mumbai sponsor integration

### 1inch Aqua + SwapVM
- `AegisSwapVMRouter` extends SwapVM with the full `AquaOpcodes` set plus `MinRate` and three
  new opcodes. Every unknown opcode falls through to `AquaOpcodes._runOpcode`.
- Strategies are shipped with `Aqua.ship()` as **virtual balances**, so no tokens move at
  registration. Settlement uses `AQUA.pull` / `AQUA.push`, and Aqua's book stays exactly equal
  to the vault backing.
- The ZK tier is passed to the fee opcode by **switching the VM's own dispatcher**
  (`ctx.vm.dispatch`). This is pure memory, so it is valid inside `quote()` (a `view`,
  STATICCALL'd by aggregators), where transient storage would revert.
- The two-sided rate floor is built from native SwapVM control flow
  (`JumpIfTokenIn` / `Jump` / `RequireMinRate`).
- The router is 21.0 KB (EIP-170 compliant). It is compiled with the full Yul optimizer; the
  stock `AquaSwapVMRouter` is 24.3 KB with the template's minimal step sequence.

### Circle USDC vault (ERC-4626)
- The Maker's USDC sits in an ERC-4626 vault (`MockERC4626Vault`, standard OpenZeppelin) and
  keeps earning yield. The vault is a drop-in slot for any USDC ERC-4626 yield vault.
- `AegisJITVaultHook` redeems exactly `amountOut` just before Aqua pulls it, and re-deposits
  `amountIn` right after. The Maker's wallet ends every swap holding only vault shares.
- `0x9A` reads `convertToAssets(balanceOf(maker))` live. Vault yield raises the exposure cap
  automatically, and a Maker withdrawal shrinks it immediately, with no re-configuration.

### World ID (global proof of personhood)
- **`WorldIDAdapter`** (`contracts/zk/WorldIDAdapter.sol`, MIT) implements the same `IZKVerifier`
  as the Aadhaar adapter, so the opcode treats both alike. It calls the World ID Router's
  6-argument `verifyProof(root, groupId, signalHash, nullifierHash, externalNullifierHash, proof)`
  (`contracts/zk/world-id/IWorldID.sol`, the on-chain-template interface) with:
  - `groupId = 1` (Orb-verified humans);
  - `signalHash = ByteHasher.hashToField(abi.encodePacked(taker))` — the signal **is the taker's
    address**, hashed exactly as IDKit / World App do for an address signal, so a copied proof is
    useless from any other address;
  - `externalNullifierHash = hashToField(abi.encodePacked(hashToField(appId), action))` from the
    adapter's `appId` / `action` (one action = one `nullifierHash` per human).
  - The router call is a STATICCALL inside `try/catch`: any revert (`NonExistentRoot`,
    `ExpiredRoot`, `ProofInvalid`, …) means "unverified", and the adapter itself never reverts.
- **Sybil policy.** `0x2A` binds the World ID `nullifierHash` to the first address that swaps with
  it (`nullifierTaker[worldIdAdapter][nullifierHash]`): one discounted address per human. The
  Aadhaar adapter keeps its epoch-rotating nullifiers; the two schemes never share a namespace.
- **Real proofs, World ID's real verifier.** `contracts/zk/vendor/world-id/SemaphoreVerifier.sol`
  is World ID's own Groth16 verifier (world-id-contracts, MIT; only the import path changed). All
  24 verification-key constants in it equal the key exported from the public Semaphore depth-30
  trusted-setup zkey (SHA-256 pinned in `packages/world-id/prover/fetch-artifacts.mjs`).
  `packages/world-id` builds a local depth-30 identity tree from Semaphore v3 identities and
  proves membership with snarkjs (~0.4 s), using World ID's hashing for `signalHash` and the
  external nullifier. So the proofs verified here are checked by the exact contract World ID runs
  on-chain; the only local part is the tree, where the project plays the signup sequencer.
- **Local World ID stack.** `MockWorldIDRouter` mirrors the Router + Identity Manager: group
  routing (`NoSuchGroup`), root history with the 1-hour `ExpiredRoot` window, `NonExistentRoot`,
  an identity-operator-only `registerRoot`, and delegation of the pairing check to an
  `IWorldIDSemaphoreVerifier` — the vendored `SemaphoreVerifier` in the end-to-end paths, or
  `MockSemaphoreVerifier` (accepts only exactly-registered statements; no hardcoded success) where
  real proving is impossible (Foundry fuzzing, malformed inputs).
- **Measured costs** (Hardhat, cancun): `SemaphoreVerifier.verifyProof` 239,014 gas incl. the 21k
  base; `ecPairing` 181,100; the whole 0x2A verifier call ≈ 224k; a swap with a World ID proof
  ≈ 535k vs ≈ 316k without (overhead ≈ 219k, ~50k less than the 9-input Anon Aadhaar verifier).
- **Tests.** `test/WorldIDAdapter.test.ts` (mock verifier): valid proof → same tier as Aadhaar,
  quote == swap, `NullifierBound`; unknown root, expired root, wrong group, tampered proof,
  foreign app/action, malformed envelopes → bot tier without reverting; reused nullifier from a
  second wallet → bot tier; replayed takerData → bot tier (strict mode reverts); Maker policy
  `verifierTypes` 1 / 2 / 3; trusted-forwarder envelope; real STATICCALL quote.
  `test/RealWorldIDSwap.test.ts` (real proofs, real verifier): tree root == registered root,
  World ID hashing conventions, pairing accept / reject, swap with `ecPairing` in the trace,
  replay, Sybil with a fresh proof from a second wallet, root lifecycle, tampered proof.
  `test/foundry/WorldIDAdapter.t.sol`: 5,000-run fuzz of signal binding, external nullifier,
  root history, router access, forwarder envelopes and malformed input, plus the committed real
  proof (`test/fixtures/world-id/human-proof.json`) against the vendored verifier with every
  proof word fuzzed.
- Production wiring: deploy `WorldIDAdapter(worldIdRouter, 1, "app_…", "aegis-jit-fee-tier", [forwarder])`
  with the World ID Router address of the target chain, and pass the IDKit result's
  `merkle_root`, `nullifier_hash` and `proof` into `encodeWorldIdTakerArgs`.

### Anon Aadhaar + zkAadhaar (identity)
- **zkAadhaar** (`packages/zk-aadhaar`, MIT) handles the Secure QR offline:
  - scanner (zxing-wasm), decimal → GZIP → field parser (Legacy, V2, V3, V5), JPEG 2000 photo;
  - RSA-2048 signature check against pinned UIDAI certificates (2017–2029 keys).
- **Real Groth16.** `packages/zk-aadhaar/prover` builds inputs for the official Anon Aadhaar v2
  circuit and proves with snarkjs. The artifacts come from Anon Aadhaar's S3 with pinned
  SHA-256, and the zkey's verification key equals all 26 constants in the official `Verifier.sol`.
- **On-chain chain of contracts:**
  - `AnonAadhaarAdapter` (epoch-rotating seed, freshness, `signal = beneficiary`,
    constructor-fixed forwarders);
  - → `AnonAadhaarGroth16Verifier` (trust root = circuit hash of the RSA key);
  - → vendored, unmodified `Verifier.sol` → `ecPairing`.
- **Measured costs:** `ecPairing` 181,100 gas; whole 0x2A verification ≈ 266k; ZK overhead on a
  swap ≈ 268k gas.
- **Test trust root.** Locally, synthetic **V2** QRs are signed by the committed *AegisJIT TEST
  signer* (`packages/zk-aadhaar/prover/test-signer`, NOT UIDAI), and the verifier's trust root
  is that key's hash. A verifier pinned to the UIDAI key hash rejects these proofs (tested).
- `MockGroth16AnonAadhaar` (same ABI; accepts only exactly-registered public signals) is kept
  where speed matters:
  - the 5,000-run Foundry fuzz;
  - fast adapter unit tests that need inputs a real prover can't produce (wrong seeds,
    malformed bytes, future timestamps).
- `MockAnonIdentityVerifier` (ECDSA attestation) still backs the opcode invariant suite.

## CROPS Evaluation (Ethereum Foundation)

**Censorship resistance**
- Makers keep custody: capital stays in their own ERC-4626 positions, and strategies are
  immutable Aqua orders that no operator can pause.
- Tiered mode (`mode = 1`, the default) **never reverts**. Unverified takers still trade, at
  the bot fee tier, so identity is a discount, not a gate. Strict mode is opt-in per order.
- No relayer or allow-list sits between the taker and the router. Proofs are generated on the
  user's own machine from their own QR. In this repo that is a local Node prover the browser
  calls on 127.0.0.1; the QR never goes to a remote server. Anon Aadhaar also supports fully
  in-browser proving, but it needs the 612 MB zkey in the browser, which isn't wired here.

**Open source**
- Source for every component is in this repo. Licences are split (see
  [License & licensing boundary](#-license--licensing-boundary)):
  - MIT: ZK adapter, verifier interface, JIT hook, mocks, scripts, tests and UI.
  - `LicenseRef-Degensoft-SwapVM-1.1`: the opcodes and router, because they compile into
    SwapVM. SwapVM-1.1 is a source-available copyleft licence with commercial triggers, not
    an OSI-approved open-source licence. Judges should weigh that.

**Privacy — epoch-rotating nullifiers**
- No name, Aadhaar number, photo or address goes on-chain. Calldata carries:
  - `ageAbove18`; `state` only if the order requires it (gender and pincode stay 0);
  - the proof timestamp and the Groth16 proof;
  - `signal`, which is the beneficiary address and already public;
  - one **nullifier per epoch**.
- **Unlinkability across epochs.** In Anon Aadhaar the nullifier is
  `Poseidon(nullifierSeed, photo)`, with `nullifierSeed` as a public circuit input.
  `AnonAadhaarAdapter` requires `nullifierSeed = keccak256(APP_SEED, ⌊block.timestamp / EPOCH⌋) mod p`.
  So the same person shows a **different, unlinkable nullifier every epoch**. This is verified
  with real proofs of the same QR in two epochs (`test/EpochNullifiers.test.ts`). The adapter
  rejects any other seed, so a client can't opt into a stable pseudonym.
- **Sybil-bound within an epoch.** 0x2A binds `nullifier → beneficiary` on first swap, giving one
  discounted address per human per epoch. In the next epoch the human can use a fresh wallet.
  Because the nullifier changed, nothing on-chain ties it to the previous wallet.
- **What rotation does *not* hide:**
  - trades by the same wallet (they share an address);
  - funding flows between a user's wallets;
  - all verified trades within one epoch (they share a nullifier).

  Shorter epochs mean less linkability but more frequent re-proving (~13 s per proof in Node).

**Relayers / aggregators**
- `AnonAadhaarAdapter` accepts a forwarded envelope `(timestamp, recipient, proof)`. The signal
  must equal `recipient`, and this is only honoured when the taker is a forwarder fixed in the
  adapter's constructor (no admin, no setters). The nullifier binds to `recipient`, so a shared
  aggregator can't be used to farm discounts.
- Reference forwarder `AegisZKForwarder` requires `recipient == msg.sender`, sends the output to
  `msg.sender`, and pulls the input from `msg.sender`. A searcher replaying someone's forwarder
  calldata is reverted. A non-whitelisted relayer simply gets bot pricing.

**Security**
- Mempool hijack: a proof copied into a searcher's own transaction fails the
  `signal = uint160(taker)` check, and the searcher pays the bot tier. This is tested by
  replaying the exact takerData bytes, and fuzzed in Foundry.
- One identity cannot farm discounts across wallets (nullifier binding), and stale proofs
  are rejected (freshness window).
- Maker protection:
  - λ caps any single execution at 25% of the live vault;
  - virtual depth uses constant offsets, so buy-then-sell round trips can't drain the Maker;
  - the rolling surge window makes split trades pay the same fee as one trade;
  - two-sided `RequireMinRate` floors.
- `quote()` is STATICCALL-safe (proven with a real STATICCALL) and equals `swap()` to the wei.
- **Not audited.**

## SwapVM Inspector UI (`ui/`)

Vite + React + TypeScript + Tailwind + viem. `./scripts/start-local-demo.sh` starts
`hardhat node`, runs `scripts/seed-local.ts` (writes `ui/public/deployment.json`), and opens
the UI.

- **ZK Pass selector.** Two tabs feed the same `0x2A` opcode:
  - **🌍 World ID (Global)** — a Semaphore v3 identity from the local World ID tree, a Groth16
    membership proof generated **in the browser** (snarkjs over the public depth-30 artifacts,
    served from `/semaphore/30`), checked with an `eth_call` through
    `WorldIDAdapter → MockWorldIDRouter → SemaphoreVerifier` (World ID's own), then attached as
    a type-1 payload. The witness never leaves the tab. A "Production: World App via IDKit"
    box encodes a pasted IDKit result (`merkle_root`, `nullifier`, `proof`) into the same payload
    and reports, honestly, that a real World ID root is not known to the local router.
  - **🇮🇳 ZK Aadhaar (India Sovereign)** — the Secure QR scanner, in-browser RSA-2048 check and
    Anon Aadhaar Groth16 proof via the local prover, attached as a type-2 payload.
- **Bytecode disassembler.** The order is decoded live from Aqua's `Shipped` event, not from
  a file. Each `[opcode][len][args]` frame is colour-coded: `0x2A` emerald (both verifier slots
  and `verifierTypes` decoded), `0x9A` indigo (λ and constant offsets decoded), `0x7A` amber
  (fees and window decoded), stock opcodes slate. Hovering links the hex to the decoded card.
  With a pass attached the `0x2A` card reads `PASSED (World ID Verified · type 1 …)` or
  `PASSED (Groth16 Aadhaar Verified · type 2 …)`; the simulator shows the live fee drop
  (0.30% → 0.15%) and the 0 wei quote-vs-swap divergence for whichever pass is attached.
- **Simulator.** Profiles: verified human, MEV bot, split attacker (5×), whale. The slider
  calls `router.asView().quote()` live, alongside the effective fee (bps), the rolling-window
  accumulator vs threshold, and a check against an independent TS model of the opcode math.
  "Execute" sends a real `swap()` and shows quote vs executed and the divergence (0 wei).
  The split attack runs inside `evm_snapshot` / `evm_revert`. The whale shows the decoded
  `JITExposureCapExceeded`.
- **Vault panel.** Shows the λ-exposed slice vs the untouched, yield-earning reserve, and
  whether the Aqua book equals the vault backing.
- `cd ui && npm run smoke` checks the same client library headlessly against a seeded node,
  for both tabs: it rebuilds the World ID tree, generates a Semaphore proof with the dashboard's
  own code path, verifies it on-chain, rebuilds the takerTraits header, compares the World ID
  and Aadhaar quotes (identical tier), swaps with both, and checks replay protection.

## Demo (`scripts/demo-mumbai.ts`)

The demo deploys Aqua, WETHMock, USDC, two vaults (1,000,000 USDC + 400 WETH), both verifier
stacks and the router, then ships the strategy and runs five on-chain scenarios. It prints tx
hashes, gas, and vault balances before and after each one:

| Scenario | Result |
|---|---|
| 1A · Verified human via ZK Aadhaar, 5,000 USDC → WETH | **real** Anon Aadhaar Groth16 proof from a signed test QR (~13 s) → `0x2A` type 2 → 0.15% fee vs 0.30% for a bot; quote == swap (0 wei) |
| 1B · Verified human via World ID, 5,000 USDC → WETH | **real** Semaphore depth-30 Groth16 proof (~0.4 s) → `0x2A` type 1 → `WorldIDAdapter` → World ID's `SemaphoreVerifier` (ecPairing 181,100 gas) → 0.15% fee, the identical tier; World ID overhead ≈ 219k gas |
| 2 · Unverified bot, 50,000 USDC → WETH | `0x7A` surge: 150 USDC base + 480 USDC surge (1.26% effective, with the two 5k human trades already in the window) |
| 3 · Toxic whale, 500,000 USDC → WETH | **reverted** by `0x9A` (`JITExposureCapExceeded`); vault untouched, 75% structurally out of reach |
| 4 · Split attack, 5 × 10,000 vs 1 × 50,000 USDC | fresh window, snapshot/revert A/B: split pays **the same** 503.40 USDC fee and gets 0.0011 WETH **less**; a stateless fee would have charged 150 USDC |

For each filled swap the demo prints the decoded ERC-20 `Transfer` trace: vault share burn →
WETH out of the vault → `Aqua.pull` to the taker → taker USDC → router → `Aqua.push` to the
Maker → hook → vault deposit and share mint.

## Project structure

```
contracts/
  AegisSwapVMRouter.sol        router: SwapVM + AquaOpcodes + MinRate + AegisJIT opcodes
  AegisJITStrategy.sol         on-chain program/order builder
  AegisJITVaultHook.sol        JIT withdraw/deposit Maker hook
  AegisZKForwarder.sol         reference trusted forwarder (recipient == msg.sender)
  instructions/                ZKIdentityGuard · JITVaultReserves · VolatilitySurgeFee
  interfaces/IZKVerifier.sol
  zk/                          IAnonAadhaar · AnonAadhaarAdapter · AnonAadhaarGroth16Verifier · WorldIDAdapter
  zk/world-id/                 IWorldID (router interface) · ByteHasher · IWorldIDSemaphoreVerifier
  zk/vendor/world-id/          SemaphoreVerifier.sol (World ID's, MIT, one import path changed) + ISemaphoreVerifier
  zk/vendor/anon-aadhaar/      Verifier.sol (official, unmodified, GPL-3.0)
  libs/AegisOpcodes.sol
  mocks/                       MockAnonIdentityVerifier · MockGroth16AnonAadhaar · MockWorldIDRouter · MockSemaphoreVerifier · MockERC4626Vault · StaticQuoter
src/aegisProgramBuilder.ts     TypeScript SDK (programs, orders, ZK taker payloads)
packages/zk-aadhaar/           zkAadhaar QR scanner/parser/RSA verifier (Next.js app + libs)
  prover/                      Anon Aadhaar inputs + snarkjs prover · CLI · 127.0.0.1 service · test signer
packages/world-id/             World ID-compatible local tree + prover (Semaphore v3, depth 30, snarkjs) · CLI · artifact fetcher
test/AegisJIT.test.ts          invariant suite      test/AnonAadhaarAdapter.test.ts · test/WorldIDAdapter.test.ts
test/RealGroth16Swap.test.ts   real proofs → swap   test/EpochNullifiers.test.ts (epochs, forwarders)
test/RealWorldIDSwap.test.ts   real World ID proofs → swap   test/fixtures/world-id/ (committed real proof)
test/foundry/                  fee-math, Aadhaar adapter and World ID adapter fuzzing (+ real pairing)
scripts/demo-mumbai.ts         judge CLI demo       scripts/seed-local.ts · start-local-demo.sh
ui/                            SwapVM Inspector (dual-tab ZK Pass: WorldIdPass · AadhaarPass · lib/worldid)   docs/SPEC.md    spec & deviations
```

The original template (`AquaAMM`, `MockTaker`, `deploy/`) is unchanged and its tests still pass.

## Known limits

- The surge window resets at expiry, so a patient taker who splits across windows pays less
  surge.
- λ caps a *single* execution. Cumulative exposure is bounded by the Aqua allocation.
- Local deployments trust the AegisJIT TEST signer. Production must deploy
  `AnonAadhaarGroth16Verifier` with the UIDAI key hash. Upstream only publishes the 2021 key's
  hash, so the hash for the current (2026) key has to be computed with the circuit and checked
  independently.
- The circuit parses the **V2** layout (≤ 1536 padded bytes). Whether current V5 e-Aadhaar QRs
  fit hasn't been verified. zkAadhaar parses them, but proving may fail.
- Proving runs in a local Node process, not inside the browser.
- Each epoch needs a fresh proof. Proofs also expire after 24 h because the QR timestamp
  must be recent.
- World ID locally means a local identity tree: the project is its own signup sequencer, and
  `MockWorldIDRouter` publishes its roots. On a live network the adapter points at the World ID
  Router and takers prove with World App / IDKit; nothing in the adapter or the opcode changes.
- The World ID external nullifier is one action, so a human's `nullifierHash` is stable: trades
  of the bound address are linkable to one another (they share an address anyway). Rotating the
  action per epoch, as the Aadhaar seed rotates, is possible but not implemented.
- Not audited.

## Disclaimer

This software is provided "as is", without warranty of any kind. Use at your own risk.

## 📄 License & licensing boundary

**Powered by SwapVM — © Degensoft Ltd 2025.** Aqua © Degensoft Ltd 2025.

This repo mixes two licences. The split follows SwapVM-1.1. §1.7(b) treats instruction
programs that run in the same EVM address space as a *Modification*, and §3.1A requires
Modifications to be published under SwapVM-1.1. §3.3 exempts independent code that only
calls or interfaces with SwapVM.

| Licence | Files | Why |
|---|---|---|
| `LicenseRef-Degensoft-SwapVM-1.1` | `contracts/AegisSwapVMRouter.sol`, `contracts/instructions/*`, `contracts/AegisJITStrategy.sol`, `contracts/AegisZKForwarder.sol` (uses `TakerTraitsLib`), `contracts/libs/AegisOpcodes.sol`, `test/foundry/SurgeFeeMath.t.sol` | Inherit or import SwapVM implementation code (`SwapVM`, `AquaOpcodes`, `ContextLib`, `MinRate`, arg builders) and are compiled into the router runtime |
| `LicenseRef-Degensoft-SwapVM-1.1` | `src/aegisProgramBuilder.ts`, `test/utils/aegisFixture.ts` | Import the swap-vm-template helper `test/utils/SwapVMHelpers.ts` |
| `LicenseRef-Degensoft-SwapVM-1.1` (unchanged template files) | `AquaAMM.sol`, `MockTaker.sol`, `deploy/`, `test/AquaAMM.test.ts`, `test/utils/{fixtures,ProgramBuilder,SwapVMHelpers}.ts` | Original swap-vm-template |
| `GPL-3.0` (unmodified vendor) | `contracts/zk/vendor/anon-aadhaar/Verifier.sol` | snarkjs-generated Groth16 verifier from Anon Aadhaar v2; deployed separately and called via an independently written interface |
| `MIT` (vendor, one import path changed) | `contracts/zk/vendor/world-id/SemaphoreVerifier.sol`, `ISemaphoreVerifier.sol` | World ID's Groth16 verifier from worldcoin/world-id-contracts; deployed separately and called via the independently declared `IWorldIDSemaphoreVerifier` |
| `MIT` | `packages/world-id/` | Local Semaphore v3 identity tree + prover (uses `@semaphore-protocol/*` and snarkjs, MIT/GPL-3.0 runtime deps, not redistributed) |
| `MIT` | `packages/zk-aadhaar/` (Aadhaar Secure-QR scanner/parser/RSA verifier + Node Groth16 prover) | Independent; reuses circuit-input encoding from `@anon-aadhaar/core` (MIT, Ethereum Foundation) |
| `MIT` | `contracts/interfaces/IZKVerifier.sol`, `contracts/zk/*.sol`, `contracts/zk/world-id/*.sol` (World ID interfaces, after worldcoin/world-id-onchain-template, MIT), `contracts/AegisJITVaultHook.sol`, `contracts/mocks/*`, `test/*.test.ts` (AegisJIT), `scripts/*`, `ui/` | Independent code that only implements or calls interfaces (`IMakerHooks`, `ISwapVM`) or talks to deployed contracts via ABI/RPC (§3.3) |

Full texts: [LICENSE](LICENSE), [LICENSES/](LICENSES/),
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES). SwapVM-1.1 makes hackathon and non-commercial
use free (§4). Commercial triggers (§5) apply above US$100k fees per year or US$10M
liquidity under control. This summary is not legal advice.

### Changes to the swap-vm-template (SwapVM-1.1 §3.1D)
| Date | File | Change |
|---|---|---|
| 2026-11-05 | `hardhat.config.ts` | added `TokenCustomDecimalsMock` to `dependencyCompiler`; full-Yul-optimizer override for `AegisSwapVMRouter.sol` (EIP-170) |
| 2026-11-05 | `tsconfig.json` | include `src/` and `scripts/` |
| 2026-11-05 | `README.md` | rewritten for AegisJIT |
| 2026-11-05 | `.gitignore` | Foundry output dirs |

Everything else under the template's original paths is unchanged.
