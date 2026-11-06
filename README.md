# AegisJIT — Custom-Opcode AMM & Self-Custodial JIT Liquidity Vault

Built on **1inch Aqua** and **1inch SwapVM** for ETHGlobal Mumbai 2026.

AegisJIT lets a Maker keep 100% of their capital in ERC-4626 yield vaults, in their own wallet,
while quoting deep liquidity to takers. Three custom SwapVM opcodes do the work inside the
interpreter loop:

| Opcode | Instruction | What it does |
|--------|-------------|--------------|
| `0x2A` | **ZKIdentityGuard** | Modular verifier router: verifies a **World ID** proof (type 1, `WorldIDAdapter` → World ID Router) or a **ZK Aadhaar** proof (type 2, `AnonAadhaarAdapter` → Anon Aadhaar Groth16) from the taker's calldata (STATICCALL). It either gates the order (strict mode) or tiers the taker as *verified human* vs *unverified bot* (tiered mode). Both pathways land in the same 0x7A discount. The first swap binds the proof's nullifier to the taker; later swaps in the same epoch send a **33-byte binding claim** instead of the proof and skip the pairing entirely. |
| `0x9A` | **JITVaultReserves** | Reads the Maker's **live** ERC-4626 backing (`maxWithdraw`) and caps every execution **and every window** at **λ** (e.g. 25%) of it: a token bucket on a fixed time grid, so a drain split into many executions, even inside one block, gets one budget per window. It also adds virtual depth (`boost`) without locking extra capital. quote == swap. |
| `0x7A` | **VolatilitySurgeFee** | Applies a size- and flow-aware LVR fee: base fee below a utilization threshold, surge fee above it, measured on the flow in a token bucket that leaks one threshold per window and never resets, so split trades can't dodge it and a burst keeps the surge on. Verified humans pay half the base fee. |

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

npx hardhat test && forge test                        # 128 Hardhat tests (with REAL Anon Aadhaar and World ID proofs) + 19 Foundry properties
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
 │                     ─▶ takerData = takerTraits ‖ [len ‖ nullifier ‖ revealArray ‖ (ts, epoch, key, proof)] │
 │                        (or, once bound: takerTraits ‖ [33 ‖ type ‖ nullifier] — no proof at all)   │
 └───────────────────────────────────────────────────┬─────────────────────────────────────────────┘
                                                     │ swap / quote
 ┌──────────────────────────────── AegisSwapVMRouter (SwapVM + AquaOpcodes) ───────────────────────┐
 │ 0x0D Deadline                                                                                    │
 │ 0x2A ZKIdentityGuard ─staticcall▶ type 2: AnonAadhaarAdapter (epoch seed + grace, key set, signal │
 │      │                              │        or EIP-712 taker authorisation, QR freshness)         │
 │      │                              │   └▶ AnonAadhaarGroth16Verifier → Verifier.sol → ecPairing │
 │      │                              └▶ type 1: WorldIDAdapter (signalHash = taker, ext. nullifier)│
 │      │                                  └▶ IWorldID router: verifyProof(root, 1, …, proof[8])    │
 │      └─ verified ⇒ ctx.vm.dispatch := _dispatchVerifiedHuman; nullifier → {beneficiary, validUntil} │
 │         (a live binding + msg.sender == beneficiary ⇒ 33-byte claim, no adapter call)             │
 │ 0x9A JITVaultReserves ─staticcall▶ ERC-4626 maxWithdraw (λ cap + λ budget per window, offsets)   │
 │ 0x0B/0x2B/0x0A RequireMinRate band (two-sided floor)                                             │
 │ 0x7A VolatilitySurgeFee (token-bucket surge; human base-fee discount via dispatcher)             │
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
[2] 0x9A JITVaultReserves      λ cap + λ budget per window + virtual offsets — wraps everything below
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
  `abi.encode(merkleRoot, epoch, uint256[8])` (320 B), or `abi.encode(merkleRoot, epoch, recipient,
  authDeadline, r, s, v, uint256[8])` (480 B) when a contract presents it for `recipient`. The
  adapter calls `IWorldID.verifyProof(root, groupId = 1, hashToField(beneficiary), nullifierHash,
  externalNullifierFor(epoch), proof)` under STATICCALL.
- **Type 2, ZK Aadhaar:** `revealArray = [ageAbove18, gender, pincode, state]`, `proof` =
  `abi.encode(timestamp, epoch, pubkeyHash, uint256[8])` (352 B), or with `(recipient, authDeadline,
  r, s, v)` (512 B). `revealArray[0]` must be 1 and the state must match. `pubkeyHash` selects the
  UIDAI key from the verifier's trusted set (0 = primary key).
- **Binding claim (either type):** `[uint16 33][verifierType][nullifier]`, no proof. Honoured iff the
  nullifier is bound to `msg.sender` and the binding has not expired, on orders without an
  opcode-level `requiredStateCode`. One `SLOAD` instead of a pairing.

`epoch` must be the adapter's current epoch, or the previous one during the adapter's grace
period (default 600 s), so a proof generated just before an epoch roll still lands. `recipient`
envelopes are honoured for any taker that holds the recipient's EIP-712
`TakerAuthorization(taker, deadline)` signature (`contracts/zk/TakerAuthorization.sol`): no
forwarder whitelist anywhere.

The taker is verified iff the Maker accepts the type, the adapter returns `true` for the
beneficiary, and the per-verifier nullifier binding allows it. Binding the proof to the
beneficiary stops a bot replaying a human's proof; binding the nullifier to the first address
stops one human farming the discount from many wallets. Bindings carry a `validUntil` (the
nullifier's epoch end; forever for a stable World ID nullifier): claims die with it, the
nullifier itself stays with its first address.

### `0x9A JITVaultReserves` — 86 bytes
| Offset | Size | Type | Field | Notes |
|---:|---:|---|---|---|
| 0 | 20 | `address` | `vaultA` | ERC-4626 for the lower-address token, or `0` = Aqua balance |
| 20 | 20 | `address` | `vaultB` | ERC-4626 for the higher-address token, or `0` |
| 40 | 4 | `uint32` | `lambdaBps` | per-execution exposure cap, `(0, 10000]` |
| 44 | 6 | `uint48` | `virtualBoostBps` | `>= 10000`; virtual offset = `(boost − 1) · ref` |
| 50 | 16 | `uint128` | `refA` | Maker's committed Aqua allocation of tokenA |
| 66 | 16 | `uint128` | `refB` | Maker's committed Aqua allocation of tokenB |
| 82 | 4 | `uint32` | `exposureWindowSec` | λ budget window; `0` = per-execution cap only |

`capOut = min(λ · maxWithdraw(maker), aquaBalanceOut)` for every execution, and
`spent + amountOut <= λ · refBacking` per window, where `refBacking` is the withdrawable backing
when the bucket was last empty. The bucket leaks one budget per elapsed window and never
resets. Reverts `JITExposureCapExceeded(amountOut, capOut)` / `JITExposureBudgetExceeded(amountOut,
remaining)`. The bucket is read in `quote()` and written only outside STATICCALL, after the
amounts are computed, so quote == swap.

### `0x7A VolatilitySurgeFee` — 20 bytes
| Offset | Size | Type | Field | Notes |
|---:|---:|---|---|---|
| 0 | 4 | `uint32` | `baseFeeBps` | 1e9 = 100%; halved for verified humans |
| 4 | 4 | `uint32` | `maxSurgeFeeBps` | marginal rate above threshold; `base <= max <= 50%` |
| 8 | 8 | `uint64` | `impactThresholdBps` | utilization of `balanceIn` (1e4 = 100%) where surge begins |
| 16 | 4 | `uint32` | `decayWindowSec` | token-bucket window: leaks one threshold `T` per window, never resets (`0` = stateless) |

`fee(g) = ceil((g·b + max(0, g − G0)·(max − base)) / 1e9)`, where `G0` is the threshold minus
the flow left in the bucket. exactOut uses the closed-form inverse plus an integer fix-up,
which yields the minimal gross input. Inside a window the bucket is constant (quote == swap to
the wei); each elapsed window leaks exactly `T`, so a `k·T` burst keeps the surge on for `k`
windows and the Maker sells at most `T` per window at the base rate in steady state.

## Invariants proved in `test/AegisJIT.test.ts`

| # | Invariant | How |
|---|---|---|
| 1 | **quote == swap** | 10 direction/tier/mode cases on non-trivial window state, plus a real STATICCALL via `StaticQuoter` |
| 2 | **Symmetry** | `exactIn(X)→Y`, `exactOut(Y)→X'`: `X' ≤ X`, `X − X' ≤ 2 wei` (measured on the coarse 6-dp side) |
| 3 | **Sub-additivity** | 2 × ½ never beats 1 × full, exactIn and exactOut, both tiers and directions |
| 4 | **Monotonicity** | strictly increasing output; average price never improves with size |
| 5 | **ZK tier differentiation** | human > bot on the same trade; discount is exactly 50% of base; replayed, forged, under-18 and wrong-state proofs get no discount; strict mode reverts; a World ID proof and a ZK Aadhaar proof get the identical tier (`test/WorldIDAdapter.test.ts`) |
| 6 | **JIT protection** | a 500k whale is blocked; the maximum single execution is exactly λ of the vault; the cap tracks live vault withdrawals (`maxWithdraw`) and yield |
| 6b | **λ per window** | sequential and same-block split drains get exactly one λ budget (`JITExposureBudgetExceeded`); the bucket leaks one budget per window and re-anchors on the live backing |
| 7 | **Binding claims** (`test/BindingFastPath.test.ts`) | after one proof a 33-byte claim gets the human tier with no adapter call (checked in the trace, ~5k gas over a proof-less swap); other addresses, expired bindings, state-gated orders and contract takers get none |
| 8 | **Taker authorisation** | an aggregator with the human's EIP-712 signature keeps the tier; any other contract, an expired signature, or a direct bot call does not (Hardhat + Foundry `vm.sign` fuzz) |
| + | Round-trip safety, self-custody (vault == Aqua book, no idle tokens; capped-vault fallback), TS == Solidity builder parity, epoch grace, World ID action rotation, UIDAI key set, and an independent off-chain model of the math |

Mutation-checked: making the fee stateless makes 9 sub-additivity tests fail, and disabling
the verified-human dispatcher makes the tier tests fail. Adversarial probes that motivated the
hardening (four max-cap swaps in one block draining 68% of the vault; a 601-second wait resetting
the surge; a proof made 10 s before the epoch roll dying) are now regression tests.

## ETHGlobal Mumbai sponsor integration

### 1inch Aqua + SwapVM
- `AegisSwapVMRouter` extends SwapVM with the full `AquaOpcodes` set plus `MinRate` and three
  new opcodes. Every unknown opcode falls through to `AquaOpcodes._runOpcode`. Pinned sources:
  `1inch/swap-vm@b44977a` and `1inch/aqua@6f05aa1` (`package.json`).
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
  `amountIn` right after. The Maker's wallet ends every swap holding only vault shares. If the
  vault is at its deposit cap (or `deposit` reverts) the hook leaves the tokens in the Maker's
  wallet and emits `JITDepositSkipped`: settlement never fails because of the yield vault.
- `0x9A` reads `maxWithdraw(maker)` live, so an illiquid lending vault lowers quote and swap
  together. Vault yield raises the exposure cap automatically, and a Maker withdrawal shrinks it
  immediately, with no re-configuration.

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
  it: one discounted address per human. With `epochDuration > 0` the adapter rotates the action
  (`actionFor(epoch) = "<action>-<epoch>"`), so the `nullifierHash` changes every epoch, trades
  are unlinkable across epochs and a lost wallet costs at most the rest of the epoch; the demo
  deploys rotation off. The two schemes never share a namespace. After the first swap the bound
  address trades with a 33-byte binding claim and no pairing.
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
- **Measured costs** (Hardhat, cancun, demo): `SemaphoreVerifier.verifyProof` 239,014 gas incl.
  the 21k base; `ecPairing` 181,100; a swap with a World ID proof ≈ 559k vs ≈ 334k without
  (overhead ≈ 225k, ~60k less than the 9-input Anon Aadhaar verifier). Every later swap in the
  epoch uses the binding claim: ≈ 5k over a proof-less swap.
- **Tests.** `test/WorldIDAdapter.test.ts` (mock verifier): valid proof → same tier as Aadhaar,
  quote == swap, `NullifierBound`; unknown root, expired root, wrong group, tampered proof,
  foreign app/action, malformed envelopes → bot tier without reverting; reused nullifier from a
  second wallet → bot tier; replayed takerData → bot tier (strict mode reverts); Maker policy
  `verifierTypes` 1 / 2 / 3; authorised-forwarder envelope; action rotation per epoch; real
  STATICCALL quote.
  `test/RealWorldIDSwap.test.ts` (real proofs, real verifier): tree root == registered root,
  World ID hashing conventions, pairing accept / reject, swap with `ecPairing` in the trace,
  replay, Sybil with a fresh proof from a second wallet, root lifecycle, tampered proof.
  `test/foundry/WorldIDAdapter.t.sol`: 5,000-run fuzz of signal binding, external nullifier,
  root history, router access, forwarder envelopes and malformed input, plus the committed real
  proof (`test/fixtures/world-id/human-proof.json`) against the vendored verifier with every
  proof word fuzzed.
- Production wiring: deploy `WorldIDAdapter(worldIdRouter, 1, "app_…", "aegis-jit-fee-tier", epochDuration, epochGrace)`
  with the World ID Router address of the target chain, ask IDKit for `action = actionFor(currentEpoch())`
  with `signal = <taker address>`, and pass the result's `merkle_root`, `nullifier_hash`, the epoch
  and `proof` into `encodeWorldIdProofEnvelope` / `encodeWorldIdTakerArgs`. This is live on World
  Chain Sepolia against the chain's World ID Router with IDKit in the dashboard (see *Live on
  World Chain Sepolia*).

### Anon Aadhaar + zkAadhaar (identity)
- **zkAadhaar** (`packages/zk-aadhaar`, MIT) handles the Secure QR offline:
  - scanner (zxing-wasm), decimal → GZIP → field parser (Legacy, V2, V3, V5), JPEG 2000 photo;
  - RSA-2048 signature check against pinned UIDAI certificates (2017–2029 keys).
- **Real Groth16.** `packages/zk-aadhaar/prover` builds inputs for the official Anon Aadhaar v2
  circuit and proves with snarkjs. The artifacts come from Anon Aadhaar's S3 with pinned
  SHA-256, and the zkey's verification key equals all 26 constants in the official `Verifier.sol`.
- **On-chain chain of contracts:**
  - `AnonAadhaarAdapter` (epoch-rotating seed with a grace period, QR freshness, UIDAI key
    selection, `signal = beneficiary`, EIP-712 taker authorisation for aggregators);
  - → `AnonAadhaarGroth16Verifier` (trust root = a SET of circuit hashes of UIDAI RSA keys; the
    envelope's `pubkeyHash` picks one, so a UIDAI certificate rotation does not strand residents);
  - → vendored, unmodified `Verifier.sol` → `ecPairing`.
- **Measured costs** (demo): `ecPairing` 181,100 gas; a swap with the Groth16 proof ≈ 681k vs
  ≈ 393k for the same swap without a proof on a cold budget window (≈ 334k warm); the next swap
  in the epoch, with the 35-byte binding claim, ≈ 340k.
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
- No relayer or allow-list sits between the taker and the router. Aggregators and relayers are
  not whitelisted either: a contract may present a human's proof iff the human signed an EIP-712
  `TakerAuthorization` for that contract. Proofs are generated on the user's own machine from
  their own QR. In this repo that is a local Node prover the browser calls on 127.0.0.1; the QR
  never goes to a remote server. Anon Aadhaar also supports fully in-browser proving, but it
  needs the 612 MB zkey in the browser, which isn't wired here.

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
  - `timestamp`: the QR's **issuance hour** (the circuit floors it to the hour), the epoch, the
    UIDAI `pubkeyHash` and the Groth16 proof;
  - `signal`, which is the beneficiary address and already public;
  - one **nullifier per epoch**, and only on the first trade of the epoch: later trades send a
    33-byte claim that repeats the nullifier and nothing else.
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
  - all verified trades within one epoch (they share a nullifier);
  - **the Anon Aadhaar v2 public signals themselves.** `timestamp` is the QR's issuance hour and
    `state` is revealed when the order requires it. A resident who reuses one QR carries the same
    issuance hour into every epoch, so an observer who reads calldata can link their first trade
    of each epoch across epochs even though the nullifier rotated. The anonymity set is "residents
    of that state whose QR was issued in that hour and who traded here". Rotation hides the
    nullifier, not the circuit's outputs; hiding `timestamp` needs a wrapper circuit that checks
    freshness in-circuit against a public epoch, which is the open problem we would take on next.

  Shorter epochs mean less linkability but more frequent re-proving (~13 s per proof in Node);
  only the first trade per epoch needs the proof.

**Relayers / aggregators**
- Both adapters accept an authorised envelope carrying `(recipient, deadline, r, s, v)`: the
  recipient's EIP-712 `TakerAuthorization(taker, deadline)` for exactly the contract that calls
  the router (ECDSA, or ERC-1271 for smart accounts). No whitelist, no admin, no setters: any
  aggregator works once a human signs for it, and only until the deadline. The nullifier binds to
  `recipient`, so a shared aggregator can't be used to farm discounts.
- Reference forwarder `AegisZKForwarder` requires `recipient == msg.sender`, sends the output to
  `msg.sender`, and pulls the input from `msg.sender`. A searcher replaying someone's forwarder
  calldata is reverted; a contract the human never authorised simply gets bot pricing. Binding
  claims are for direct takers only, so an aggregator carries the proof plus authorisation on
  every trade.

**Security**
- Mempool hijack: a proof copied into a searcher's own transaction fails the
  `signal = uint160(taker)` check, and the searcher pays the bot tier. This is tested by
  replaying the exact takerData bytes, and fuzzed in Foundry.
- One identity cannot farm discounts across wallets (nullifier binding; a nullifier stays with
  its first address even after the binding expires), proofs die with their epoch (plus a short
  grace period), QRs older than `MAX_PROOF_AGE` (30 days in the demo) are rejected, and a copied
  binding claim fails for any address but the bound one.
- Maker protection:
  - λ caps every execution **and every 10-minute window** at 25% of the live withdrawable
    backing: a drain split into max-cap executions, even inside one block, gets one budget;
  - virtual depth uses constant offsets, so buy-then-sell round trips can't drain the Maker;
  - the token-bucket surge window makes split trades pay the same fee as one trade, and a
    burst keeps the surge on for as many windows as it filled;
  - two-sided `RequireMinRate` floors.
- Not a protection: virtual depth. A 2x boost is a Uniswap-v3-style range between a quarter and
  four times the initial price; concentration improves retail execution and *raises* what toxic
  flow extracts per unit of price move. The surge fee and the λ budget are what price that in.
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
    a type-1 payload. The witness never leaves the tab. **Verify with World App / Simulator**
    opens IDKit's request widget for the registered app (legacy Orb proof, signal = the taker,
    request signed by the local prover's RP endpoint), checks the returned proof through the
    deployment's router by `eth_call` and attaches it; on the local chain that honestly reports
    that a real World ID root is not known to the mock router, on World Chain Sepolia it passes
    (see *Live on World Chain Sepolia*). A paste box takes an IDKit result JSON as well.
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
  calls `router.asView().quote()` live, alongside the effective fee (bps), the flow-bucket
  accumulator vs threshold, and a check against an independent TS model of the opcode math.
  "Execute" sends a real `swap()` and shows quote vs executed and the divergence (0 wei).
  The split attack runs inside `evm_snapshot` / `evm_revert`. The whale shows the decoded
  `JITExposureCapExceeded`.
- **Vault panel.** Shows the λ-exposed slice vs the untouched, yield-earning reserve, and
  whether the Aqua book equals the vault backing.
- `cd ui && npm run smoke:public` runs the read-only checks against a public deployment
  (`scripts/ui-deployment.ts`): live order, quotes per tier, fee mirror, 0x9A cap, the
  read-only guards and the adapter's wiring to the chain's World ID Router.
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
| 1A · Verified human via ZK Aadhaar, 5,000 USDC → WETH | **real** Anon Aadhaar Groth16 proof from a signed test QR (~13 s) → `0x2A` type 2 → 0.15% fee vs 0.30% for a bot; quote == swap (0 wei); binds the epoch nullifier |
| 1C · Same human, next trade | **35-byte binding claim**, no proof: `0x2A` checks one storage slot, same 0.15% tier, ≈ 5k gas over a proof-less swap (vs ≈ 288k with the pairing) |
| 1B · Verified human via World ID, 5,000 USDC → WETH | **real** Semaphore depth-30 Groth16 proof (~0.4 s) → `0x2A` type 1 → `WorldIDAdapter` → World ID's `SemaphoreVerifier` (ecPairing 181,100 gas) → 0.15% fee, the identical tier; World ID overhead ≈ 225k gas |
| 2 · Unverified bot, 50,000 USDC → WETH | `0x7A` surge: 150 USDC base + 540 USDC surge (1.38% effective, with the three 5k human trades already in the bucket) |
| 3 · Toxic whale, 500,000 USDC → WETH | **reverted** by `0x9A` (`JITExposureCapExceeded`); vault untouched |
| 3b · Same whale, 4 × 25%-of-vault executions in ONE block | sandboxed: leg 1 fills exactly 25.00%, legs 2–4 revert `JITExposureBudgetExceeded`; the per-execution cap alone would have let 68% leave in that block |
| 4 · Split attack, 5 × 10,000 vs 1 × 50,000 USDC | the bucket never resets, so the demo fast-forwards `ceil(flow / T)` windows first; snapshot/revert A/B: split pays **the same** 502.20 USDC fee and gets 0.0011 WETH **less**; a stateless fee would have charged 150 USDC |

For each filled swap the demo prints the decoded ERC-20 `Transfer` trace: vault share burn →
WETH out of the vault → `Aqua.pull` to the taker → taker USDC → router → `Aqua.push` to the
Maker → hook → vault deposit and share mint.

## Live on Sepolia

The complete demo stack is deployed on Ethereum Sepolia and the judge scenarios were executed
there. Every address and transaction below is on Etherscan. The machine-readable records are
committed under [`deployments/sepolia/`](deployments/sepolia/): `aegis.json` (deployment, order,
parameters) and `demo.json` (the live run).

<!-- sepolia:deployment -->
Deployed 2026-11-06 on sepolia (chainId 11155111) by [`0x467071F2ee89347354ee91105d8dbA129D1c8eE6`](https://sepolia.etherscan.io/address/0x467071F2ee89347354ee91105d8dbA129D1c8eE6), who is also the Maker.

| Contract | Address | Deploy tx |
|---|---|---|
| Aqua (1inch shared liquidity layer) | [`0x9eF466A272b7977851c711148623eCaFCeF2B576`](https://sepolia.etherscan.io/address/0x9eF466A272b7977851c711148623eCaFCeF2B576) | [`0x75e4019f…78f553`](https://sepolia.etherscan.io/tx/0x75e4019f609b6f88d124c6294b56f30c91978ee955ffbfe444f5cae10478f553) |
| USDC mock (6 dp, mintable) | [`0x6C55FD16716A64FC40aE1857B3aF7039dDb8DE3c`](https://sepolia.etherscan.io/address/0x6C55FD16716A64FC40aE1857B3aF7039dDb8DE3c) | [`0x21fc701a…aedb6c`](https://sepolia.etherscan.io/tx/0x21fc701ab35daa97b10c4498f5c8a4ad2a791a7bada18187676f96124eaedb6c) |
| WETH mock (18 dp, mintable) | [`0x8ba8E179BCdc065C497Dfa571D35dC7c3BB36535`](https://sepolia.etherscan.io/address/0x8ba8E179BCdc065C497Dfa571D35dC7c3BB36535) | [`0x24df3275…b824e3`](https://sepolia.etherscan.io/tx/0x24df3275a2c4bf15d4aae296f2cba6da697dd072d5b86cde1d0d497ea2b824e3) |
| AegisSwapVMRouter (SwapVM + 0x2A / 0x9A / 0x7A) | [`0xd3b9B73806086AfD0C736EBD36470856E098A917`](https://sepolia.etherscan.io/address/0xd3b9B73806086AfD0C736EBD36470856E098A917) | [`0x28e0b684…87dcbd`](https://sepolia.etherscan.io/tx/0x28e0b684260c131f6df964fd5c6bf45f24a955abc6c4484cf4ded154f387dcbd) |
| AegisJITVaultHook (JIT withdraw / re-deposit) | [`0x78bCaf9e1f39424B651CC524Cb38aeeFC493C4EC`](https://sepolia.etherscan.io/address/0x78bCaf9e1f39424B651CC524Cb38aeeFC493C4EC) | [`0x28bda284…cb7681`](https://sepolia.etherscan.io/tx/0x28bda284970e534713ecace6b1b4399a83c7d9c35b345c849f4af7001dcb7681) |
| AegisJITStrategy (on-chain order builder) | [`0x10dAae3dFf736978568fBAD6feF24F99C732a11D`](https://sepolia.etherscan.io/address/0x10dAae3dFf736978568fBAD6feF24F99C732a11D) | [`0x4676996d…87b8f0`](https://sepolia.etherscan.io/tx/0x4676996dc6c0f6588e7a6a383107860f9adb55808920c5d9f39938730687b8f0) |
| AegisZKForwarder (reference aggregator) | [`0xB39bf2c69106FfAAA60F0Bc35139CB6207FC8FC3`](https://sepolia.etherscan.io/address/0xB39bf2c69106FfAAA60F0Bc35139CB6207FC8FC3) | [`0xa9d5a9e8…937f31`](https://sepolia.etherscan.io/tx/0xa9d5a9e8bc163ac2f076a1eba36dbf8eb63fa64914ddc99b3ff0574498937f31) |
| avUSDC MockERC4626Vault | [`0xffDe80F6EE5db69807F4E244AD622686354c5eB1`](https://sepolia.etherscan.io/address/0xffDe80F6EE5db69807F4E244AD622686354c5eB1) | [`0x210ddcb9…fb7a5c`](https://sepolia.etherscan.io/tx/0x210ddcb911dc565ec697be7944503f868abf8db39fe6a879c50ab1591afb7a5c) |
| avWETH MockERC4626Vault | [`0x84b34a6c383Da7dD0f1098CE9E2569c6033E0261`](https://sepolia.etherscan.io/address/0x84b34a6c383Da7dD0f1098CE9E2569c6033E0261) | [`0x3d3dd152…65903f`](https://sepolia.etherscan.io/tx/0x3d3dd1524433afb8315e66ce454180e3282e3338b864a21181e6b3e18165903f) |
| Anon Aadhaar v2 Groth16 verifier (vendored snarkjs, ecPairing) | [`0xbF1C48baC951E1D5429b27017585A4a920C29CCb`](https://sepolia.etherscan.io/address/0xbF1C48baC951E1D5429b27017585A4a920C29CCb) | [`0xec6ced5c…e77dca`](https://sepolia.etherscan.io/tx/0xec6ced5c6a686754f4e9166fa690d82a6c5818b44c8a55102e3eb122a8e77dca) |
| AnonAadhaarGroth16Verifier (UIDAI key set; test signer here) | [`0x100d5447596FF130Eb4813BA740f315cF9948d3F`](https://sepolia.etherscan.io/address/0x100d5447596FF130Eb4813BA740f315cF9948d3F) | [`0xe702fb19…91b167`](https://sepolia.etherscan.io/tx/0xe702fb19ce73425e5e3d91e465735ee0c4f2f64ac33c6aff7e8c719b6691b167) |
| AnonAadhaarAdapter (0x2A type 2) | [`0x309812F2e37E3CF3Ed28870ba2307F5e7d566cDc`](https://sepolia.etherscan.io/address/0x309812F2e37E3CF3Ed28870ba2307F5e7d566cDc) | [`0x40408771…b8cabf`](https://sepolia.etherscan.io/tx/0x40408771a1f3a5adff5f0e69096d9f79027b65a48f52e560cdb5efd3f3b8cabf) |
| World ID SemaphoreVerifier (vendored, real pairing) | [`0xc68E85F4Ff30e4E2Cfe992f70722406f33E74882`](https://sepolia.etherscan.io/address/0xc68E85F4Ff30e4E2Cfe992f70722406f33E74882) | [`0x19e23a74…493882`](https://sepolia.etherscan.io/tx/0x19e23a745b2fb0f90a921d3e3f87b44101fc6de7487578cc264efd5c5d493882) |
| MockWorldIDRouter (router + identity-manager semantics) | [`0x08b72330f18Db923e66A7912658b85B9Aaa87b6B`](https://sepolia.etherscan.io/address/0x08b72330f18Db923e66A7912658b85B9Aaa87b6B) | [`0x9207242f…a58695`](https://sepolia.etherscan.io/tx/0x9207242f18f4012311ea6a79d6f234655fe6e31919547acc6cf64a4610a58695) |
| WorldIDAdapter (0x2A type 1) | [`0x17cC2A95F0d9B75eF3Df1dcfE7Dbd04bdc209A59`](https://sepolia.etherscan.io/address/0x17cC2A95F0d9B75eF3Df1dcfE7Dbd04bdc209A59) | [`0x205d2670…c275cd`](https://sepolia.etherscan.io/tx/0x205d2670fe885836cf5f7bcd6f1443dd34e58c916ff9edb987d186bdd3c275cd) |

| Strategy | |
|---|---|
| orderHash | `0xf6d915b75f75797d743648038da21bd8bdb084de5bfdddefaedd73f0a5928b99` |
| Aqua.ship tx | [`0xa402cc73…34c115`](https://sepolia.etherscan.io/tx/0xa402cc734d224671e42793af6ef1969278ccc7ba2ca1be46042ff6c17734c115) (block 12076059) |
| Maker capital | 1,000,000 USDC + 400 WETH in the two vaults; Aqua book = the same, as virtual balances |
| λ / boost / windows | 25% per execution and per 600s window / 2x / 600s fee bucket |
| fees | base 0.3% (humans 0.15%), surge marginal 1.5% above 1% utilisation |
| Aadhaar epochs | 24 h, grace 600 s, QR freshness 30 days |

Taker accounts used by the live run:

| Role | Address |
|---|---|
| human | [`0xb47Fc63033Db7C92964aC2DB3Ec120A8605e8073`](https://sepolia.etherscan.io/address/0xb47Fc63033Db7C92964aC2DB3Ec120A8605e8073) |
| bot | [`0xbF0df288Cb85e83158d98dCA7C513FDf3d5Bee84`](https://sepolia.etherscan.io/address/0xbF0df288Cb85e83158d98dCA7C513FDf3d5Bee84) |
| whale | [`0xd115abbd24D26308af7501f6644eF22357026f3A`](https://sepolia.etherscan.io/address/0xd115abbd24D26308af7501f6644eF22357026f3A) |
| worldHuman | [`0x7ae898883b91534923737A792aAC3973CE5028F6`](https://sepolia.etherscan.io/address/0x7ae898883b91534923737A792aAC3973CE5028F6) |

- USDC and WETH are mintable ERC-20 mocks (TokenCustomDecimalsMock, 6 / 18 decimals).
- MockERC4626Vault = OpenZeppelin ERC-4626; the Maker's capital sits there, the hook moves it JIT.
- World ID: MockWorldIDRouter (router + identity-manager semantics) in front of World ID's real SemaphoreVerifier; identity tree = packages/world-id local tree.
- ZK Aadhaar: real Anon Aadhaar v2 Groth16 verifier; trust root = the public AegisJIT TEST signer, NOT UIDAI.
- Order deadline: 30 days after deployment.

Live run of `scripts/demo-sepolia.ts` on 2026-11-06:

| Scenario | Taker | In | Out | USDC/WETH | Fee | Gas | Tx | Result |
|---|---|---|---|---|---|---|---|---|
| 0 Warm-up bot | unverified | 1,000 USDC | 0.3986 WETH | 2,508.77 | 0.300% | 794,386 | [0xc1d7a8bc…c1bc2a2c](https://sepolia.etherscan.io/tx/0xc1d7a8bcd1c9e6397a5e3a506ca855c332261a967d2ce57e4fa70fbcc1bc2a2c) | filled |
| 1 Bot 5k (baseline) | unverified | 5,000 USDC | 1.9871 WETH | 2,516.28 | 0.300% | 383,476 | [0xfb0c04c3…7cc82b11](https://sepolia.etherscan.io/tx/0xfb0c04c35588911020ba01b8d54657d492a80be4db26c3bc5d0f6a3b7cc82b11) | filled |
| 2 Human · ZK Aadhaar | Groth16 ✔ | 5,000 USDC | 1.9802 WETH | 2,525.05 | 0.150% | 671,244 | [0x11e169f0…ed198bcf](https://sepolia.etherscan.io/tx/0x11e169f08c75a809e773803c206e3a0349480cadf6096110a4ea7abced198bcf) | filled |
| 3 Human · binding claim | binding ✔ | 5,000 USDC | 1.9703 WETH | 2,537.62 | 0.150% | 390,273 | [0x4919f261…1e154066](https://sepolia.etherscan.io/tx/0x4919f2612420af53c310db1aaaf3dd95ff48ba07e6b2600f47bb72621e154066) | filled |
| 4 Human · via aggregator | authorised ✔ | 5,000 USDC | 1.9559 WETH | 2,556.36 | 0.390% (0.150% base + 0.240% surge) | 717,279 | [0xd31a637f…c4b3d3a5](https://sepolia.etherscan.io/tx/0xd31a637f663a06a238edb673e5b01996590114ceae26cec1e1723c5ac4b3d3a5) | filled |
| 5 Human · World ID | Semaphore ✔ | 5,000 USDC | 1.9276 WETH | 2,593.96 | 1.350% (0.150% base + 1.200% surge) | 623,467 | [0x061c30a4…8dbe2728](https://sepolia.etherscan.io/tx/0x061c30a4487bafaa3310cf9e14c853d63dc64cfcb25013562d2fa2f18dbe2728) | filled |
| 6 Arb bot 50k | unverified | 50,000 USDC | 18.7431 WETH | 2,667.64 | 1.500% | 383,492 | [0x534a8ec7…9d1c8e27](https://sepolia.etherscan.io/tx/0x534a8ec7ecd7e317715f6e5fafd7843b30496b4c2756f5db411b39849d1c8e27) | filled |
| 7 Split 5x10k | unverified | 50,000 USDC | 17.8653 WETH | 2,798.72 | 1.500% | 1,917,460 | [5 txs](https://sepolia.etherscan.io/tx/0x28d32e57ccd02d3b273c154d2908ad41d6b8e69f1096d0dc9c58da13cf54f67e) | no gain |
| 8 Whale 500k | unverified | 500,000 USDC | 0 WETH | — | — | 97,917 | [0x09bf4f67…00f26898](https://sepolia.etherscan.io/tx/0x09bf4f670cf2e8cf91b219f1680eeb6817ccabecd1180bd5648b9dad00f26898) | blocked 0x9A |
| 9 Whale split 4x25% | unverified | 4 txs | 88.2930 WETH | — | — | — | [4 txs](https://sepolia.etherscan.io/tx/0x92aebe9c77ff9d3648b858654b6156122f482450d9984a4d0c0d5c30e7d47599) | 1 of 4 filled |
<!-- /sepolia:deployment -->

**What is real and what is a mock here.** Real: Aqua, `AegisSwapVMRouter` with the three opcodes,
the JIT hook, both `IZKVerifier` adapters, the reference aggregator, the Anon Aadhaar v2 Groth16
verifier (vendored snarkjs, BN254 pairing) and World ID's `SemaphoreVerifier`. Mock, by design:
USDC and WETH are mintable ERC-20s (a 1,000,000 USDC / 400 WETH book cannot be funded from
faucets), the vaults are OpenZeppelin ERC-4626 mocks, `MockWorldIDRouter` plays the World ID Router
and identity manager in front of World ID's real verifier with the project's local identity tree,
and the Aadhaar trust root is the public AegisJIT test signer. Anyone with this repo can therefore
mint a valid *test* QR against this deployment: it demonstrates the pipeline end to end, not
UIDAI-backed identity.

All 15 contracts are source-verified on Etherscan. This is the second order shipped on these
contracts (salt 1); the first one (salt 0, listed under `previousOrders` in `aegis.json`) served an
interrupted run and is still active but unused. Fees for everything on this page, the deployment,
both runs and verification across 90 transactions, came to 0.134 ETH; Sepolia's base fee was near zero throughout.

**Reading the fee column.** The 0x7A flow bucket integrates every trade on the order, human or
bot. By scenario 4 the earlier trades had put 16,000 USDC into it, and by scenario 5 21,000, past
the 1% threshold of 20,000 USDC, so those two verified-human trades pay surge on the excess while
still getting the halved base fee; the bot in scenario 6 pays surge on all of its 50,000 USDC. That
is the designed behaviour: the identity tier discounts the base fee, the surge prices flow.

**Gas.** The gas column comes from the Sepolia receipts of this run and sits slightly above the
Hardhat (cancun) figures used elsewhere in this README: a proof-less 5,000 USDC swap costs 383k
here against 335k locally; the Groth16 proof adds 288k, the binding claim 6.8k, the World ID proof
240k. Scenario 0 pays about 400k extra for the cold storage slots of the fee and budget buckets.

Reproduce on a fresh account (resumable, about 45 transactions):

```bash
# .env: PRIVATE_KEY (funded Sepolia account), SEPOLIA_RPC_URL, ETHERSCAN_API_KEY (optional);
#       TAKER_MNEMONIC for the four taker accounts is generated and appended on the first run
node packages/zk-aadhaar/prover/fetch-artifacts.mjs && node packages/world-id/prover/fetch-artifacts.mjs
npx hardhat run --network sepolia scripts/deploy-sepolia.ts     # deploy + seed + ship; checkpoints, re-run to resume
npx hardhat run --network sepolia scripts/verify-sepolia.ts     # Etherscan source verification
npx hardhat run --network sepolia scripts/demo-sepolia.ts       # the scenarios above with real proofs; writes demo.json
npx hardhat run --network sepolia scripts/deployment-readme.ts  # renders this section's tables
```

Judges can also call the deployment directly: `router.asView().quote(order, amount, takerData)`
with the `order` from `aegis.json` and `takerData` built by `src/aegisProgramBuilder.ts`, or read the
live buckets with `router.surgeWindow(orderHash, usdc)` and `router.exposureWindow(orderHash, weth)`.

## Live on World Chain Sepolia (real World ID Router)

The same stack is deployed on World Chain Sepolia (chainId 4801) with one difference: there is no
`MockWorldIDRouter`. `WorldIDAdapter` points at the chain's World ID Router,
[`0x57f928158C3EE7CDad1e4D8642503c4D0201f611`](https://sepolia.worldscan.org/address/0x57f928158C3EE7CDad1e4D8642503c4D0201f611),
for the staging app `app_2d47490f3897300939bf0fab0426cf79` registered in the World Developer Portal
and the action `aegis-jit-fee-tier`. Proofs come from World App, or from the World ID Simulator for
this staging app, through IDKit; the project's local identity tree cannot prove into this deployment.
All 13 contracts are source-verified on Worldscan. Records: [`deployments/worldchainSepolia/`](deployments/worldchainSepolia/).

<!-- worldchainSepolia:deployment -->
Deployed 2026-11-06 on worldchainSepolia (chainId 4801) by [`0x467071F2ee89347354ee91105d8dbA129D1c8eE6`](https://sepolia.worldscan.org/address/0x467071F2ee89347354ee91105d8dbA129D1c8eE6), who is also the Maker.

| Contract | Address | Deploy tx |
|---|---|---|
| Aqua (1inch shared liquidity layer) | [`0x9eF466A272b7977851c711148623eCaFCeF2B576`](https://sepolia.worldscan.org/address/0x9eF466A272b7977851c711148623eCaFCeF2B576) | [`0x516717bc…c677b0`](https://sepolia.worldscan.org/tx/0x516717bcab6c4baa3b15068d721aa7bba6d8d57e5970986acaf7884b9fc677b0) |
| USDC mock (6 dp, mintable) | [`0x6C55FD16716A64FC40aE1857B3aF7039dDb8DE3c`](https://sepolia.worldscan.org/address/0x6C55FD16716A64FC40aE1857B3aF7039dDb8DE3c) | [`0x5d36ba5e…4a1c8c`](https://sepolia.worldscan.org/tx/0x5d36ba5ea4f153f25dc2aca697098b64d2c34cc9f3d4d151d1ad38289a4a1c8c) |
| WETH mock (18 dp, mintable) | [`0x8ba8E179BCdc065C497Dfa571D35dC7c3BB36535`](https://sepolia.worldscan.org/address/0x8ba8E179BCdc065C497Dfa571D35dC7c3BB36535) | [`0x12f741f3…548f05`](https://sepolia.worldscan.org/tx/0x12f741f3b8138249f323c25f93e449bf00f6e66479933d3ed006172517548f05) |
| AegisSwapVMRouter (SwapVM + 0x2A / 0x9A / 0x7A) | [`0xd3b9B73806086AfD0C736EBD36470856E098A917`](https://sepolia.worldscan.org/address/0xd3b9B73806086AfD0C736EBD36470856E098A917) | [`0xcb4b7889…89275a`](https://sepolia.worldscan.org/tx/0xcb4b78890c965ec7003eb572c07f094221fb64b0c28edefe6109a908fc89275a) |
| AegisJITVaultHook (JIT withdraw / re-deposit) | [`0x78bCaf9e1f39424B651CC524Cb38aeeFC493C4EC`](https://sepolia.worldscan.org/address/0x78bCaf9e1f39424B651CC524Cb38aeeFC493C4EC) | [`0x5eb4440a…2b7d30`](https://sepolia.worldscan.org/tx/0x5eb4440abca056a9fee96aa71ce587248421d2c00452c75b7639882e332b7d30) |
| AegisJITStrategy (on-chain order builder) | [`0x10dAae3dFf736978568fBAD6feF24F99C732a11D`](https://sepolia.worldscan.org/address/0x10dAae3dFf736978568fBAD6feF24F99C732a11D) | [`0x9f577935…c65e79`](https://sepolia.worldscan.org/tx/0x9f577935eb2e6720cf7468eb4e4bd91de626d98243a4bdb4db98294b27c65e79) |
| AegisZKForwarder (reference aggregator) | [`0xB39bf2c69106FfAAA60F0Bc35139CB6207FC8FC3`](https://sepolia.worldscan.org/address/0xB39bf2c69106FfAAA60F0Bc35139CB6207FC8FC3) | [`0x328e4fe7…ceb419`](https://sepolia.worldscan.org/tx/0x328e4fe76437ccab65ad8fa1d92111b4e4b9cc006ebc10b2df6b55ca30ceb419) |
| avUSDC MockERC4626Vault | [`0xffDe80F6EE5db69807F4E244AD622686354c5eB1`](https://sepolia.worldscan.org/address/0xffDe80F6EE5db69807F4E244AD622686354c5eB1) | [`0x754c8cc9…6e2d2e`](https://sepolia.worldscan.org/tx/0x754c8cc9dd3fac701a8955fce101501129f0a8e67ae6de0e21b47f7f0f6e2d2e) |
| avWETH MockERC4626Vault | [`0x84b34a6c383Da7dD0f1098CE9E2569c6033E0261`](https://sepolia.worldscan.org/address/0x84b34a6c383Da7dD0f1098CE9E2569c6033E0261) | [`0xd4354154…caf798`](https://sepolia.worldscan.org/tx/0xd435415405c34638a70da87cdc0cc96245938dfba9710315db2382139ecaf798) |
| Anon Aadhaar v2 Groth16 verifier (vendored snarkjs, ecPairing) | [`0xbF1C48baC951E1D5429b27017585A4a920C29CCb`](https://sepolia.worldscan.org/address/0xbF1C48baC951E1D5429b27017585A4a920C29CCb) | [`0xce9f477d…0f145e`](https://sepolia.worldscan.org/tx/0xce9f477d6dddf554d7177417d03574f6c412ff37062a69d8085f1a38c10f145e) |
| AnonAadhaarGroth16Verifier (UIDAI key set; test signer here) | [`0x100d5447596FF130Eb4813BA740f315cF9948d3F`](https://sepolia.worldscan.org/address/0x100d5447596FF130Eb4813BA740f315cF9948d3F) | [`0xb11bcb84…bc8069`](https://sepolia.worldscan.org/tx/0xb11bcb843fbf2f30ac066898fa2357429abf8f3fd0e13bf29cf8423e8cbc8069) |
| AnonAadhaarAdapter (0x2A type 2) | [`0x309812F2e37E3CF3Ed28870ba2307F5e7d566cDc`](https://sepolia.worldscan.org/address/0x309812F2e37E3CF3Ed28870ba2307F5e7d566cDc) | [`0xb8479849…385657`](https://sepolia.worldscan.org/tx/0xb84798494dde5ef4baf79d30de880f3491500c816e68786f867e0a384f385657) |
| WorldIDAdapter (0x2A type 1) | [`0xc68E85F4Ff30e4E2Cfe992f70722406f33E74882`](https://sepolia.worldscan.org/address/0xc68E85F4Ff30e4E2Cfe992f70722406f33E74882) | [`0x354bf3fb…d553cc`](https://sepolia.worldscan.org/tx/0x354bf3fb9449faf29eaab64b36259184f72b94ed20ae6d8592e68c32bdd553cc) |

| Strategy | |
|---|---|
| orderHash | `0x697fbe007a5e999b2581806240cfa67c65497df51372ff8a716de027451f3a81` |
| Aqua.ship tx | [`0xcef0bffd…5c838c`](https://sepolia.worldscan.org/tx/0xcef0bffdb287887fcec44b1e14dc1f1fa79a84f15ec1ad2fad405cec145c838c) (block 36708564) |
| Maker capital | 1,000,000 USDC + 400 WETH in the two vaults; Aqua book = the same, as virtual balances |
| λ / boost / windows | 25% per execution and per 600s window / 2x / 600s fee bucket |
| fees | base 0.3% (humans 0.15%), surge marginal 1.5% above 1% utilisation |
| Aadhaar epochs | 24 h, grace 600 s, QR freshness 30 days |

Taker accounts used by the live run:

| Role | Address |
|---|---|
| human | [`0xb47Fc63033Db7C92964aC2DB3Ec120A8605e8073`](https://sepolia.worldscan.org/address/0xb47Fc63033Db7C92964aC2DB3Ec120A8605e8073) |
| bot | [`0xbF0df288Cb85e83158d98dCA7C513FDf3d5Bee84`](https://sepolia.worldscan.org/address/0xbF0df288Cb85e83158d98dCA7C513FDf3d5Bee84) |
| whale | [`0xd115abbd24D26308af7501f6644eF22357026f3A`](https://sepolia.worldscan.org/address/0xd115abbd24D26308af7501f6644eF22357026f3A) |
| worldHuman | [`0x7ae898883b91534923737A792aAC3973CE5028F6`](https://sepolia.worldscan.org/address/0x7ae898883b91534923737A792aAC3973CE5028F6) |

- USDC and WETH are mintable ERC-20 mocks (TokenCustomDecimalsMock, 6 / 18 decimals).
- MockERC4626Vault = OpenZeppelin ERC-4626; the Maker's capital sits there, the hook moves it JIT.
- World ID: the chain's World ID Router (0x57f928158C3EE7CDad1e4D8642503c4D0201f611); proofs come from World App / the World ID Simulator via IDKit for app app_2d47490f3897300939bf0fab0426cf79, action aegis-jit-fee-tier.
- ZK Aadhaar: real Anon Aadhaar v2 Groth16 verifier; trust root = the public AegisJIT TEST signer, NOT UIDAI.
- Order deadline: 30 days after deployment.
<!-- /worldchainSepolia:deployment -->

Deployment and verification cost about 0.02 ETH. Scenarios 0–4 and 6–9 of `scripts/demo-sepolia.ts`
run here unchanged (the Aadhaar pass and the binding claim do not depend on the chain); scenario 5
needs a World ID proof and is skipped until one is supplied with `IDKIT_RESULT` (below).

**World ID through IDKit.** IDKit 4.x signs every request with the app's relying-party key, so the
flow has a server side even for a demo:

1. Developer Portal → the app → relying-party registration gives an `rp_id` and a signing key.
   `.env`: `WORLD_ID_STAGING_APP_ID`, `WORLD_ID_RP_ID`, `WORLD_ID_RP_SIGNING_KEY`. The key is read
   only by the local prover process (`packages/zk-aadhaar/prover/server.ts`), whose
   `POST /worldid/rp-context` signs one request at a time with `@worldcoin/idkit-core/signing`;
   the browser receives `{ rp_id, nonce, created_at, expires_at, signature }`, never the key.
   `GET /health` reports whether the RP is configured.
2. `npx hardhat run --network worldchainSepolia scripts/ui-deployment.ts` writes
   `ui/public/deployment.json` for the public deployment and `npm --prefix ui run dev` serves the
   dashboard in **read-only mode**: live quotes, buckets, the disassembled order from Worldscan's
   chain, both ZK passes; `swap()` and the split sandbox are disabled (no signer in the browser,
   no `evm_snapshot` on a public node) and point at the CLI. `npm --prefix ui run smoke:public`
   checks that path headlessly, including that the adapter is wired to the real router.
3. 🌍 World ID tab → **Verify with World App / Simulator**. `IDKitRequestWidget` opens with
   `preset = orbLegacy({ signal: <Verified Human taker> })`, `allow_legacy_proofs` and
   `environment = staging`; World App or the Simulator (`https://simulator.worldcoin.org`) scans the
   QR and returns a legacy (World ID 3.0) Orb proof `{ merkle_root, nullifier, proof }`, the format
   the router's 6-argument `verifyProof` checks on-chain. `handleVerify` runs
   `WorldIDAdapter.verifyProof` through the real router by `eth_call` before the widget reports
   success; the proof is then attached to the Verified Human profile, the quote drops to the human
   tier, and **Download IDKit result** saves the JSON.
4. `IDKIT_RESULT=idkit-result.json DEMO_SCENARIOS=5 npx hardhat run --network worldchainSepolia scripts/demo-sepolia.ts`
   executes the swap with that proof. The scenario runs as the taker the proof's `signal_hash`
   names (the dashboard signs for the Verified Human account), because the adapter binds the
   signal to the taker address and rejects the proof from any other account.

**Hosted Simulator vs. the staging portal.** The hosted Simulator at `simulator.worldcoin.org`
resolves app metadata from the *production* Developer Portal (`developer.world.org`; its
`vercel.json` pins `NEXT_PUBLIC_DEV_PORTAL_URL` there). An app created in the staging portal
(`staging-developer.world.org`, where this app lives) is unknown to it: the Simulator reports
"App not found", and for an IDKit 4.x request with `environment: "staging"` it then reports
"Production request detected", because its `/api/v4/proof-context` lookup cannot reach the staging
portal (the page's Content-Security-Policy only allows `developer.world.org`; the staging portal
itself answers that call with CORS `*`). Two clean ways around it: register the app in
`developer.world.org` and redeploy `WorldIDAdapter` with that app id
(`WORLD_ID_APP_ID=app_… WORLD_ID_ROUTER=0x57f9…f611 REDEPLOY=worldIdAdapter ORDER_SALT=1 npx hardhat run --network worldchainSepolia scripts/deploy-sepolia.ts`,
then `scripts/ui-deployment.ts` again), or run the open-source Simulator locally with
`NEXT_PUBLIC_DEV_PORTAL_URL=https://staging-developer.world.org`. The proof
recorded above was produced by the hosted Simulator after the app metadata that the staging portal
returns for this app was supplied to the Simulator's page state from the browser console; the test
identity, the Semaphore proof, the bridge delivery and the on-chain verification are untouched.

Nothing else changes between the chains: signal binding, the Sybil policy, the nullifier binding
with the 33-byte claim, the envelopes and the fee tier are the same code the Sepolia and local runs
exercise with the mock router.

Reproduce:

```bash
# .env additionally: WORLD_ID_STAGING_APP_ID (Developer Portal), WORLD_ID_RP_ID + WORLD_ID_RP_SIGNING_KEY (IDKit request signing),
#                    WORLDCHAIN_SEPOLIA_RPC_URL (optional; public endpoint by default)
WORLD_ID_ROUTER=0x57f928158C3EE7CDad1e4D8642503c4D0201f611 \
  npx hardhat run --network worldchainSepolia scripts/deploy-sepolia.ts   # no mock router: the adapter gets the chain's World ID Router
npx hardhat run --network worldchainSepolia scripts/verify-sepolia.ts      # Worldscan (Etherscan API V2, chainid 4801)
npx hardhat run --network worldchainSepolia scripts/ui-deployment.ts       # read-only dashboard config
npm --prefix packages/zk-aadhaar run prover:serve                          # Aadhaar prover + World ID request signing
npm --prefix ui run dev                                                    # http://127.0.0.1:5173
```

## Project structure

```
contracts/
  AegisSwapVMRouter.sol        router: SwapVM + AquaOpcodes + MinRate + AegisJIT opcodes
  AegisJITStrategy.sol         on-chain program/order builder
  AegisJITVaultHook.sol        JIT withdraw/deposit Maker hook
  AegisZKForwarder.sol         reference aggregator (recipient == msg.sender; authorised via EIP-712, not whitelisted)
  instructions/                ZKIdentityGuard · JITVaultReserves · VolatilitySurgeFee
  interfaces/IZKVerifier.sol
  zk/                          IAnonAadhaar(+MultiKey) · TakerAuthorization · AnonAadhaarAdapter · AnonAadhaarGroth16Verifier · WorldIDAdapter
  zk/world-id/                 IWorldID (router interface) · ByteHasher · IWorldIDSemaphoreVerifier
  zk/vendor/world-id/          SemaphoreVerifier.sol (World ID's, MIT, one import path changed) + ISemaphoreVerifier
  zk/vendor/anon-aadhaar/      Verifier.sol (official, unmodified, GPL-3.0)
  libs/AegisOpcodes.sol
  mocks/                       MockAnonIdentityVerifier · MockGroth16AnonAadhaar · MockWorldIDRouter · MockSemaphoreVerifier · MockERC4626Vault · StaticQuoter
src/aegisProgramBuilder.ts     TypeScript SDK (programs, orders, ZK taker payloads)
packages/zk-aadhaar/           zkAadhaar QR scanner/parser/RSA verifier (Next.js app + libs)
  prover/                      Anon Aadhaar inputs + snarkjs prover · CLI · 127.0.0.1 service · test signer
packages/world-id/             World ID-compatible local tree + prover (Semaphore v3, depth 30, snarkjs) · CLI · artifact fetcher
test/AegisJIT.test.ts          invariant suite      test/AnonAadhaarAdapter.test.ts · test/WorldIDAdapter.test.ts · test/BindingFastPath.test.ts
test/RealGroth16Swap.test.ts   real proofs → swap   test/EpochNullifiers.test.ts (epochs, forwarders)
test/RealWorldIDSwap.test.ts   real World ID proofs → swap   test/fixtures/world-id/ (committed real proof)
test/foundry/                  fee-math, Aadhaar adapter and World ID adapter fuzzing (+ real pairing)
scripts/demo-mumbai.ts         judge CLI demo       scripts/seed-local.ts · start-local-demo.sh
ui/                            SwapVM Inspector (dual-tab ZK Pass: WorldIdPass · AadhaarPass · lib/worldid)   docs/SPEC.md    spec & deviations
```

The original template (`AquaAMM`, `MockTaker`, `deploy/`) is unchanged and its tests still pass.

## Threat model (what stops what)

| Attack | Stopped by | Regression test |
|---|---|---|
| Bot replays a human's proof or claim from its own address | signal / binding bound to the beneficiary | `AnonAadhaarAdapter`, `WorldIDAdapter`, `BindingFastPath` |
| One human, many wallets | nullifier bound to its first address for the epoch (forever for a stable World ID nullifier) | `EpochNullifiers`, `WorldIDAdapter`, `BindingFastPath` |
| Contract the human never authorised presents the proof | EIP-712 `TakerAuthorization` for exactly one taker, with a deadline | `EpochNullifiers`, Foundry `vm.sign` fuzz |
| Whale drains the vault with one execution | per-execution cap `λ · maxWithdraw` | `AegisJIT` invariant 6 |
| Whale splits the drain into max-cap executions, even in one block | per-window λ budget bucket | `AegisJIT` invariant 6b, demo 3b |
| Bot splits a toxic trade to stay under the surge threshold | fee integrated over the flow bucket | `AegisJIT` invariant 3, demo 4 |
| Bot waits for the window to roll and gets full capacity back | bucket leaks `T` per window, never resets | `AegisJIT` 0x7A mechanics |
| Proof made just before the epoch roll dies on inclusion | grace period for the previous epoch | `EpochNullifiers` |
| Quote promises what the vault cannot withdraw | `maxWithdraw` sizing; deposit-cap fallback in the hook | `AegisJIT` invariant 6 |
| UIDAI rotates its signing certificate | verifier trusts a key set; envelope names the key | `RealGroth16Swap`, `AnonAadhaarAdapter` |

Not stopped: a verified human running an arbitrage bot (the tier is about personhood, not
intent); a competitor trading `T` at window start to put the pool into surge for everyone (it costs
them the base fee and price impact every window); linkage through the Anon Aadhaar `timestamp` /
`state` public signals (see CROPS); and anything an unaudited codebase implies.

## Known limits

- The surge bucket leaks one threshold `T` per window: a taker who waits `k` windows regains
  `k·T` of base-fee capacity (steady state `T` per window, at most `2T` across one boundary).
- λ is a budget per window: at most λ of the backing per window in steady state and `2λ` across
  one boundary. Over longer horizons exposure is bounded by the Aqua allocation and priced by
  the surge fee.
- Binding claims are for direct takers on orders without an opcode-level `requiredStateCode`;
  aggregators carry the full proof plus authorisation on every trade.
- `timestamp` (QR issuance hour) and a revealed `state` are public signals of the Anon Aadhaar
  v2 circuit and can link a resident's first trades across epochs (see CROPS).
- Local deployments trust the AegisJIT TEST signer. Production must deploy
  `AnonAadhaarGroth16Verifier` with the UIDAI key hashes in circulation. Upstream only publishes
  the 2021 key's hash, so the hashes of the current (2026) keys have to be computed with the
  circuit and checked independently.
- The circuit parses the **V2** layout (≤ 1536 padded bytes). Whether current V5 e-Aadhaar QRs
  fit hasn't been verified. zkAadhaar parses them, but proving may fail.
- Proving runs in a local Node process, not inside the browser.
- Each epoch needs one fresh proof (later trades use the claim). QRs older than `MAX_PROOF_AGE`
  (30 days by default) are rejected.
- World ID locally (and on Ethereum Sepolia) means a local identity tree: the project is its own
  signup sequencer, and `MockWorldIDRouter` publishes its roots. On World Chain Sepolia the adapter
  points at the chain's World ID Router and takers prove with World App / the Simulator through
  IDKit; nothing in the adapter or the opcode changes. IDKit 4.x needs the app's relying-party
  signing key on a server, here the local prover process.
- The demo deploys the World ID adapter with action rotation off, so IDKit's static action
  matches; with rotation on, IDKit must be asked for `actionFor(currentEpoch())`.
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
