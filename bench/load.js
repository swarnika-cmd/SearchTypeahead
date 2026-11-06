// k6 load test for GET /suggest. Started by bench/run-load.sh.
// Closed model: each virtual user (VU) sends the next request as soon as the
// previous one returns (no think time), so this measures throughput at saturation.
import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const LABEL = __ENV.LABEL || 'run';

// Prefixes sampled from the seeded data set (bench/prefixes.ts), shared by all VUs
const prefixes = new SharedArray('prefixes', () => JSON.parse(open(__ENV.PREFIXES_FILE || '/work/prefixes.json')));

export const options = {
  vus: Number(__ENV.VUS || 50),
  duration: __ENV.DURATION || '30s',
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

// Seeded RNG per VU (mulberry32) so runs pick the same prefix sequence
let rngState = null;
function nextRandom() {
  if (rngState === null) rngState = (__VU * 2654435761) >>> 0;
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export default function () {
  const prefix = prefixes[Math.floor(nextRandom() * prefixes.length)];
  const res = http.get(`${BASE_URL}/suggest?q=${encodeURIComponent(prefix)}`, { tags: { name: 'suggest' } });
  check(res, { 'status is 200': r => r.status === 200 });
}

const fmt = (x, digits = 2) => Number(x).toFixed(digits);

export function handleSummary(data) {
  const d = data.metrics.http_req_duration.values;
  const reqs = data.metrics.http_reqs.values;
  const failed = data.metrics.http_req_failed ? data.metrics.http_req_failed.values.rate : 0;

  const summary = {
    label: LABEL,
    date: new Date().toISOString(),
    host: __ENV.BENCH_HOST || 'unknown',
    serverNode: __ENV.NODE_VERSION || 'unknown',
    cpus: { server: Number(__ENV.BENCH_CPUS || 2), k6: Number(__ENV.BENCH_CPUS || 2) },
    seededTerms: Number(__ENV.TERMS || 0),
    vus: options.vus,
    duration: options.duration,
    requests: reqs.count,
    requestsPerSec: Number(fmt(reqs.rate, 1)),
    latencyMs: {
      p50: Number(fmt(d.med, 3)),
      p95: Number(fmt(d['p(95)'], 3)),
      p99: Number(fmt(d['p(99)'], 3)),
      avg: Number(fmt(d.avg, 3)),
      max: Number(fmt(d.max, 3)),
    },
    errorRate: failed,
  };

  const md = [
    `# Load test: GET /suggest (${LABEL})`,
    '',
    `- Date: ${summary.date}`,
    `- Host: ${summary.host}`,
    `- Server: node ${summary.serverNode} in node:20, --cpus=${summary.cpus.server}; k6 in grafana/k6:2.3.0, --cpus=${summary.cpus.k6}; same Docker network`,
    `- Data: ${summary.seededTerms} seeded terms; random prefixes of length 1-6 sampled from them`,
    `- Load: ${summary.vus} VUs, closed loop, no think time, ${summary.duration}`,
    '',
    '| Requests | Req/s | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) | Error rate |',
    '|---:|---:|---:|---:|---:|---:|---:|',
    `| ${summary.requests} | ${summary.requestsPerSec} | ${summary.latencyMs.p50} | ${summary.latencyMs.p95} | ${summary.latencyMs.p99} | ${summary.latencyMs.max} | ${fmt(summary.errorRate * 100, 3)}% |`,
    '',
  ].join('\n');

  return {
    [`/results/load-${LABEL}.json`]: JSON.stringify(summary, null, 2) + '\n',
    [`/results/load-${LABEL}.md`]: md,
    stdout: `${LABEL}: ${summary.requests} requests, ${summary.requestsPerSec} req/s, p50 ${summary.latencyMs.p50} ms, p95 ${summary.latencyMs.p95} ms, p99 ${summary.latencyMs.p99} ms, errors ${fmt(summary.errorRate * 100, 3)}%\n`,
  };
}
