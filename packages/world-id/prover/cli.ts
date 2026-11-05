// SPDX-License-Identifier: MIT
// JSON CLI around the World ID-compatible prover, used by Hardhat tests / demo scripts (CommonJS,
// which cannot import this ESM pipeline directly).
//   tsx prover/cli.ts status
//   tsx prover/cli.ts root   [--members a,b,c]
//   tsx prover/cli.ts external-nullifier --app-id <id> --action <action>
//   tsx prover/cli.ts prove  --identity human --signal 0x<address> --external-nullifier <uint> [--members a,b,c]
//   tsx prover/cli.ts vkey
import { artifactsAvailable, exportVerificationKey, externalNullifierOf, groupRoot, localGroup, prove, testIdentity, DEFAULT_MEMBERS, TREE_DEPTH } from "./semaphore";

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= args.length) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing --${name}`);
  }
  return args[i + 1];
};
const members = () => (args.includes("--members") ? opt("members").split(",") : DEFAULT_MEMBERS);
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

async function run() {
  if (cmd === "status") return { artifacts: artifactsAvailable(), treeDepth: TREE_DEPTH };
  if (cmd === "root") {
    const m = members();
    const g = localGroup(m);
    return { root: groupRoot(m), members: m.map((s) => ({ seed: s, commitment: testIdentity(s).commitment, index: g.indexOf(testIdentity(s).commitment) })) };
  }
  if (cmd === "external-nullifier") return { externalNullifier: externalNullifierOf(opt("app-id"), opt("action")) };
  if (cmd === "prove") {
    return prove({ identity: opt("identity"), members: members(), signal: opt("signal"), externalNullifier: BigInt(opt("external-nullifier")) });
  }
  if (cmd === "vkey") return exportVerificationKey();
  throw new Error(`unknown command ${cmd}`);
}

run().then((r) => { process.stdout.write(json(r) + "\n"); process.exit(0); })
  .catch((e) => { process.stderr.write(String(e?.stack ?? e) + "\n"); process.exit(1); });
