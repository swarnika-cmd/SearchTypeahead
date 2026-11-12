/**
 * Public entry point for the trie. At this step `Trie` is the array trie.
 * (The next commit adds the radix trie and the TRIE_IMPL switch.)
 */
export { hourStart } from './trie-common';
export type { Suggestion, SuggestionMode, TrieEntry, TrieLike } from './trie-common';
export { ArrayTrie, ArrayTrieNode, ArrayTrieNode as TrieNode } from './trie-array';
import { ArrayTrie } from './trie-array';

export class Trie extends ArrayTrie {}
