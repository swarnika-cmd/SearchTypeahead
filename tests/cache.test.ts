import { HashRing, CacheNode, hashKey } from '../src/cache';

describe('Consistent Hashing Ring & Cache Node', () => {
  describe('HashRing', () => {
    let ring: HashRing;

    beforeEach(() => {
      ring = new HashRing(10); // 10 virtual nodes per physical node
      ring.addNode('node-A');
      ring.addNode('node-B');
      ring.addNode('node-C');
    });

    test('should route same key to the same physical node consistently', () => {
      const key = 'test-prefix';
      const node1 = ring.getNode(key);
      const node2 = ring.getNode(key);
      const node3 = ring.getNode(key);

      expect(node1).toBe(node2);
      expect(node2).toBe(node3);
      expect(['node-A', 'node-B', 'node-C']).toContain(node1);
    });

    test('should distribute keys across nodes', () => {
      const counts: Record<string, number> = { 'node-A': 0, 'node-B': 0, 'node-C': 0 };
      
      for (let i = 0; i < 100; i++) {
        const node = ring.getNode(`query-key-${i}`);
        counts[node]++;
      }

      // Check that keys are distributed (none of the nodes should have 0 keys)
      expect(counts['node-A']).toBeGreaterThan(0);
      expect(counts['node-B']).toBeGreaterThan(0);
      expect(counts['node-C']).toBeGreaterThan(0);
    });

    test('should minimize key migration when adding a node (Consistent Hashing check)', () => {
      const keyCount = 1000;
      const initialMappings: string[] = [];

      for (let i = 0; i < keyCount; i++) {
        initialMappings.push(ring.getNode(`key-${i}`));
      }

      // Add a new node Node-D
      ring.addNode('node-D');

      let migratedCount = 0;
      for (let i = 0; i < keyCount; i++) {
        const newNode = ring.getNode(`key-${i}`);
        if (newNode !== initialMappings[i]) {
          migratedCount++;
          // Remapped key must belong to the new node
          expect(newNode).toBe('node-D');
        }
      }

      // In a consistent hashing system with 3 nodes expanding to 4,
      // expected migration is roughly 1/4 (25%).
      // We expect it to be well below standard modulo hashing (which would migrate ~75%).
      const migrationPercentage = (migratedCount / keyCount) * 100;
      console.log(`Consistent Hashing Migration: ${migrationPercentage}% of keys migrated.`);
      expect(migrationPercentage).toBeLessThan(35); // strictly less than 35%
    });

    test('should handle node removal and migrate keys to active nodes', () => {
      // Get a key currently owned by node-C
      let targetKey = '';
      for (let i = 0; i < 100; i++) {
        const key = `key-c-find-${i}`;
        if (ring.getNode(key) === 'node-C') {
          targetKey = key;
          break;
        }
      }

      expect(ring.getNode(targetKey)).toBe('node-C');

      // Remove node-C
      ring.removeNode('node-C');

      // The key should now be mapped to either node-A or node-B
      const newOwner = ring.getNode(targetKey);
      expect(newOwner).not.toBe('node-C');
      expect(['node-A', 'node-B']).toContain(newOwner);
    });
  });

  describe('HashRing remapping with 10,000 keys', () => {
    const KEYS = 10000;
    const keys = Array.from({ length: KEYS }, (_, i) => `prefix-${i}`);
    const nodes = ['cache-node-0', 'cache-node-1', 'cache-node-2'];

    function ringWith(names: string[], vnodes = 50): HashRing {
      const ring = new HashRing(vnodes); // 50 = what the server uses
      names.forEach(n => ring.addNode(n));
      return ring;
    }

    test('adding a 4th node moves about 1/4 of keys, all of them to the new node', () => {
      const ring = ringWith(nodes);
      const before = keys.map(k => ring.getNode(k));
      ring.addNode('cache-node-3');

      let moved = 0;
      keys.forEach((k, i) => {
        const now = ring.getNode(k);
        if (now !== before[i]) {
          moved++;
          expect(now).toBe('cache-node-3');
        }
      });
      // Ideal is 1/(N+1) = 25%. Measured with MD5 and 50 vnodes: 26.3%.
      expect(moved / KEYS).toBeGreaterThan(0.20);
      expect(moved / KEYS).toBeLessThan(0.30);
    });

    test('modulo hashing would move about 3/4 of keys for the same change', () => {
      let moved = 0;
      keys.forEach(k => {
        const h = hashKey(k);
        if (h % 3 !== h % 4) moved++;
      });
      expect(moved / KEYS).toBeGreaterThan(0.70);
    });

    test('removing a node only moves the keys that node owned', () => {
      const ring = ringWith([...nodes, 'cache-node-3']);
      const before = keys.map(k => ring.getNode(k));
      ring.removeNode('cache-node-1');

      keys.forEach((k, i) => {
        const now = ring.getNode(k);
        if (before[i] === 'cache-node-1') {
          expect(now).not.toBe('cache-node-1');
        } else {
          expect(now).toBe(before[i]);
        }
      });
    });

    test('more virtual nodes give a more even spread', () => {
      // Largest node load divided by the ideal load (1.0 = perfectly even)
      const worstLoad = (vnodes: number) => {
        const ring = ringWith(nodes, vnodes);
        const counts = new Map<string, number>();
        keys.forEach(k => {
          const n = ring.getNode(k);
          counts.set(n, (counts.get(n) || 0) + 1);
        });
        return Math.max(...counts.values()) / (KEYS / nodes.length);
      };
      const with1 = worstLoad(1);
      const with50 = worstLoad(50);
      const with200 = worstLoad(200);
      expect(with50).toBeLessThan(with1);
      expect(with200).toBeLessThan(with50);
      expect(with200).toBeLessThan(1.15); // measured 1.12 with 3 nodes
    });
  });

  describe('CacheNode', () => {
    let cache: CacheNode;

    beforeEach(() => {
      cache = new CacheNode('cache-A');
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('should cache and retrieve suggestions', () => {
      const suggestions = [{ query: 'iphone', count: 100 }];
      cache.set('iph', suggestions, 1000); // 1s TTL

      expect(cache.get('iph')).toEqual(suggestions);
    });

    test('should expire and evict cache entry after TTL (lazy eviction)', () => {
      const suggestions = [{ query: 'iphone', count: 100 }];
      cache.set('iph', suggestions, 1000); // 1s TTL

      // Advance time by 900ms, should still be valid
      jest.advanceTimersByTime(900);
      expect(cache.get('iph')).toEqual(suggestions);

      // Advance past TTL (1100ms total), should return null
      jest.advanceTimersByTime(200);
      expect(cache.get('iph')).toBeNull();
      expect(cache.getKeys()).toHaveLength(0); // confirms key was deleted from store
    });
  });
});
