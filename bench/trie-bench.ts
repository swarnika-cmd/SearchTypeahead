/**
 * Trie micro-benchmark: build time, heap used and prefix lookup latency.
 *
 * Run (inside node:20, see bench/run-trie.sh):
 *   node --expose-gc -r ts-node/register/transpile-only bench/trie-bench.ts \
 *     --sizes 100000,1000000 --lookups 100000 --label full
 *
 * For each size N:
 *   1. generate N queries with Zipf counts (seeded, not timed)
 *   2. time inserting all of them into a new Trie (build time)
 *   3. force GC and record heap growth caused by the trie
 *   4. time 100k getSuggestions() calls on prefixes of length 1-6 sampled from
 *      the stored queries, one process.hrtime.bigint() pair per call
 * Writes bench/results/trie-bench-<label>.json and .md
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Trie, TrieNode } from '../src/trie';
import { generateDataset } from '../src/dataset';
import { samplePrefixes } from './prefixes';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const sizes = arg('sizes', '100000,1000000').split(',').map(Number);
const lookups = Number(arg('lookups', '100000'));
const label = arg('label', 'full');
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

function countNodes(root: TrieNode): number {
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop()!;
    count++;
    for (const child of node.children) if (child) stack.push(child);
  }
  return count;
}

// Nearest-rank percentile on a sorted array
function percentile(sorted: Float64Array, p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

const round = (x: number, digits = 2) => Number(x.toFixed(digits));

interface Result {
  terms: number;
  trieNodes: number;
  buildMs: number;
  heapMB: number;
  bytesPerTerm: number;
  lookups: number;
  latencyUs: { p50: number; p99: number; p999: number; mean: number; max: number };
}

function runSize(size: number): Result {
  const data = generateDataset(size);
  const prefixes = samplePrefixes(data.map(d => d.query), lookups + WARMUP);

  const heapBefore = heapUsedMB();
  const buildStart = process.hrtime.bigint();
  const trie = new Trie();
  for (const { query, count } of data) trie.insert(query, count);
  const buildMs = Number(process.hrtime.bigint() - buildStart) / 1e6;
  const heapMB = heapUsedMB() - heapBefore;

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
    terms: size,
    trieNodes: countNodes(trie.root),
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

fs.mkdirSync(outDir, { recursive: true });
const base = path.join(outDir, `trie-bench-${label}`);
const results: Result[] = [];

// Files are rewritten after every size, so if the largest size runs out of
// memory the smaller results are still saved.
function writeResults(): void {
  fs.writeFileSync(`${base}.json`, JSON.stringify({ environment, results }, null, 2) + '\n');
  fs.writeFileSync(`${base}.md`, markdown());
}

for (const size of sizes) {
  console.log(`Trie bench: ${size} terms, ${lookups} lookups...`);
  const r = runSize(size);
  console.log(JSON.stringify(r));
  results.push(r);
  writeResults();
}
console.log(`Wrote ${base}.json and ${base}.md`);

function markdown(): string {
  return [
    `# Trie benchmark (${label})`,
    '',
    `- Date: ${environment.date}`,
    `- Host: ${environment.host}`,
    `- Container: node ${environment.node}, ${environment.platform}, --cpus=${environment.dockerCpus}`,
    `- Data: seeded Zipf data set (src/dataset.ts, seed 42); prefixes of length 1-6 sampled from stored queries (seed 7)`,
    `- Lookup: Trie.getSuggestions(prefix, 'trending'), ${WARMUP} warm-up calls discarded, one hrtime pair per call`,
    `- Heap: growth in heapUsed after building the trie, measured after forced GC (gc exposed: ${environment.gcExposed})`,
    '',
    '| Terms | Trie nodes | Build (ms) | Heap (MB) | Bytes/term | Lookups | p50 (us) | p99 (us) | p99.9 (us) | max (us) |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...results.map(
      r =>
        `| ${r.terms.toLocaleString('en-US')} | ${r.trieNodes.toLocaleString('en-US')} | ${r.buildMs} | ${r.heapMB} | ${r.bytesPerTerm} | ${r.lookups.toLocaleString('en-US')} | ${r.latencyUs.p50} | ${r.latencyUs.p99} | ${r.latencyUs.p999} | ${r.latencyUs.max} |`
    ),
    '',
  ].join('\n');
}
