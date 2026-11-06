import request from 'supertest';
import { app, trie, rebuildTrie } from '../src/server';
import { metrics } from '../src/metrics';
import { initDb, dbRun, closeDb } from '../src/db';

describe('Server API Suggestion Route Integration Tests', () => {
  beforeAll(async () => {
    // Ensure SQLite tables are created before running tests
    await initDb();
    // Clear and seed test data directly into the database
    await dbRun('DELETE FROM queries');
    await dbRun('DELETE FROM query_buckets');
    await dbRun('INSERT INTO queries (query, count) VALUES (?, ?)', ['react developer', 100]);
    await dbRun('INSERT INTO queries (query, count) VALUES (?, ?)', ['react tutorial', 200]);
    await dbRun('INSERT INTO queries (query, count) VALUES (?, ?)', ['rust design', 50]);
    
    // Rebuild the trie to load the database records
    await rebuildTrie();
  });

  test('GET /suggest should return matching suggestions sorted by count', async () => {
    const res = await request(app).get('/suggest?q=react');
    
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('suggestions');
    expect(res.body.suggestions).toHaveLength(2);
    
    // Check sorting: tutorial (count 200) then developer (count 100)
    expect(res.body.suggestions[0].query).toBe('react tutorial');
    expect(res.body.suggestions[1].query).toBe('react developer');
  });

  test('GET /suggest with empty query should return overall top suggestions', async () => {
    const res = await request(app).get('/suggest?q=');
    
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toHaveLength(3);
    expect(res.body.suggestions[0].query).toBe('react tutorial');
  });

  test('GET /suggest should record operational metrics', async () => {
    const startMisses = metrics.cacheMisses;
    
    await request(app).get('/suggest?q=rust');
    
    expect(metrics.cacheMisses).toBe(startMisses + 1);
    expect(metrics.getP95Latency()).toBeGreaterThanOrEqual(0);
  });

  test('GET /api/metrics should return metrics snapshot', async () => {
    const res = await request(app).get('/api/metrics');
    
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('p95LatencyMs');
    expect(res.body).toHaveProperty('cacheHitRatePercent');
    expect(res.body).toHaveProperty('dbReads');
  });

  test('POST /search should record a new query search and update trie', async () => {
    // Check initial count
    expect(trie.getCount('kotlin tutorial')).toBe(0);

    const res = await request(app)
      .post('/search')
      .send({ query: 'kotlin tutorial' });
    
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Searched' });

    // Check count increased in Trie
    expect(trie.getCount('kotlin tutorial')).toBe(1);

    // Increment again
    await request(app)
      .post('/search')
      .send({ query: 'kotlin tutorial' });
    expect(trie.getCount('kotlin tutorial')).toBe(2);
  });

  test('POST /search should return 400 for empty or invalid query', async () => {
    const res1 = await request(app).post('/search').send({ query: '' });
    expect(res1.status).toBe(400);

    const res2 = await request(app).post('/search').send({});
    expect(res2.status).toBe(400);
  });

  test('should route requests and record cache hits and misses in /suggest API', async () => {
    const key = 'cache-test-key';
    trie.insert(key, 100);

    const hitMissBefore = { hits: metrics.cacheHits, misses: metrics.cacheMisses };

    // First call: Cache Miss
    const res1 = await request(app).get(`/suggest?q=${key}`);
    expect(res1.status).toBe(200);
    expect(metrics.cacheMisses).toBe(hitMissBefore.misses + 1);
    expect(metrics.cacheHits).toBe(hitMissBefore.hits);

    // Second call: Cache Hit
    const res2 = await request(app).get(`/suggest?q=${key}`);
    expect(res2.status).toBe(200);
    expect(metrics.cacheMisses).toBe(hitMissBefore.misses + 1);
    expect(metrics.cacheHits).toBe(hitMissBefore.hits + 1);
  });

  test('GET /cache/debug should return correct routing and status', async () => {
    const debugPrefix = 'debugprefix';
    
    // First, check status on debug, should be a miss
    const res1 = await request(app).get(`/cache/debug?prefix=${debugPrefix}`);
    expect(res1.status).toBe(200);
    expect(res1.body).toHaveProperty('responsibleNode');
    expect(res1.body.status).toBe('miss');
    expect(res1.body.activeKeysOnNode).not.toContain(debugPrefix);

    // Trigger suggest to populate cache
    await request(app).get(`/suggest?q=${debugPrefix}`);

    // Check debug again, should be a hit
    const res2 = await request(app).get(`/cache/debug?prefix=${debugPrefix}`);
    expect(res2.status).toBe(200);
    expect(res2.body.status).toBe('hit');
    expect(res2.body.activeKeysOnNode).toContain(`${debugPrefix}:trending`);
  });

  test('POST /search invalidates cached suggestions for every prefix of the query', async () => {
    // Cache the (empty) lists for 'zeb' in both modes
    expect((await request(app).get('/suggest?q=zeb')).body.suggestions).toEqual([]);
    expect((await request(app).get('/suggest?q=zeb&mode=basic')).body.suggestions).toEqual([]);

    await request(app).post('/search').send({ query: 'zebra crossing' });

    // Within the 10s TTL the cached empty lists must not be served any more
    const trending = await request(app).get('/suggest?q=zeb');
    expect(trending.body.suggestions.map((s: any) => s.query)).toEqual(['zebra crossing']);
    const basic = await request(app).get('/suggest?q=zeb&mode=basic');
    expect(basic.body.suggestions).toEqual([{ query: 'zebra crossing', count: 1 }]);
  });

  test('cached lists are snapshots, not live references into the trie', async () => {
    await request(app).get('/suggest?q=rust&mode=basic'); // cache it
    const fromTrie = trie.getSuggestions('rust', 'basic');
    fromTrie.push({ query: 'mutated', count: 1 });
    const res = await request(app).get('/suggest?q=rust&mode=basic');
    expect(res.body.suggestions.map((s: any) => s.query)).toEqual(['rust design']);
  });

  afterAll(async () => {
    await closeDb();
  });
});
