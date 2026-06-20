import crypto from 'crypto';
import { Suggestion } from './trie';

/**
 * 32-bit FNV-1a Hash function for fast hashing.
 * Converts string keys into 32-bit unsigned integers.
 */
export function hashKey(key: string): number {
  const hash = crypto.createHash('md5').update(key).digest();
  // Read first 4 bytes as a 32-bit unsigned big-endian integer
  return hash.readUInt32BE(0);
}

/**
 * Cache Entry structure with TTL.
 */
interface CacheEntry {
  suggestions: Suggestion[];
  expiryTime: number;
}

/**
 * CacheNode class simulating a single distributed cache server node.
 */
export class CacheNode {
  readonly id: string;
  private store: Map<string, CacheEntry>;

  constructor(id: string) {
    this.id = id;
    this.store = new Map();
  }

  /**
   * Retrieves suggestions for a prefix. Performs lazy eviction if expired.
   */
  get(prefix: string): Suggestion[] | null {
    const entry = this.store.get(prefix);
    if (!entry) return null;

    // Lazy eviction check
    if (Date.now() > entry.expiryTime) {
      this.store.delete(prefix);
      return null;
    }

    return entry.suggestions;
  }

  /**
   * Caches suggestions for a prefix with a given Time-To-Live (TTL) in ms.
   */
  set(prefix: string, suggestions: Suggestion[], ttlMs: number): void {
    this.store.set(prefix, {
      suggestions,
      expiryTime: Date.now() + ttlMs,
    });
  }

  /**
   * Checks if prefix is present (expired or not) for debugging.
   */
  hasActive(prefix: string): boolean {
    const entry = this.store.get(prefix);
    if (!entry) return false;
    return Date.now() <= entry.expiryTime;
  }

  /**
   * Deletes a key from the cache store.
   */
  delete(prefix: string): void {
    this.store.delete(prefix);
  }

  /**
   * Clears all entries in the cache.
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Returns a list of all active cached prefix keys.
   */
  getKeys(): string[] {
    const activeKeys: string[] = [];
    for (const [key, entry] of this.store.entries()) {
      if (Date.now() <= entry.expiryTime) {
        activeKeys.push(key);
      }
    }
    return activeKeys;
  }
}

/**
 * HashRing class implementing consistent hashing with virtual nodes.
 */
export class HashRing {
  private virtualNodeCount: number;
  private ring: number[];
  private nodeMap: Map<number, string>;
  private physicalNodes: Set<string>;

  constructor(virtualNodeCount = 50) {
    this.virtualNodeCount = virtualNodeCount;
    this.ring = [];
    this.nodeMap = new Map();
    this.physicalNodes = new Set();
  }

  /**
   * Adds a physical node to the consistent hashing ring.
   */
  addNode(node: string): void {
    if (this.physicalNodes.has(node)) return;
    this.physicalNodes.add(node);

    // Create virtual nodes and insert their hashes into the ring
    for (let i = 0; i < this.virtualNodeCount; i++) {
      const vNodeKey = `${node}-vnode-${i}`;
      const hash = hashKey(vNodeKey);
      
      this.ring.push(hash);
      this.nodeMap.set(hash, node);
    }

    // Keep the ring sorted to allow binary search successor routing
    this.ring.sort((a, b) => a - b);
  }

  /**
   * Removes a physical node and its virtual nodes from the ring.
   */
  removeNode(node: string): void {
    if (!this.physicalNodes.has(node)) return;
    this.physicalNodes.delete(node);

    // Filter out virtual node hashes associated with the removed physical node
    for (let i = 0; i < this.virtualNodeCount; i++) {
      const vNodeKey = `${node}-vnode-${i}`;
      const hash = hashKey(vNodeKey);
      
      const index = this.ring.indexOf(hash);
      if (index !== -1) {
        this.ring.splice(index, 1);
      }
      this.nodeMap.delete(hash);
    }
  }

  /**
   * Maps a key to its responsible physical node using binary search.
   * Finds the successor node (the first node on the ring with hash >= key hash).
   * Wraps around to the first node if no successor is found.
   */
  getNode(key: string): string {
    if (this.ring.length === 0) {
      throw new Error('Hash ring is empty');
    }

    const hash = hashKey(key);
    
    // Binary search successor on sorted ring array
    let low = 0;
    let high = this.ring.length - 1;
    let idx = 0;

    // Special edge cases or standard binary search
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (this.ring[mid] >= hash) {
        idx = mid; // Possible successor found
        high = mid - 1; // Try to find a smaller hash value >= key hash
      } else {
        low = mid + 1; // Hash is larger, search right side
      }
    }

    // Wrap around to 0 if the key hash is greater than all nodes hashes
    if (low > this.ring.length - 1) {
      idx = 0;
    }

    const successorHash = this.ring[idx];
    return this.nodeMap.get(successorHash)!;
  }

  /**
   * Retrieves all physical nodes on the ring.
   */
  getPhysicalNodes(): string[] {
    return Array.from(this.physicalNodes);
  }
}
