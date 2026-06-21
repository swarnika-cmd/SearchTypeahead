import express from 'express';
import path from 'path';
import { Trie, TrieNode } from './trie';
import { dbAll, initDb, dbRun } from './db';
import { metrics } from './metrics';
import { HashRing, CacheNode, hashKey } from './cache';
import { SearchBuffer } from './buffer';

const app = express();
const PORT = process.env.PORT || 3000;

// Instantiate the single shared in-memory Trie
const trie = new Trie();

// Instantiate the SearchBuffer (flushes every 5 seconds or when size reaches 50)
const searchBuffer = new SearchBuffer(trie, 5000, 50);

// Configure the Cache Ring
const CACHE_TTL_MS = 10000; // 10 seconds TTL
const hashRing = new HashRing(50); // 50 virtual nodes per cache node
const cacheNodes = ['cache-node-0', 'cache-node-1', 'cache-node-2'];
const cacheInstances = new Map<string, CacheNode>();

// Initialize Cache Nodes
cacheNodes.forEach(node => {
  hashRing.addNode(node);
  cacheInstances.set(node, new CacheNode(node));
});

// Keep track of the last hour the Trie was rebuilt
let lastTrieBuildHour = 0;

/**
 * Rebuilds the in-memory Trie from SQLite data.
 * Merges historical all-time counts and recent hourly bucket counts
 * to calculate decayed scores.
 */
export async function rebuildTrie(): Promise<void> {
  console.log('Rebuilding in-memory Trie from SQLite data...');
  const startTime = Date.now();

  // Clear existing Trie root to purge deleted entries
  trie.root = new TrieNode();

  // Fetch all-time query counts
  metrics.dbReads++;
  const queries = await dbAll('SELECT query, count FROM queries');

  // Fetch only relevant recent buckets (current hour and previous hour)
  // to avoid loading expired historical data into memory
  const currentHour = Math.floor(Date.now() / 3600000) * 3600000;
  const prevHour = currentHour - 3600000;

  metrics.dbReads++;
  const buckets = await dbAll(
    'SELECT query, hour_timestamp, count FROM query_buckets WHERE hour_timestamp IN (?, ?)',
    [currentHour, prevHour]
  );

  // Group buckets by query
  const queryBucketsMap = new Map<string, Map<number, number>>();
  buckets.forEach(row => {
    if (!queryBucketsMap.has(row.query)) {
      queryBucketsMap.set(row.query, new Map());
    }
    queryBucketsMap.get(row.query)!.set(row.hour_timestamp, row.count);
  });

  // Re-insert all queries with their counts and recent bucket mapping into Trie
  queries.forEach(row => {
    const recentMap = queryBucketsMap.get(row.query) || new Map();
    trie.insert(row.query, row.count, recentMap);
  });

  lastTrieBuildHour = currentHour;
  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`Trie rebuilt successfully: ${queries.length} queries loaded in ${durationSec}s.`);
}

app.use(express.json());
// Serve frontend static files from the 'public' directory
app.use(express.static(path.join(__dirname, '../public')));

/**
 * Endpoint: GET /suggest
 * Query Parameters:
 *   - q=<prefix>
 *   - mode=basic | trending (defaults to trending)
 * Returns: Array of top 10 suggestions matching the prefix.
 */
app.get('/suggest', async (req, res) => {
  const startTime = process.hrtime.bigint();
  const prefix = (req.query.q as string) || '';
  const mode = (req.query.mode as 'basic' | 'trending') || 'trending';
  const sanitized = prefix.toLowerCase().trim();
  
  try {
    // 1. Lazy check for hour-transition to rebuild Trie and recompute scores
    const currentHour = Math.floor(Date.now() / 3600000) * 3600000;
    if (currentHour !== lastTrieBuildHour) {
      await rebuildTrie();
    }

    // 2. Consistent hashing routing (route based on prefix only)
    const targetNodeName = hashRing.getNode(sanitized);
    const cacheNode = cacheInstances.get(targetNodeName)!;

    // 3. Cache key incorporates mode to isolate basic vs trending suggestion arrays
    const cacheKey = `${sanitized}:${mode}`;
    const cachedSuggestions = cacheNode.get(cacheKey);

    let suggestions;
    if (cachedSuggestions !== null) {
      // Cache Hit!
      metrics.cacheHits++;
      suggestions = cachedSuggestions;
    } else {
      // Cache Miss!
      metrics.cacheMisses++;
      // Fallback to the in-memory Trie
      suggestions = trie.getSuggestions(sanitized, mode);
      // Backfill the cache node
      cacheNode.set(cacheKey, suggestions, CACHE_TTL_MS);
    }

    const endTime = process.hrtime.bigint();
    const durationMs = Number(endTime - startTime) / 1_000_000; // convert ns to ms
    metrics.recordLatency(durationMs);

    return res.json({ suggestions });
  } catch (error) {
    console.error('Error fetching suggestions:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Endpoint: GET /cache/debug
 * Query Parameter: prefix=<prefix>
 * Returns: Hashing routing info, hit/miss status on responsible node,
 *          and snapshots of active cached keys.
 */
app.get('/cache/debug', (req, res) => {
  const prefix = (req.query.prefix as string) || '';
  const sanitized = prefix.toLowerCase().trim();

  try {
    const targetNodeName = hashRing.getNode(sanitized);
    const cacheNode = cacheInstances.get(targetNodeName)!;
    const isHit = cacheNode.hasActive(`${sanitized}:trending`) || cacheNode.hasActive(`${sanitized}:basic`);
    const hashVal = hashKey(sanitized);

    return res.json({
      prefix: sanitized,
      responsibleNode: targetNodeName,
      status: isHit ? 'hit' : 'miss',
      hashValue: hashVal,
      activeKeysOnNode: cacheNode.getKeys(),
    });
  } catch (error) {
    console.error('Error in cache debug:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Endpoint: POST /search
 * Request Body: { query: string }
 * Behavior: Synchronously writes the updated count to SQLite (both queries and query_buckets),
 *           updates the in-memory Trie, and returns a confirmation message.
 */
app.post('/search', async (req, res) => {
  const { query } = req.body;
  
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'Invalid search query' });
  }

  const sanitizedQuery = query.toLowerCase().trim();

  try {
    const currentHour = Math.floor(Date.now() / 3600000) * 3600000;

    // 1. Increment client submission counter
    metrics.searchesSubmitted++;

    // 2. Get current counts from Trie in O(L) time and increment
    const currentCount = trie.getCount(sanitizedQuery);
    const recentCounts = trie.getRecentCounts(sanitizedQuery);

    const newCount = currentCount + 1;
    const currentHourCount = (recentCounts.get(currentHour) || 0) + 1;
    recentCounts.set(currentHour, currentHourCount);

    // 3. Update the in-memory Trie immediately so autocomplete reflects changes instantly
    trie.insert(sanitizedQuery, newCount, recentCounts);

    // 4. Mark query as dirty to flush asynchronously in background batch
    searchBuffer.add(sanitizedQuery);

    return res.json({ message: 'Searched' });
  } catch (error) {
    console.error('Error submitting search:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});

/**
 * Endpoint: GET /metrics
 * Returns: Operational metrics (latency, cache stats, db reads/writes)
 */
app.get('/api/metrics', (req, res) => {
  res.json(metrics.getSnapshot());
});

/**
 * Bootstrap function to start the application
 */
async function startServer() {
  try {
    // 1. Initialize SQLite Database Tables
    await initDb();
    
    // Auto-seed if the queries database is empty (essential for fresh deployments like Render)
    const rows = await dbAll('SELECT COUNT(*) as count FROM queries');
    if (!rows || rows.length === 0 || rows[0].count === 0) {
      console.log('Queries database is empty. Auto-seeding Zipf queries...');
      const { runSeeder } = require('./seed');
      await runSeeder(105000);
    }

    // 2. Rebuild Trie (loads queries from DB)
    await rebuildTrie();

    // 3. Start Search Buffer flush worker
    searchBuffer.start();

    // 4. Start Listening
    app.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
if (require.main === module) {
  startServer();
}

export { app, trie, searchBuffer };
