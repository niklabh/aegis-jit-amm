# AegisJIT — Custom-Opcode AMM & Self-Custodial JIT Liquidity Vault

Built on **1inch Aqua** and **1inch SwapVM** for ETHGlobal Mumbai 2026.

AegisJIT lets a Maker keep 100% of their capital in ERC-4626 yield vaults, in their own wallet,
while quoting deep liquidity to takers. Three custom SwapVM opcodes do the work inside the
interpreter loop:

| Opcode | Instruction | What it does |
|--------|-------------|--------------|
| `0x2A` | **ZKIdentityGuard** | Verifies an Anon-Aadhaar / World-ID style proof from the taker's calldata (STATICCALL). It either gates the order (strict mode) or tiers the taker as *verified human* vs *unverified bot* (tiered mode). |
| `0x9A` | **JITVaultReserves** | Reads the Maker's **live** ERC-4626 backing and caps any single execution at **λ** (e.g. 25%) of it. It also adds virtual depth (`boost`) without locking extra capital. View-safe. |
| `0x7A` | **VolatilitySurgeFee** | Applies a size- and flow-aware LVR fee: base fee below a utilization threshold, surge fee above it, measured on cumulative in-window flow so split trades can't dodge it. Verified humans pay half the base fee. |

```bash
yarn                                     # install
npx hardhat test                         # 67 Hardhat tests (64 AegisJIT + 3 template)
forge test                               # Foundry fuzzing of the fee math (5 properties × 5,000 runs)
npx hardhat run scripts/demo-mumbai.ts   # 3-minute judge demo
```

---

## Architecture

```
                         ┌──────────────────────────── AegisSwapVMRouter ───────────────────────────┐
 Taker ──swap/quote────▶ │ SwapVM core: order hash · Aqua safeBalances preload · runLoop · settle   │
 (takerData: ZK proof)   │   ctx.vm.dispatch = _dispatch  ──(0x2A verified)──▶ _dispatchVerifiedHuman│
                         │   ├─ 0x2A ZKIdentityGuard ──staticcall──▶ IZKVerifier (MockAnonIdentity)  │
                         │   ├─ 0x9A JITVaultReserves ─staticcall──▶ ERC-4626 vaults (live backing)  │
                         │   ├─ 0x2B RequireMinRate ×2 (two-sided floor via JumpIfTokenIn)           │
                         │   ├─ 0x7A VolatilitySurgeFee (window state written only when !static)     │
                         │   └─ AquaOpcodes: Deadline · Jump · XYCSwap · … via _runOpcode             │
                         └───────────────┬───────────────────────────────────────┬──────────────────┘
                                         │ AQUA.pull / push (virtual balances)    │ Maker hooks
                                         ▼                                        ▼
                                   ┌──────────┐                       ┌──────────────────────┐
                                   │   Aqua   │◀── ship(strategy) ─── │ Maker EOA            │
                                   └──────────┘                       │ holds vault SHARES   │
                                                                      └─────────┬────────────┘
                                          AegisJITVaultHook:  withdraw amountOut│just before pull
                                                              deposit  amountIn │just after push
                                                                                ▼
                                                              ┌──────────────────────────────┐
                                                              │ avUSDC  MockERC4626Vault      │
                                                              │ avWETH  MockERC4626Vault      │
                                                              └──────────────────────────────┘
```

**Program** (compiled identically by `src/aegisProgramBuilder.ts` and `contracts/AegisJITStrategy.sol`):

```
[0] 0x0D Deadline              strategy expiry
    (Aqua balances)            preloaded by the router — not an opcode
[1] 0x2A ZKIdentityGuard       tier / gate the taker
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

### `0x2A ZKIdentityGuard` — 25 bytes
| Offset | Size | Type | Field | Notes |
|---:|---:|---|---|---|
| 0 | 20 | `address` | `verifier` | `IZKVerifier.verifyProof(taker, nullifier, revealArray, proof) view returns (bool)` |
| 20 | 1 | `uint8` | `mode` | `0` strict (reverts `ZKVerificationFailed()`), `1` tiered (never reverts) |
| 21 | 4 | `uint32` | `requiredStateCode` | `0` = any; else must equal `revealArray[3]` |

Taker payload (consumed with `tryChopTakerArgs`):
`[uint16 L][nullifier:32][revealArray:4×32][proof:L−160]`, where
`revealArray = [ageAbove18, gender, pincode, state]`. The taker is verified iff
`revealArray[0] == 1`, the state matches, and the verifier returns `true` for
`ctx.query.taker`. Binding the proof to the taker stops a bot replaying a human's proof.

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
| 5 | **ZK tier differentiation** | human > bot on the same trade; discount is exactly 50% of base; replayed, forged, under-18 and wrong-state proofs get no discount; strict mode reverts |
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

### Anon-Identity (Anon Aadhaar / World ID) — CROPS
- **Privacy**: takers reveal only selective attributes (`ageAbove18`, `state`), never identity.
  The proof is bound to the taker address and gated by a nullifier.
- **Censorship resistance**: in tiered mode (`mode = 1`) the opcode **never reverts**.
  Unverified takers still trade, at the bot fee tier. Strict mode is opt-in per order.
- **Open source & security**: the verifier is a pluggable `IZKVerifier` called by STATICCALL,
  so a Groth16 / Anon-Aadhaar adapter replaces the mock without touching the opcode.
  `MockAnonIdentityVerifier` is **not a SNARK**: it does a real ECDSA check of an issuer
  attestation over `(chainid, verifier, taker, nullifier, revealArray)`, which gives
  deterministic local tests with no hardcoded `true`.

## Demo (`scripts/demo-mumbai.ts`)

The demo deploys Aqua, WETHMock, USDC, two vaults (1,000,000 USDC + 400 WETH), the verifier and
the router, then ships the strategy and runs three on-chain scenarios. It prints tx hashes, gas,
and vault balances before and after each one:

| Scenario | Result |
|---|---|
| 1 · Verified human, 5,000 USDC → WETH | `0x2A` pass → 0.15% fee, better fill than a bot; quote == swap |
| 2 · Unverified bot, 50,000 USDC → WETH | `0x7A` surge: 150 USDC base + 420 USDC surge (1.14% effective) |
| 3 · Toxic whale, 500,000 USDC → WETH | **reverted** by `0x9A` (`JITExposureCapExceeded`); vault untouched, 75% structurally out of reach |

## Project structure

```
contracts/
  AegisSwapVMRouter.sol        router: SwapVM + AquaOpcodes + MinRate + AegisJIT opcodes
  AegisJITStrategy.sol         on-chain program/order builder
  AegisJITVaultHook.sol        JIT withdraw/deposit Maker hook
  instructions/                ZKIdentityGuard · JITVaultReserves · VolatilitySurgeFee
  interfaces/IZKVerifier.sol
  libs/AegisOpcodes.sol
  mocks/                       MockAnonIdentityVerifier · MockERC4626Vault · StaticQuoter
src/aegisProgramBuilder.ts     TypeScript SDK (programs, orders, ZK taker payloads)
test/AegisJIT.test.ts          invariant suite      test/foundry/   fee-math fuzzing
scripts/demo-mumbai.ts         judge demo           docs/SPEC.md    spec & deviations
```

The original template (`AquaAMM`, `MockTaker`, `deploy/`) is unchanged and its tests still pass.

## Known limits

- The surge window resets at expiry, so a patient taker who splits across windows pays less
  surge.
- λ caps a *single* execution. Cumulative exposure is bounded by the Aqua allocation.
- `MockAnonIdentityVerifier` is a trusted-issuer stand-in. Production needs a real ZK
  verifier adapter.
- Not audited.

## Disclaimer

This software is provided "as is", without warranty of any kind. Use at your own risk.

## 📄 License

The SwapVM template code is licensed under **LicenseRef-Degensoft-SwapVM-1.1**. See
[LICENSE](LICENSE) and [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
