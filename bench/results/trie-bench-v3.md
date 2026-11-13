# Trie benchmark (v3)

- Date: 2026-11-13T01:10:34.935Z
- Host: Apple M4 Pro, 12 cores; Docker Desktop: 12 CPUs, 8319238144 bytes RAM
- Container: node v20.20.2, linux arm64, --cpus=2
- Implementations: array, radix (src/trie-array.ts, src/trie-radix.ts), each in its own process
- Data: seeded Zipf data set (src/dataset.ts, seed 42); prefixes of length 1-6 sampled from stored queries (seed 7)
- Lookup: getSuggestions(prefix, 'trending'), 10000 warm-up calls discarded, one hrtime pair per call
- Heap: growth in heapUsed (MiB; JSON field heapMB) after building the trie, measured after forced GC, data set kept reachable (gc exposed: true)

| Impl | Terms | Trie nodes | Build (ms) | Heap (MiB) | Bytes/term | Lookups | p50 (us) | p99 (us) | p99.9 (us) | max (us) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| array | 100,000 | 558,714 | 2523 | 540.1 | 5664 | 100,000 | 0.33 | 3.54 | 6.96 | 57752.29 |
| radix | 100,000 | 131,876 | 375 | 54.3 | 569 | 100,000 | 0.17 | 1.75 | 5.29 | 33844.25 |
| array | 1,000,000 | 4,850,630 | 74681 | 4477 | 4694 | 100,000 | 0.67 | 5.83 | 10.79 | 56856.71 |
| radix | 1,000,000 | 1,396,994 | 5736 | 529.2 | 555 | 100,000 | 0.21 | 2.92 | 7.71 | 53718.54 |

## Array / radix ratio

| Terms | Nodes | Heap | Build time | Lookup p50 (radix / array) | Lookup p99 (radix / array) |
|---:|---:|---:|---:|---:|---:|
| 100,000 | 4.24x | 9.95x | 6.73x | 0.52x | 0.49x |
| 1,000,000 | 3.47x | 8.46x | 13.02x | 0.31x | 0.50x |

Node, heap and build columns are array divided by radix (higher means radix is smaller or faster). Lookup columns are radix divided by array (above 1 means radix is slower).
