#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# One-command AegisJIT demo: Hardhat node -> deploy & seed -> SwapVM Inspector UI
#   ./scripts/start-local-demo.sh        (Ctrl-C stops the UI and the node it started)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
RPC="http://127.0.0.1:8545"
NODE_PID=""

rpc_up() {
  curl -s -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC" >/dev/null 2>&1
}
cleanup() { if [[ -n "$NODE_PID" ]]; then kill "$NODE_PID" 2>/dev/null || true; fi; }
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

echo "▸ Deploying + seeding AegisJIT (writes ui/public/deployment.json)"
npx hardhat run --network localhost scripts/seed-local.ts

if [[ ! -d ui/node_modules ]]; then
  echo "▸ Installing UI dependencies"
  (cd ui && npm install --no-audit --no-fund)
fi

echo "▸ SwapVM Inspector → http://127.0.0.1:5173"
cd ui && npm run dev
