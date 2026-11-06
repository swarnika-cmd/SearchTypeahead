import express from 'express';
import path from 'path';
import { Trie, hourStart } from './trie';
import { dbAll, initDb, closeDb } from './db';
import { metrics } from './metrics';
import { HashRing, CacheNode, hashKey } from './cache';
import { SearchBuffer } from './buffer';
import { normalizeQuery, MAX_QUERY_LENGTH } from './normalize';

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

// The hour that the trending scores in the trie were computed for
let scoredForHour = 0;

/**
 * Loads the Trie from SQLite. Called once at startup (and by tests).
 * Merges all-time counts and recent hourly bucket counts to compute trending scores.
 * The new trie is built on the side and swapped in at the end, so readers never
 * see a half-loaded trie.
 */
export async function rebuildTrie(): Promise<void> {
  console.log('Rebuilding in-memory Trie from SQLite data...');
  const startTime = Date.now();

  // Fetch all-time query counts
  metrics.dbReads++;
  const queries = await dbAll('SELECT query, count FROM queries');

  // Fetch only relevant recent buckets (current hour and previous hour)
  // to avoid loading expired historical data into memory
  const currentHour = hourStart();
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

  // Insert all queries with their counts and recent buckets into a fresh Trie
  const fresh = new Trie();
  queries.forEach(row => {
    const recentMap = queryBucketsMap.get(row.query) || new Map();
    fresh.insert(row.query, row.count, recentMap);
  });
  trie.root = fresh.root;

  // Cached lists came from the old trie
  cacheInstances.forEach(cache => cache.clear());
  scoredForHour = currentHour;
  const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`Trie rebuilt successfully: ${queries.length} queries loaded in ${durationSec}s.`);
}

/**
 * Reads a text parameter sent by the client (query string or JSON body).
 * Returns the normalised text, or an error message when the value is unusable:
 * sent more than once (Express turns ?q=a&q=b into an array), not a string,
 * or longer than MAX_QUERY_LENGTH after normalisation.
 * A missing value counts as an empty string.
 */
function readText(value: unknown): { text: string } | { error: string } {
  if (value === undefined) return { text: '' };
  if (typeof value !== 'string') return { error: 'must be a single string' };
  const text = normalizeQuery(value);
  if (text.length > MAX_QUERY_LENGTH) {
    return { error: `must be at most ${MAX_QUERY_LENGTH} characters` };
  }
  return { text };
}

/**
 * Trending scores use "this hour" and "previous hour" buckets, so when the clock
 * moves into a new hour every score changes. The first request of a new hour
 * recomputes them in memory and empties the cache (which holds last hour's lists).
 */
function refreshScoresIfNewHour(): void {
  const hour = hourStart();
  if (hour === scoredForHour) return;
  trie.refreshScores();
  cacheInstances.forEach(cache => cache.clear());
  scoredForHour = hour;
}

/**
 * A search changes the counts for every prefix of the query ('', 'k', 'ko', ...),
 * so the cached lists for those prefixes are now stale. Delete them (both modes)
 * so the next read goes to the trie. Costs one hash-ring lookup per prefix.
 */
function invalidatePrefixes(query: string): void {
  for (let len = 0; len <= query.length; len++) {
    const prefix = query.slice(0, len);
    const cacheNode = cacheInstances.get(hashRing.getNode(prefix))!;
    cacheNode.delete(`${prefix}:basic`);
    cacheNode.delete(`${prefix}:trending`);
  }
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
app.get('/suggest', (req, res) => {
  const startTime = process.hrtime.bigint();

  const parsed = readText(req.query.q);
  if ('error' in parsed) {
    return res.status(400).json({ error: `q ${parsed.error}` });
  }
  const sanitized = parsed.text;

  const modeParam = req.query.mode ?? 'trending';
  if (modeParam !== 'basic' && modeParam !== 'trending') {
    return res.status(400).json({ error: "mode must be 'basic' or 'trending'" });
  }
  const mode: 'basic' | 'trending' = modeParam;

  try {
    // 1. Lazy check for a new hour: recompute trending scores in memory
    refreshScoresIfNewHour();

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
  const parsed = readText(req.query.prefix);
  if ('error' in parsed) {
    return res.status(400).json({ error: `prefix ${parsed.error}` });
  }
  const sanitized = parsed.text;

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
  // req.body is undefined when the request has no JSON body
  const query = req.body?.query;
  if (typeof query !== 'string') {
    return res.status(400).json({ error: 'Invalid search query' });
  }
  const parsed = readText(query);
  if ('error' in parsed) {
    return res.status(400).json({ error: `query ${parsed.error}` });
  }
  if (!parsed.text) {
    // Empty, or only punctuation/whitespace
    return res.status(400).json({ error: 'Invalid search query' });
  }
  const sanitizedQuery = parsed.text;

  try {
    refreshScoresIfNewHour();
    const currentHour = hourStart();

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
    invalidatePrefixes(sanitizedQuery);

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
    const server = app.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}`);
    });

    // 5. On graceful stop (Ctrl+C, docker stop, Kubernetes) write the buffered
    //    searches to SQLite before exiting. A crash or SIGKILL still loses them.
    const shutdown = async (signal: string) => {
      console.log(`${signal} received: flushing search buffer and shutting down...`);
      server.close();
      try {
        await searchBuffer.shutdown();
        await closeDb();
        process.exit(0);
      } catch (err) {
        console.error('Shutdown flush failed:', err);
        process.exit(1);
      }
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
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
