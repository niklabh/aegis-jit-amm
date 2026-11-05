// SPDX-License-Identifier: MIT
// World ID-compatible local identity tree + Groth16 prover.
//   * identities: Semaphore v3 `Identity` (deterministic from a seed string for tests and the demo;
//     World App holds a random one)
//   * tree: Semaphore v3 `Group` at depth 30 — the depth of World ID's identity tree
//   * proof: snarkjs groth16 over the public Semaphore depth-30 artifacts (PSE trusted setup), whose
//     verification key equals the constants in World ID's on-chain `SemaphoreVerifier`
//   * hashing: World ID conventions — signalHash = keccak(abi.encodePacked(address)) >> 8,
//     externalNullifierHash = keccak(abi.encodePacked(keccak(appId) >> 8, action)) >> 8
// Nothing here is a fallback: the proof either verifies on the ecPairing precompile or it does not.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Identity } from "@semaphore-protocol/identity";
import { Group } from "@semaphore-protocol/group";
import { keccak256 } from "@ethersproject/keccak256";
import { arrayify, concat, hexZeroPad } from "@ethersproject/bytes";
import * as snarkjs from "snarkjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** World ID identity-tree depth */
export const TREE_DEPTH = 30;
/** World ID group of Orb-verified humans */
export const ORB_GROUP_ID = 1;
export const ARTIFACT_DIR = join(HERE, "..", "..", "..", ".cache", "semaphore", "30");
export const WASM = join(ARTIFACT_DIR, "semaphore.wasm");
export const ZKEY = join(ARTIFACT_DIR, "semaphore.zkey");
export const SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export function artifactsAvailable(): boolean {
  return existsSync(WASM) && existsSync(ZKEY);
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const be32 = (v: bigint) => arrayify(hexZeroPad("0x" + v.toString(16), 32));

/** World ID `ByteHasher.hashToField`: keccak256(bytes) >> 8 (fits the BN254 scalar field) */
export function hashToField(bytes: Uint8Array): bigint {
  return BigInt(keccak256(bytes)) >> 8n;
}

/** Semaphore signalHash for an address signal: hashToField(abi.encodePacked(address)) */
export function signalHashOf(address: string): bigint {
  const b = arrayify(address);
  if (b.length !== 20) throw new Error(`signal must be a 20-byte address, got ${b.length} bytes`);
  return hashToField(b);
}

/** externalNullifierHash = hashToField(abi.encodePacked(hashToField(appId), action)) — as World ID's template */
export function externalNullifierOf(appId: string, action: string): bigint {
  return hashToField(concat([be32(hashToField(utf8(appId))), utf8(action)]));
}

/** Deterministic test identity. Semaphore v3: trapdoor/nullifier from sha512(message), commitment = Poseidon(Poseidon(nullifier, trapdoor)). */
export function testIdentity(seed: string): Identity {
  return new Identity(`aegis-jit/world-id/${seed}`);
}

/** Members of the local "World ID" tree (identity seeds). Only `human` trades in the demo. */
export const DEFAULT_MEMBERS = ["human", "alice", "bob", "carol", "dave"];

/** Local identity tree: the role World ID's signup sequencer plays for the real tree */
export function localGroup(members: string[] = DEFAULT_MEMBERS): Group {
  return new Group(ORB_GROUP_ID, TREE_DEPTH, members.map((m) => testIdentity(m).commitment));
}

export function groupRoot(members: string[] = DEFAULT_MEMBERS): bigint {
  return BigInt(localGroup(members).root);
}

export interface ProveRequest {
  /** identity seed (must be a member of the tree) */
  identity: string;
  /** tree members (identity seeds); default DEFAULT_MEMBERS */
  members?: string[];
  /** the beneficiary address the proof is bound to (Semaphore signal) */
  signal: string;
  /** externalNullifierHash of the (appId, action) the adapter was deployed with */
  externalNullifier: bigint;
}

export interface WorldIdProof {
  root: string;
  nullifierHash: string;
  signalHash: string;
  externalNullifierHash: string;
  identityCommitment: string;
  memberIndex: number;
  /** [a0, a1, b01, b00, b11, b10, c0, c1] — World ID / IDKit packing */
  proof: string[];
  /** [root, nullifierHash, signalHash, externalNullifierHash] */
  publicSignals: string[];
  provingMs: number;
}

export async function prove(r: ProveRequest): Promise<WorldIdProof> {
  if (!artifactsAvailable()) throw new Error("Semaphore artifacts missing: run `node packages/world-id/prover/fetch-artifacts.mjs`");
  const group = localGroup(r.members);
  const id = testIdentity(r.identity);
  const index = group.indexOf(id.commitment);
  if (index < 0) throw new Error(`identity "${r.identity}" is not a member of the local tree`);
  const mp = group.generateMerkleProof(index);
  const signalHash = signalHashOf(r.signal);
  const input = {
    identityTrapdoor: id.trapdoor.toString(),
    identityNullifier: id.nullifier.toString(),
    treePathIndices: mp.pathIndices,
    treeSiblings: mp.siblings.map((s: unknown) => BigInt(s as bigint).toString()),
    externalNullifier: r.externalNullifier.toString(),
    signalHash: signalHash.toString(),
  };
  const t0 = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
  const provingMs = Math.round(performance.now() - t0);
  if (BigInt(publicSignals[0]) !== BigInt(mp.root)) throw new Error("circuit root != tree root");
  if (BigInt(publicSignals[2]) !== signalHash || BigInt(publicSignals[3]) !== r.externalNullifier) throw new Error("public signal mismatch");
  return {
    root: publicSignals[0],
    nullifierHash: publicSignals[1],
    signalHash: publicSignals[2],
    externalNullifierHash: publicSignals[3],
    identityCommitment: id.commitment.toString(),
    memberIndex: index,
    proof: [proof.pi_a[0], proof.pi_a[1], proof.pi_b[0][1], proof.pi_b[0][0], proof.pi_b[1][1], proof.pi_b[1][0], proof.pi_c[0], proof.pi_c[1]],
    publicSignals,
    provingMs,
  };
}

/** Verification key exported from the zkey (to cross-check the vendored verifier's constants) */
export async function exportVerificationKey(): Promise<Record<string, unknown>> {
  return snarkjs.zKey.exportVerificationKey(ZKEY);
}
