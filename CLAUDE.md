You are a Lead DeFi Protocol Engineer building "AegisJIT" — a Custom Opcode AMM & Self-Custodial JIT Liquidity Vault built on 1inch Aqua (`v1.0.0`) and 1inch SwapVM (`v1.0.1` / `v1.0.2`) for ETHGlobal Mumbai 2026.

## 0. MANDATORY HACKATHON COMPLIANCE RULES (DO NOT VIOLATE)
1. **Spec-Driven AI Disclosure**: Before writing any Solidity or TypeScript code, save our architectural plan and opcode byte-layout specification into `docs/SPEC.md` and commit it.
2. **Granular Git Commit History**: Sponsors (1inch) strictly disqualify single-commit repositories. You MUST execute atomic `git add` and `git commit -m "..."` after completing each milestone (Milestone 1: Spec, Milestone 2: Instruction Libraries, Milestone 3: Router & Strategy, Milestone 4: Invariant & Unit Tests, Milestone 5: Demo Script/UI).
3. **Zero Fake Fallbacks**: Never hardcode mocked return values inside production contracts. All math must execute deterministically inside the SwapVM interpreter loop.

---

## 1. FIRST STEP: INSPECT EXISTING REPO INTERFACES
Before writing code, inspect:
- `contracts/AquaAMM.sol`, `contracts/MockTaker.sol`, and `contracts/SwapVMImport.sol`
- `node_modules/@1inch/swap-vm/contracts/SwapVM.sol`
- `node_modules/@1inch/swap-vm/contracts/libs/OpcodeList.sol` and `Context.sol`
- `node_modules/@1inch/swap-vm/contracts/opcodes/AquaOpcodes.sol`
- `test/AquaAMM.test.ts`

Verify the exact struct fields of `Context` (specifically `balanceIn`, `balanceOut`, `amountIn`, `amountOut`, `isExactIn`, `tokenIn`, `tokenOut`, `maker`, `taker`, and `takerData` / `tryChopTakerArgs()`).

---

## 2. ARCHITECTURE & CUSTOM OPCODES TO IMPLEMENT

We are extending `AquaSwapVMRouter` by subclassing `SwapVM` and `AquaOpcodes` and overriding `_dispatch(Context memory ctx, uint256 opcode, bytes calldata args)`.

Every instruction follows SwapVM's framing format:
`[opcode: 1 byte][argsLength: 1 byte][args: argsLength bytes]`

Remember that SwapVM `FeeFlatIn` / `FeeFlatOut` uses `BPS = 1e7` (where `1e9 = 100%`). Match the exact precision constants used in `@1inch/swap-vm`.

Implement three custom instruction libraries in `contracts/instructions/`:

### A. `JITVaultReserves.sol` — Opcode `0x9A` (Balances Family `0x90`)
- **Purpose**: Self-custodial Just-In-Time (JIT) liquidity sizing with an active per-swap exposure cap ($\lambda$) to prevent catastrophic Loss-Versus-Rebalancing (LVR) on a Maker's passive capital.
- **Bytecode `args` layout (50 bytes packed)**:
  - `address vaultIn` (20 bytes): ERC-4626 or underlying reserve source for `tokenIn` (or `address(0)` to read Maker's direct Aqua/ERC20 balance).
  - `address vaultOut` (20 bytes): ERC-4626 or underlying reserve source for `tokenOut`.
  - `uint32 lambdaBps` (4 bytes): Active liquidity exposure cap (e.g., `2500` = 25.00% of total underlying vault balance exposed per trade).
  - `uint48 virtualBoostBps` (6 bytes): Virtual concentration multiplier (`>= 10000`) to concentrate the active slice around the current price without locking extra capital.
- **Execution Logic (`_execJITVaultReserves`)**:
  - Read the Maker's available underlying liquidity via `staticcall` (`convertToAssets(balanceOf(ctx.maker))` for ERC-4626, or fallback to existing `ctx.balanceIn` / `ctx.balanceOut` loaded by Aqua).
  - Clamp active reserves:
    `ctx.balanceIn = (rawBalanceIn * lambdaBps) / 10000`
    `ctx.balanceOut = (rawBalanceOut * lambdaBps) / 10000`
  - **CRITICAL INVARIANT**: Must be 100% view-safe (`staticcall` only, zero `SSTORE`) so `router.asView().quote()` returns the exact same output as `router.swap()`.

### B. `VolatilitySurgeFee.sol` — Opcode `0x7A` (Fees Family `0x70`)
- **Purpose**: Dynamic LVR & Toxic-Flow Surge Fee that protects the Maker from CEX-DEX arbitrage and large directional impacts while keeping fees low for normal retail flow.
- **Bytecode `args` layout (20 bytes packed)**:
  - `uint32 baseFeeBps` (4 bytes): Base LP fee (scaled to SwapVM's fee denominator).
  - `uint32 maxSurgeFeeBps` (4 bytes): Cap on the dynamic surge fee.
  - `uint64 impactThresholdBps` (8 bytes): Trade size relative to `ctx.balanceIn` where surge pricing begins.
  - `uint32 decayWindowSec` (4 bytes): Time-weighted or oracle divergence sensitivity factor.
- **Execution Logic (`_execVolatilitySurgeFee`)**:
  - Calculate trade utilization ratio:
    - For `isExactIn == true`: `utilization = (ctx.amountIn * 10000) / ctx.balanceIn`
    - For `isExactIn == false`: derive implied utilization from `ctx.amountOut` and `ctx.balanceOut` so **Symmetry (`exactIn(X) -> Y` == `exactOut(Y) -> X`)** holds within 1 wei rounding.
  - Compute piecewise-linear or quadratic effective fee rate between `baseFeeBps` and `maxSurgeFeeBps`.
  - Check if a discount flag was set by `ZKIdentityGuard (0x2A)` in `ctx`; if verified retail human, apply a 50% discount on `baseFeeBps`.
  - Apply Maker-favouring rounding (`ceil` on fee deduction for `exactIn`, `ceil` on required input for `exactOut`) to preserve **Sub-Additivity** and **Monotonicity**.

### C. `ZKIdentityGuard.sol` — Opcode `0x2A` (Guards Family `0x20`)
- **Purpose**: Opcode-level Sybil & Compliance Gate supporting an Anon-Identity / World ID verifier (with a clean `IZKVerifier` interface and `MockAnonIdentityVerifier.sol` for deterministic local testing).
- **Bytecode `args` layout (25 bytes packed)**:
  - `address verifier` (20 bytes): Contract implementing `IZKVerifier.verifyProof(address taker, uint256 nullifier, uint256[4] calldata revealArray, bytes calldata proof) external view returns (bool)`.
  - `uint8 mode` (1 byte):
    - `0`: Strict Gate (reverts with `ZKVerificationFailed()` if proof in `takerData` is missing/invalid or `revealArray[0] != 1` for `ageAbove18`).
    - `1`: Tiered Retail Mode (never reverts; if valid proof is supplied in `takerData` via `tryChopTakerArgs()`, grants a fee discount / higher $\lambda$ cap; if absent, treats Taker as unverified arbitrage bot and charges full surge fee).
  - `uint32 requiredStateCode` (4 bytes): Optional jurisdiction check (`0` = any state).

---

## 3. ROUTER, STRATEGY BUILDER & TYPESCRIPT SDK

1. **`contracts/AegisSwapVMRouter.sol`**:
   - Inherit from `SwapVM` and `AquaOpcodes`.
   - Override `_dispatch(Context memory ctx, uint256 opcode, bytes calldata args)` to route `0x9A`, `0x7A`, and `0x2A` to our custom instruction libraries and delegate all other opcodes to `super._runOpcode(ctx, opcode, args)`.
2. **`contracts/AegisJITStrategy.sol` & TypeScript `ProgramBuilder` (`src/aegisProgramBuilder.ts`)**:
   - Create a TypeScript helper that compiles an AegisJIT order bytecode program in this exact sequence:
     1. `Deadline (0x20 family)` — Strategy expiry guard
     2. `AquaBalances / StaticBalances` — Base balance initialization
     3. `ZKIdentityGuard (0x2A)` — Inspects `takerData` for ZK proof (`mode = 1` tiered or `mode = 0` strict)
     4. `JITVaultReserves (0x9A)` — Applies $\lambda$ active exposure cap from `MockERC4626Vault.sol`
     5. `VolatilitySurgeFee (0x7A)` — Applies dynamic LVR fee (with human discount if verified)
     6. `XYCSwap` / `XYCConcentrateSwap` — Executes swap curve over active JIT reserves
     7. `RequireMinRate` — Hard floor protection

---

## 4. MANDATORY SWAPVM CORE INVARIANT TEST SUITE (`test/AegisJIT.test.ts`)

Write a comprehensive Hardhat/Mocha + Foundry test suite (`test/AegisJIT.test.ts`) that proves:
1. **Quote == Swap Consistency**: `router.asView().quote(order, amount, takerData)` returns the exact `amountIn` and `amountOut` executed by `router.swap(order, amount, takerData)`.
2. **Symmetry**: `exactIn(X) -> Y` matches `exactOut(Y) -> X` within rounding bounds (`<= 2 wei`).
3. **Sub-Additivity (Anti-Split Gaming)**: Executing two back-to-back swaps of `amount / 2` never yields strictly more `amountOut` to the Taker than a single swap of `amount` against the active state.
4. **Monotonicity**: Increasing `amountIn` strictly increases `amountOut`, while the marginal execution price (`amountOut / amountIn`) monotonically decreases or stays flat.
5. **ZK Tier Differentiation**: Prove in tests that a Taker supplying a valid ZK proof in `takerData` receives a measurably better execution rate (lower fee) than an unverified MEV bot swapping the exact same amount.
6. **Self-Custodial JIT Protection**: Prove that a massive whale swap cannot drain more than `lambdaBps` (e.g., 25%) of the Maker's underlying ERC-4626 vault balance in a single execution.

---

## 5. INTERACTIVE CLI BENCHMARK & DEMO SCRIPT (`scripts/demo-mumbai.ts`)

Create a script runnable via `npx hardhat run scripts/demo-mumbai.ts` that outputs a clean terminal table for our 3-minute ETHGlobal Mumbai judge demo:
- Deploys `Aqua`, `WETHMock`, `MockERC4626Vault` (seeded with 1,000,000 USDC and 400 WETH), `MockAnonIdentityVerifier`, and `AegisSwapVMRouter`.
- Registers the Maker's self-custodial AegisJIT strategy with Aqua.
- Runs 3 live onchain scenarios with transaction hashes, gas used, and before/after vault balances:
  - **Scenario 1**: Verified Human Retail Trader swaps 5,000 USDC -> WETH (triggers `0x2A` ZK pass -> low base fee -> settles via Aqua).
  - **Scenario 2**: Unverified Arbitrage Bot swaps 50,000 USDC -> WETH (triggers `0x7A` volatility surge fee -> Maker captures extra LVR spread).
  - **Scenario 3**: Toxic Whale attempts to drain 500,000 USDC (blocked by `0x9A` $\lambda = 25\%$ JIT cap; 75% of Maker's capital remains untouched earning yield in `MockERC4626Vault`).

update `README.md` with:
- Architecture diagram (ASCII)
- Opcode Byte-Layout Specification table
- ETHGlobal Mumbai Sponsor Integration summary (1inch Aqua + SwapVM, Circle USDC Vault, Anon-Identity CROPS privacy section).

Start now with Milestone 1: Inspect the repository files, write `docs/SPEC.md`, run `git commit`, and proceed sequentially through Milestone 5 until `npx hardhat test` and `npx hardhat run scripts/demo-mumbai.ts` pass with 0 errors.