// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IZKVerifier } from "../interfaces/IZKVerifier.sol";
import { IAnonAadhaar, IAnonAadhaarMultiKey } from "./IAnonAadhaar.sol";
import { TakerAuthorization } from "./TakerAuthorization.sol";

/// @title AnonAadhaarAdapter
/// @notice `IZKVerifier` for opcode 0x2A backed by an Anon Aadhaar Groth16 verifier.
///
///   proof bytes (direct):      abi.encode(uint256 timestamp, uint256 epoch, uint256 pubkeyHash, uint256[8] proof)             352 B
///   proof bytes (authorised):  abi.encode(uint256 timestamp, uint256 epoch, uint256 pubkeyHash, address recipient,
///                                         uint256 authDeadline, bytes32 r, bytes32 s, uint8 v, uint256[8] proof)              512 B
///
///   * Signal binding: the proof must commit to `signal = uint160(beneficiary)`. The beneficiary is the
///     taker itself, or the `recipient` of an authorised envelope, which any taker (aggregator, relayer,
///     smart account) may present iff `recipient` signed an EIP-712 `TakerAuthorization(taker, deadline)`
///     for exactly that taker (see `TakerAuthorization`). A searcher replaying a trader's takerData from
///     their own address is neither the beneficiary nor authorised, and fails.
///   * Epoch-rotating nullifiers (unlinkability): with `EPOCH_DURATION > 0` the proof must use
///     `nullifierSeed = keccak256(APP_SEED, epoch) mod p` for the `epoch` named in the envelope, and that
///     epoch must be the current one, or the previous one during the first `EPOCH_GRACE` seconds of the
///     current epoch (a proof takes ~13 s to make and a transaction some time to land). The circuit's
///     nullifier = Poseidon(nullifierSeed, photo), so the same person shows a fresh, unlinkable
///     nullifier every epoch, while within an epoch it is stable (Sybil-bound by 0x2A).
///   * UIDAI key set: `pubkeyHash` (the circuit's hash of the RSA key that signed the QR) selects the
///     trust root from the verifier's set; 0 means "the verifier's primary key" (upstream ABI).
///   * Freshness: `0 <= block.timestamp - timestamp <= MAX_PROOF_AGE`, where `timestamp` is the QR's
///     issuance time (hour precision in the circuit).
///   * Policy: `revealArray[0]` (ageAbove18) == 1; `revealArray[3]` (state, packed as emitted by
///     the circuit) == `REQUIRED_STATE` unless 0. (Anon Aadhaar order: [age, gender, pincode, state].)
///   * Binding validity returned to 0x2A: the end of the proof's epoch, never beyond the QR freshness window.
/// @dev No admin, no setters. Never reverts on malformed input — returns false.
contract AnonAadhaarAdapter is IZKVerifier, TakerAuthorization {
    uint256 public constant SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 private constant _DIRECT_PROOF_LENGTH = 32 * 11;
    uint256 private constant _AUTHORIZED_PROOF_LENGTH = 32 * 16;
    uint256 private constant _AGE_ABOVE_18 = 0;
    uint256 private constant _STATE = 3;

    IAnonAadhaar public immutable ANON_AADHAAR;
    uint256 public immutable APP_SEED;
    uint256 public immutable EPOCH_DURATION;
    /// @notice Seconds after an epoch roll during which the previous epoch's proofs are still accepted
    uint256 public immutable EPOCH_GRACE;
    uint256 public immutable MAX_PROOF_AGE;
    uint256 public immutable REQUIRED_STATE;

    struct Envelope {
        uint256 timestamp;
        uint256 epoch;
        uint256 pubkeyHash;
        address beneficiary;
        uint256[8] proof;
    }

    error NullifierSeedOutOfField(uint256 seed);
    error EpochGraceTooLong(uint256 grace, uint256 epochDuration);

    constructor(
        IAnonAadhaar anonAadhaar,
        uint256 appSeed,
        uint256 epochDuration,
        uint256 epochGrace,
        uint256 maxProofAge,
        uint256 requiredState
    ) {
        require(epochDuration != 0 || appSeed < SNARK_FIELD, NullifierSeedOutOfField(appSeed));
        require(epochDuration == 0 || epochGrace < epochDuration, EpochGraceTooLong(epochGrace, epochDuration));
        ANON_AADHAAR = anonAadhaar;
        APP_SEED = appSeed;
        EPOCH_DURATION = epochDuration;
        EPOCH_GRACE = epochGrace;
        MAX_PROOF_AGE = maxProofAge;
        REQUIRED_STATE = requiredState;
    }

    /// @notice Current epoch (0 when epochs are disabled)
    function currentEpoch() public view returns (uint256) {
        return EPOCH_DURATION == 0 ? 0 : block.timestamp / EPOCH_DURATION;
    }

    /// @notice nullifierSeed a proof must use in `epoch`
    function nullifierSeedFor(uint256 epoch) public view returns (uint256) {
        if (EPOCH_DURATION == 0) return APP_SEED;
        return uint256(keccak256(abi.encode(APP_SEED, epoch))) % SNARK_FIELD;
    }

    /// @notice nullifierSeed a proof must use right now
    function currentNullifierSeed() external view returns (uint256) {
        return nullifierSeedFor(currentEpoch());
    }

    /// @notice True for the current epoch, and for the previous one during the grace period
    function isAcceptedEpoch(uint256 epoch) public view returns (bool) {
        uint256 current = currentEpoch();
        if (epoch == current) return true;
        return EPOCH_DURATION != 0 && epoch + 1 == current && block.timestamp % EPOCH_DURATION < EPOCH_GRACE;
    }

    /// @notice Last second of `epoch` (type(uint40).max when epochs are disabled)
    function epochEnd(uint256 epoch) public view returns (uint256) {
        return EPOCH_DURATION == 0 ? type(uint40).max : (epoch + 1) * EPOCH_DURATION - 1;
    }

    /// @inheritdoc IZKVerifier
    function verifyProof(
        address taker,
        uint256 nullifier,
        uint256[4] calldata revealArray,
        bytes calldata proof
    ) external view returns (bool, address, uint40) {
        (bool ok, Envelope memory e) = _decode(taker, proof);
        if (!ok) return (false, address(0), 0);
        if (!isAcceptedEpoch(e.epoch)) return (false, address(0), 0);
        if (e.timestamp > block.timestamp || block.timestamp - e.timestamp > MAX_PROOF_AGE) return (false, address(0), 0);
        if (revealArray[_AGE_ABOVE_18] != 1) return (false, address(0), 0);
        if (REQUIRED_STATE != 0 && revealArray[_STATE] != REQUIRED_STATE) return (false, address(0), 0);
        if (!_verifyGroth16(e, nullifier, revealArray)) return (false, address(0), 0);
        return (true, e.beneficiary, _bindingValidUntil(e));
    }

    /// @dev Decodes either envelope; for the authorised one, checks the recipient's taker authorisation.
    ///      Pre-validates the words that `abi.decode` would revert on (address, uint8), so this never reverts.
    function _decode(address taker, bytes calldata proof) private view returns (bool, Envelope memory e) {
        if (proof.length == _DIRECT_PROOF_LENGTH) {
            (e.timestamp, e.epoch, e.pubkeyHash, e.proof) = abi.decode(proof, (uint256, uint256, uint256, uint256[8]));
            e.beneficiary = taker;
            return (true, e);
        }
        if (proof.length == _AUTHORIZED_PROOF_LENGTH) {
            if (uint256(bytes32(proof[96:128])) > type(uint160).max || uint256(bytes32(proof[224:256])) > type(uint8).max) return (false, e);
            (
                uint256 timestamp, uint256 epoch, uint256 pubkeyHash, address recipient, uint256 deadline,
                bytes32 r, bytes32 s, uint8 v, uint256[8] memory words
            ) = abi.decode(proof, (uint256, uint256, uint256, address, uint256, bytes32, bytes32, uint8, uint256[8]));
            if (!_isAuthorizedTaker(recipient, taker, deadline, r, s, v)) return (false, e);
            e = Envelope(timestamp, epoch, pubkeyHash, recipient, words);
            return (true, e);
        }
        return (false, e);
    }

    function _verifyGroth16(Envelope memory e, uint256 nullifier, uint256[4] calldata revealArray) private view returns (bool) {
        uint256 seed = nullifierSeedFor(e.epoch);
        uint256 signal = uint256(uint160(e.beneficiary));
        if (e.pubkeyHash == 0) {
            try ANON_AADHAAR.verifyAnonAadhaarProof(seed, nullifier, e.timestamp, signal, revealArray, e.proof) returns (bool ok) {
                return ok;
            } catch {
                return false;
            }
        }
        try IAnonAadhaarMultiKey(address(ANON_AADHAAR)).verifyAnonAadhaarProofWithKey(e.pubkeyHash, seed, nullifier, e.timestamp, signal, revealArray, e.proof)
        returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }

    /// @notice How long 0x2A may honour a proof-less binding claim for this proof's nullifier: until
    ///         its epoch ends, and never beyond the point where the QR itself is too old to prove with.
    function _bindingValidUntil(Envelope memory e) private view returns (uint40) {
        uint256 validUntil = Math.min(e.timestamp + MAX_PROOF_AGE, epochEnd(e.epoch));
        return uint40(Math.min(validUntil, type(uint40).max));
    }
}
