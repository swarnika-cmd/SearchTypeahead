# Changelog

## v2.0.0 (Nov 2026)

### Fixed
- **Test suite did not compile under TypeScript 6** (`Cannot find name 'describe'`). Jest and Node types are now listed explicitly, and tests use `tsconfig.test.json`.
- **Punctuation aliasing in the trie:** every character outside `a-z0-9` used the space slot while the original text was kept, so `c++` and `c--` shared a node and overwrote each other's count. All input now goes through `normalizeQuery()`.
- **Counts lost at the hour change:** the first `/suggest` of a new hour reloaded the trie from SQLite, dropping searches still in the write-behind buffer. It also briefly served an empty trie and kept last hour's scores in the cache. Scores are now recomputed in memory (`Trie.refreshScores()`) and the cache is cleared.
- **Stale suggestions after a search:** cached lists for the query's prefixes were served for up to 10 s. `POST /search` now invalidates them. The cache also stores copies, not references to the trie's internal arrays.
- **Write-behind buffer:**
  - a failing statement was ignored and the batch committed half-written with its keys gone. It now rolls back and re-queues the keys.
  - only the current hour's bucket was written, so a search at 10:59 flushed at 11:00 lost its bucket.
  - overlapping flushes are serialised.
- **No flush on shutdown:** SIGTERM/SIGINT now flushes the buffer and closes SQLite before exiting.
- **Input validation:** `?q=a&q=b` and `POST /search` without a JSON body returned 500. Unknown `mode` was silently accepted. There was no length cap. All of these now return 400, and queries are capped at 100 characters.
- **Trailing space ignored:** `"iphone "` suggested `"iphones"`. Prefixes keep one trailing space.
- **`totalRequests` metric** was capped at 10,000 (it counted kept latency samples).
- Vite dev proxy was missing `/search` and `/cache`.

### Added
- Property test comparing every prefix's top-10 with a brute-force sort (seeded random data).
- Consistent-hashing tests with 10,000 keys (remapping on add/remove, spread vs virtual nodes), buffer failure/shutdown tests, API validation tests.
- Deterministic seed data (`src/dataset.ts`, mulberry32 RNG), `DB_PATH` and `SEED_TERMS` settings.
- `bench/`: trie micro-benchmark (build time, heap, p50/p99/p99.9) and a k6 HTTP load test, both in Docker (`bash bench/run-all.sh`).
- GitHub Actions CI: typecheck, tests and build on Node 20.

### Changed
- Trie nodes allocate the hourly-bucket map only where a query ends (about 14% less heap).
- README rewritten: architecture, trade-offs, API reference and benchmark method. Unverified performance claims were removed.

### Removed
- Committed frontend bundle in `public/`. It is now build output (`npm run build`).
