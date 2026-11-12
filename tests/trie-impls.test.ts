import { ArrayTrie, RadixTrie, TrieLike, Suggestion, createTrie, trieImplFromEnv } from '../src/trie';
import { createRng } from '../src/rng';
import { normalizeQuery } from '../src/normalize';
import { generateDataset } from '../src/dataset';
import { nodeCountsSorted } from '../bench/trie-shape';

/**
 * Tests that run against both trie implementations (ArrayTrie and RadixTrie):
 *  - top-10 lists equal a brute-force scan on seeded random data, for every prefix
 *    of every stored query (this includes prefixes that end in the middle of a radix
 *    edge), for prefixes with no match, the empty prefix and trailing-space prefixes
 *  - edge cases around prefix splits
 *  - the two implementations return identical results for the same operations
 */

const HOUR = 3600000;
const IMPLS: Array<[string, new () => TrieLike]> = [
  ['array', ArrayTrie],
  ['radix', RadixTrie],
];

interface ModelEntry {
  count: number;
  recent: Map<number, number>;
}
type Model = Map<string, ModelEntry>;

function score(entry: ModelEntry, now: number): number {
  const current = Math.floor(now / HOUR) * HOUR;
  return 10 * (entry.recent.get(current) || 0) + 5 * (entry.recent.get(current - HOUR) || 0) + 0.05 * entry.count;
}

const byQuery = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function bruteForce(model: Model, prefix: string, mode: 'basic' | 'trending', now: number): Suggestion[] {
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

function randomTerm(rng: () => number, alphabet: string, maxLength: number): string {
  const length = 1 + Math.floor(rng() * maxLength);
  let term = '';
  for (let i = 0; i < length; i++) term += alphabet[Math.floor(rng() * alphabet.length)];
  return normalizeQuery(term);
}

/** Every prefix of every stored query (mid-edge ones included), plus the empty prefix and prefixes with a trailing space. */
function prefixesOf(model: Model): Set<string> {
  const prefixes = new Set<string>(['']);
  for (const q of model.keys()) {
    for (let i = 1; i <= q.length; i++) prefixes.add(q.slice(0, i));
    prefixes.add(q + ' ');
  }
  return prefixes;
}

/** Prefixes that cannot match: a stored query with one character changed, or one extra character at the end. */
function missPrefixes(model: Model, rng: () => number, known: Set<string>): string[] {
  const misses: string[] = ['zzz', '9', 'q q q'];
  const queries = [...model.keys()];
  for (let n = 0; n < 60 && queries.length; n++) {
    const q = queries[Math.floor(rng() * queries.length)];
    misses.push(q + 'z'); // 'z' is outside the test alphabets
    const at = Math.floor(rng() * q.length);
    misses.push(q.slice(0, at) + 'z' + q.slice(at + 1));
  }
  return misses.filter(p => !known.has(p));
}

function expectMatchesModel(trie: TrieLike, model: Model, now: number, rng: () => number) {
  const known = prefixesOf(model);
  for (const prefix of known) {
    // normalizePrefix keeps one trailing space; queries never end in a space, so "q " has no match unless "q x..." exists
    expect(trie.getSuggestions(prefix, 'basic')).toEqual(bruteForce(model, prefix, 'basic', now));
    const trending = trie.getSuggestions(prefix, 'trending');
    const expected = bruteForce(model, prefix, 'trending', now);
    expect(trending.map(s => s.query)).toEqual(expected.map(s => s.query));
    trending.forEach((s, i) => {
      expect(s.count).toBe(expected[i].count);
      expect(s.score).toBeCloseTo(expected[i].score!, 9);
    });
  }
  for (const prefix of missPrefixes(model, rng, known)) {
    expect(trie.getSuggestions(prefix, 'basic')).toEqual([]);
    expect(trie.getSuggestions(prefix, 'trending')).toEqual([]);
  }
  for (const [query, e] of model) {
    expect(trie.getCount(query)).toBe(e.count);
    expect(trie.getRecentCounts(query)).toEqual(e.recent);
  }
  expect(trie.entries().map(e => [e.query, e.count]).sort()).toEqual([...model].map(([q, e]) => [q, e.count]).sort());
}

/** Applies the same random searches to a trie and a model. Counts only go up, as in the server. */
function applyRandomOps(
  trie: TrieLike,
  model: Model,
  rng: () => number,
  ops: number,
  alphabet: string,
  maxLength: number,
  now: number,
  onCheckpoint?: () => void
) {
  const currentHour = Math.floor(now / HOUR) * HOUR;
  for (let op = 0; op < ops; op++) {
    const term = randomTerm(rng, alphabet, maxLength);
    if (!term) continue;
    const entry = model.get(term) || { count: 0, recent: new Map<number, number>() };
    const added = 1 + Math.floor(rng() * 3); // small steps, so equal counts (ties) are common
    entry.count += added;
    const hour = rng() < 0.7 ? currentHour : currentHour - HOUR;
    entry.recent.set(hour, (entry.recent.get(hour) || 0) + added);
    model.set(term, entry);
    trie.insert(term, entry.count, new Map(entry.recent));
    if (onCheckpoint && op % 350 === 349) onCheckpoint();
  }
}

const SCENARIOS: Array<{ name: string; alphabet: string; maxLength: number }> = [
  // Few letters: many shared prefixes, lists overflow 10 entries, short edges
  { name: 'dense, short terms', alphabet: 'abc ', maxLength: 7 },
  // Longer terms with digits: long edges that get split later, mid-edge prefixes
  { name: 'longer terms with digits', alphabet: 'ab1 ', maxLength: 14 },
  // Wide alphabet: nodes with many children
  { name: 'wide alphabet', alphabet: 'abcdefghij01234 ', maxLength: 5 },
];

describe.each(IMPLS)('%s trie: top-10 equals brute force', (_name, Impl) => {
  const now = Math.floor(Date.now() / HOUR) * HOUR + HOUR / 2;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(now);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe.each(SCENARIOS)('$name', ({ alphabet, maxLength }) => {
    test.each([101, 202])('seed %i: random inserts and increments, basic and trending, then an hour change', seed => {
      const rng = createRng(seed);
      const trie = new Impl();
      const model: Model = new Map();
      applyRandomOps(trie, model, rng, 700, alphabet, maxLength, now, () => expectMatchesModel(trie, model, now, rng));
      expectMatchesModel(trie, model, now, rng);

      // One hour later this hour's bucket becomes "previous" and scores drop
      const later = now + HOUR;
      (Date.now as jest.Mock).mockReturnValue(later);
      trie.refreshScores();
      // refreshScores drops buckets older than the previous hour; the model does the same
      for (const entry of model.values()) {
        for (const hour of [...entry.recent.keys()]) if (hour < later - HOUR - (later % HOUR)) entry.recent.delete(hour);
      }
      expectMatchesModel(trie, model, later, rng);

      // The rebuilt trie keeps accepting searches
      const currentHour = Math.floor(later / HOUR) * HOUR;
      for (const term of [...model.keys()].slice(0, 20)) {
        const entry = model.get(term)!;
        entry.count += 5;
        entry.recent.set(currentHour, (entry.recent.get(currentHour) || 0) + 5); // scores only go up between rebuilds
        trie.insert(term, entry.count, new Map(entry.recent));
      }
      expectMatchesModel(trie, model, later, rng);
    });
  });
});

describe('array and radix tries agree', () => {
  const now = Math.floor(Date.now() / HOUR) * HOUR + HOUR / 2;
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(now);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each([7, 8])('seed %i: identical suggestions, counts and entries for the same operations', seed => {
    const rng = createRng(seed);
    const model: Model = new Map();
    const a = new ArrayTrie();
    const r = new RadixTrie();
    const currentHour = Math.floor(now / HOUR) * HOUR;
    for (let op = 0; op < 1500; op++) {
      const term = randomTerm(rng, 'abcd1 ', 10);
      if (!term) continue;
      const entry = model.get(term) || { count: 0, recent: new Map<number, number>() };
      const added = 1 + Math.floor(rng() * 4);
      entry.count += added;
      entry.recent.set(currentHour, (entry.recent.get(currentHour) || 0) + added);
      model.set(term, entry);
      a.insert(term, entry.count, new Map(entry.recent));
      r.insert(term, entry.count, new Map(entry.recent));
    }
    for (const prefix of prefixesOf(model)) {
      for (const mode of ['basic', 'trending'] as const) {
        expect(r.getSuggestions(prefix, mode)).toEqual(a.getSuggestions(prefix, mode));
      }
    }
    const sorted = (t: TrieLike) => t.entries().sort((x, y) => byQuery(x.query, y.query));
    expect(sorted(r)).toEqual(sorted(a));
  });

  test('node counts match the independent structure count from bench/trie-shape.ts', () => {
    const queries = generateDataset(5000).map(d => d.query);
    const a = new ArrayTrie();
    const r = new RadixTrie();
    for (const q of queries) {
      a.insert(q, 1);
      r.insert(q, 1);
    }
    const expected = nodeCountsSorted(queries);
    expect(a.nodeCount()).toBe(expected.arrayNodes);
    expect(r.nodeCount()).toBe(expected.radixNodes);
    expect(r.nodeCount()).toBeLessThan(a.nodeCount());
  });
});

describe.each(IMPLS)('%s trie: prefix splits and edge cases', (_name, Impl) => {
  let trie: TrieLike;
  beforeEach(() => {
    trie = new Impl();
  });

  const queries = (prefix: string, mode: 'basic' | 'trending' = 'basic') => trie.getSuggestions(prefix, mode).map(s => s.query);

  test('test, then team, then te, then t', () => {
    trie.insert('test', 40);
    expect(queries('t')).toEqual(['test']);
    expect(queries('tes')).toEqual(['test']);

    trie.insert('team', 30); // splits the edge "test" after "te"
    expect(queries('t')).toEqual(['test', 'team']);
    expect(queries('te')).toEqual(['test', 'team']);
    expect(queries('tea')).toEqual(['team']);
    expect(queries('tes')).toEqual(['test']);
    expect(queries('tex')).toEqual([]);

    trie.insert('te', 20); // ends exactly on the split node
    expect(queries('t')).toEqual(['test', 'team', 'te']);
    expect(queries('te')).toEqual(['test', 'team', 'te']);
    expect(trie.getCount('te')).toBe(20);

    trie.insert('t', 50); // ends above the split node
    expect(queries('t')).toEqual(['t', 'test', 'team', 'te']);
    expect(queries('te')).toEqual(['test', 'team', 'te']);
    expect(queries('')).toEqual(['t', 'test', 'team', 'te']);

    expect(trie.getCount('t')).toBe(50);
    expect(trie.getCount('te')).toBe(20);
    expect(trie.getCount('tes')).toBe(0); // a prefix of a stored query is not a stored query
    expect(trie.getCount('test')).toBe(40);
    expect(trie.getCount('team')).toBe(30);
    expect(trie.getCount('tea')).toBe(0);
    expect(trie.getCount('teams')).toBe(0);
  });

  test('a word that is a prefix of an existing edge (inserted after the longer word)', () => {
    trie.insert('international', 100);
    trie.insert('inter', 10);
    expect(queries('int')).toEqual(['international', 'inter']);
    expect(queries('inter')).toEqual(['international', 'inter']);
    expect(queries('interna')).toEqual(['international']);
    expect(trie.getCount('inter')).toBe(10);
    expect(trie.getCount('international')).toBe(100);
    expect(trie.getCount('interna')).toBe(0);
  });

  test('a word extending past the end of an existing edge (inserted before the longer word)', () => {
    trie.insert('inter', 10);
    trie.insert('international', 100);
    trie.insert('internet', 60);
    expect(queries('inter')).toEqual(['international', 'internet', 'inter']);
    expect(queries('intern')).toEqual(['international', 'internet']);
    expect(queries('interne')).toEqual(['internet']);
    expect(queries('internat')).toEqual(['international']);
    expect(queries('internx')).toEqual([]);
    expect(queries('international ')).toEqual([]); // trailing space: word finished, nothing continues
  });

  test('identical repeats keep one entry and the latest count', () => {
    for (let n = 1; n <= 5; n++) trie.insert('repeat', n * 10);
    expect(trie.getSuggestions('repeat', 'basic')).toEqual([{ query: 'repeat', count: 50 }]);
    expect(trie.getSuggestions('r', 'trending')).toHaveLength(1);
    expect(trie.getSuggestions('r', 'trending')[0].count).toBe(50);
    expect(trie.getCount('repeat')).toBe(50);
    expect(trie.entries()).toHaveLength(1);

    // Repeat of a term in the middle of a populated trie
    trie.insert('repeated', 5);
    trie.insert('repeat', 60);
    expect(queries('rep')).toEqual(['repeat', 'repeated']);
    trie.insert('repeated', 70);
    expect(queries('rep')).toEqual(['repeated', 'repeat']);
  });

  test('raising a count after a split reorders every list on the path', () => {
    trie.insert('abcdef', 10);
    trie.insert('abcxyz', 20); // splits the edge after "abc"
    trie.insert('abqrst', 15); // splits again after "ab"
    expect(queries('a')).toEqual(['abcxyz', 'abqrst', 'abcdef']);
    trie.insert('abcdef', 25);
    expect(queries('a')).toEqual(['abcdef', 'abcxyz', 'abqrst']);
    expect(queries('abc')).toEqual(['abcdef', 'abcxyz']);
    expect(queries('abcd')).toEqual(['abcdef']);
    expect(queries('abq')).toEqual(['abqrst']);
  });

  test('a term pushed out of a full list comes back when its count rises', () => {
    for (let i = 1; i <= 12; i++) trie.insert(`item${String.fromCharCode(96 + i)}`, i * 10);
    expect(queries('item')).toHaveLength(10);
    expect(queries('item')).not.toContain('itema');
    trie.insert('itema', 500);
    expect(queries('item')[0]).toBe('itema');
    expect(queries('item')).toHaveLength(10);
    expect(queries('item')).not.toContain('itemc');
  });

  test('normalisation: case, punctuation, repeated spaces, digits', () => {
    trie.insert('  iPhone   15!! ', 500);
    trie.insert('iphone 15 pro', 300);
    trie.insert('IPHONE-15-PRO MAX', 100);
    trie.insert('iphone 1', 50);
    expect(trie.getCount('iphone 15')).toBe(500);
    expect(trie.getCount('IPhone  15 Pro')).toBe(300);
    expect(trie.getCount('iphone 15 pro max')).toBe(100);
    expect(queries('IPHONE 1')).toEqual(['iphone 15', 'iphone 15 pro', 'iphone 15 pro max', 'iphone 1']);
    expect(queries('iphone ')).toEqual(['iphone 15', 'iphone 15 pro', 'iphone 15 pro max', 'iphone 1']);
    expect(queries('iphone  15 ')).toEqual(['iphone 15 pro', 'iphone 15 pro max']);
    expect(queries('iphone 15 pro m')).toEqual(['iphone 15 pro max']);
    expect(queries('iphones')).toEqual([]);
  });

  test('inputs that normalise to nothing are ignored', () => {
    trie.insert('', 5);
    trie.insert('   ', 5);
    trie.insert('!!!', 5);
    expect(trie.entries()).toEqual([]);
    expect(trie.getSuggestions('')).toEqual([]);
    expect(trie.getCount('')).toBe(0);
  });

  test('returned lists are copies', () => {
    trie.insert('copy', 3);
    trie.insert('copycat', 2);
    const first = trie.getSuggestions('copy', 'trending');
    first[0].count = 999;
    first.pop();
    expect(trie.getSuggestions('copy', 'trending').map(s => s.count)).toEqual([3, 2]);
    expect(trie.getSuggestions('copy', 'basic')[0]).toEqual({ query: 'copy', count: 3 });
  });

  test('getRecentCounts returns the stored map for a stored query only', () => {
    const recent = new Map([[123, 4]]);
    trie.insert('stored query', 9, recent);
    expect(trie.getRecentCounts('stored query')).toBe(recent);
    expect(trie.getRecentCounts('stored')).toEqual(new Map());
    expect(trie.getRecentCounts('stored query more')).toEqual(new Map());
  });
});

describe('radix node counts', () => {
  test('path compression: one node per run of single-child characters', () => {
    const r = new RadixTrie();
    expect(r.nodeCount()).toBe(1); // root
    r.insert('test', 1);
    expect(r.nodeCount()).toBe(2); // root, "test"
    r.insert('team', 1);
    expect(r.nodeCount()).toBe(4); // root, "te", "st", "am"
    r.insert('te', 1);
    expect(r.nodeCount()).toBe(4); // "te" already exists as a node
    r.insert('t', 1);
    expect(r.nodeCount()).toBe(5); // new node "t" above "e"
    r.insert('test', 5);
    expect(r.nodeCount()).toBe(5); // repeats add nothing

    const a = new ArrayTrie();
    for (const q of ['test', 'team', 'te', 't']) a.insert(q, 1);
    expect(a.nodeCount()).toBe(7); // root, t, e, s, t, a, m
  });
});

describe('implementation selection', () => {
  test('TRIE_IMPL values', () => {
    expect(trieImplFromEnv({})).toBe('radix');
    expect(trieImplFromEnv({ TRIE_IMPL: '' })).toBe('radix');
    expect(trieImplFromEnv({ TRIE_IMPL: 'radix' })).toBe('radix');
    expect(trieImplFromEnv({ TRIE_IMPL: 'array' })).toBe('array');
    expect(() => trieImplFromEnv({ TRIE_IMPL: 'trie' })).toThrow(/TRIE_IMPL/);
  });

  test('createTrie returns the requested class', () => {
    expect(createTrie('array')).toBeInstanceOf(ArrayTrie);
    expect(createTrie('radix')).toBeInstanceOf(RadixTrie);
  });
});
