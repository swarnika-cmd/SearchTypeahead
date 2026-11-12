import { normalizeQuery, normalizePrefix } from './normalize';
import { HOUR_MS, TOP_K, hourStart, Suggestion, SuggestionMode, TrieEntry, TrieLike } from './trie-common';

/**
 * Radix (path-compressed) trie.
 *
 * - A node stores the edge label that leads to it, not one character. A run of
 *   single-child nodes in the array trie is one node here, so the node count is
 *   at most 2 x (number of stored queries) instead of one per character.
 * - Children sit in a small array sorted by the first character of their label
 *   (at most 37 entries, binary search), instead of a 37-slot array on every node.
 *   Leaves have `children === null`.
 * - Every node still keeps a precomputed top-K list for both modes. A prefix that
 *   ends in the middle of an edge uses the list of the node at the end of that
 *   edge: every stored query under that point passes through that node.
 * - Each stored query has one `Suggestion` object, shared by every list that
 *   contains it (the lists along its path, in both modes). It is updated in place.
 * - Lists are never changed in place. An update builds a new array of exactly the
 *   needed size, so a node created by a split can share its child's lists and a
 *   one-entry node can use the same array for both modes.
 * - `recentCounts` is null except on nodes where a query ends.
 */

// Shared by every node that has no list yet (only a node between creation and its first update)
const EMPTY: Suggestion[] = Object.freeze([]) as unknown as Suggestion[];

export class RadixNode {
  label: string; // edge label from the parent ('' on the root)
  children: RadixNode[] | null; // sorted by label.charCodeAt(0); null on a leaf
  entry: Suggestion | null; // set where a query ends: its text, all-time count and score
  recentCounts: Map<number, number> | null; // hour_timestamp -> count, only where a query ends
  topSuggestions: Suggestion[]; // sorted by count descending (basic mode)
  topTrendingSuggestions: Suggestion[]; // sorted by score descending (trending mode)

  constructor(label: string) {
    this.label = label;
    this.children = null;
    this.entry = null;
    this.recentCounts = null;
    this.topSuggestions = EMPTY;
    this.topTrendingSuggestions = EMPTY;
  }
}

function compareBasic(a: Suggestion, b: Suggestion): number {
  if (b.count !== a.count) return b.count - a.count;
  return a.query < b.query ? -1 : a.query > b.query ? 1 : 0;
}

function compareTrending(a: Suggestion, b: Suggestion): number {
  const scoreA = a.score || 0;
  const scoreB = b.score || 0;
  if (scoreB !== scoreA) return scoreB - scoreA;
  if (b.count !== a.count) return b.count - a.count;
  return a.query < b.query ? -1 : a.query > b.query ? 1 : 0;
}

/**
 * Returns the list after `entry` has been added or changed. Returns the same array
 * when nothing changes, otherwise a new array of exactly the needed length.
 * The result equals "add or update, sort, keep the first TOP_K" because the
 * comparators are total orders (query text breaks every tie).
 */
function withEntry(
  list: Suggestion[],
  entry: Suggestion,
  compare: (a: Suggestion, b: Suggestion) => number
): Suggestion[] {
  const n = list.length;
  const at = list.indexOf(entry);

  if (at !== -1) {
    // The entry's count/score were already changed in place; check whether it still sits in order
    if ((at === 0 || compare(list[at - 1], entry) <= 0) && (at === n - 1 || compare(entry, list[at + 1]) <= 0)) {
      return list;
    }
    const next = list.slice();
    next.sort(compare);
    return next;
  }

  if (n >= TOP_K && compare(entry, list[n - 1]) >= 0) return list; // not good enough for the list

  const size = n < TOP_K ? n + 1 : n;
  const next = new Array<Suggestion>(size);
  let placed = false;
  let o = 0;
  for (let i = 0; i < n && o < size; i++) {
    if (!placed && compare(entry, list[i]) < 0) {
      next[o++] = entry;
      placed = true;
      if (o === size) break;
    }
    next[o++] = list[i];
  }
  if (!placed && o < size) next[o] = entry;
  return next;
}

/** Index of the child whose label starts with `code`, or ~(insertion index) when there is none. */
function indexOfChild(children: RadixNode[] | null, code: number): number {
  if (children === null) return -1;
  let lo = 0;
  let hi = children.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const c = children[mid].label.charCodeAt(0);
    if (c === code) return mid;
    if (c < code) lo = mid + 1;
    else hi = mid - 1;
  }
  return ~lo;
}

/** New array equal to `children` with `child` inserted at `index` (exact length, never in place). */
function withChildAt(children: RadixNode[] | null, index: number, child: RadixNode): RadixNode[] {
  if (children === null) return [child];
  const next = new Array<RadixNode>(children.length + 1);
  for (let i = 0; i < index; i++) next[i] = children[i];
  next[index] = child;
  for (let i = index; i < children.length; i++) next[i + 1] = children[i];
  return next;
}

/** Length of the common prefix of `label` and `s` from offset `from`. */
function commonLength(label: string, s: string, from: number): number {
  const max = Math.min(label.length, s.length - from);
  let k = 0;
  while (k < max && label.charCodeAt(k) === s.charCodeAt(from + k)) k++;
  return k;
}

export class RadixTrie implements TrieLike {
  root: RadixNode;

  constructor() {
    this.root = new RadixNode('');
  }

  /** Normalises query input (see normalize.ts): lowercase, punctuation to spaces, repeated spaces collapsed, trimmed. */
  private sanitize(query: string): string {
    return normalizeQuery(query);
  }

  /**
   * Computes the decayed score based on all-time count and recent hourly bucket counts.
   * Formula: Score = 10 * current_hour_count + 5 * previous_hour_count + 0.05 * all_time_count
   */
  public getDecayedScore(allTimeCount: number, recentCounts: Map<number, number>): number {
    const currentHour = hourStart();
    const prevHour = currentHour - HOUR_MS;

    const countCurrent = recentCounts.get(currentHour) || 0;
    const countPrev = recentCounts.get(prevHour) || 0;

    return 10 * countCurrent + 5 * countPrev + 0.05 * allTimeCount;
  }

  /**
   * Inserts a query with all-time count and recent bucket counts, updating both
   * top-10 lists on every node of its path. Splits an edge when the query
   * leaves it half way.
   */
  insert(query: string, allTimeCount: number, recentCountsMap = new Map<number, number>()): void {
    const sanitized = this.sanitize(query);
    if (!sanitized) return;

    let node = this.root;
    const path: RadixNode[] = [node];
    let i = 0;

    while (i < sanitized.length) {
      const slot = indexOfChild(node.children, sanitized.charCodeAt(i));
      if (slot < 0) {
        // No edge starts with this character: the rest of the query becomes a new leaf
        const leaf = new RadixNode(sanitized.slice(i));
        node.children = withChildAt(node.children, ~slot, leaf);
        node = leaf;
        path.push(node);
        i = sanitized.length;
        break;
      }

      const child = node.children![slot];
      const k = commonLength(child.label, sanitized, i);
      if (k < child.label.length) {
        // The query leaves the edge after k characters: split it with a new node
        const mid = new RadixNode(child.label.slice(0, k));
        child.label = child.label.slice(k);
        mid.children = [child];
        // Every query under `mid` is under `child`, so the lists are the same (copy-on-write makes sharing safe)
        mid.topSuggestions = child.topSuggestions;
        mid.topTrendingSuggestions = child.topTrendingSuggestions;
        node.children![slot] = mid; // same first character, so the order is unchanged
        node = mid;
        path.push(node);
        i += k;
        if (i < sanitized.length) {
          const leaf = new RadixNode(sanitized.slice(i));
          const at = ~indexOfChild(mid.children, sanitized.charCodeAt(i));
          mid.children = withChildAt(mid.children, at, leaf);
          node = leaf;
          path.push(node);
          i = sanitized.length;
        }
        break;
      }

      node = child;
      path.push(node);
      i += k;
    }

    // Set the node where the query ends
    const score = this.getDecayedScore(allTimeCount, recentCountsMap);
    let entry = node.entry;
    if (entry === null) {
      entry = { query: sanitized, count: allTimeCount, score };
      node.entry = entry;
    } else {
      entry.count = allTimeCount;
      entry.score = score;
    }
    node.recentCounts = recentCountsMap;

    // Propagate the updated entry back up the path
    for (let p = path.length - 1; p >= 0; p--) {
      const currNode = path[p];
      const basic = withEntry(currNode.topSuggestions, entry, compareBasic);
      const trending = withEntry(currNode.topTrendingSuggestions, entry, compareTrending);
      currNode.topSuggestions = basic;
      // A one-entry list holds the same entry in both modes, so one array serves both
      currNode.topTrendingSuggestions = basic.length === 1 && trending.length === 1 ? basic : trending;
    }
  }

  /**
   * Walks the prefix and returns the node whose list answers it: the node at the
   * end of the edge the prefix stops on (or in the middle of). Null if no stored query starts with it.
   */
  private findNode(s: string): RadixNode | null {
    let node = this.root;
    let i = 0;
    while (i < s.length) {
      const slot = indexOfChild(node.children, s.charCodeAt(i));
      if (slot < 0) return null;
      const child = node.children![slot];
      const label = child.label;
      const max = Math.min(label.length, s.length - i);
      for (let k = 1; k < max; k++) {
        if (label.charCodeAt(k) !== s.charCodeAt(i + k)) return null;
      }
      i += label.length;
      node = child;
    }
    return node;
  }

  /**
   * Fetches the top 10 suggestions for a given prefix in O(L) time.
   * Supports 'basic' (popularity) and 'trending' (recency-decayed) sorting modes.
   * Returns a copy, so callers (and the cache) cannot change the trie's own lists.
   */
  getSuggestions(prefix: string, mode: SuggestionMode = 'trending'): Suggestion[] {
    const node = this.findNode(normalizePrefix(prefix));
    if (node === null) return [];
    return mode === 'trending' ? this.copyTrending(node.topTrendingSuggestions) : this.copyBasic(node.topSuggestions);
  }

  private copyBasic(list: Suggestion[]): Suggestion[] {
    return list.map(s => ({ query: s.query, count: s.count }));
  }

  private copyTrending(list: Suggestion[]): Suggestion[] {
    return list.map(s => ({ query: s.query, count: s.count, score: s.score }));
  }

  /** Walks the full query; the node must end exactly at its last character. */
  private findEnd(sanitized: string): RadixNode | null {
    let node = this.root;
    let i = 0;
    while (i < sanitized.length) {
      const slot = indexOfChild(node.children, sanitized.charCodeAt(i));
      if (slot < 0) return null;
      const child = node.children![slot];
      const label = child.label;
      if (i + label.length > sanitized.length) return null;
      for (let k = 1; k < label.length; k++) {
        if (label.charCodeAt(k) !== sanitized.charCodeAt(i + k)) return null;
      }
      i += label.length;
      node = child;
    }
    return node;
  }

  /** Returns the count of a specific query, or 0 if it does not exist in the Trie. */
  getCount(query: string): number {
    const sanitized = this.sanitize(query);
    if (!sanitized) return 0;
    const node = this.findEnd(sanitized);
    return node !== null && node.entry !== null ? node.entry.count : 0;
  }

  /** Returns every stored query with its counts, using a depth-first walk. O(number of trie nodes). */
  entries(): TrieEntry[] {
    const result: TrieEntry[] = [];
    const stack: RadixNode[] = [this.root];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.entry !== null) {
        result.push({ query: node.entry.query, count: node.entry.count, recentCounts: node.recentCounts ?? new Map() });
      }
      const children = node.children;
      if (children !== null) {
        for (let c = children.length - 1; c >= 0; c--) stack.push(children[c]);
      }
    }
    return result;
  }

  /**
   * Recomputes every trending score for the current hour.
   * A score only depends on the current and previous hour buckets, so it can
   * only go stale when the hour changes. The server calls this once per hour.
   * Buckets older than the previous hour are dropped. It rebuilds the trie from
   * its own entries (not from SQLite), so searches that are still waiting in the
   * write-behind buffer are kept. It is synchronous, so no request can observe
   * a half-built trie.
   */
  refreshScores(): void {
    const currentHour = hourStart();
    const prevHour = currentHour - HOUR_MS;
    const all = this.entries();

    this.root = new RadixNode('');
    for (const entry of all) {
      const recent = new Map<number, number>();
      for (const hour of [prevHour, currentHour]) {
        const count = entry.recentCounts.get(hour);
        if (count) recent.set(hour, count);
      }
      this.insert(entry.query, entry.count, recent);
    }
  }

  /** Returns the hourly counts map of a specific query, or an empty map if it does not exist in the Trie. */
  getRecentCounts(query: string): Map<number, number> {
    const sanitized = this.sanitize(query);
    if (!sanitized) return new Map();
    const node = this.findEnd(sanitized);
    return node !== null && node.entry !== null && node.recentCounts ? node.recentCounts : new Map();
  }

  /** Number of nodes reachable from the root, root included. */
  nodeCount(): number {
    let count = 0;
    const stack: RadixNode[] = [this.root];
    while (stack.length) {
      const node = stack.pop()!;
      count++;
      const children = node.children;
      if (children !== null) for (let c = 0; c < children.length; c++) stack.push(children[c]);
    }
    return count;
  }
}
