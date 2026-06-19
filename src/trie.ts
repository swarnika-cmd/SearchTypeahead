export interface Suggestion {
  query: string;
  count: number;
  score?: number; // Decayed score for trending searches
}

export class TrieNode {
  // Option B: Fixed-size array for children (a-z: 0-25, 0-9: 26-35, space: 36)
  children: Array<TrieNode | null>;
  isEndOfWord: boolean;
  count: number; // all-time count
  recentCounts: Map<number, number>; // Map of hour_timestamp -> count
  topSuggestions: Suggestion[]; // sorted by count descending (basic mode)
  topTrendingSuggestions: Suggestion[]; // sorted by score descending (trending mode)

  constructor() {
    this.children = new Array(37).fill(null);
    this.isEndOfWord = false;
    this.count = 0;
    this.recentCounts = new Map();
    this.topSuggestions = [];
    this.topTrendingSuggestions = [];
  }
}

export class Trie {
  root: TrieNode;

  constructor() {
    this.root = new TrieNode();
  }

  /**
   * Helper to map a character to an index (0-36):
   * 'a'-'z' => 0-25
   * '0'-'9' => 26-35
   * any other character (space, punctuation) => 36 (space)
   */
  private getCharIndex(char: string): number {
    const code = char.charCodeAt(0);
    if (code >= 97 && code <= 122) {
      return code - 97;
    }
    if (code >= 48 && code <= 57) {
      return code - 48 + 26;
    }
    return 36; // fallback to space
  }

  /**
   * Cleans and sanitizes query input (converts to lowercase, trims).
   */
  private sanitize(query: string): string {
    return query.toLowerCase().trim();
  }

  /**
   * Computes the decayed score based on all-time count and recent hourly bucket counts.
   * Formula: Score = 10 * current_hour_count + 5 * previous_hour_count + 0.05 * all_time_count
   */
  public getDecayedScore(allTimeCount: number, recentCounts: Map<number, number>): number {
    const currentHour = Math.floor(Date.now() / 3600000) * 3600000;
    const prevHour = currentHour - 3600000;
    
    const countCurrent = recentCounts.get(currentHour) || 0;
    const countPrev = recentCounts.get(prevHour) || 0;

    return 10 * countCurrent + 5 * countPrev + 0.05 * allTimeCount;
  }

  /**
   * Inserts a query with all-time count and recent bucket counts into the Trie,
   * updating both top-10 basic and trending lists along the path.
   */
  insert(query: string, allTimeCount: number, recentCountsMap = new Map<number, number>()): void {
    const sanitized = this.sanitize(query);
    if (!sanitized) return;

    let node = this.root;
    const path: TrieNode[] = [node];

    for (let i = 0; i < sanitized.length; i++) {
      const idx = this.getCharIndex(sanitized[i]);
      if (node.children[idx] === null) {
        node.children[idx] = new TrieNode();
      }
      node = node.children[idx]!;
      path.push(node);
    }

    // Set leaf node info
    node.isEndOfWord = true;
    node.count = allTimeCount;
    node.recentCounts = recentCountsMap;

    // Calculate the decayed score for this query
    const score = this.getDecayedScore(allTimeCount, recentCountsMap);

    // Propagate the updated query and scores back up the path
    for (let i = path.length - 1; i >= 0; i--) {
      const currNode = path[i];
      
      // 1. Update basic suggestions list (sorted by count descending)
      const existingIdx = currNode.topSuggestions.findIndex(s => s.query === sanitized);
      if (existingIdx !== -1) {
        currNode.topSuggestions[existingIdx].count = allTimeCount;
      } else {
        currNode.topSuggestions.push({ query: sanitized, count: allTimeCount });
      }
      currNode.topSuggestions.sort((a, b) => {
        if (b.count !== a.count) return b.count - a.count;
        return a.query < b.query ? -1 : a.query > b.query ? 1 : 0;
      });
      if (currNode.topSuggestions.length > 10) {
        currNode.topSuggestions = currNode.topSuggestions.slice(0, 10);
      }

      // 2. Update trending suggestions list (sorted by score descending)
      const existingTrendIdx = currNode.topTrendingSuggestions.findIndex(s => s.query === sanitized);
      if (existingTrendIdx !== -1) {
        currNode.topTrendingSuggestions[existingTrendIdx].count = allTimeCount;
        currNode.topTrendingSuggestions[existingTrendIdx].score = score;
      } else {
        currNode.topTrendingSuggestions.push({ query: sanitized, count: allTimeCount, score });
      }
      currNode.topTrendingSuggestions.sort((a, b) => {
        const scoreA = a.score || 0;
        const scoreB = b.score || 0;
        if (scoreB !== scoreA) return scoreB - scoreA;
        if (b.count !== a.count) return b.count - a.count;
        return a.query < b.query ? -1 : a.query > b.query ? 1 : 0;
      });
      if (currNode.topTrendingSuggestions.length > 10) {
        currNode.topTrendingSuggestions = currNode.topTrendingSuggestions.slice(0, 10);
      }
    }
  }

  /**
   * Fetches the top 10 suggestions for a given prefix in O(L) time.
   * Supports 'basic' (popularity) and 'trending' (recency-decayed) sorting modes.
   */
  getSuggestions(prefix: string, mode: 'basic' | 'trending' = 'trending'): Suggestion[] {
    const sanitized = this.sanitize(prefix);
    
    // Select root node suggestions if prefix is empty
    if (!sanitized) {
      return mode === 'trending' ? this.root.topTrendingSuggestions : this.root.topSuggestions;
    }

    let node = this.root;
    for (let i = 0; i < sanitized.length; i++) {
      const idx = this.getCharIndex(sanitized[i]);
      if (node.children[idx] === null) {
        return []; // No match found
      }
      node = node.children[idx]!;
    }

    return mode === 'trending' ? node.topTrendingSuggestions : node.topSuggestions;
  }

  /**
   * Returns the count of a specific query, or 0 if it does not exist in the Trie.
   * Runs in O(L) time.
   */
  getCount(query: string): number {
    const sanitized = this.sanitize(query);
    if (!sanitized) return 0;

    let node = this.root;
    for (let i = 0; i < sanitized.length; i++) {
      const idx = this.getCharIndex(sanitized[i]);
      if (node.children[idx] === null) {
        return 0;
      }
      node = node.children[idx]!;
    }

    return node.isEndOfWord ? node.count : 0;
  }

  /**
   * Returns the hourly counts map of a specific query, or an empty map if it does not exist in the Trie.
   * Runs in O(L) time.
   */
  getRecentCounts(query: string): Map<number, number> {
    const sanitized = this.sanitize(query);
    if (!sanitized) return new Map();

    let node = this.root;
    for (let i = 0; i < sanitized.length; i++) {
      const idx = this.getCharIndex(sanitized[i]);
      if (node.children[idx] === null) {
        return new Map();
      }
      node = node.children[idx]!;
    }

    return node.isEndOfWord ? node.recentCounts : new Map();
  }
}
