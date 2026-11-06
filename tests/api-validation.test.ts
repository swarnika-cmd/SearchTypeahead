import request from 'supertest';
import { app, rebuildTrie } from '../src/server';
import { initDb, dbRun, closeDb } from '../src/db';

describe('API input validation', () => {
  beforeAll(async () => {
    await initDb();
    await dbRun('DELETE FROM queries');
    await dbRun('DELETE FROM query_buckets');
    await dbRun('INSERT INTO queries (query, count) VALUES (?, ?)', ['react tutorial', 200]);
    await dbRun('INSERT INTO queries (query, count) VALUES (?, ?)', ['react developer', 100]);
    await rebuildTrie();
  });

  afterAll(async () => {
    await closeDb();
  });

  describe('GET /suggest', () => {
    test('empty prefix returns the overall top suggestions', async () => {
      const res = await request(app).get('/suggest?q=');
      expect(res.status).toBe(200);
      expect(res.body.suggestions[0].query).toBe('react tutorial');
    });

    test('missing q behaves like an empty prefix', async () => {
      const res = await request(app).get('/suggest');
      expect(res.status).toBe(200);
      expect(res.body.suggestions.length).toBeGreaterThan(0);
    });

    test('uppercase, punctuation and extra spaces are normalised', async () => {
      const res = await request(app).get('/suggest?q=' + encodeURIComponent('  REACT!!   d'));
      expect(res.status).toBe(200);
      expect(res.body.suggestions.map((s: any) => s.query)).toEqual(['react developer']);
    });

    test('prefix longer than 100 characters is rejected with 400', async () => {
      const res = await request(app).get('/suggest?q=' + 'a'.repeat(101));
      expect(res.status).toBe(400);
    });

    test('prefix of exactly 100 characters is accepted', async () => {
      const res = await request(app).get('/suggest?q=' + 'a'.repeat(100));
      expect(res.status).toBe(200);
      expect(res.body.suggestions).toEqual([]);
    });

    test('repeated q parameter (array) is rejected with 400, not a 500', async () => {
      const res = await request(app).get('/suggest?q=a&q=b');
      expect(res.status).toBe(400);
    });

    test('unknown mode is rejected with 400', async () => {
      const res = await request(app).get('/suggest?q=re&mode=random');
      expect(res.status).toBe(400);
    });
  });

  describe('POST /search', () => {
    test('request without a JSON body is rejected with 400, not a 500', async () => {
      const res = await request(app).post('/search');
      expect(res.status).toBe(400);
    });

    test('query made only of punctuation is rejected with 400', async () => {
      const res = await request(app).post('/search').send({ query: '!!! ???' });
      expect(res.status).toBe(400);
    });

    test('query longer than 100 characters is rejected with 400', async () => {
      const res = await request(app).post('/search').send({ query: 'b'.repeat(101) });
      expect(res.status).toBe(400);
    });

    test('non-string query is rejected with 400', async () => {
      const res = await request(app).post('/search').send({ query: 42 });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /cache/debug', () => {
    test('repeated prefix parameter is rejected with 400', async () => {
      const res = await request(app).get('/cache/debug?prefix=a&prefix=b');
      expect(res.status).toBe(400);
    });
  });
});
