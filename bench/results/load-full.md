# Load test: GET /suggest (full)

- Date: 2026-11-06T20:01:21.281Z
- Host: Apple M4 Pro, 12 cores; Docker Desktop: 12 CPUs, 8319238144 bytes RAM
- Server: node v20.20.2 in node:20, --cpus=2; k6 in grafana/k6:2.3.0, --cpus=2; same Docker network
- Data: 100000 seeded terms; random prefixes of length 1-6 sampled from them
- Load: 50 VUs, closed loop, no think time, 30s

| Requests | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | Error rate |
|---:|---:|---:|---:|---:|---:|---:|
| 328745 | 10956.9 | 3.598 | 7.862 | 9.945 | 309.978 | 0.000% |

## Server metrics after the run (GET /api/metrics, includes warm-up requests if any)

```json
{
  "p95LatencyMs": 0.01,
  "cacheHitRatePercent": 97.9,
  "cacheHits": 429479,
  "cacheMisses": 9211,
  "dbReads": 2,
  "dbWrites": 0,
  "searchesSubmitted": 0,
  "totalRequests": 438690
}
```
