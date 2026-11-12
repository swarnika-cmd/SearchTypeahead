#!/usr/bin/env bash
# Trie micro-benchmark in Docker: the array trie and the radix trie in one run,
# each implementation and size in its own Node process.
#   bash bench/run-trie.sh          # 100k and 1M terms, 100k lookups -> bench/results/trie-bench-v3.json (+ .md)
#   bash bench/run-trie.sh --quick  # 10k terms, 10k lookups (smoke test, trie-bench-quick.*, not committed)
#
# Memory: each Node process may use a 6 GB old space (--max-old-space-size=6144).
# The 1M-term array trie needs about 4.4 GB of heap (bench/results/trie-bench-full.json),
# so the container is capped at 7 GB. Docker Desktop must be given at least that
# much RAM, and the machine should be otherwise idle.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

SIZES="100000,1000000"; LOOKUPS=100000; LABEL="v3"; IMPLS="array,radix"
if [[ "${1:-}" == "--quick" ]]; then SIZES="10000"; LOOKUPS=10000; LABEL="quick"; fi

ensure_deps
docker rm -f typeahead-bench-trie >/dev/null 2>&1 || true
docker run --rm --name typeahead-bench-trie --cpus="$BENCH_CPUS" --memory=7g --memory-swap=7g \
  -v "$ROOT":/app -w /app \
  -e BENCH_HOST="$(host_description)" -e BENCH_DOCKER_CPUS="$BENCH_CPUS" \
  "$NODE_IMAGE" node --expose-gc --max-old-space-size=6144 \
  -r ts-node/register/transpile-only bench/trie-bench.ts \
  --sizes "$SIZES" --impls "$IMPLS" --lookups "$LOOKUPS" --label "$LABEL"
