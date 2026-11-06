import { Trie, Suggestion } from '../src/trie';
import { createRng } from '../src/rng';
import { normalizeQuery } from '../src/normalize';

/**
 * Property test: the precomputed top-10 lists must always equal what a brute-force
 * scan over every stored query would return.
 *
 * We keep a plain Map as the "model", apply the same random operations to the
 * trie and the model, then compare every prefix. Seeded RNG -> reproducible.
 *
 * The operations only ever increase counts, which is how the server uses the trie
 * (a search adds 1). Scores only go down at an hour change, and then the whole
 * trie is rebuilt by refreshScores(), which is also checked below.
 */

const HOUR = 3600000;

interface ModelEntry {
  count: number;
  recent: Map<number, number>;
}

function score(entry: ModelEntry, now: number): number {
  const current = Math.floor(now / HOUR) * HOUR;
  const cur = entry.recent.get(current) || 0;
  const prev = entry.recent.get(current - HOUR) || 0;
  return 10 * cur + 5 * prev + 0.05 * entry.count;
}

function byQuery(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function bruteForce(model: Map<string, ModelEntry>, prefix: string, mode: 'basic' | 'trending', now: number): Suggestion[] {
  const matches = [...model.entries()].filter(([q]) => q.startsWith(prefix));
  if (mode === 'basic') {
    return matches
      .sort(([qa, a], [qb, b]) => b.count - a.count || byQuery(qa, qb))
      .slice(0, 10)
      .map(([query, e]) => ({ query, count: e.count }));
  }
  return matches
    .sort(([qa, a], [qb, b]) => score(b, now) - score(a, now) || b.count - a.count || byQuery(qa, qb))
    .slice(0, 10)
    .map(([query, e]) => ({ query, count: e.count, score: score(e, now) }));
}

function randomTerm(rng: () => number): string {
  // Small alphabet so many terms share prefixes and lists overflow 10 entries
  const letters = 'abcd ';
  const length = 1 + Math.floor(rng() * 6);
  let term = '';
  for (let i = 0; i < length; i++) term += letters[Math.floor(rng() * letters.length)];
  return normalizeQuery(term);
}

function allPrefixes(model: Map<string, ModelEntry>): Set<string> {
  const prefixes = new Set<string>(['']);
  for (const q of model.keys()) {
    for (let i = 1; i <= q.length; i++) prefixes.add(q.slice(0, i));
  }
  return prefixes;
}

function expectMatchesModel(trie: Trie, model: Map<string, ModelEntry>, now: number) {
  for (const prefix of allPrefixes(model)) {
    expect(trie.getSuggestions(prefix, 'basic')).toEqual(bruteForce(model, prefix, 'basic', now));

    const trending = trie.getSuggestions(prefix, 'trending');
    const expected = bruteForce(model, prefix, 'trending', now);
    expect(trending.map(s => s.query)).toEqual(expected.map(s => s.query));
    trending.forEach((s, i) => expect(s.score).toBeCloseTo(expected[i].score!, 9));
  }
}

describe('Trie top-K matches brute force on random data', () => {
  // Fixed clock in the middle of an hour so the test never straddles a boundary
  const now = Math.floor(Date.now() / HOUR) * HOUR + HOUR / 2;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each([1, 2, 3, 42, 2026])('seed %i: 2,000 random searches', (seed) => {
    const rng = createRng(seed);
    const trie = new Trie();
    const model = new Map<string, ModelEntry>();
    const currentHour = Math.floor(now / HOUR) * HOUR;

    for (let op = 0; op < 2000; op++) {
      const term = randomTerm(rng);
      if (!term) continue;
      const entry = model.get(term) || { count: 0, recent: new Map<number, number>() };

      const added = 1 + Math.floor(rng() * 20);
      entry.count += added;
      // Some searches land in this hour, some in the previous hour
      const hour = rng() < 0.7 ? currentHour : currentHour - HOUR;
      entry.recent.set(hour, (entry.recent.get(hour) || 0) + added);
      model.set(term, entry);

      trie.insert(term, entry.count, new Map(entry.recent));

      if (op % 500 === 499) expectMatchesModel(trie, model, now);
    }
    expectMatchesModel(trie, model, now);

    // One hour later scores drop (this hour's bucket becomes "previous").
    // refreshScores() must rebuild every list to match brute force again.
    const later = now + HOUR;
    (Date.now as jest.Mock).mockReturnValue(later);
    trie.refreshScores();
    expectMatchesModel(trie, model, later);
  });
});
