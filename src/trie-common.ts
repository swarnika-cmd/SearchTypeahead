export const HOUR_MS = 3600000;

/** Start of the hour (epoch ms) that `time` falls in. Hourly buckets are keyed by this. */
export function hourStart(time: number = Date.now()): number {
  return Math.floor(time / HOUR_MS) * HOUR_MS;
}

/** Length of the precomputed top lists kept on every node. */
export const TOP_K = 10;

export interface Suggestion {
  query: string;
  count: number;
  score?: number; // Decayed score for trending searches
}

export type SuggestionMode = 'basic' | 'trending';

export interface TrieEntry {
  query: string;
  count: number;
  recentCounts: Map<number, number>;
}

/**
 * What the server, the cache and the tests rely on. Both trie implementations
 * (ArrayTrie in trie-array.ts, RadixTrie in trie-radix.ts) provide it.
 */
export interface TrieLike {
  /** Opaque root node. The server swaps it for the root of a freshly built trie. */
  root: object;
  getDecayedScore(allTimeCount: number, recentCounts: Map<number, number>): number;
  insert(query: string, allTimeCount: number, recentCountsMap?: Map<number, number>): void;
  getSuggestions(prefix: string, mode?: SuggestionMode): Suggestion[];
  getCount(query: string): number;
  entries(): TrieEntry[];
  refreshScores(): void;
  getRecentCounts(query: string): Map<number, number>;
  /** Number of nodes reachable from the root, root included. */
  nodeCount(): number;
}
