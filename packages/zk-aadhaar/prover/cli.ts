// SPDX-License-Identifier: MIT
// JSON CLI around the Node prover, used by Hardhat tests / demo scripts (which run in CommonJS
// and cannot import this ESM pipeline directly).
//   tsx prover/cli.ts test-qr --timestamp <unix>
//   tsx prover/cli.ts prove   --digits <decimal> --seed <uint> --signal <uint|0xaddress>
//   tsx prover/cli.ts e2e     --timestamp <unix> --seed <uint> --signal <uint|0xaddress>
import { makeTestQr, proveFromQr, sha256 } from "./anon-aadhaar";

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= args.length) throw new Error(`missing --${name}`);
  return args[i + 1];
};
const big = (v: string) => BigInt(v);
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x instanceof Uint8Array ? undefined : x));

async function run() {
  if (cmd === "test-qr") {
    const qr = makeTestQr({ timestamp: Number(opt("timestamp")) });
    return { digits: qr.digits, signedDataSha256: sha256(qr.signedData), signedDataLength: qr.signedData.length };
  }
  if (cmd === "prove" || cmd === "e2e") {
    const digits = cmd === "e2e" ? makeTestQr({ timestamp: Number(opt("timestamp")) }).digits : opt("digits");
    const { parsed, proof } = await proveFromQr(digits, big(opt("seed")), big(opt("signal")));
    return {
      digits: cmd === "e2e" ? digits : undefined,
      qr: {
        version: parsed.data.version,
        rsa: parsed.rsa,
        // only the attributes the proof can reveal — no name/address leave this process
        state: parsed.data.state,
        signedDataSha256: sha256(parsed.signedData),
      },
      proof,
    };
  }
  throw new Error(`unknown command ${cmd}`);
}

run().then((r) => { process.stdout.write(json(r) + "\n"); process.exit(0); })
  .catch((e) => { process.stderr.write(String(e?.stack ?? e) + "\n"); process.exit(1); });
