#!/usr/bin/env bash
# Runs both benchmarks. Use an otherwise idle machine for the full run.
#   bash bench/run-all.sh          # full: trie 100k + 1M terms, load test 50 VUs x 30s
#   bash bench/run-all.sh --quick  # smoke test with small sizes
set -euo pipefail
DIR="$(dirname "$0")"
bash "$DIR/run-trie.sh" "$@"
bash "$DIR/run-load.sh" "$@"
