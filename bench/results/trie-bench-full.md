# Trie benchmark (full)

- Date: 2026-11-06T19:57:33.948Z
- Host: Apple M4 Pro, 12 cores; Docker Desktop: 12 CPUs, 8319238144 bytes RAM
- Container: node v20.20.2, linux arm64, --cpus=2
- Data: seeded Zipf data set (src/dataset.ts, seed 42); prefixes of length 1-6 sampled from stored queries (seed 7)
- Lookup: Trie.getSuggestions(prefix, 'trending'), 10000 warm-up calls discarded, one hrtime pair per call
- Heap: growth in heapUsed after building the trie, measured after forced GC (gc exposed: true)

| Terms | Trie nodes | Build (ms) | Heap (MB) | Bytes/term | Lookups | p50 (us) | p99 (us) | p99.9 (us) | max (us) |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 100,000 | 558,714 | 2475 | 531.9 | 5578 | 100,000 | 0.25 | 2.75 | 5.63 | 1997.71 |
| 1,000,000 | 4,850,630 | 132258 | 4394 | 4607 | 100,000 | 2.08 | 35.04 | 83.08 | 90679.58 |
