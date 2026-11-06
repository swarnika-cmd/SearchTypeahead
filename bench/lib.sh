# Shared helpers for the benchmark scripts. Everything runs in Docker (node:20).
NODE_IMAGE="node:20"
K6_IMAGE="grafana/k6:2.3.0"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BENCH_CPUS="2"

# Host description recorded with every result
host_description() {
  local cpu cores vm
  if command -v sysctl >/dev/null 2>&1 && sysctl -n machdep.cpu.brand_string >/dev/null 2>&1; then
    cpu="$(sysctl -n machdep.cpu.brand_string)"
    cores="$(sysctl -n hw.ncpu)"
  else
    cpu="$(grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2 | xargs || echo unknown)"
    cores="$(nproc 2>/dev/null || echo '?')"
  fi
  vm="$(docker info --format '{{.OperatingSystem}}: {{.NCPU}} CPUs, {{.MemTotal}} bytes RAM' 2>/dev/null || echo 'docker info unavailable')"
  echo "${cpu}, ${cores} cores; ${vm}"
}

# Installs dependencies (Linux build, inside the container), makes sure the
# sqlite3 native module loads, and compiles the server to dist/.
# The sqlite3 6.x prebuilt binary needs glibc 2.38, node:20 (Debian 12) has 2.36,
# so it is compiled from source there using the headers shipped in the image.
ensure_deps() {
  docker run --rm --name typeahead-bench-deps -v "$ROOT":/app -w /app "$NODE_IMAGE" bash -c '
    set -e
    [ -d node_modules ] || npm ci --no-audit --no-fund
    node -e "require(\"sqlite3\")" 2>/dev/null || {
      echo "Compiling sqlite3 from source for this glibc...";
      npm rebuild sqlite3 --build-from-source --nodedir=/usr/local >/dev/null;
    }
    npx tsc
  '
}
