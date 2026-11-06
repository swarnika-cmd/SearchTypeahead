import fs from 'fs';
import path from 'path';
import { createRng } from '../src/rng';
import { generateDataset } from '../src/dataset';

/**
 * Picks `count` prefixes the way a user would type them: a random stored query,
 * cut to a random length of 1-6 characters (never longer than the query).
 * Seeded, so the trie benchmark and the load test always use the same prefixes.
 */
export function samplePrefixes(queries: string[], count: number, seed = 7): string[] {
  const rng = createRng(seed);
  const prefixes: string[] = [];
  for (let i = 0; i < count; i++) {
    const query = queries[Math.floor(rng() * queries.length)];
    const length = 1 + Math.floor(rng() * Math.min(6, query.length));
    prefixes.push(query.slice(0, length));
  }
  return prefixes;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// CLI: write prefixes for the k6 load test
//   ts-node bench/prefixes.ts --terms 100000 --count 100000 --out bench/.work/prefixes.json
if (require.main === module) {
  const terms = Number(arg('terms', '100000'));
  const count = Number(arg('count', '100000'));
  const out = arg('out', 'bench/.work/prefixes.json');

  const queries = generateDataset(terms).map(d => d.query);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(samplePrefixes(queries, count)));
  console.log(`Wrote ${count} prefixes drawn from ${terms} terms to ${out}`);
}
