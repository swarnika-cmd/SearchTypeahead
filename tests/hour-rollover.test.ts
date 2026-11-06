import request from 'supertest';
import { app, rebuildTrie, trie } from '../src/server';
import { initDb, dbRun, closeDb } from '../src/db';

const HOUR = 3600000;

describe('Hour rollover (trending scores move to the next hour)', () => {
  let realNow: number;

  beforeAll(async () => {
    await initDb();
    await dbRun('DELETE FROM queries');
    await dbRun('DELETE FROM query_buckets');
    await dbRun('INSERT INTO queries (query, count) VALUES (?, ?)', ['react tutorial', 200]);
    await rebuildTrie();
  });

  beforeEach(() => {
    realNow = Date.now();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await closeDb();
  });

  test('searches still waiting in the write-behind buffer survive the rollover', async () => {
    for (let i = 0; i < 3; i++) {
      await request(app).post('/search').send({ query: 'kotlin' });
    }
    // Warm the trending cache entry for 'kot' in the current hour
    const before = await request(app).get('/suggest?q=kot');
    expect(before.body.suggestions[0]).toMatchObject({ query: 'kotlin', count: 3 });
    expect(before.body.suggestions[0].score).toBeCloseTo(10 * 3 + 0.05 * 3);

    // The buffer has not flushed (threshold 50, timer not started), so SQLite
    // does not know about 'kotlin' yet. Now move the clock into the next hour.
    jest.spyOn(Date, 'now').mockReturnValue(realNow + HOUR);

    const basic = await request(app).get('/suggest?q=kot&mode=basic');
    expect(basic.status).toBe(200);
    expect(basic.body.suggestions).toEqual([{ query: 'kotlin', count: 3 }]);
    expect(trie.getCount('kotlin')).toBe(3);

    // Trending score must be recomputed: the 3 searches now sit in the
    // "previous hour" bucket (weight 5) instead of the current one (weight 10).
    const trending = await request(app).get('/suggest?q=kot');
    expect(trending.body.suggestions[0].score).toBeCloseTo(5 * 3 + 0.05 * 3);
  });
});
