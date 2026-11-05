// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @custom:copyright Powered by SwapVM — © Degensoft Ltd 2025
/// @dev AegisJIT extension of SwapVM (created 2026-11-05). Compiled into the SwapVM router
///      runtime, hence a Modification under SwapVM-1.1 §1.7 and licensed under SwapVM-1.1 (§3.1A).

import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import { ControlsArgsBuilder } from "@1inch/swap-vm/src/instructions/Controls.sol";
import { MinRateArgsBuilder } from "@1inch/swap-vm/src/instructions/MinRate.sol";

import { AegisOpcodes } from "./libs/AegisOpcodes.sol";
import { ZKIdentityGuardArgsBuilder } from "./instructions/ZKIdentityGuard.sol";
import { JITVaultReservesArgsBuilder } from "./instructions/JITVaultReserves.sol";
import { VolatilitySurgeFeeArgsBuilder } from "./instructions/VolatilitySurgeFee.sol";

/// @title AegisJITStrategy
/// @notice On-chain builder for AegisJIT orders. Produces byte-identical programs to
///         `src/aegisProgramBuilder.ts` (asserted in tests).
///
/// Program layout:
///   [Deadline 0x0D]?                       strategy expiry (omitted if deadline == 0)
///   (Aqua balances preloaded by the router — not an opcode)
///   ZKIdentityGuard 0x2A                   tier / gate the taker (World ID and/or ZK Aadhaar proofs)
///   JITVaultReserves 0x9A                  λ exposure cap + virtual-offset boost (wraps the rest)
///   [JumpIfTokenIn 0x0B → P2]?             two-sided rate floor band (omitted if no floors):
///   [RequireMinRate 0x2B (A→B)]?             P1
///   [Jump 0x0A → P3]?
///   [RequireMinRate 0x2B (B→A)]?             P2
///   VolatilitySurgeFee 0x7A                P3
///   XYCSwap 0x11
contract AegisJITStrategy {
    error AegisJITStrategyIdenticalTokens();
    error AegisJITStrategyProgramTooLarge(uint256 length);

    struct Params {
        address maker;
        address token0;              // any order; sorted internally
        address token1;
        address vault0;              // ERC-4626 backing token0 (0 = Aqua balance only)
        address vault1;              // ERC-4626 backing token1
        address jitHook;             // AegisJITVaultHook (0 = no JIT vault settlement)
        uint40 deadline;             // 0 = none
        uint8 zkVerifierTypes;       // accepted 0x2A proof types: 1 World ID, 2 ZK Aadhaar, 3 either
        address worldIdVerifier;     // IZKVerifier for World ID proofs (0 iff bit 1 unset)
        address aadhaarVerifier;     // IZKVerifier for ZK Aadhaar proofs (0 iff bit 2 unset)
        uint8 zkMode;                // 0 strict, 1 tiered
        uint32 requiredStateCode;    // 0 = any (Aadhaar only)
        uint32 lambdaBps;            // 1e4 = 100%
        uint48 virtualBoostBps;      // 1e4 = 1.0x
        uint128 allocation0;         // amount of token0 the Maker ships to Aqua (boost anchor)
        uint128 allocation1;         // amount of token1 the Maker ships to Aqua
        uint64 floor01AmountIn;      // token0 -> token1: maker requires >= In token0 per Out token1
        uint64 floor01AmountOut;
        uint64 floor10AmountIn;      // token1 -> token0
        uint64 floor10AmountOut;
        uint32 baseFeeBps;           // 1e9 = 100%
        uint32 maxSurgeFeeBps;       // 1e9 = 100%
        uint64 impactThresholdBps;   // 1e4 = 100% of balanceIn
        uint32 decayWindowSec;
        uint64 salt;                 // distinguishes otherwise identical strategies (0 = none)
    }

    function buildOrder(Params calldata p) external pure returns (ISwapVM.Order memory) {
        require(p.token0 != p.token1, AegisJITStrategyIdenticalTokens());
        (address tokenA, address tokenB, address vaultA, address vaultB) = p.token0 < p.token1
            ? (p.token0, p.token1, p.vault0, p.vault1)
            : (p.token1, p.token0, p.vault1, p.vault0);

        bool useHook = p.jitHook != address(0);
        bytes memory hookData = useHook ? abi.encodePacked(vaultA, vaultB) : bytes("");

        return MakerTraitsLib.build(MakerTraitsLib.Args({
            maker: p.maker,
            receiver: address(0),
            tokenA: tokenA,
            tokenB: tokenB,
            shouldUnwrapWeth: false,
            useAquaInsteadOfSignature: true,
            allowZeroAmountIn: false,
            hasPreTransferInHook: false,
            hasPostTransferInHook: useHook,
            hasPreTransferOutHook: useHook,
            hasPostTransferOutHook: false,
            preTransferInTarget: address(0),
            preTransferInData: "",
            postTransferInTarget: p.jitHook,
            postTransferInData: hookData,
            preTransferOutTarget: p.jitHook,
            preTransferOutData: hookData,
            postTransferOutTarget: address(0),
            postTransferOutData: "",
            program: buildProgram(p)
        }));
    }

    function buildProgram(Params calldata p) public pure returns (bytes memory program) {
        bool zeroToOne = p.token0 < p.token1;
        (address tokenA, address tokenB, address vaultA, address vaultB) = zeroToOne
            ? (p.token0, p.token1, p.vault0, p.vault1)
            : (p.token1, p.token0, p.vault1, p.vault0);
        (uint128 refA, uint128 refB) = zeroToOne ? (p.allocation0, p.allocation1) : (p.allocation1, p.allocation0);

        program = bytes.concat(
            p.deadline > 0 ? _ix(AegisOpcodes.DEADLINE, ControlsArgsBuilder.buildDeadline(p.deadline)) : bytes(""),
            _ix(AegisOpcodes.ZK_IDENTITY_GUARD, ZKIdentityGuardArgsBuilder.build(p.zkVerifierTypes, p.zkMode, p.requiredStateCode, p.worldIdVerifier, p.aadhaarVerifier)),
            _ix(AegisOpcodes.JIT_VAULT_RESERVES, JITVaultReservesArgsBuilder.build(vaultA, vaultB, p.lambdaBps, p.virtualBoostBps, refA, refB))
        );

        bool hasFloors = (p.floor01AmountIn | p.floor01AmountOut | p.floor10AmountIn | p.floor10AmountOut) != 0;
        if (hasFloors) {
            // A→B floor: (inA, outB); B→A floor: (inB, outA)
            (uint64 inA, uint64 outB, uint64 inB, uint64 outA) = zeroToOne
                ? (p.floor01AmountIn, p.floor01AmountOut, p.floor10AmountIn, p.floor10AmountOut)
                : (p.floor10AmountIn, p.floor10AmountOut, p.floor01AmountIn, p.floor01AmountOut);

            bytes memory minRateAtoB = _ix(AegisOpcodes.REQUIRE_MIN_RATE_1D, MinRateArgsBuilder.build(tokenA, tokenB, inA, outB));
            bytes memory minRateBtoA = _ix(AegisOpcodes.REQUIRE_MIN_RATE_1D, MinRateArgsBuilder.build(tokenA, tokenB, outA, inB));

            uint256 base = program.length;
            uint256 jumpIfLen = 2 + 22;
            uint256 jumpLen = 2 + 2;
            uint256 pcBtoA = base + jumpIfLen + minRateAtoB.length + jumpLen;
            uint256 pcFee = pcBtoA + minRateBtoA.length;
            require(pcFee <= type(uint16).max, AegisJITStrategyProgramTooLarge(pcFee));

            program = bytes.concat(
                program,
                _ix(AegisOpcodes.JUMP_IF_TOKEN_IN, ControlsArgsBuilder.buildJumpIfToken(tokenB, uint16(pcBtoA))),
                minRateAtoB,
                _ix(AegisOpcodes.JUMP, ControlsArgsBuilder.buildJump(uint16(pcFee))),
                minRateBtoA
            );
        }

        program = bytes.concat(
            program,
            _ix(AegisOpcodes.VOLATILITY_SURGE_FEE, VolatilitySurgeFeeArgsBuilder.build(p.baseFeeBps, p.maxSurgeFeeBps, p.impactThresholdBps, p.decayWindowSec)),
            _ix(AegisOpcodes.XYC_SWAP_XD, ""),
            p.salt > 0 ? _ix(AegisOpcodes.SALT, ControlsArgsBuilder.buildSalt(p.salt)) : bytes("")
        );
    }

    function _ix(uint256 opcode, bytes memory args) private pure returns (bytes memory) {
        return abi.encodePacked(uint8(opcode), uint8(args.length), args);
    }
}
