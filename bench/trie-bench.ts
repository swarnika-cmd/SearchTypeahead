/**
 * Trie micro-benchmark: build time, heap used and prefix lookup latency, for the
 * array trie and the radix trie in one run.
 *
 * Run (inside node:20, see bench/run-trie.sh):
 *   node --expose-gc -r ts-node/register/transpile-only bench/trie-bench.ts \
 *     --sizes 100000,1000000 --impls array,radix --lookups 100000 --label v3
 *
 * For each size N and each implementation, one fresh child process (so the heap
 * of one run never affects the next) does:
 *   1. generate N queries with Zipf counts (seeded, not timed)
 *   2. time inserting all of them into a new trie (build time)
 *   3. force GC and record heap growth caused by the trie
 *   4. time 100k getSuggestions() calls on prefixes of length 1-6 sampled from
 *      the stored queries, one process.hrtime.bigint() pair per call
 * Writes bench/results/trie-bench-<label>.json and .md
 */
import fs from 'fs';
import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';
import { createTrie, TrieImpl } from '../src/trie';
import { generateDataset } from '../src/dataset';
import { samplePrefixes } from './prefixes';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const sizes = arg('sizes', '100000,1000000').split(',').map(Number);
const impls = arg('impls', 'array,radix').split(',') as TrieImpl[];
const lookups = Number(arg('lookups', '100000'));
const label = arg('label', 'v3');
const isWorker = process.argv.includes('--worker');
const outDir = arg('out', path.join(__dirname, 'results'));
const WARMUP = Math.min(10000, lookups);

const gc = (global as any).gc as (() => void) | undefined;
function heapUsedMB(): number {
  if (gc) {
    gc();
    gc();
  }
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

// Nearest-rank percentile on a sorted array
function percentile(sorted: Float64Array, p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

const round = (x: number, digits = 2) => Number(x.toFixed(digits));

interface Result {
  impl: TrieImpl;
  terms: number;
  trieNodes: number;
  buildMs: number;
  heapMB: number;
  bytesPerTerm: number;
  lookups: number;
  latencyUs: { p50: number; p99: number; p999: number; mean: number; max: number };
}

function runSize(impl: TrieImpl, size: number): Result {
  const data = generateDataset(size);
  const prefixes = samplePrefixes(data.map(d => d.query), lookups + WARMUP);

  // Keep the data set reachable until after the post-build heap measurement. The query strings
  // are shared with the trie, and if the data set could be collected in between, its size would
  // be subtracted from the trie's heap (the same amount for both implementations).
  (globalThis as any).__benchData = data;
  const heapBefore = heapUsedMB();
  const buildStart = process.hrtime.bigint();
  const trie = createTrie(impl);
  for (const { query, count } of data) trie.insert(query, count);
  const buildMs = Number(process.hrtime.bigint() - buildStart) / 1e6;
  const heapMB = heapUsedMB() - heapBefore;
  delete (globalThis as any).__benchData;

  // Warm up the JIT, results discarded
  for (let i = 0; i < WARMUP; i++) trie.getSuggestions(prefixes[i], 'trending');

  const latencies = new Float64Array(lookups);
  let sink = 0; // keep results alive so the call cannot be optimised away
  for (let i = 0; i < lookups; i++) {
    const prefix = prefixes[WARMUP + i];
    const start = process.hrtime.bigint();
    const result = trie.getSuggestions(prefix, 'trending');
    latencies[i] = Number(process.hrtime.bigint() - start) / 1000; // ns -> us
    sink += result.length;
  }
  if (sink < 0) console.log(sink);

  latencies.sort();
  const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;

  return {
    impl,
    terms: size,
    trieNodes: trie.nodeCount(),
    buildMs: round(buildMs, 0),
    heapMB: round(heapMB, 1),
    bytesPerTerm: round((heapMB * 1024 * 1024) / size, 0),
    lookups,
    latencyUs: {
      p50: round(percentile(latencies, 50)),
      p99: round(percentile(latencies, 99)),
      p999: round(percentile(latencies, 99.9)),
      mean: round(mean),
      max: round(latencies[latencies.length - 1]),
    },
  };
}

const environment = {
  date: new Date().toISOString(),
  node: process.version,
  platform: `${os.platform()} ${os.arch()}`,
  cpuModel: os.cpus()[0]?.model || 'unknown',
  cpusVisible: os.cpus().length,
  dockerCpus: process.env.BENCH_DOCKER_CPUS || 'n/a',
  host: process.env.BENCH_HOST || 'unknown',
  gcExposed: Boolean(gc),
};

if (!gc) console.warn('Run with --expose-gc for accurate heap numbers.');

// Worker: measure one (implementation, size) and print the result as the last stdout line
if (isWorker) {
  console.log(JSON.stringify(runSize(impls[0], sizes[0])));
  process.exit(0);
}

for (const impl of impls) {
  if (impl !== 'array' && impl !== 'radix') throw new Error(`Unknown implementation "${impl}"`);
}

fs.mkdirSync(outDir, { recursive: true });
const base = path.join(outDir, `trie-bench-${label}`);
const results: Result[] = [];
const failures: Array<{ impl: TrieImpl; terms: number; error: string }> = [];

// Files are rewritten after every run, so if the largest size runs out of
// memory the smaller results are still saved.
function writeResults(): void {
  const doc = { environment: { ...environment, impls }, results, ...(failures.length ? { failures } : {}) };
  fs.writeFileSync(`${base}.json`, JSON.stringify(doc, null, 2) + '\n');
  fs.writeFileSync(`${base}.md`, markdown());
}

function runInChild(impl: TrieImpl, size: number): Result | null {
  const child = spawnSync(
    process.execPath,
    [...process.execArgv, __filename, '--worker', '--impls', impl, '--sizes', String(size), '--lookups', String(lookups)],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] }
  );
  if (child.status !== 0) {
    failures.push({ impl, terms: size, error: `child exited with ${child.status ?? child.signal}` });
    return null;
  }
  const lastLine = child.stdout.trim().split('\n').pop()!;
  return JSON.parse(lastLine) as Result;
}

for (const size of sizes) {
  for (const impl of impls) {
    console.log(`Trie bench: ${impl}, ${size} terms, ${lookups} lookups...`);
    const r = runInChild(impl, size);
    if (r) {
      console.log(JSON.stringify(r));
      results.push(r);
    } else {
      console.error(`FAILED: ${impl}, ${size} terms`);
    }
    writeResults();
  }
}
console.log(`Wrote ${base}.json and ${base}.md`);
if (failures.length) process.exit(1);

function ratio(a: number, b: number): string {
  return b === 0 ? 'n/a' : (a / b).toFixed(2) + 'x';
}

function markdown(): string {
  const fmt = (n: number) => n.toLocaleString('en-US');
  const lines = [
    `# Trie benchmark (${label})`,
    '',
    `- Date: ${environment.date}`,
    `- Host: ${environment.host}`,
    `- Container: node ${environment.node}, ${environment.platform}, --cpus=${environment.dockerCpus}`,
    `- Implementations: ${impls.join(', ')} (src/trie-array.ts, src/trie-radix.ts), each in its own process`,
    `- Data: seeded Zipf data set (src/dataset.ts, seed 42); prefixes of length 1-6 sampled from stored queries (seed 7)`,
    `- Lookup: getSuggestions(prefix, 'trending'), ${WARMUP} warm-up calls discarded, one hrtime pair per call`,
    `- Heap: growth in heapUsed (MiB; JSON field heapMB) after building the trie, measured after forced GC, data set kept reachable (gc exposed: ${environment.gcExposed})`,
    '',
    '| Impl | Terms | Trie nodes | Build (ms) | Heap (MiB) | Bytes/term | Lookups | p50 (us) | p99 (us) | p99.9 (us) | max (us) |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...results.map(
      r =>
        `| ${r.impl} | ${fmt(r.terms)} | ${fmt(r.trieNodes)} | ${r.buildMs} | ${r.heapMB} | ${r.bytesPerTerm} | ${fmt(r.lookups)} | ${r.latencyUs.p50} | ${r.latencyUs.p99} | ${r.latencyUs.p999} | ${r.latencyUs.max} |`
    ),
    '',
  ];
  const pairs = sizes
    .map(n => ({ n, a: results.find(r => r.impl === 'array' && r.terms === n), x: results.find(r => r.impl === 'radix' && r.terms === n) }))
    .filter(p => p.a && p.x);
  if (pairs.length) {
    lines.push(
      '## Array / radix ratio',
      '',
      '| Terms | Nodes | Heap | Build time | Lookup p50 (radix / array) | Lookup p99 (radix / array) |',
      '|---:|---:|---:|---:|---:|---:|',
      ...pairs.map(
        ({ n, a, x }) =>
          `| ${fmt(n)} | ${ratio(a!.trieNodes, x!.trieNodes)} | ${ratio(a!.heapMB, x!.heapMB)} | ${ratio(a!.buildMs, x!.buildMs)} | ${ratio(x!.latencyUs.p50, a!.latencyUs.p50)} | ${ratio(x!.latencyUs.p99, a!.latencyUs.p99)} |`
      ),
      '',
      'Node, heap and build columns are array divided by radix (higher means radix is smaller or faster). Lookup columns are radix divided by array (above 1 means radix is slower).',
      ''
    );
  }
  return lines.join('\n');
}
