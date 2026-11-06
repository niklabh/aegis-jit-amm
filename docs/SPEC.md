# AegisJIT — Architecture & Opcode Specification

> Spec-driven AI disclosure: this document was written **before** any Solidity/TypeScript
> implementation, by an AI pair-programmer (Claude) working from the project brief in
> `CLAUDE.md`, after inspecting the pinned `@1inch/swap-vm` and `@1inch/aqua` sources in
> `node_modules`. Where the brief conflicted with the actual SwapVM source or with the
> invariants it requires, this spec records the deviation and the reason (§7).

## 1. Goal

AegisJIT is a **custom-opcode AMM strategy** for 1inch SwapVM, settled through 1inch Aqua,
in which a Maker keeps 100% of their capital **self-custodied in ERC-4626 vaults** (earning
yield) while exposing only a bounded, just-in-time slice of it to takers.

Three custom instructions are added to the SwapVM interpreter:

| Opcode | Name                | Role                                                                  |
|--------|---------------------|-----------------------------------------------------------------------|
| `0x2A` | `ZKIdentityGuard`   | Sybil/compliance gate with a modular verifier router (World ID **or** ZK Aadhaar proofs); tiers takers into *verified human* vs *unverified* |
| `0x9A` | `JITVaultReserves`  | Reads live ERC-4626 backing (`maxWithdraw`); enforces the exposure cap λ per execution AND per window (token bucket); virtual-offset depth boost |
| `0x7A` | `VolatilitySurgeFee`| Size- and flow-aware LVR fee on a token-bucket flow window; 50% base-fee discount for verified humans |

## 2. Verified SwapVM facts (from source)

Inspected: `src/SwapVM.sol`, `src/libs/VM.sol`, `src/opcodes/AquaOpcodes.sol`,
`src/routers/AquaSwapVMRouter.sol`, `src/instructions/{Fee,FeeExperimental,XYCSwap,MinRate,Controls,Balances,Extruction}.sol`,
`src/libs/{MakerTraits,TakerTraits}.sol`, `aqua/src/Aqua.sol`.
(The brief referenced `contracts/…` paths and `contracts/SwapVMImport.sol`; the package
actually ships sources under `src/` and that import file does not exist.)

* `Context { VM vm; SwapQuery query; SwapRegisters swap; }`
  * `vm   = { bool isStaticContext; uint256 nextPC; CalldataPtr programPtr; CalldataPtr takerArgsPtr; function(Context memory,uint256,bytes calldata) internal dispatch; }`
  * `query= { bytes32 orderHash; address maker; address taker; address tokenIn; address tokenOut; bool isExactIn; }`
  * `swap = { uint256 balanceIn; uint256 balanceOut; uint256 amountIn; uint256 amountOut; uint256 amountNetPulled; }`
* `ContextLib.tryChopTakerArgs(ctx, len)` consumes up to `len` bytes of the taker's
  `instructionsArgs` slice (never reverts; returns fewer bytes if not enough data).
* `ContextLib.runLoop(ctx)` runs from `ctx.vm.nextPC` to program end — this is how
  "wrapping" instructions (Fee, MinRate) execute the remainder of the program and then
  post-process amounts.
* Instruction framing: `[opcode:1][argsLength:1][args:argsLength]`. **Opcode is a dispatch
  index**, not a family code. `AquaOpcodes._runOpcode` uses indices `10..33`;
  `0x2A`, `0x7A`, `0x9A` (and `0x2B`, see below) are unused there.
* Fee precision: `uint256 constant BPS = 1e9;` → **1e9 = 100%** (`Fee.sol`). The brief's
  "BPS = 1e7" does not match this version; AegisJIT fee rates use `BPS = 1e9` imported
  from `Fee.sol`. λ / boost / utilization use **1e4 basis points** (10 000 = 100%), as in the brief.
* Aqua orders: `swap()`/`quote()` preload `ctx.swap.balanceIn/Out` from
  `AQUA.safeBalances(...)` **before** the program runs. There is no `AquaBalances`
  opcode, and `StaticBalances` would revert (`SetBalancesExpectZeroBalances`).
* `ISwapVM.quote` is declared **`view`** → integrators call it with STATICCALL. Any opcode
  that writes storage or transient storage in static context would make quoting revert.
* `MinRate._requireMinRate1D` is a wrapping instruction that **must run before** the
  swap-computing instruction (it reverts `MinRateExpectedBeforeSwapAmountsComputed` otherwise).
  It is not part of `AquaOpcodes`; AegisJIT mounts it at index `0x2B`.
* Settlement: `_transferOut` (Maker→Taker via `AQUA.pull`, i.e. `transferFrom(maker)`)
  runs before `_transferIn` by default; Maker hooks `preTransferOut` / `postTransferIn`
  are invoked around them when enabled in `MakerTraits`.

## 3. Architecture

```
                         ┌──────────────────────────── AegisSwapVMRouter ───────────────────────────┐
 Taker ──swap/quote────▶ │ SwapVM core (hash, Aqua safeBalances preload, runLoop, settlement)       │
 (takerData: ZK proof)   │   ctx.vm.dispatch = _dispatch ──or── _dispatchVerifiedHuman              │
                         │   ├─ 0x2A ZKIdentityGuard ─staticcall─▶ IZKVerifier: WorldIDAdapter (type 1) │
                         │   │                                      │ AnonAadhaarAdapter (type 2)    │
                         │   ├─ 0x9A JITVaultReserves ─staticcall─▶ ERC-4626 vaults (live backing)  │
                         │   ├─ 0x2B RequireMinRate (SwapVM MinRate)                                 │
                         │   ├─ 0x7A VolatilitySurgeFee (window state: write only when !static)     │
                         │   └─ AquaOpcodes (Deadline, Jump, XYCSwap, …) via _runOpcode             │
                         └───────────────┬───────────────────────────────────────┬──────────────────┘
                                         │ AQUA.pull / push (virtual balances)    │ Maker hooks
                                         ▼                                        ▼
                                   ┌──────────┐                       ┌─────────────────────┐
                                   │   Aqua   │◀── ship(strategy) ─── │ Maker (EOA)          │
                                   └──────────┘                       │ holds vault SHARES   │
                                                                      └─────────┬───────────┘
                                                 AegisJITVaultHook: JIT withdraw│amountOut before pull
                                                                    re-deposit  │amountIn after push
                                                                                ▼
                                                                ┌────────────────────────────┐
                                                                │ MockERC4626Vault (USDC)     │
                                                                │ MockERC4626Vault (WETH)     │
                                                                └────────────────────────────┘
```

Capital never leaves the Maker's custody: the vault shares sit in the Maker's wallet. The
`AegisJITVaultHook` (an `IMakerHooks` target, callable only by the router) withdraws exactly
`amountOut` from the Maker's vault position into the Maker's own wallet immediately before
Aqua pulls it, and re-deposits the received `amountIn` immediately after Aqua pushes it.
It can only move the Maker's assets between the Maker's wallet and the Maker's vault position
(it requires Maker-granted share/token allowances), never to third parties.

## 4. Strategy program (compiled by `src/aegisProgramBuilder.ts` and `AegisJITStrategy.sol`)

| # | Instruction | Opcode | Notes |
|---|-------------|--------|-------|
| 1 | `Deadline` | `0x0D` | optional (deadline = 0 → omitted) |
| 2 | Aqua balances | — | implicit: preloaded by `swap()`/`quote()` from `AQUA.safeBalances` |
| 3 | `ZKIdentityGuard` | `0x2A` | consumes a typed ZK payload (World ID or ZK Aadhaar) from taker `instructionsArgs` |
| 4 | `JITVaultReserves` | `0x9A` | wraps the rest of the program; post-checks the per-execution cap and the per-window budget |
| 5 | `JumpIfTokenIn` / `RequireMinRate` ×2 / `Jump` | `0x0B`,`0x2B`,`0x0A` | optional two-sided rate floor (one MinRate per direction) |
| 6 | `VolatilitySurgeFee` | `0x7A` | wraps the swap instruction |
| 7 | `XYCSwap` | `0x11` | constant-product over boosted reserves |

**Rate-floor band (step 5).** A single MinRate instruction encodes one reference price that
applies to *both* directions, which would block one side of a two-sided market. The builder
therefore emits:
```
P0: JumpIfTokenIn(tokenB → P2)
P1: RequireMinRate(floor A→B)   ; wraps P1' .. end
P1': Jump(→ P3)
P2: RequireMinRate(floor B→A)   ; wraps P3 .. end
P3: VolatilitySurgeFee …
```
The floor protects the Maker against selling below / buying above a hard price
(e.g. stale-oracle style arbitrage) and sees the final, fee-inclusive amounts.

## 5. Opcode byte layouts

All integers big-endian, tightly packed (`abi.encodePacked`).

### 5.1 `0x2A ZKIdentityGuard` — 46 bytes (modular verifier router)
| Offset | Size | Field | Meaning |
|-------:|-----:|-------|---------|
| 0  | 1  | `uint8 verifierTypes` | accepted proof types, bitmask: `0x01` World ID, `0x02` ZK Aadhaar, `0x03` either |
| 1  | 1  | `uint8 mode` | `0` = Strict gate, `1` = Tiered retail |
| 2  | 4  | `uint32 requiredStateCode` | `0` = any; else Aadhaar `revealArray[3]` must equal it (type 2 only) |
| 6  | 20 | `address worldIdVerifier` | `IZKVerifier` for type 1 (`WorldIDAdapter`); must be zero iff bit `0x01` is unset |
| 26 | 20 | `address aadhaarVerifier` | `IZKVerifier` for type 2 (`AnonAadhaarAdapter`); must be zero iff bit `0x02` is unset |

Both builders (`ZKIdentityGuardArgsBuilder.build`, `encodeZKIdentityGuardArgs`) reject
`verifierTypes ∉ {1,2,3}` and any verifier slot that disagrees with its bit, so the encoding is
canonical. The brief asked for a single `verifierType` selector byte (1 = World ID, 2 = ZK Aadhaar);
making it a bitmask keeps those two values and adds `3`, which is what lets one order serve both
pathways — the whole point of the dual verification.

**Taker args** (consumed via `tryChopTakerArgs`), with the proof type as the first payload byte:

```
[uint16 L][verifierType:1][nullifier:32][revealArray: 4×32 — type 2 only][proof: rest]
[uint16 33][verifierType:1][nullifier:32]                                            (binding claim, no proof)
```

| Type | `nullifier` | `revealArray` | `proof` envelope | `L` |
|---|---|---|---|---:|
| `0x01` World ID | World ID `nullifierHash` | absent (zeros are passed to the adapter) | `abi.encode(uint256 merkleRoot, uint256 epoch, uint256[8] proof)` 320 B, or `abi.encode(merkleRoot, epoch, address recipient, uint256 authDeadline, bytes32 r, bytes32 s, uint8 v, uint256[8])` 480 B when a contract presents it for `recipient` | 353 / 513 |
| `0x02` ZK Aadhaar | Anon Aadhaar nullifier (epoch-rotating) | `[ageAbove18, gender, pincode, state]` | `abi.encode(uint256 timestamp, uint256 epoch, uint256 pubkeyHash, uint256[8])` 352 B, or `(timestamp, epoch, pubkeyHash, recipient, authDeadline, r, s, v, uint256[8])` 512 B | 481 / 641 |
| either | the bound nullifier | absent | **none** — binding claim | 33 |

Empty/short payload ⇒ "no proof". A type the Maker does not accept (`type & verifierTypes == 0`)
⇒ "no proof". Both cases follow the mode rules below; nothing reverts in tiered mode.

**Binding claim (fast path).** A payload of exactly `[type][nullifier]` is not sent to the adapter.
0x2A reads `_bindings[verifier][nullifier]` and treats the taker as verified iff
`beneficiary == ctx.query.taker && validUntil >= block.timestamp`. Claims are refused on orders with
`requiredStateCode != 0` (the opcode-level policy was never evaluated for that order) and never for a
contract taker acting for someone else. Cost: one SLOAD instead of a ~260k-gas pairing, so only the
first trade per epoch carries a proof (demo: 339.5k gas vs 681k).

**Taker authorisation (aggregators, relayers, smart accounts).** The `recipient` envelopes are honoured
for any taker that presents the recipient's EIP-712 signature over
`TakerAuthorization(address taker, uint256 deadline)` in the adapter's domain
(`name = "AegisJIT ZK Adapter"`, `version = "1"`, `chainId`, `verifyingContract = adapter`), verified
with OpenZeppelin `SignatureChecker` (ECDSA or ERC-1271, view-only). This replaced the constructor-fixed
forwarder whitelist: no admin, no setters, any aggregator, bounded by the deadline the human chose.

**Epochs and grace.** The envelope names its `epoch`; the adapter derives the nullifier seed (Aadhaar) or
the external nullifier (World ID) from it and accepts `epoch == currentEpoch()`, or
`epoch + 1 == currentEpoch()` during the first `EPOCH_GRACE` seconds of the current epoch (default 600 s),
so a ~13 s proof made before a roll still lands. The binding validity returned to 0x2A is the end of the
proof's own epoch, so a grace proof grants the tier for that trade but cannot extend a binding.

**Execution.** `0x2A` chops the payload, selects the adapter for the type, runs the type's cheap
public-input policy first (type 2: `revealArray[0] == 1`, state code), then STATICCALLs
`IZKVerifier.verifyProof(ctx.query.taker, nullifier, revealArray, proof) → (bool ok, address beneficiary)`.
A taker is *verified* iff the call succeeds, returns exactly 64 bytes with `ok == 1`, and the
nullifier binding (below) allows it. The verifier interface is unchanged, so the World ID adapter
and the Anon Aadhaar adapter are interchangeable from the opcode's point of view.

* Mode 0 (Strict): not verified ⇒ `revert ZKVerificationFailed()`.
* Mode 1 (Tiered): never reverts; not verified ⇒ continue as unverified.
* Verified (either mode, either proof type) ⇒ `ctx.vm.dispatch` is switched to the router's
  `_dispatchVerifiedHuman`, which routes `0x7A` with `verifiedHuman = true` (base fee halved:
  0.30% → 0.15% in the demo order). This is the "human-verified flag in transient state": it lives
  in the VM's in-memory `Context` for this execution only. It is valid under STATICCALL (`quote()`),
  cannot leak across swaps, and needs no `TSTORE`, which would revert inside the `view` `quote()`.

**Nullifier binding (anti-Sybil), per verifier.** After a successful proof check, 0x2A looks up
`_bindings[verifier][nullifier] = {beneficiary, validUntil}`. If unbound, the first **swap** binds it
to the beneficiary with the adapter's `validUntil` (written only when `!isStaticContext`). If bound
to another beneficiary, the taker is unverified, expired or not: a nullifier stays with its first
address. The same beneficiary may re-prove to extend `validUntil`. Keying by verifier keeps the two
schemes in separate namespaces.
* World ID: `nullifierHash = Poseidon(externalNullifier, identityNullifier)` is stable per human per
  (app, action). With rotation off this is **one discounted address per human** for the lifetime of
  the adapter (`validUntil = type(uint40).max`). With `EPOCH_DURATION > 0` the action becomes
  `actionFor(epoch) = "<action>-<epoch>"`, the `nullifierHash` changes every epoch and the binding
  ends with the epoch — the same model as Aadhaar.
* ZK Aadhaar with an epoch-rotating `AnonAadhaarAdapter`: the nullifier changes every epoch, so
  this is **one address per human per epoch**, unlinkable *by nullifier* across epochs. The binding
  ends at `min(epochEnd, timestamp + MAX_PROOF_AGE)`.

**World ID adapter: `contracts/zk/WorldIDAdapter.sol`** (type 1). It implements `IZKVerifier` over
the World ID Router (`contracts/zk/world-id/IWorldID.sol`, the 6-argument router entry point,
declared `view`):
`verifyProof(root, groupId, signalHash, nullifierHash, externalNullifierHash, uint256[8] proof)`.
- `groupId = 1` (Orb-verified humans). The router reverts on any failure and returns nothing; the
  adapter wraps it in `try/catch` and returns `false`. It also returns `false` for malformed
  envelopes and for a router with no code, so it never reverts.
- **Signal binding:** `signalHash = ByteHasher.hashToField(abi.encodePacked(beneficiary))`, exactly
  as World ID's on-chain template hashes an address signal and as IDKit / World App compute it
  when the `signal` is the user's address. The brief's `uint256(uint160(taker))` is the same
  binding (the signal *is* the taker's address) expressed in World ID's hashing convention; using
  the raw integer would reject every proof World App produces. A searcher replaying the takerData
  from another address presents a different `signalHash` and the pairing check fails.
- **External nullifier:** `hashToField(abi.encodePacked(hashToField(appId), action))` from the
  constructor's `appId` / `action` (World ID template). One action = one `nullifierHash` per human.
- **Authorised takers:** the 480-byte envelope `(root, epoch, recipient, deadline, r, s, v, proof)`
  binds `signal = recipient` and is honoured for any `taker` holding the recipient's EIP-712
  `TakerAuthorization` (see §5.1). `AegisZKForwarder` is the reference aggregator: it enforces
  `recipient == msg.sender` and understands both payload types, but nothing whitelists it.
- **Epochs:** `currentEpoch`, `isAcceptedEpoch` (grace), `epochEnd`, `actionFor(epoch)`,
  `externalNullifierFor(epoch)`, `currentExternalNullifier`. `EXTERNAL_NULLIFIER` stays the static one.
- No admin, no setters, no stored roots: root validity is the Router's business.

**Local World ID stack (tests, fuzzing, demo, dashboard).** `contracts/mocks/MockWorldIDRouter.sol`
mirrors the Router + Identity Manager behaviour an integrator depends on: the 6-argument `view`
`verifyProof`, `NoSuchGroup(groupId)` for any group but 1, and root history — the latest root is
always valid, a superseded root stays valid for `ROOT_HISTORY_EXPIRY` (World ID default 1 hour) and
then `ExpiredRoot()`, an unknown root is `NonExistentRoot()` (same errors as `IBaseWorldID`). Roots
are published by an `IDENTITY_OPERATOR` (the signup sequencer's role). Proof verification is
delegated to an `IWorldIDSemaphoreVerifier` (`verifyProof(uint256[8] proof, uint256[4] input)`,
`input = [root, nullifierHash, signalHash, externalNullifierHash]`), which is either
`MockSemaphoreVerifier` — a soundness-modelling double that accepts only exactly-registered
statements, like `MockGroth16AnonAadhaar` — or the vendored, unmodified World ID `SemaphoreVerifier`
(real BN254 pairing; see §7c). The mock is introduced with this milestone because the adapter's
tests (invalid roots, expiry, groups) need the router semantics; the brief listed it under the
demo milestone.

**ZK Aadhaar adapter (type 2): `contracts/zk/AnonAadhaarAdapter.sol`.** It implements
`IZKVerifier` over the deployed Anon Aadhaar contract:
`verifyAnonAadhaarProof(nullifierSeed, nullifier, timestamp, signal, revealArray, groth16Proof)`, or
`verifyAnonAadhaarProofWithKey(pubkeyHash, …)` when the envelope names a key.
- `proof` bytes = `abi.encode(uint256 timestamp, uint256 epoch, uint256 pubkeyHash, uint256[8])` (352 B),
  or with `(address recipient, uint256 deadline, bytes32 r, bytes32 s, uint8 v)` (512 B).
- `signal = uint256(uint160(beneficiary))` (Anon Aadhaar hashes it internally).
- Freshness: `0 <= block.timestamp − timestamp <= MAX_PROOF_AGE` (default 30 days; `timestamp` is the
  QR's issuance hour, so this is how often a resident must re-download their QR).
- `revealArray[0] == 1`. `revealArray[3]` must equal `REQUIRED_STATE` if set (full-width because
  the circuit emits the state as a packed string; Anon Aadhaar order is `[ageAbove18, gender,
  pincode, state]`).
- Epoch-rotating nullifiers: `nullifierSeed = keccak256(APP_SEED, epoch) mod p` for the envelope's
  `epoch`, accepted per §5.1 (current epoch, or previous during `EPOCH_GRACE`). The circuit computes
  `nullifier = Poseidon(nullifierSeed, photo)`, so the nullifier rotates every epoch.
- UIDAI key set: `AnonAadhaarGroth16Verifier` holds a set of trusted circuit `pubkeyHash` values
  (first = primary, used by the upstream-shaped entry point). UIDAI rotates certificates and several
  stay valid at once; the envelope's `pubkeyHash` selects one (0 = primary).

`MockGroth16AnonAadhaar` is the Aadhaar soundness double; `MockAnonIdentityVerifier` (ECDSA
attestation, type-2 shaped) still backs the main invariant suite.

### 5.2 `0x9A JITVaultReserves` — 86 bytes
| Offset | Size | Field | Meaning |
|-------:|-----:|-------|---------|
| 0  | 20 | `address vaultA` | ERC-4626 backing for `tokenA` (lower address) or `0` = use Aqua balance |
| 20 | 20 | `address vaultB` | ERC-4626 backing for `tokenB` (higher address) or `0` |
| 40 | 4  | `uint32 lambdaBps` | per-swap exposure cap, `(0, 10000]` (2500 = 25%) |
| 44 | 6  | `uint48 virtualBoostBps` | virtual depth multiplier, `>= 10000` (20000 = 2.0x) |
| 50 | 16 | `uint128 refA` | Maker's committed Aqua allocation of `tokenA` (boost anchor) |
| 66 | 16 | `uint128 refB` | Maker's committed Aqua allocation of `tokenB` |
| 82 | 4  | `uint32 exposureWindowSec` | λ budget window in seconds (`0` = per-execution cap only; 600 in the demo) |

`vaultIn/vaultOut` and `refIn/refOut` are resolved at runtime from the A/B fields by
comparing `tokenIn < tokenOut` (same convention as `MinRateArgsBuilder`), so one order serves
both swap directions.

Execution (quote == swap: reads in both, writes only when `!isStaticContext`):
1. For each non-zero vault: `require(vault.asset() == token)`.
2. `rawOut = vaultOut == 0 ? ctx.swap.balanceOut : vaultOut.maxWithdraw(maker)` — what the Maker can
   redeem right now, including vault-level liquidity limits, so a quote never promises what the
   `preTransferOut` hook could not withdraw.
3. `capOut = min(rawOut * λ / 1e4, ctx.swap.balanceOut)` — never more than λ of the live
   withdrawable backing, and never more than Aqua can actually pull.
4. Budget bucket per `(orderHash, tokenOut)`: `{start, outFlow, refBacking}` on a fixed grid of
   `exposureWindowSec`. `used = max(0, outFlow − k · λ·refBacking)` for the `k` whole windows elapsed;
   when `used == 0` the grid re-anchors at this trade and `refBacking = rawOut`.
   `remaining = λ·refBacking − used`.
5. Concentration via **constant** virtual offsets:
   `balanceIn += refIn·(boost−1e4)/1e4`, `balanceOut += refOut·(boost−1e4)/1e4`.
   This is a shifted constant-product curve (a Uniswap-v3-style range): at ship time the
   book has `boost×` depth, and the curve stays path-independent as Aqua balances evolve.
6. exactOut: pre-check `amountOut <= capOut` and `amountOut <= remaining`. Then `ctx.runLoop()`.
7. Post-check the same two bounds, else `revert JITExposureCapExceeded(amountOut, capOut)` /
   `JITExposureBudgetExceeded(amountOut, remaining)`.
8. swap only: `outFlow = used + amountOut`, store `start`, `refBacking`, emit `ExposureWindowUpdated`.

Bound: at most λ of the backing leaves per window in steady state, at most 2λ across one window
boundary, however many executions, blocks or taker addresses the drain is split into.

### 5.3 `0x7A VolatilitySurgeFee` — 20 bytes
| Offset | Size | Field | Meaning |
|-------:|-----:|-------|---------|
| 0  | 4 | `uint32 baseFeeBps` | base LP fee, `BPS = 1e9` scale |
| 4  | 4 | `uint32 maxSurgeFeeBps` | marginal fee rate for flow above threshold, `base <= max < 1e9` |
| 8  | 8 | `uint64 impactThresholdBps` | utilization (1e4 = 100% of `balanceIn`) where surge begins |
| 16 | 4 | `uint32 decayWindowSec` | token-bucket window: leaks one threshold per window, never resets (0 = stateless, per-trade) |

**Fee schedule.** Fee is charged on gross `amountIn` (Maker-side, stays in the pool like
`FlatFeeAmountIn`). Let `B` = reference `balanceIn`, `T = B·threshold/1e4`, `F` = flow
already accumulated in the current window for this `(orderHash, tokenIn)`, `b` = base rate
(halved for verified humans), `P = maxSurge − base` (surge premium). The marginal rate on
cumulative-window flow `x` is `b` for `x < T` and `b + P` for `x ≥ T`. For a trade of gross
size `g`, with `G0 = max(0, T − F)`:

```
fee(g) = ceil( (g·b + max(0, g − G0)·P) / 1e9 )
net(g) = g − fee(g)                         // amount fed to the swap curve
```
Effective rate rises piecewise-linearly from `b` toward `b + P = maxSurge` (capped by
construction). Verified humans pay `base/2` on the whole trade; the surge premium is
unchanged (large human trades are still toxic to the pool).

* exactIn: `amountIn := net(g)`; `runLoop`; restore `amountIn = g`.
* exactOut: `runLoop` yields required net `n`; closed-form inverse
  `g = ceilDiv(n·1e9, 1e9 − b)` if `n·1e9 <= G0·(1e9 − b)`, else
  `g = ceilDiv(n·1e9 − G0·P, 1e9 − b − P)`; then `while (net(g) < n) g++` (≤ 2 steps).
  `net` is non-decreasing (marginal rate < 100%), so this yields the smallest-or-near `g`
  with `net(g) >= n` — Maker-favouring and symmetric with exactIn within rounding.
* **Bucket state.** `{start, flow, refBalanceIn}` is read from storage keyed by
  `(orderHash, tokenIn)` and evaluated on a fixed time grid: for the `k` whole windows elapsed since
  `start`, `F = max(0, flow − k·T)` with `T = refBalanceIn·threshold/1e4`; `B` stays frozen while
  `F > 0`, and when the bucket is empty the grid re-anchors at this trade with `B = balanceIn`.
  Inside a window nothing depends on time, so `quote` and `swap` are equal to the wei whenever
  both fall in the same window (Hardhat's `eth_call` runs at the latest block's timestamp, so a
  per-second decay would have made every quote stale by one block — rejected for that reason).
  Writes (`start`, `F + g`, `B`) happen **only when `!ctx.vm.isStaticContext`**, after the amounts
  are computed (same pattern as SwapVM's `Balances._dynamicBalancesXD`). Capacity: `T` per window
  at the base rate in steady state; a `k·T` burst keeps the surge on for `k` windows.

## 6. Invariants (proved in `test/AegisJIT.test.ts`)

1. **Quote == Swap** — `quote()` (static) returns exactly the `amountIn/amountOut` that `swap()` settles.
2. **Symmetry** — `exactIn(X) → Y` then `exactOut(Y) → X'` with `X' <= X` and `X − X' <= 2 wei`.
3. **Sub-additivity** — two back-to-back `amount/2` swaps never return more than one `amount` swap.
4. **Monotonicity** — `amountOut` strictly increases with `amountIn`; average price non-increasing.
5. **ZK tier differentiation** — verified human gets strictly more out than unverified bot for the same input.
6. **JIT protection** — no single execution, and no window of executions, moves more than λ of the
   Maker's withdrawable `tokenOut` backing (`JITExposureCapExceeded` / `JITExposureBudgetExceeded`).
7. **Round-trip safety** — buy-then-sell never returns more than the taker put in.
8. **Binding claims** (`test/BindingFastPath.test.ts`) — after one proof the bound address gets the
   tier from a 33-byte claim with no adapter call; nobody else does; claims die with the epoch.
9. **Taker authorisation** (`test/EpochNullifiers.test.ts`, Foundry) — exactly the authorised
   contract may present a human's proof, until the deadline.

Fee-math properties (`net` monotone, minimal exactOut inverse, fee cap, pipeline symmetry)
are additionally fuzzed with Foundry in `test/foundry/SurgeFeeMath.t.sol`.

## 7. Deviations from the brief (and why)

| Brief | This spec | Reason |
|-------|-----------|--------|
| `ctx.balanceIn/Out = raw × λ` each swap | λ is a hard **exposure cap**; pricing uses the Aqua book + constant boost offsets | Re-clamping by λ<1 on every swap re-centres the curve after each trade, so splitting a trade gets a *better* price (worked example: 2×50k USDC → 32.0 WETH vs 1×100k → 28.6 WETH on a 1M/400 book with λ = 25%). That violates invariant 3. |
| `virtualBoostBps` as a multiplier on current reserves; 50-byte layout | Boost = constant offsets `(boost−1)·ref`; layout extended by `refA, refB` (82 bytes; 86 since `exposureWindowSec`, §7d) | Multiplying the *current* reserves by `boost > 1` on every swap is round-trip exploitable: buy 50k USDC of WETH, sell it straight back → 52.5k USDC (2× boost, 1M/400 book), a 2.5k loss to the Maker before fees. Constant offsets make it a fixed shifted curve (round trip returns exactly 50k). A constant needs an absolute anchor, and no view-safe one exists at runtime, so the Maker's committed allocation is encoded in the args. (Found while implementing; the first draft of this spec used the multiplier.) |
| Utilization `= amountIn·1e4/balanceIn`, stateless | Utilization measured on **cumulative flow within `decayWindowSec`** with a frozen reference balance | Any stateless convex size-fee is split-gameable (two halves each below threshold dodge the surge). Accumulating flow makes the fee path-independent within the window, which is what invariant 3 needs; `decayWindowSec` becomes the accumulation window. |
| `BPS = 1e7` | `BPS = 1e9` | Matches `Fee.sol` in the pinned SwapVM. |
| `RequireMinRate` last | Before the surge fee / swap | MinRate is a wrapping instruction and reverts if amounts are already computed. |
| `AquaBalances / StaticBalances` opcode | Implicit Aqua preload | Not an opcode in AquaOpcodes; StaticBalances would revert on preloaded balances. |
| ZK flag "in ctx" | Dispatcher switch `ctx.vm.dispatch` | `Context` has no free field; transient storage is unusable under STATICCALL (`quote` is `view`). |
| "MockERC4626Vault seeded with 1M USDC and 400 WETH" | Two `MockERC4626Vault` instances (USDC, WETH) | ERC-4626 vaults are single-asset by definition. |
| ZK verifier | `MockAnonIdentityVerifier` checks an ECDSA attestation from a trusted issuer over `(chainid, verifier, taker, nullifier, revealArray)` | Deterministic and cryptographically real for local testing (no hardcoded `true`); a Groth16/Anon-Aadhaar adapter implementing `IZKVerifier` drops in without touching the opcode. |
| 0x2A `verifierType` selector byte (1 World ID, 2 ZK Aadhaar) | bitmask `verifierTypes` (1, 2 or 3) + both adapter addresses; the taker payload carries the single type it supplies | A Maker must be able to accept *both* pathways in one order; a single selector would need two 0x2A instructions fighting over the same taker payload. |
| World ID signal `uint256(uint160(taker))` | `signalHash = hashToField(abi.encodePacked(taker))` (World ID `ByteHasher`) | Same binding (the signal is the taker's address) in the hashing World App / IDKit actually use; the raw integer would reject every real World ID proof. |
| `MockWorldIDRouter` in the demo milestone | introduced with the adapter | The adapter's unit tests for invalid / expired roots and groups need the router semantics. |
| "human-verified flag in transient state" | dispatcher switch in the in-memory `Context` | `quote()` is a `view` (STATICCALL): `TSTORE` would revert there and break quote == swap. |

## 7d. Hardening after the adversarial review (2026-11-06)

| Finding | Change |
|---|---|
| λ capped one execution; 4 max-cap swaps in one block drained 68% of the vault, 10 drained 94% | per-window λ budget bucket in 0x9A (`exposureWindowSec`, 86-byte args), `JITExposureBudgetExceeded` |
| 0x7A window reset at expiry: a 601 s wait restored full base-fee capacity after any burst | token bucket on a fixed grid: leaks one `T` per window, never resets |
| `convertToAssets(balanceOf)` sizing could quote what an illiquid vault cannot withdraw; a capped vault failed settlement | `maxWithdraw(maker)` sizing; hook skips the re-deposit (`JITDepositSkipped`) instead of reverting |
| every swap paid the ~260k-gas pairing | `{beneficiary, validUntil}` bindings + 33-byte binding claims (fast path); first-address rule survives expiry |
| a proof made just before the epoch roll was rejected on inclusion | envelope names its `epoch`; previous epoch accepted during `EPOCH_GRACE` |
| World ID `nullifierHash` permanently linkable; lost wallet = lost tier forever | optional per-epoch action rotation (`actionFor(epoch)`) |
| forwarder whitelist fixed in the adapter constructors; aggregators could never be added | EIP-712 `TakerAuthorization(taker, deadline)` by the beneficiary, ECDSA / ERC-1271 |
| one hard-coded UIDAI key hash | `AnonAadhaarGroth16Verifier` trusts a key set; envelope carries `pubkeyHash` |
| `MAX_PROOF_AGE = 24 h` implied daily QR re-downloads | default 30 days; epochs, not QR age, drive re-proving |
| "unlinkable across epochs" overstated | README states what the Anon Aadhaar `timestamp` / `state` public signals still leak |

Known limits (documented, not hidden): the bucket leaks `T` per window, so a taker who waits
`k` windows regains `k·T` of base-fee capacity; λ bounds each window (2λ across one boundary),
while the Aqua allocation bounds cumulative exposure over longer horizons.

## 7a. Bytecode size (EIP-170)

| Build | Runtime size | Headroom vs 24,576 B |
|---|---:|---:|
| Stock `AquaSwapVMRouter`, template optimizer (`runs: 1`, minimal Yul steps `dhfoDgvulfnTUtnIf`) | 24,281 B | 295 B |
| `AegisSwapVMRouter`, template optimizer | 29,550 B | **−4,974 B (undeployable)** |
| `AegisSwapVMRouter`, full default Yul optimizer (`runs: 1`, `viaIR`) | 21,021 B | 3,555 B |
| `AegisSwapVMRouter` with the modular 0x2A (two verifier slots, typed payloads) | **21,897 B** | 2,679 B |

Size by component in the template build: JIT ≈ 1.5 KB, surge fee ≈ 1.7 KB, ZK guard ≈ 1.3 KB,
MinRate ≈ 0.4 KB. Splitting `_route` across two dispatchers costs only 32 B. The override in
`hardhat.config.ts` applies to `contracts/AegisSwapVMRouter.sol` only, so every other
contract keeps the template's settings. `AegisOpcodes` lives in its own file so
`AegisJITStrategy` does not pull the router into the default-settings job. Moving
instruction logic into external libraries was rejected: it would add DELEGATECALL overhead
and ABI-encoding glue per opcode, and the optimizer alone recovers about 8.5 KB.

## 7b. Merged zkAadhaar → Anon Aadhaar → 0x2A pipeline

```
Secure QR (decimal) ─▶ BigInt → bytes → GUNZIP ─▶ signedData ‖ 256-B RSA signature
   │  zkAadhaar (packages/zk-aadhaar/src/lib/aadhaar): parse fields + photo; RSA-2048 PKCS#1 v1.5 / SHA-256
   │  against pinned UIDAI certificates (Web Crypto)            ← browser (UI) or Node (tests / demo)
   ▼
circuit inputs (prover/anon-aadhaar.ts, mirrors @anon-aadhaar/core 2.4.3 generateArgs):
   qrDataPadded = SHA-256-pad(signedData) zero-filled to 1536 B, 18 delimiter indices,
   signature / pubKey as 17 × 121-bit words, nullifierSeed, signalHash = keccak(uint256 signal) >> 3,
   reveal flags (ageAbove18, state)
   ▼  snarkjs groth16.fullProve(aadhaar-verifier.wasm, circuit_final.zkey)   ~13 s, Node, local only
public signals [pubkeyHash, nullifier, timestamp, ageAbove18, gender, pincode, state, nullifierSeed, signalHash]
   ▼  packed proof [a0, a1, b01, b00, b11, b10, c0, c1]
0x2A taker args = [uint16 L][nullifier][revealArray[4]][abi.encode(timestamp, epoch, pubkeyHash, [recipient, deadline, r, s, v,] uint256[8])]
   ▼
AnonAadhaarAdapter (seed = keccak(APP_SEED, epoch) mod p, epoch current or in grace; 0 ≤ now − ts ≤ MAX_PROOF_AGE; age; state;
                    signal = beneficiary = taker or an EIP-712-authorised recipient)
   → AnonAadhaarGroth16Verifier (pubkeyHash ∈ trusted key set) → Verifier.sol (ecMul/ecAdd + ecPairing 0x08)
   next trade in the epoch: [uint16 33][0x02][nullifier] → 0x2A binding claim, no adapter call
```

**Artifact integrity.** `fetch-artifacts.mjs` pins the SHA-256 of `circuit_final.zkey` (612 MB),
`aadhaar-verifier.wasm` and `vkey.json`. The verification key exported from the zkey equals
`vkey.json`, and all 26 curve constants appear in the vendored `Verifier.sol`.

**Measured gas** (Hardhat, cancun):

| Item | Gas |
|---|---:|
| `ecPairing` STATICCALL (4 pairs) | 181,100 (= EIP-1108 181,000 + 100 warm access) |
| 0x2A verifier call (adapter + Groth16 incl. pairing) | ≈ 265,900 |
| swap with proof vs the same swap without | ≈ 681,300 vs ≈ 393,200 on a cold budget window, ≈ 334,500 warm (overhead ≈ 288k) |
| next swap in the epoch with a 35-byte binding claim | ≈ 339,500 (≈ 5k over a proof-less swap) |

**Deviations from the Phase-3 brief**

| Brief | Implementation | Reason |
|---|---|---|
| zkAadhaar provides the prover | zkAadhaar provides scanning, parsing and RSA. Proving uses the official Anon Aadhaar v2 circuit and artifacts | zkAadhaar contains no circuit. Writing a new RSA-in-circuit circuit plus a trusted setup was out of scope, and a circuit without in-circuit RSA would prove nothing about UIDAI |
| Client-side prover in the browser | Local Node prover service on 127.0.0.1, called by the browser | User's choice: avoids loading the 612 MB zkey into a browser during a 3-minute demo. The UI states that the QR is sent to the local process |
| "Never leaves the browser" | Parsing and RSA stay in the browser. The proving step sends the QR to the local prover | Accuracy |
| Real Aadhaar QR → proof | Synthetic **V2** QRs signed by a committed TEST key | The circuit parses V2. Real QRs need the UIDAI trust root, and must not be committed |
| `nullifierEpochOwner[epoch][nullifier]` | Epoch-derived `nullifierSeed`, so the nullifier itself rotates; binding stays keyed by nullifier | An epoch-keyed map over a static nullifier still links every wallet through the nullifier in calldata |
| `requiredStateCode` in `revealArray[2]` | `revealArray[3]` (state); full-width adapter `REQUIRED_STATE` | Anon Aadhaar order is [age, gender, pincode, state], and state is a packed string that doesn't fit `uint32` |
| `MockGroth16AnonAadhaar` only for Foundry fuzz | Also kept for fast adapter unit tests; every end-to-end path uses real proofs | Those unit tests need inputs a real prover can't produce, and ~13 s per proof matters |
| `Verifier.sol` MIT | Kept GPL-3.0, unmodified | That is its licence (snarkjs template) |

## 7c. World ID pathway (dual verification)

```
World App / IDKit (production)        local tree + prover (tests, demo, dashboard)
  Orb-verified identity in the         packages/world-id: Semaphore v3 identities, depth-30 Group,
  World ID tree (depth 30)             snarkjs Groth16 over the public PSE depth-30 artifacts
      │ signal = taker address, action = "aegis-jit-fee-tier"
      ▼
  { merkle_root, nullifier_hash, proof[8] }
      ▼
0x2A taker args = [uint16 L][0x01][nullifierHash][abi.encode(merkleRoot, epoch, [recipient, deadline, r, s, v,] uint256[8])]
      ▼
WorldIDAdapter → IWorldID.verifyProof(root, 1, hashToField(beneficiary), nullifierHash, externalNullifierFor(epoch), proof)   (STATICCALL)
      (action rotation optional: actionFor(epoch) = "<action>-<epoch>"; IDKit is asked for that action)
      ▼ production: World ID Router (World Chain / Ethereum / Optimism …)
                    live: World Chain Sepolia 0x57f928158C3EE7CDad1e4D8642503c4D0201f611, staging app, IDKit legacy Orb proofs
      ▼ local:      MockWorldIDRouter (group 1, root history, 1 h expiry) → SemaphoreVerifier (vendored, real pairing)
```

The vendored `contracts/zk/vendor/world-id/SemaphoreVerifier.sol` is World ID's own verifier
(world-id-contracts, MIT; only the import path changed). All 24 verification-key constants in it
equal the key exported from the public Semaphore depth-30 zkey (SHA-256 `00aaa6d8…a948`), so a
proof generated locally for a local identity tree verifies against the exact contract World ID
runs on-chain. The only thing local is the tree: the project plays the signup sequencer and
publishes its own roots to `MockWorldIDRouter`.

**Measured gas** (Hardhat, cancun; `test/RealWorldIDSwap.test.ts`, `scripts/demo-mumbai.ts`):

| Item | Gas |
|---|---:|
| `ecPairing` STATICCALL (4 pairs) | 181,100 |
| `SemaphoreVerifier.verifyProof` (incl. 21k base; MSM over 4 public inputs + pairing) | 239,014 |
| 0x2A verifier call (adapter + router + verifier) | ≈ 224,500 |
| swap with a World ID proof vs the same swap without | ≈ 559,400 vs ≈ 334,500 (overhead ≈ 225k); later swaps in the epoch: binding claim ≈ 5k |

The World ID path costs about 50k gas less than the Anon Aadhaar path (4 public inputs instead of 9).

**Local prover (`packages/world-id`).** Semaphore v3 `Identity(seed)` (deterministic for tests),
`Group(1, 30, commitments)`, snarkjs `groth16.fullProve` over the circuit inputs
`{identityTrapdoor, identityNullifier, treePathIndices, treeSiblings, externalNullifier, signalHash}`
with the already-hashed World ID values, proof packed `[a0, a1, b01, b00, b11, b10, c0, c1]`.
Hardhat tests and the demo call it through a JSON CLI (`prover/cli.ts`), like the Aadhaar prover.
A real proof for the default tree is committed as `test/fixtures/world-id/human-proof.json` so the
Foundry suite exercises the vendored verifier without snarkjs.

**Dashboard (`ui/src/lib/worldid.ts`).** The same identity/tree/proving code runs in the browser:
the 4.5 MB zkey and 1.3 MB wasm are self-hosted under `ui/public/semaphore/30` and snarkjs'
browser build proves in ~1 s. The witness (identity secrets, merkle path) stays in the tab; the
page then runs `WorldIDAdapter.verifyProof` by `eth_call`, builds the takerTraits header for the
321-byte type-1 payload (`buildTakerData`: slice index 9 = payload end, flags from the seeded
header) and attaches it to the Verified Human profile. `fromIdKitResult` maps an IDKit / World App
result (`merkle_root`, `nullifier` or `nullifier_hash`, abi-encoded `proof`) to the same payload.

IDKit 4.x in the dashboard: `IDKitRequestWidget` with `preset = orbLegacy({ signal: taker })`,
`allow_legacy_proofs` (the router's 6-argument `verifyProof` checks World ID 3.0 Orb proofs) and
`environment = staging | production`. Every request carries an `rp_context` signed with the app's
relying-party key; that signature is produced by the local prover process
(`POST /worldid/rp-context`, `@worldcoin/idkit-core/signing`) so the key never reaches the browser.
`handleVerify` runs `WorldIDAdapter.verifyProof` through the deployment's router by `eth_call`
before the widget reports success. Against a public deployment (`scripts/ui-deployment.ts`) the
dashboard is read-only: quotes, buckets and proofs work, `swap()` and the `evm_snapshot` sandbox
are disabled and the IDKit result is downloaded for `IDKIT_RESULT=… scripts/demo-sepolia.ts`.

## 8. Milestones

1. Spec (this file)
2. Instruction libraries `contracts/instructions/{ZKIdentityGuard,JITVaultReserves,VolatilitySurgeFee}.sol` + mocks
3. `AegisSwapVMRouter.sol`, `AegisJITStrategy.sol`, `AegisJITVaultHook.sol`, `src/aegisProgramBuilder.ts`
4. `test/AegisJIT.test.ts` invariant + unit tests
5. `scripts/demo-mumbai.ts` + README
6–9. Licensing, Anon Aadhaar adapter + nullifier binding, multi-block demo, SwapVM Inspector UI
10–13. zkAadhaar merge + real Groth16, epoch nullifiers + forwarders, ZK Pass UI, docs
14. World ID: `WorldIDAdapter`, modular 0x2A (`verifierTypes`, typed payloads), `MockWorldIDRouter`, `test/WorldIDAdapter.test.ts`
15. World ID backend: `packages/world-id` prover (real Semaphore proofs), vendored verifier, Foundry fuzz, demo scenarios 1A/1B
16. Dashboard: dual-tab ZK Pass (World ID proofs generated in the browser with snarkjs / ZK Aadhaar via the local prover), typed takerData header builder, disassembler PASSED status per proof type, IDKit result import, headless smoke for both tabs
17. Hardening after the adversarial review (§7d): maxWithdraw sizing + hook fallback, token-bucket surge window, per-window λ budget, binding claims, epoch grace, World ID action rotation, taker authorisation, UIDAI key set
18. Ethereum Sepolia: resumable deployment (`scripts/deploy-sepolia.ts`), Etherscan verification, public-chain demo runner with real proofs, README renderer; 15 verified contracts, 10 live scenarios
19. World Chain Sepolia: deployment against the chain's World ID Router (staging app from the Developer Portal), Worldscan verification, IDKit 4.x request signing in the prover, `IDKitRequestWidget` in the dashboard, read-only public dashboard config + `smoke:public`, `IDKIT_RESULT` demo scenario
