#!/usr/bin/env bash
# HTTP load test: server (node:20, --cpus=2) + k6 (--cpus=2) on a private Docker network.
#   bash bench/run-load.sh          # 100k seeded terms, 50 VUs, 30s
#   bash bench/run-load.sh --quick  # 10k terms, 10 VUs, 5s (smoke test)
# Override with TERMS=, VUS=, DURATION= environment variables.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

LABEL="full"; TERMS="${TERMS:-100000}"; VUS="${VUS:-50}"; DURATION="${DURATION:-30s}"; WARMUP="10s"
if [[ "${1:-}" == "--quick" ]]; then
  LABEL="quick"; TERMS="${TERMS_QUICK:-10000}"; VUS=10; DURATION="5s"; WARMUP=""
fi

NET="typeahead-bench-net"
SERVER="typeahead-bench-server"
K6="typeahead-bench-k6"
WORK="$ROOT/bench/.work"
RESULTS="$ROOT/bench/results"

cleanup() {
  docker rm -f "$SERVER" "$K6" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

ensure_deps
mkdir -p "$WORK" "$RESULTS"

echo "Generating 100000 request prefixes from ${TERMS} terms..."
docker run --rm --name typeahead-bench-prep -v "$ROOT":/app -w /app "$NODE_IMAGE" \
  npx ts-node --transpile-only bench/prefixes.ts --terms "$TERMS" --count 100000 --out bench/.work/prefixes.json

docker network create "$NET" >/dev/null

echo "Starting server (seeding ${TERMS} terms into a fresh SQLite file)..."
docker run -d --name "$SERVER" --network "$NET" --cpus="$BENCH_CPUS" \
  -v "$ROOT":/app -w /app \
  -e DB_PATH=/tmp/bench.db -e SEED_TERMS="$TERMS" -e PORT=3000 \
  "$NODE_IMAGE" node dist/server.js >/dev/null

for _ in $(seq 1 180); do
  if docker logs "$SERVER" 2>&1 | grep -q "Server running"; then break; fi
  if ! docker ps -q -f name="^${SERVER}$" | grep -q .; then docker logs "$SERVER"; exit 1; fi
  sleep 1
done
docker logs "$SERVER" 2>&1 | grep -q "Server running" || { docker logs "$SERVER"; echo "Server did not start"; exit 1; }

NODE_VERSION="$(docker exec "$SERVER" node -v)"
HOST="$(host_description)"

run_k6() {
  local duration="$1" label="$2"
  docker run --rm --name "$K6" --network "$NET" --cpus="$BENCH_CPUS" \
    -v "$ROOT/bench":/bench:ro -v "$WORK":/work:ro -v "$RESULTS":/results \
    -e BASE_URL="http://${SERVER}:3000" -e PREFIXES_FILE=/work/prefixes.json \
    -e VUS="$VUS" -e DURATION="$duration" -e LABEL="$label" -e TERMS="$TERMS" \
    -e BENCH_HOST="$HOST" -e NODE_VERSION="$NODE_VERSION" -e BENCH_CPUS="$BENCH_CPUS" \
    "$K6_IMAGE" run --quiet /bench/load.js
}

if [[ -n "$WARMUP" ]]; then
  echo "Warm-up run (${WARMUP}, results discarded)..."
  run_k6 "$WARMUP" "warmup" >/dev/null
  rm -f "$RESULTS"/load-warmup.*
fi

echo "Load test: ${VUS} VUs for ${DURATION}..."
run_k6 "$DURATION" "$LABEL"

# Server-side view: cache hit rate, in-process p95, request count (includes warm-up)
docker exec "$SERVER" node -e \
  "fetch('http://localhost:3000/api/metrics').then(r => r.json()).then(m => console.log(JSON.stringify(m, null, 2)))" \
  > "$RESULTS/load-${LABEL}-server-metrics.json"
{
  echo ""
  echo "## Server metrics after the run (GET /api/metrics, includes warm-up requests if any)"
  echo ""
  echo '```json'
  cat "$RESULTS/load-${LABEL}-server-metrics.json"
  echo '```'
} >> "$RESULTS/load-${LABEL}.md"

# Graceful stop: SIGTERM -> the server flushes its write buffer and exits
docker stop -t 10 "$SERVER" >/dev/null
docker logs "$SERVER" 2>&1 | grep -E "SIGTERM|Shutdown" || true
echo "Wrote $RESULTS/load-${LABEL}.json and .md"
