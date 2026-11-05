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
| `0x2A` | `ZKIdentityGuard`   | Sybil/compliance gate; tiers takers into *verified human* vs *unverified* |
| `0x9A` | `JITVaultReserves`  | Reads live ERC-4626 backing; enforces per-swap exposure cap λ; virtual-offset depth boost |
| `0x7A` | `VolatilitySurgeFee`| Size- and flow-aware LVR fee; 50% base-fee discount for verified humans |

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
                         │   ├─ 0x2A ZKIdentityGuard ─staticcall─▶ IZKVerifier (MockAnonIdentity)   │
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
| 3 | `ZKIdentityGuard` | `0x2A` | consumes ZK payload from taker `instructionsArgs` |
| 4 | `JITVaultReserves` | `0x9A` | wraps the rest of the program; post-checks exposure cap |
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

### 5.1 `0x2A ZKIdentityGuard` — 25 bytes
| Offset | Size | Field | Meaning |
|-------:|-----:|-------|---------|
| 0  | 20 | `address verifier` | `IZKVerifier` implementation |
| 20 | 1  | `uint8 mode` | `0` = Strict gate, `1` = Tiered retail |
| 21 | 4  | `uint32 requiredStateCode` | `0` = any; else `revealArray[3]` must equal it |

**Taker args** (consumed via `tryChopTakerArgs`):
`[uint16 L][nullifier:32][revealArray[0..3]: 4×32][proof: L−160]`.
Empty/short payload ⇒ "no proof". `revealArray` follows the Anon-Aadhaar convention
`[ageAbove18, gender, pincode, state]`.

`IZKVerifier.verifyProof(address taker, uint256 nullifier, uint256[4] calldata revealArray, bytes calldata proof) external view returns (bool)`
is invoked with a low-level **STATICCALL** binding the proof to `ctx.query.taker`
(prevents a bot replaying a human's proof). A human is *verified* iff the call succeeds,
returns exactly 32 bytes `true`, `revealArray[0] == 1`, and the state code matches.

* Mode 0 (Strict): not verified ⇒ `revert ZKVerificationFailed()`.
* Mode 1 (Tiered): never reverts; not verified ⇒ continue as unverified.
* Verified (either mode) ⇒ `ctx.vm.dispatch` is switched to the router's
  `_dispatchVerifiedHuman`, which routes `0x7A` with `verifiedHuman = true`. This is a
  pure in-memory change of the VM's own dispatcher, scoped to this execution, valid in
  static context, and requires no storage.

**Nullifier binding (anti-Sybil).** After a successful proof check, 0x2A looks up
`nullifierTaker[verifier][nullifier]`. If it is unbound, the first **swap** binds it to
`ctx.query.taker` (written only when `!isStaticContext`). If it is bound to a different
taker, the taker is treated as unverified. One Aadhaar identity therefore gets one
discounted address.

**Production verifier: `contracts/zk/AnonAadhaarAdapter.sol`.** It implements `IZKVerifier`
over the deployed Anon Aadhaar contract:
`verifyAnonAadhaarProof(nullifierSeed, nullifier, timestamp, signal, revealArray, groth16Proof)`.
- `proof` bytes = `abi.encode(uint256 timestamp, uint256[8] groth16Proof)` (288 B).
- `signal = uint256(uint160(taker))`: a searcher replaying takerData from another address fails.
- Freshness: `0 <= block.timestamp − timestamp <= MAX_PROOF_AGE` (default 24 h).
- `revealArray[0] == 1`. `revealArray[3]` must equal `REQUIRED_STATE` if that is set; this is
  full-width because the circuit emits state as a packed string, which does not fit 0x2A's
  `uint32`. (Anon Aadhaar order is `[ageAbove18, gender, pincode, state]`, so state is index 3.)
- App scoping via the immutable `NULLIFIER_SEED`. The adapter never reverts; it returns false.
- Caveat: `taker` is `msg.sender` of `swap()`. If a taker routes through an intermediary
  contract (aggregator or resolver), the proof must be bound to that contract's address.

**Epoch-rotating nullifiers.** `AnonAadhaarAdapter(…, epochDuration, …)` requires the proof's
`nullifierSeed = uint256(keccak256(abi.encode(APP_SEED, epoch))) % p`, where
`epoch = block.timestamp / epochDuration` (`epochDuration = 0` means a static `APP_SEED`). The
circuit computes `nullifier = Poseidon(nullifierSeed, photo)`, so the nullifier rotates every epoch.
0x2A's binding stays keyed by nullifier, which makes it "one beneficiary per human per epoch".
Keying a binding map by epoch while keeping a static nullifier would let a user switch wallets,
but every wallet would still be publicly linked through the same nullifier in calldata.

**Forwarders.** `IZKVerifier.verifyProof` returns `(bool ok, address beneficiary)`, and 0x2A binds
the nullifier to the beneficiary. The adapter's 320-byte envelope `(timestamp, recipient, uint256[8])`
binds `signal = recipient`, and is only accepted when `taker` is a constructor-whitelisted
forwarder. `AegisZKForwarder` enforces `recipient == msg.sender` and `to == msg.sender`.

`MockGroth16AnonAadhaar` is a test double with the same ABI. It models SNARK soundness: a
proof verifies only for the exact public signals it was registered for.
`MockAnonIdentityVerifier` (ECDSA attestation) remains for the main invariant suite.

### 5.2 `0x9A JITVaultReserves` — 82 bytes
| Offset | Size | Field | Meaning |
|-------:|-----:|-------|---------|
| 0  | 20 | `address vaultA` | ERC-4626 backing for `tokenA` (lower address) or `0` = use Aqua balance |
| 20 | 20 | `address vaultB` | ERC-4626 backing for `tokenB` (higher address) or `0` |
| 40 | 4  | `uint32 lambdaBps` | per-swap exposure cap, `(0, 10000]` (2500 = 25%) |
| 44 | 6  | `uint48 virtualBoostBps` | virtual depth multiplier, `>= 10000` (20000 = 2.0x) |
| 50 | 16 | `uint128 refA` | Maker's committed Aqua allocation of `tokenA` (boost anchor) |
| 66 | 16 | `uint128 refB` | Maker's committed Aqua allocation of `tokenB` |

`vaultIn/vaultOut` and `refIn/refOut` are resolved at runtime from the A/B fields by
comparing `tokenIn < tokenOut` (same convention as `MinRateArgsBuilder`), so one order serves
both swap directions.

Execution (view-safe: only STATICCALLs, no SSTORE):
1. For each non-zero vault: `require(vault.asset() == token)`.
2. `rawOut = vaultOut == 0 ? ctx.swap.balanceOut : vaultOut.convertToAssets(vaultOut.balanceOf(maker))`.
3. `capOut = min(rawOut * λ / 1e4, ctx.swap.balanceOut)` — never more than λ of the live
   underlying, and never more than Aqua can actually pull.
4. Concentration via **constant** virtual offsets:
   `balanceIn += refIn·(boost−1e4)/1e4`, `balanceOut += refOut·(boost−1e4)/1e4`.
   This is a shifted constant-product curve (a Uniswap-v3-style range): at ship time the
   book has `boost×` depth, and the curve stays path-independent as Aqua balances evolve.
5. exactOut: pre-check `amountOut <= capOut`. Then `ctx.runLoop()`.
6. Post-check `amountOut <= capOut` else `revert JITExposureCapExceeded(amountOut, capOut)`.

### 5.3 `0x7A VolatilitySurgeFee` — 20 bytes
| Offset | Size | Field | Meaning |
|-------:|-----:|-------|---------|
| 0  | 4 | `uint32 baseFeeBps` | base LP fee, `BPS = 1e9` scale |
| 4  | 4 | `uint32 maxSurgeFeeBps` | marginal fee rate for flow above threshold, `base <= max < 1e9` |
| 8  | 8 | `uint64 impactThresholdBps` | utilization (1e4 = 100% of `balanceIn`) where surge begins |
| 16 | 4 | `uint32 decayWindowSec` | flow-accumulation window (0 = stateless, per-trade) |

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
* **Window state.** `B` and `F` are read from storage keyed by `(orderHash, tokenIn)`; a
  window starts at the first trade after expiry, freezing `B` and resetting `F = 0`; flow
  accumulates gross `g`. Writes happen **only when `!ctx.vm.isStaticContext`**, after the
  amounts are computed (same pattern as SwapVM's `Balances._dynamicBalancesXD`). `quote`
  and `swap` read identical pre-state ⇒ identical results.

## 6. Invariants (proved in `test/AegisJIT.test.ts`)

1. **Quote == Swap** — `quote()` (static) returns exactly the `amountIn/amountOut` that `swap()` settles.
2. **Symmetry** — `exactIn(X) → Y` then `exactOut(Y) → X'` with `X' <= X` and `X − X' <= 2 wei`.
3. **Sub-additivity** — two back-to-back `amount/2` swaps never return more than one `amount` swap.
4. **Monotonicity** — `amountOut` strictly increases with `amountIn`; average price non-increasing.
5. **ZK tier differentiation** — verified human gets strictly more out than unverified bot for the same input.
6. **JIT protection** — no single execution moves more than λ of the Maker's vault-backed `tokenOut`.
7. **Round-trip safety** — buy-then-sell never returns more than the taker put in.

Fee-math properties (`net` monotone, minimal exactOut inverse, fee cap, pipeline symmetry)
are additionally fuzzed with Foundry in `test/foundry/SurgeFeeMath.t.sol`.

## 7. Deviations from the brief (and why)

| Brief | This spec | Reason |
|-------|-----------|--------|
| `ctx.balanceIn/Out = raw × λ` each swap | λ is a hard **exposure cap**; pricing uses the Aqua book + constant boost offsets | Re-clamping by λ<1 on every swap re-centres the curve after each trade, so splitting a trade gets a *better* price (worked example: 2×50k USDC → 32.0 WETH vs 1×100k → 28.6 WETH on a 1M/400 book with λ = 25%). That violates invariant 3. |
| `virtualBoostBps` as a multiplier on current reserves; 50-byte layout | Boost = constant offsets `(boost−1)·ref`; layout extended by `refA, refB` (82 bytes) | Multiplying the *current* reserves by `boost > 1` on every swap is round-trip exploitable: buy 50k USDC of WETH, sell it straight back → 52.5k USDC (2× boost, 1M/400 book), a 2.5k loss to the Maker before fees. Constant offsets make it a fixed shifted curve (round trip returns exactly 50k). A constant needs an absolute anchor, and no view-safe one exists at runtime, so the Maker's committed allocation is encoded in the args. (Found while implementing; the first draft of this spec used the multiplier.) |
| Utilization `= amountIn·1e4/balanceIn`, stateless | Utilization measured on **cumulative flow within `decayWindowSec`** with a frozen reference balance | Any stateless convex size-fee is split-gameable (two halves each below threshold dodge the surge). Accumulating flow makes the fee path-independent within the window, which is what invariant 3 needs; `decayWindowSec` becomes the accumulation window. |
| `BPS = 1e7` | `BPS = 1e9` | Matches `Fee.sol` in the pinned SwapVM. |
| `RequireMinRate` last | Before the surge fee / swap | MinRate is a wrapping instruction and reverts if amounts are already computed. |
| `AquaBalances / StaticBalances` opcode | Implicit Aqua preload | Not an opcode in AquaOpcodes; StaticBalances would revert on preloaded balances. |
| ZK flag "in ctx" | Dispatcher switch `ctx.vm.dispatch` | `Context` has no free field; transient storage is unusable under STATICCALL (`quote` is `view`). |
| "MockERC4626Vault seeded with 1M USDC and 400 WETH" | Two `MockERC4626Vault` instances (USDC, WETH) | ERC-4626 vaults are single-asset by definition. |
| ZK verifier | `MockAnonIdentityVerifier` checks an ECDSA attestation from a trusted issuer over `(chainid, verifier, taker, nullifier, revealArray)` | Deterministic and cryptographically real for local testing (no hardcoded `true`); a Groth16/Anon-Aadhaar adapter implementing `IZKVerifier` drops in without touching the opcode. |

Known limits (documented, not hidden): the surge window resets at expiry, so a patient
taker who splits across windows pays less surge; λ caps a *single* execution, while the
Aqua allocation bounds cumulative exposure.

## 7a. Bytecode size (EIP-170)

| Build | Runtime size | Headroom vs 24,576 B |
|---|---:|---:|
| Stock `AquaSwapVMRouter`, template optimizer (`runs: 1`, minimal Yul steps `dhfoDgvulfnTUtnIf`) | 24,281 B | 295 B |
| `AegisSwapVMRouter`, template optimizer | 29,550 B | **−4,974 B (undeployable)** |
| `AegisSwapVMRouter`, full default Yul optimizer (`runs: 1`, `viaIR`) | **21,021 B** | 3,555 B |

Size by component in the template build: JIT ≈ 1.5 KB, surge fee ≈ 1.7 KB, ZK guard ≈ 1.3 KB,
MinRate ≈ 0.4 KB. Splitting `_route` across two dispatchers costs only 32 B. The override in
`hardhat.config.ts` applies to `contracts/AegisSwapVMRouter.sol` only, so every other
contract keeps the template's settings. `AegisOpcodes` lives in its own file so
`AegisJITStrategy` does not pull the router into the default-settings job. Moving
instruction logic into external libraries was rejected: it would add DELEGATECALL overhead
and ABI-encoding glue per opcode, and the optimizer alone recovers about 8.5 KB.

## 8. Milestones

1. Spec (this file)
2. Instruction libraries `contracts/instructions/{ZKIdentityGuard,JITVaultReserves,VolatilitySurgeFee}.sol` + mocks
3. `AegisSwapVMRouter.sol`, `AegisJITStrategy.sol`, `AegisJITVaultHook.sol`, `src/aegisProgramBuilder.ts`
4. `test/AegisJIT.test.ts` invariant + unit tests
5. `scripts/demo-mumbai.ts` + README
