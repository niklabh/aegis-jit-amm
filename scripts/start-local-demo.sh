#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# One-command AegisJIT demo: Hardhat node + local Anon Aadhaar prover -> deploy & seed -> UI
#   ./scripts/start-local-demo.sh        (Ctrl-C stops everything it started)
# First run downloads the official Anon Aadhaar v2 artifacts (~620 MB) into .cache/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
RPC="http://127.0.0.1:8545"
NODE_PID=""
PROVER_PID=""
ZK="packages/zk-aadhaar"

rpc_up() {
  curl -s -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC" >/dev/null 2>&1
}
cleanup() {
  if [[ -n "$PROVER_PID" ]]; then kill "$PROVER_PID" 2>/dev/null || true; fi
  if [[ -n "$NODE_PID" ]]; then kill "$NODE_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

if rpc_up; then
  echo "▸ Reusing node already running at $RPC"
else
  echo "▸ Starting Hardhat node (log: .hardhat-node.log)"
  npx hardhat node > .hardhat-node.log 2>&1 &
  NODE_PID=$!
  for _ in $(seq 1 90); do rpc_up && break; sleep 1; done
  rpc_up || { echo "Hardhat node did not start; see .hardhat-node.log"; exit 1; }
fi

if [[ ! -d "$ZK/node_modules" ]]; then
  echo "▸ Installing zk-aadhaar dependencies"
  (cd "$ZK" && npm install --no-audit --no-fund)
fi
if [[ ! -f .cache/anon-aadhaar/v2.0.0/circuit_final.zkey ]]; then
  echo "▸ Downloading official Anon Aadhaar v2 artifacts (~620 MB, SHA-256 pinned)"
  node "$ZK/prover/fetch-artifacts.mjs"
fi
if curl -s http://127.0.0.1:8547/health >/dev/null 2>&1; then
  echo "▸ Reusing Anon Aadhaar prover at http://127.0.0.1:8547"
else
  echo "▸ Starting local Anon Aadhaar prover (log: .prover.log)"
  (cd "$ZK" && exec npx tsx prover/server.ts) > .prover.log 2>&1 &
  PROVER_PID=$!
fi

echo "▸ Deploying + seeding AegisJIT with real Groth16 verification (writes ui/public/deployment.json)"
npx hardhat run --network localhost scripts/seed-local.ts

if [[ ! -d ui/node_modules ]]; then
  echo "▸ Installing UI dependencies"
  (cd ui && npm install --no-audit --no-fund)
fi

echo "▸ SwapVM Inspector → http://127.0.0.1:5173"
cd ui && npm run dev
