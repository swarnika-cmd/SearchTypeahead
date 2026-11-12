/**
 * Public entry point for the trie. `Trie` is the implementation the server and
 * the tests use. It is the radix trie unless TRIE_IMPL=array is set, which
 * selects the original 37-slot array trie (kept as the memory baseline).
 *
 *   TRIE_IMPL=radix  (default)  src/trie-radix.ts
 *   TRIE_IMPL=array             src/trie-array.ts
 *
 * Both classes are exported too, so a benchmark can run them side by side.
 */
import { ArrayTrie } from './trie-array';
import { RadixTrie } from './trie-radix';
import type { TrieLike } from './trie-common';

export { hourStart } from './trie-common';
export type { Suggestion, SuggestionMode, TrieEntry, TrieLike } from './trie-common';
// TrieNode is the old name of the array trie's node class, kept so existing imports still compile
export { ArrayTrie, ArrayTrieNode, ArrayTrieNode as TrieNode } from './trie-array';
export { RadixTrie, RadixNode } from './trie-radix';

export type TrieImpl = 'array' | 'radix';

/** Reads TRIE_IMPL. An unknown value is an error, so a typo cannot silently pick the wrong trie. */
export function trieImplFromEnv(env: Record<string, string | undefined> = process.env): TrieImpl {
  const value = env.TRIE_IMPL;
  if (value === undefined || value === '' || value === 'radix') return 'radix';
  if (value === 'array') return 'array';
  throw new Error(`Unknown TRIE_IMPL "${value}" (expected "radix" or "array")`);
}

export function createTrie(impl: TrieImpl = trieImplFromEnv()): TrieLike {
  return impl === 'array' ? new ArrayTrie() : new RadixTrie();
}

export type Trie = TrieLike;
export const Trie: new () => TrieLike = trieImplFromEnv() === 'array' ? ArrayTrie : RadixTrie;
