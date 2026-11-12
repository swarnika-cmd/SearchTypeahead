/**
 * Measures what common structures cost on this Node build (heapUsed growth per
 * item after a forced GC). It is the input to the per-node estimate in
 * docs/MEMORY_V3.md. Run with --expose-gc; writes bench/results/v8-unit-costs.json:
 *
 *   node --expose-gc -r ts-node/register/transpile-only bench/v8-unit-costs.ts [--out <file>]
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const gcFn = (global as any).gc as (() => void) | undefined;
if (!gcFn) throw new Error('Run with --expose-gc');
const gc: () => void = gcFn;

export {};

const N = 200000;
const costs: Array<{ name: string; bytes: number }> = [];

function record(name: string, bytes: number): void {
  const row = { name, bytes: Number(bytes.toFixed(1)) };
  costs.push(row);
  console.log(JSON.stringify(row));
}

function heapUsed(): number {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

function bytesPer(name: string, make: (i: number) => unknown): void {
  const keep: unknown[] = new Array(N);
  keep[0] = make(0); // warm the allocation site
  const before = heapUsed();
  for (let i = 0; i < N; i++) keep[i] = make(i);
  const after = heapUsed();
  // `keep` is allocated at full size before `before`, so its slots are not counted
  record(name, (after - before) / N);
  keep.length = 0;
}

class Node6 {
  a: unknown = null;
  b: unknown = null;
  c = 0;
  d: unknown = null;
  e: unknown = [];
  f: unknown = [];
}

const longBase = 'x'.repeat(40);

// Baseline for the container array that holds the items (one slot each)
{
  const before = heapUsed();
  const holder: unknown[] = new Array(N).fill(0);
  const after = heapUsed();
  record('array slot (holder cost per item)', (after - before) / N);
  holder.length = 0;
}

bytesPer('empty array []', () => []);
bytesPer('array [x] then push (grows to capacity 17)', i => { const a: number[] = []; a.push(i + 1000000); return a; });
bytesPer('array literal [x, y] (exact)', i => [i + 1000000, i + 2000000]);
bytesPer('new Array(37).fill(null)', () => new Array(37).fill(null));
bytesPer('new Array(3) filled with objects ({}), array only', () => { const a = new Array(3); a[0] = null; a[1] = null; a[2] = null; return a; });
bytesPer('empty Map', () => new Map());
bytesPer('object {query, count}', i => ({ query: 'q', count: i + 1000000 }));
bytesPer('object {query, count, score}', i => ({ query: 'q', count: i + 1000000, score: i + 0.5 }));
bytesPer('class instance, 6 fields (2 empty arrays)', () => new Node6());
bytesPer('string slice, 6 chars (copied)', i => (longBase + i).slice(2, 8));
bytesPer('string slice, 12 chars (copied)', i => (longBase + i).slice(2, 14));
bytesPer('string slice, 20 chars (sliced string)', i => (longBase + i).slice(2, 22));

const environment = {
  date: new Date().toISOString(),
  node: process.version,
  platform: `${os.platform()} ${os.arch()}`,
  cpuModel: os.cpus()[0]?.model || 'unknown',
  cpusVisible: os.cpus().length,
  dockerCpus: process.env.BENCH_DOCKER_CPUS || 'n/a',
  host: process.env.BENCH_HOST || 'unknown',
  gcExposed: true,
};
const argOut = process.argv.indexOf('--out');
const out = argOut !== -1 && process.argv[argOut + 1] ? process.argv[argOut + 1] : path.join(__dirname, 'results', 'v8-unit-costs.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(
  out,
  JSON.stringify({ note: `heapUsed growth per item after forced GC, ${N} items each (bytes)`, environment, costs }, null, 2) + '\n'
);
console.log(`Wrote ${out}`);
