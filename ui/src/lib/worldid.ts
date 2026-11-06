// SPDX-License-Identifier: MIT
// World ID pass, browser side: Semaphore v3 identity -> local depth-30 tree -> Groth16 proof generated
// IN THE BROWSER with snarkjs over the public PSE depth-30 artifacts (whose verification key equals
// World ID's on-chain SemaphoreVerifier) -> 0x2A type-1 payload. World App / IDKit produce the same
// { merkle_root, nullifier(_hash), proof } for the real World ID tree; `fromIdKitResult` maps that.
import { Identity } from "@semaphore-protocol/identity";
import { Group } from "@semaphore-protocol/group";
import * as snarkjs from "snarkjs";
import {
  concat, decodeAbiParameters, encodeAbiParameters, encodePacked, keccak256, pad, size, stringToBytes, toHex, type Address, type Hex,
} from "viem";

/** World ID identity-tree depth */
export const WORLD_ID_TREE_DEPTH = 30;
/** World ID group of Orb-verified humans */
export const WORLD_ID_ORB_GROUP = 1n;
/** 0x2A proof type selector for World ID payloads */
export const ZK_TYPE_WORLD_ID = 1;

/** World ID `ByteHasher.hashToField`: keccak256(bytes) >> 8 */
export const hashToField = (data: Hex | Uint8Array): bigint => BigInt(keccak256(data)) >> 8n;

/** Semaphore signalHash for an address signal: hashToField(abi.encodePacked(address)) */
export const signalHashOf = (address: Address): bigint => hashToField(address);

/** externalNullifierHash = hashToField(abi.encodePacked(hashToField(appId), action)) — World ID on-chain template */
export function externalNullifierOf(appId: string, action: string): bigint {
  return hashToField(concat([pad(toHex(hashToField(stringToBytes(appId))), { size: 32 }), toHex(stringToBytes(action))]));
}

/** Deterministic test identity (World App holds a random one): sha512-derived trapdoor/nullifier, Poseidon commitment */
export const identityFor = (prefix: string, seed: string): Identity => new Identity(`${prefix}${seed}`);

/** The local "World ID" tree the sequencer (the project) published to MockWorldIDRouter */
export function buildGroup(prefix: string, members: string[]): Group {
  return new Group(WORLD_ID_ORB_GROUP, WORLD_ID_TREE_DEPTH, members.map((m) => identityFor(prefix, m).commitment));
}

export const treeRoot = (prefix: string, members: string[]): bigint => BigInt(buildGroup(prefix, members).root);

export interface WorldIdProofResult {
  root: bigint;
  nullifierHash: bigint;
  signalHash: bigint;
  externalNullifierHash: bigint;
  /** [a0, a1, b01, b00, b11, b10, c0, c1] — World ID / IDKit packing */
  proof: bigint[];
  identityCommitment: bigint;
  memberIndex: number;
  provingMs: number;
}

export interface ProveOptions {
  prefix: string;
  members: string[];
  /** identity seed; must be a tree member */
  identity: string;
  /** the taker address the proof is bound to */
  signal: Address;
  externalNullifier: bigint;
  /** URLs in the browser (served from /semaphore/30), file paths in Node */
  artifacts: { wasm: string; zkey: string };
}

/** Groth16 membership proof for the Semaphore v3 depth-30 circuit, public inputs already hashed the World ID way */
export async function proveWorldId(o: ProveOptions): Promise<WorldIdProofResult> {
  const group = buildGroup(o.prefix, o.members);
  const id = identityFor(o.prefix, o.identity);
  const memberIndex = group.indexOf(id.commitment);
  if (memberIndex < 0) throw new Error(`identity "${o.identity}" is not a member of the local tree`);
  const mp = group.generateMerkleProof(memberIndex);
  const signalHash = signalHashOf(o.signal);
  const input = {
    identityTrapdoor: id.trapdoor.toString(),
    identityNullifier: id.nullifier.toString(),
    treePathIndices: mp.pathIndices,
    treeSiblings: mp.siblings.map((s: unknown) => BigInt(s as bigint).toString()),
    externalNullifier: o.externalNullifier.toString(),
    signalHash: signalHash.toString(),
  };
  const t0 = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, o.artifacts.wasm, o.artifacts.zkey);
  const provingMs = Math.round(performance.now() - t0);
  const [root, nullifierHash, sig, ext] = publicSignals.map(BigInt);
  if (root !== BigInt(mp.root)) throw new Error("circuit root != tree root");
  if (sig !== signalHash || ext !== o.externalNullifier) throw new Error("public signal mismatch");
  return {
    root, nullifierHash, signalHash: sig, externalNullifierHash: ext,
    proof: [proof.pi_a[0], proof.pi_a[1], proof.pi_b[0][1], proof.pi_b[0][0], proof.pi_b[1][1], proof.pi_b[1][0], proof.pi_c[0], proof.pi_c[1]].map(BigInt),
    identityCommitment: id.commitment, memberIndex, provingMs,
  };
}

/** WorldIDAdapter envelope (direct): abi.encode(merkleRoot, epoch, uint256[8]); epoch = 0 unless the adapter rotates actions */
export function worldIdEnvelope(root: bigint, epoch: bigint, proof: bigint[]): Hex {
  if (proof.length !== 8) throw new Error("World ID proof must be 8 words");
  return encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256[8]" }], [root, epoch, proof as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]]);
}

/** 0x2A type-1 taker payload: [uint16 L][0x01][nullifierHash][abi.encode(merkleRoot, epoch, uint256[8])] */
export function encodeWorldIdPayload(root: bigint, epoch: bigint, nullifierHash: bigint, proof: bigint[]): Hex {
  const body = encodePacked(["uint8", "uint256", "bytes"], [ZK_TYPE_WORLD_ID, nullifierHash, worldIdEnvelope(root, epoch, proof)]);
  return encodePacked(["uint16", "bytes"], [size(body), body]);
}

/** IDKit `action` for an epoch when the adapter rotates actions (`<action>-<epoch>`), else the plain action */
export const worldIdActionFor = (action: string, epochDuration: number, epoch: bigint): string => (epochDuration ? `${action}-${epoch.toString()}` : action);

/** Proof as 256 bytes (8 x 32-byte BN254 coordinates), for display */
export const proofWordsHex = (proof: bigint[]): Hex => encodePacked(Array(8).fill("uint256"), proof as unknown as bigint[]);

/**
 * IDKit / World App result for an on-chain action (`orbLegacy({ signal: address })` in IDKit 4,
 * `ISuccessResult` in IDKit 1-2): merkle_root, nullifier (v4) / nullifier_hash (v1-2), and the
 * proof as abi.encode(uint256[8]). The same bytes become the 0x2A payload — no re-encoding of
 * the proof itself.
 */
/** The legacy (World ID 3.0) orb response item inside an IDKit 4.x result, or the item itself if that is what was passed */
export function legacyItemFromIdKit(result: any): { merkle_root: string; nullifier?: string; nullifier_hash?: string; proof: string; signal_hash?: string } {
  if (result && Array.isArray(result.responses)) {
    const item = result.responses.find((x: any) => x.identifier === "orb") ?? result.responses[0];
    if (!item) throw new Error("IDKit result has no responses");
    if (result.protocol_version && result.protocol_version !== "3.0") throw new Error(`IDKit returned a protocol ${result.protocol_version} proof; the on-chain adapter verifies legacy (3.0) orb proofs — request with allow_legacy_proofs`);
    return item;
  }
  return result;
}

export function fromIdKitResult(r: { merkle_root: string; nullifier?: string; nullifier_hash?: string; proof: string }): {
  root: bigint; nullifierHash: bigint; proof: bigint[];
} {
  const nullifier = r.nullifier ?? r.nullifier_hash;
  if (!nullifier) throw new Error("IDKit result has no nullifier / nullifier_hash");
  const proofHex = r.proof as Hex;
  if (size(proofHex) !== 256) throw new Error(`IDKit proof must be abi.encode(uint256[8]) (256 bytes), got ${size(proofHex)}`);
  const [words] = decodeAbiParameters([{ type: "uint256[8]" }], proofHex);
  return { root: BigInt(r.merkle_root), nullifierHash: BigInt(nullifier), proof: [...words] };
}
