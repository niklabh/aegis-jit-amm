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
npx hardhat test                         # 75 Hardhat tests (64 AegisJIT + 8 Anon Aadhaar adapter + 3 template)
forge test                               # Foundry fuzzing: fee math + adapter (8 properties × 5,000 runs)
./scripts/start-local-demo.sh            # node + deploy/seed + SwapVM Inspector UI at http://127.0.0.1:5173
npx hardhat run scripts/demo-mumbai.ts   # 3-minute judge demo (in-process network)
npx hardhat node & npx hardhat run --network localhost scripts/demo-mumbai.ts   # same, on a real JSON-RPC node
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

### Anon Aadhaar (identity)
- `contracts/zk/AnonAadhaarAdapter.sol` implements `IZKVerifier` over the deployed Anon
  Aadhaar verifier (`verifyAnonAadhaarProof`). It binds `signal = uint160(taker)`, enforces
  proof freshness (24 h), `ageAbove18`, an optional state policy and an app nullifier seed.
- Opcode `0x2A` binds each nullifier to the first address that swaps with it, so one identity
  gets one discounted address.
- Tests and the demo use `MockGroth16AnonAadhaar`. It has the same ABI and accepts a proof
  only for the exact public signals it was registered for. **No real Groth16 proving or
  verification runs in this repo.** Wiring the real verifier means deploying the adapter
  with the official Anon Aadhaar contract address; that is not done or tested here.

## CROPS Evaluation (Ethereum Foundation)

**Censorship resistance**
- Makers keep custody: capital stays in their own ERC-4626 positions, and strategies are
  immutable Aqua orders that no operator can pause.
- Tiered mode (`mode = 1`, the default) **never reverts**. Unverified takers still trade, at
  the bot fee tier, so identity is a discount, not a gate. Strict mode is opt-in per order.
- No relayer or allow-list sits between the taker and the router. With real Anon Aadhaar,
  proofs are generated client-side from the user's own Aadhaar QR. (In this repo the prover
  is mocked.)

**Open source**
- Source for every component is in this repo. Licences are split (see
  [License & licensing boundary](#-license--licensing-boundary)):
  - MIT: ZK adapter, verifier interface, JIT hook, mocks, scripts, tests and UI.
  - `LicenseRef-Degensoft-SwapVM-1.1`: the opcodes and router, because they compile into
    SwapVM. SwapVM-1.1 is a source-available copyleft licence with commercial triggers, not
    an OSI-approved open-source licence. Judges should weigh that.

**Privacy**
- No name, Aadhaar number, photo or address goes on-chain. Calldata carries:
  - `ageAbove18`; `state` only if the order requires it (default reveal `[1, 0, 0, state]`,
    with gender and pincode left at 0);
  - the proof timestamp and the Groth16 proof;
  - `signal`, which is the taker address and already public.
- Trade-off: the **nullifier** is a stable pseudonym per app (fixed `NULLIFIER_SEED`). Every
  verified trade by the same person is linkable, and binding pins it to one address. That is
  the cost of Sybil resistance.

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

- **Bytecode disassembler.** The order is decoded live from Aqua's `Shipped` event, not from
  a file. Each `[opcode][len][args]` frame is colour-coded: `0x2A` emerald, `0x9A` indigo
  (λ and constant offsets decoded), `0x7A` amber (fees and window decoded), stock opcodes
  slate. Hovering links the hex to the decoded card.
- **Simulator.** Profiles: verified human, MEV bot, split attacker (5×), whale. The slider
  calls `router.asView().quote()` live, alongside the effective fee (bps), the rolling-window
  accumulator vs threshold, and a check against an independent TS model of the opcode math.
  "Execute" sends a real `swap()` and shows quote vs executed and the divergence (0 wei).
  The split attack runs inside `evm_snapshot` / `evm_revert`. The whale shows the decoded
  `JITExposureCapExceeded`.
- **Vault panel.** Shows the λ-exposed slice vs the untouched, yield-earning reserve, and
  whether the Aqua book equals the vault backing.
- `cd ui && npm run smoke` checks the same client library headlessly against a seeded node.

## Demo (`scripts/demo-mumbai.ts`)

The demo deploys Aqua, WETHMock, USDC, two vaults (1,000,000 USDC + 400 WETH), the verifier and
the router, then ships the strategy and runs three on-chain scenarios. It prints tx hashes, gas,
and vault balances before and after each one:

| Scenario | Result |
|---|---|
| 1 · Verified human, 5,000 USDC → WETH | `0x2A` pass → 0.15% fee, better fill than a bot; quote == swap |
| 2 · Unverified bot, 50,000 USDC → WETH | `0x7A` surge: 150 USDC base + 420 USDC surge (1.14% effective) |
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
  instructions/                ZKIdentityGuard · JITVaultReserves · VolatilitySurgeFee
  interfaces/IZKVerifier.sol
  zk/                          IAnonAadhaar · AnonAadhaarAdapter
  libs/AegisOpcodes.sol
  mocks/                       MockAnonIdentityVerifier · MockGroth16AnonAadhaar · MockERC4626Vault · StaticQuoter
src/aegisProgramBuilder.ts     TypeScript SDK (programs, orders, ZK taker payloads)
test/AegisJIT.test.ts          invariant suite      test/AnonAadhaarAdapter.test.ts
test/foundry/                  fee-math + adapter fuzzing
scripts/demo-mumbai.ts         judge CLI demo       scripts/seed-local.ts · start-local-demo.sh
ui/                            SwapVM Inspector     docs/SPEC.md    spec & deviations
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

## 📄 License & licensing boundary

**Powered by SwapVM — © Degensoft Ltd 2025.** Aqua © Degensoft Ltd 2025.

This repo mixes two licences. The split follows SwapVM-1.1. §1.7(b) treats instruction
programs that run in the same EVM address space as a *Modification*, and §3.1A requires
Modifications to be published under SwapVM-1.1. §3.3 exempts independent code that only
calls or interfaces with SwapVM.

| Licence | Files | Why |
|---|---|---|
| `LicenseRef-Degensoft-SwapVM-1.1` | `contracts/AegisSwapVMRouter.sol`, `contracts/instructions/*`, `contracts/AegisJITStrategy.sol`, `contracts/libs/AegisOpcodes.sol`, `test/foundry/SurgeFeeMath.t.sol` | Inherit or import SwapVM implementation code (`SwapVM`, `AquaOpcodes`, `ContextLib`, `MinRate`, arg builders) and are compiled into the router runtime |
| `LicenseRef-Degensoft-SwapVM-1.1` | `src/aegisProgramBuilder.ts`, `test/utils/aegisFixture.ts` | Import the swap-vm-template helper `test/utils/SwapVMHelpers.ts` |
| `LicenseRef-Degensoft-SwapVM-1.1` (unchanged template files) | `AquaAMM.sol`, `MockTaker.sol`, `deploy/`, `test/AquaAMM.test.ts`, `test/utils/{fixtures,ProgramBuilder,SwapVMHelpers}.ts` | Original swap-vm-template |
| `MIT` | `contracts/interfaces/IZKVerifier.sol`, `contracts/zk/*`, `contracts/AegisJITVaultHook.sol`, `contracts/mocks/*`, `test/*.test.ts` (AegisJIT), `scripts/*`, `ui/` | Independent code that only implements or calls interfaces (`IMakerHooks`, `ISwapVM`) or talks to deployed contracts via ABI/RPC (§3.3) |

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
