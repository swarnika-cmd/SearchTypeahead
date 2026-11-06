#!/usr/bin/env bash
# Trie micro-benchmark in Docker.
#   bash bench/run-trie.sh          # 100k and 1M terms, 100k lookups
#   bash bench/run-trie.sh --quick  # 10k terms, 10k lookups (smoke test)
set -euo pipefail
source "$(dirname "$0")/lib.sh"

SIZES="100000,1000000"; LOOKUPS=100000; LABEL="full"
if [[ "${1:-}" == "--quick" ]]; then SIZES="10000"; LOOKUPS=10000; LABEL="quick"; fi

ensure_deps
docker rm -f typeahead-bench-trie >/dev/null 2>&1 || true
docker run --rm --name typeahead-bench-trie --cpus="$BENCH_CPUS" \
  -v "$ROOT":/app -w /app \
  -e BENCH_HOST="$(host_description)" -e BENCH_DOCKER_CPUS="$BENCH_CPUS" \
  "$NODE_IMAGE" node --expose-gc --max-old-space-size=6144 \
  -r ts-node/register/transpile-only bench/trie-bench.ts \
  --sizes "$SIZES" --lookups "$LOOKUPS" --label "$LABEL"
