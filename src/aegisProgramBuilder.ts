// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
// Powered by SwapVM — © Degensoft Ltd 2025. Imports the swap-vm-template helpers
// (test/utils/SwapVMHelpers.ts), so this file is licensed under SwapVM-1.1 (created 2026-11-05).
// AegisJIT TypeScript SDK: compiles AegisJIT strategy programs / orders and taker ZK payloads.
// Byte-identical to contracts/AegisJITStrategy.sol (asserted in test/AegisJIT.test.ts).

import { AbiCoder, BytesLike, ZeroAddress, concat, getBytes, hexlify, keccak256, solidityPacked } from "ethers";
import { MakerTraitsLib } from "../test/utils/SwapVMHelpers";

/** Opcode indices understood by AegisSwapVMRouter (AquaOpcodes + AegisJIT extensions). */
export const AegisOpcodes = {
  JUMP: 0x0a,
  JUMP_IF_TOKEN_IN: 0x0b,
  DEADLINE: 0x0d,
  XYC_SWAP_XD: 0x11,
  SALT: 0x14,
  ZK_IDENTITY_GUARD: 0x2a,
  REQUIRE_MIN_RATE_1D: 0x2b,
  VOLATILITY_SURGE_FEE: 0x7a,
  JIT_VAULT_RESERVES: 0x9a,
} as const;

/** SwapVM fee denominator (Fee.sol): 1e9 = 100%. */
export const FEE_BPS = 1_000_000_000n;
/** λ / boost / utilization denominator: 1e4 = 100% (1.0x). */
export const BPS_1E4 = 10_000n;

export const ZKMode = { STRICT: 0, TIERED: 1 } as const;

export interface RateFloor {
  /** Maker requires at least `amountIn` of tokenIn ... */
  amountIn: bigint;
  /** ... for every `amountOut` of tokenOut it gives. */
  amountOut: bigint;
}

export interface AegisStrategyParams {
  maker: string;
  token0: string;
  token1: string;
  vault0?: string;
  vault1?: string;
  jitHook?: string;
  deadline?: bigint;
  zkVerifier: string;
  zkMode: number;
  requiredStateCode?: number;
  lambdaBps: number;
  virtualBoostBps: number;
  /** Amount of token0 the Maker ships to Aqua — anchor for the constant virtual offsets. */
  allocation0: bigint;
  /** Amount of token1 the Maker ships to Aqua. */
  allocation1: bigint;
  /** token0 -> token1 floor */
  floor01?: RateFloor;
  /** token1 -> token0 floor */
  floor10?: RateFloor;
  baseFeeBps: number;
  maxSurgeFeeBps: number;
  impactThresholdBps: bigint;
  decayWindowSec: number;
  salt?: bigint;
}

export interface Order {
  maker: string;
  traits: string;
  data: string;
}

function ix(opcode: number, args: BytesLike = "0x"): string {
  const a = getBytes(args);
  if (a.length > 255) throw new Error(`instruction args too long: ${a.length}`);
  return solidityPacked(["uint8", "uint8", "bytes"], [opcode, a.length, a]);
}

const lt = (a: string, b: string) => BigInt(a) < BigInt(b);

// ---------- Per-opcode args encoders (layouts: docs/SPEC.md §5) ----------

/** 0x2A — 25 bytes: verifier(20) | mode(1) | requiredStateCode(4) */
export function encodeZKIdentityGuardArgs(verifier: string, mode: number, requiredStateCode = 0): string {
  if (mode !== ZKMode.STRICT && mode !== ZKMode.TIERED) throw new Error(`invalid ZK mode ${mode}`);
  return solidityPacked(["address", "uint8", "uint32"], [verifier, mode, requiredStateCode]);
}

/**
 * 0x9A — 82 bytes: vaultA(20) | vaultB(20) | lambdaBps(4) | virtualBoostBps(6) | refA(16) | refB(16)
 * A/B sorted by token address. Virtual offsets = (boost - 1) * ref (constant => path-independent curve).
 */
export function encodeJITVaultReservesArgs(
  vaultA: string, vaultB: string, lambdaBps: number, virtualBoostBps: number, refA: bigint, refB: bigint,
): string {
  if (lambdaBps <= 0 || lambdaBps > 10_000) throw new Error(`invalid lambdaBps ${lambdaBps}`);
  if (virtualBoostBps < 10_000) throw new Error(`invalid virtualBoostBps ${virtualBoostBps}`);
  return solidityPacked(
    ["address", "address", "uint32", "uint48", "uint128", "uint128"],
    [vaultA, vaultB, lambdaBps, virtualBoostBps, refA, refB],
  );
}

/** 0x7A — 20 bytes: baseFeeBps(4) | maxSurgeFeeBps(4) | impactThresholdBps(8) | decayWindowSec(4) */
export function encodeVolatilitySurgeFeeArgs(baseFeeBps: number, maxSurgeFeeBps: number, impactThresholdBps: bigint, decayWindowSec: number): string {
  if (baseFeeBps > maxSurgeFeeBps || BigInt(maxSurgeFeeBps) > FEE_BPS / 2n) {
    throw new Error(`invalid fee rates base=${baseFeeBps} max=${maxSurgeFeeBps}`);
  }
  return solidityPacked(["uint32", "uint32", "uint64", "uint32"], [baseFeeBps, maxSurgeFeeBps, impactThresholdBps, decayWindowSec]);
}

/** SwapVM MinRate args: (rateLt, rateGt) */
function encodeMinRateArgs(tokenA: string, tokenB: string, rateA: bigint, rateB: bigint): string {
  const [rLt, rGt] = lt(tokenA, tokenB) ? [rateA, rateB] : [rateB, rateA];
  return solidityPacked(["uint64", "uint64"], [rLt, rGt]);
}

/**
 * Taker-side payload consumed by 0x2A through `tryChopTakerArgs`:
 * [uint16 L][nullifier:32][revealArray: 4x32][proof: L-160]
 */
export function encodeZKTakerArgs(nullifier: bigint, revealArray: [bigint, bigint, bigint, bigint], proof: BytesLike): string {
  const payload = solidityPacked(["uint256", "uint256[4]", "bytes"], [nullifier, revealArray, proof]);
  const len = getBytes(payload).length;
  if (len > 0xffff) throw new Error("ZK payload too long");
  return solidityPacked(["uint16", "bytes"], [len, payload]);
}

/** Message the MockAnonIdentityVerifier issuer signs (EIP-191 `signMessage(getBytes(hash))`). */
export function zkAttestationHash(chainId: bigint, verifier: string, taker: string, nullifier: bigint, revealArray: [bigint, bigint, bigint, bigint]): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ["uint256", "address", "address", "uint256", "uint256[4]"],
    [chainId, verifier, taker, nullifier, revealArray],
  ));
}

// ---------- Program & order ----------

export class AegisProgramBuilder {
  /**
   * Compiles the AegisJIT program:
   *  1. Deadline (0x0D)                 — strategy expiry guard (omitted if 0)
   *  2. Aqua balances                   — preloaded by the router (no opcode)
   *  3. ZKIdentityGuard (0x2A)          — tier / gate the taker
   *  4. JITVaultReserves (0x9A)         — λ exposure cap + virtual-offset boost (wraps the rest)
   *  5. RequireMinRate band (0x0B/0x2B/0x0A/0x2B) — two-sided hard floor (omitted if none)
   *  6. VolatilitySurgeFee (0x7A)       — dynamic LVR fee, human discount
   *  7. XYCSwap (0x11)                  — constant product over boosted reserves
   */
  static buildProgram(p: AegisStrategyParams): string {
    const zeroToOne = lt(p.token0, p.token1);
    const [tokenA, tokenB] = zeroToOne ? [p.token0, p.token1] : [p.token1, p.token0];
    const v0 = p.vault0 ?? ZeroAddress;
    const v1 = p.vault1 ?? ZeroAddress;
    const [vaultA, vaultB] = zeroToOne ? [v0, v1] : [v1, v0];
    const [refA, refB] = zeroToOne ? [p.allocation0, p.allocation1] : [p.allocation1, p.allocation0];

    const parts: string[] = [];
    const deadline = p.deadline ?? 0n;
    if (deadline > 0n) parts.push(ix(AegisOpcodes.DEADLINE, solidityPacked(["uint40"], [deadline])));
    parts.push(ix(AegisOpcodes.ZK_IDENTITY_GUARD, encodeZKIdentityGuardArgs(p.zkVerifier, p.zkMode, p.requiredStateCode ?? 0)));
    parts.push(ix(AegisOpcodes.JIT_VAULT_RESERVES, encodeJITVaultReservesArgs(vaultA, vaultB, p.lambdaBps, p.virtualBoostBps, refA, refB)));

    const f01 = p.floor01 ?? { amountIn: 0n, amountOut: 0n };
    const f10 = p.floor10 ?? { amountIn: 0n, amountOut: 0n };
    if ((f01.amountIn | f01.amountOut | f10.amountIn | f10.amountOut) !== 0n) {
      // A→B floor (inA, outB); B→A floor (inB, outA)
      const [fAB, fBA] = zeroToOne ? [f01, f10] : [f10, f01];
      const minRateAtoB = ix(AegisOpcodes.REQUIRE_MIN_RATE_1D, encodeMinRateArgs(tokenA, tokenB, fAB.amountIn, fAB.amountOut));
      const minRateBtoA = ix(AegisOpcodes.REQUIRE_MIN_RATE_1D, encodeMinRateArgs(tokenA, tokenB, fBA.amountOut, fBA.amountIn));

      const base = getBytes(concat(parts)).length;
      const pcBtoA = base + 24 + getBytes(minRateAtoB).length + 4;
      const pcFee = pcBtoA + getBytes(minRateBtoA).length;
      if (pcFee > 0xffff) throw new Error("program too large for uint16 jumps");

      parts.push(ix(AegisOpcodes.JUMP_IF_TOKEN_IN, solidityPacked(["address", "uint16"], [tokenB, pcBtoA])));
      parts.push(minRateAtoB);
      parts.push(ix(AegisOpcodes.JUMP, solidityPacked(["uint16"], [pcFee])));
      parts.push(minRateBtoA);
    }

    parts.push(ix(AegisOpcodes.VOLATILITY_SURGE_FEE, encodeVolatilitySurgeFeeArgs(p.baseFeeBps, p.maxSurgeFeeBps, p.impactThresholdBps, p.decayWindowSec)));
    parts.push(ix(AegisOpcodes.XYC_SWAP_XD));
    const salt = p.salt ?? 0n;
    if (salt > 0n) parts.push(ix(AegisOpcodes.SALT, solidityPacked(["uint64"], [salt])));

    return hexlify(concat(parts));
  }

  /** Builds the full Aqua order (MakerTraits + data) including the JIT vault settlement hooks. */
  static buildOrder(p: AegisStrategyParams): Order {
    const zeroToOne = lt(p.token0, p.token1);
    const [tokenA, tokenB] = zeroToOne ? [p.token0, p.token1] : [p.token1, p.token0];
    const v0 = p.vault0 ?? ZeroAddress;
    const v1 = p.vault1 ?? ZeroAddress;
    const [vaultA, vaultB] = zeroToOne ? [v0, v1] : [v1, v0];
    const hook = p.jitHook ?? ZeroAddress;
    const useHook = hook !== ZeroAddress;
    const hookData = useHook ? solidityPacked(["address", "address"], [vaultA, vaultB]) : "0x";

    return MakerTraitsLib.build({
      maker: p.maker,
      tokenA,
      tokenB,
      useAquaInsteadOfSignature: true,
      hasPostTransferInHook: useHook,
      hasPreTransferOutHook: useHook,
      postTransferInTarget: useHook ? hook : undefined,
      postTransferInData: useHook ? hookData : undefined,
      preTransferOutTarget: useHook ? hook : undefined,
      preTransferOutData: useHook ? hookData : undefined,
      program: AegisProgramBuilder.buildProgram(p),
    });
  }

  /** Aqua strategy bytes (what `Aqua.ship` hashes into the orderHash). */
  static encodeStrategy(order: Order): string {
    return AbiCoder.defaultAbiCoder().encode(["tuple(address maker, uint256 traits, bytes data)"], [order]);
  }
}
