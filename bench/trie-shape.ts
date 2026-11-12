/**
 * Structure counts for the benchmark data set, no timing and no trie built:
 * how many nodes an array trie and a radix (path-compressed) trie need, and how
 * many top-K list slots they hold. Used to ground the per-node estimate in
 * docs/MEMORY_V3.md.
 *
 *   node -r ts-node/register/transpile-only bench/trie-shape.ts --sizes 10000,100000
 *
 * Definitions, for the set of normalised terms T and every prefix p of a term:
 *   array trie nodes = number of distinct prefixes (root included)
 *   radix nodes      = root + prefixes that are a stored term or have at least
 *                      two different next characters
 *   list slots       = sum over nodes of min(K, number of terms under the node),
 *                      once for the basic list and once for the trending list
 */
import fs from 'fs';
import path from 'path';
import { generateDataset } from '../src/dataset';

const K = 10;

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

export interface Shape {
  terms: number;
  arrayNodes: number;
  radixNodes: number;
  nodeReduction: number; // arrayNodes / radixNodes
  arrayListSlots: number; // per list (basic or trending)
  radixListSlots: number;
  radixLeaves: number;
  radixChildCountHistogram: Record<string, number>; // children per radix node
  avgRadixLabelLength: number;
}

export function shapeOf(terms: string[]): Shape {
  // under: terms below each prefix; next: distinct next characters per prefix; isTerm: stored terms
  const under = new Map<string, number>();
  const next = new Map<string, Set<string>>();
  const isTerm = new Set<string>(terms);
  under.set('', terms.length);
  for (const t of terms) {
    for (let i = 1; i <= t.length; i++) {
      const p = t.slice(0, i);
      under.set(p, (under.get(p) || 0) + 1);
    }
    for (let i = 0; i < t.length; i++) {
      const p = t.slice(0, i);
      let s = next.get(p);
      if (!s) next.set(p, (s = new Set()));
      s.add(t[i]);
    }
  }

  let radixNodes = 0;
  let arrayListSlots = 0;
  let radixListSlots = 0;
  let leaves = 0;
  let labelChars = 0;
  const hist: Record<string, number> = {};
  const radixPrefixes: string[] = [];
  for (const [p, n] of under) {
    arrayListSlots += Math.min(K, n);
    const kids = next.get(p)?.size ?? 0;
    if (p === '' || isTerm.has(p) || kids >= 2) {
      radixNodes++;
      radixListSlots += Math.min(K, n);
      if (kids === 0) leaves++;
      hist[kids] = (hist[kids] || 0) + 1;
      radixPrefixes.push(p);
    }
  }
  // Edge label length = distance to the nearest radix ancestor (or the root)
  const radixSet = new Set(radixPrefixes);
  for (const p of radixPrefixes) {
    if (p === '') continue;
    let j = p.length - 1;
    while (j > 0 && !radixSet.has(p.slice(0, j))) j--;
    labelChars += p.length - j;
  }
  return {
    terms: terms.length,
    arrayNodes: under.size,
    radixNodes,
    nodeReduction: Number((under.size / radixNodes).toFixed(2)),
    arrayListSlots,
    radixListSlots,
    radixLeaves: leaves,
    radixChildCountHistogram: hist,
    avgRadixLabelLength: Number((labelChars / Math.max(1, radixNodes - 1)).toFixed(2)),
  };
}

/**
 * Node counts only, from the sorted term list (no per-prefix maps), so it also
 * works for 1M terms. With the terms sorted, two neighbours that share a prefix
 * of length l differ at position l (or one of them ends there), so that prefix is
 * a branching point or a term. The distinct such prefixes plus the terms plus the
 * root are the radix nodes; the array trie has one node per distinct prefix.
 */
export function nodeCountsSorted(terms: string[]): { terms: number; arrayNodes: number; radixNodes: number; nodeReduction: number } {
  const sorted = Array.from(new Set(terms)).sort();
  const termSet = new Set(sorted);
  let arrayNodes = 1;
  const branching = new Set<string>();
  let prev = '';
  for (const t of sorted) {
    let l = 0;
    const max = Math.min(prev.length, t.length);
    while (l < max && prev.charCodeAt(l) === t.charCodeAt(l)) l++;
    arrayNodes += t.length - l;
    if (l > 0) {
      const p = t.slice(0, l);
      if (!termSet.has(p)) branching.add(p);
    }
    prev = t;
  }
  const radixNodes = 1 + sorted.length + branching.size;
  return { terms: sorted.length, arrayNodes, radixNodes, nodeReduction: Number((arrayNodes / radixNodes).toFixed(2)) };
}

if (require.main === module) {
  const sizes = arg('sizes', '10000,100000').split(',').map(Number);
  const countsOnly = arg('counts-only', '1000000').split(',').map(Number).filter(Boolean);
  const out = arg('out', '');
  const shapes = sizes.map(n => shapeOf(generateDataset(n).map(d => d.query)));
  // Same counts through the lean method, as a cross-check, then the sizes that are too big for shapeOf
  const nodeCounts = [...sizes, ...countsOnly].map(n => nodeCountsSorted(generateDataset(n).map(d => d.query)));
  for (const s of shapes) console.log(JSON.stringify(s));
  for (const c of nodeCounts) console.log(JSON.stringify(c));
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ note: 'structure counts only, no timing', k: K, shapes, nodeCounts }, null, 2) + '\n');
  }
}
