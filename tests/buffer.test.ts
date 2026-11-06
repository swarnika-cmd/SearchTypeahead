import { SearchBuffer } from '../src/buffer';
import { Trie } from '../src/trie';
import { initDb, dbRun, dbAll, closeDb } from '../src/db';
import { metrics } from '../src/metrics';

describe('SearchBuffer Write-Behind Aggregator', () => {
  let trie: Trie;
  let buffer: SearchBuffer;

  beforeAll(async () => {
    // Connects to in-memory database due to NODE_ENV='test'
    await initDb();
  });

  beforeEach(async () => {
    // Clear mock tables
    await dbRun('DELETE FROM queries');
    await dbRun('DELETE FROM query_buckets');
    
    trie = new Trie();
    // Configure with a short 100ms flush interval and threshold of 5 for rapid real-time testing
    buffer = new SearchBuffer(trie, 100, 5);
  });

  afterEach(() => {
    buffer.stop();
  });

  afterAll(async () => {
    await closeDb();
  });

  test('should buffer queries in memory without writing immediately to database', async () => {
    trie.insert('react', 10);
    buffer.add('react');

    expect(buffer.getBufferSize()).toBe(1);

    // Verify database remains empty
    const rows = await dbAll('SELECT * FROM queries');
    expect(rows).toHaveLength(0);
  });

  test('should flush automatically when size threshold is reached', async () => {
    trie.insert('query1', 1);
    trie.insert('query2', 1);
    trie.insert('query3', 1);
    trie.insert('query4', 1);
    trie.insert('query5', 1);

    // Add 4 unique queries, buffer should hold them
    buffer.add('query1');
    buffer.add('query2');
    buffer.add('query3');
    buffer.add('query4');
    expect(buffer.getBufferSize()).toBe(4);

    // Add 5th item, triggering size-based flush
    buffer.add('query5'); 
    
    // Wait 50ms for SQLite thread pool to complete transaction commit
    await new Promise(resolve => setTimeout(resolve, 50));

    // Buffer should now be cleared
    expect(buffer.getBufferSize()).toBe(0);

    // Check DB rows are written
    const rows = await dbAll('SELECT * FROM queries');
    expect(rows).toHaveLength(5);
  });

  test('should flush periodically based on timer', async () => {
    trie.insert('golang', 5);
    buffer.add('golang');

    buffer.start();

    // Verify DB empty before timer fires
    expect(await dbAll('SELECT * FROM queries')).toHaveLength(0);

    // Wait 150ms for the 100ms timer to fire and commit
    await new Promise(resolve => setTimeout(resolve, 150));

    // Confirm DB flush
    const rows = await dbAll('SELECT * FROM queries');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ query: 'golang', count: 5 });
  });

  test('should aggregate duplicate searches and write only once during flush', async () => {
    const startDbWrites = metrics.dbWrites;

    // Simulate 5 client searches for the same query "python"
    // (like POST /search: all-time count and this hour's bucket both go up)
    const hour = Math.floor(Date.now() / 3600000) * 3600000;
    for (let i = 1; i <= 5; i++) {
      metrics.searchesSubmitted++;
      trie.insert('python', i, new Map([[hour, i]])); // increment trie count
      buffer.add('python');                           // mark key as dirty
    }

    // Flush the buffer containing duplicate updates
    await buffer.flush();

    // Verify the DB count is the final aggregated value
    const rows = await dbAll('SELECT * FROM queries');
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(5);

    // DB writes should only show +2 (one for queries, one for query_buckets)
    // rather than +10 (for 5 searches write-throughs)
    const dbWritesAdded = metrics.dbWrites - startDbWrites;
    expect(dbWritesAdded).toBe(2);
  });
  test('a failed flush keeps the keys so the next flush retries them', async () => {
    const hour = Math.floor(Date.now() / 3600000) * 3600000;
    trie.insert('swift', 3, new Map([[hour, 3]]));
    buffer.add('swift');

    // Make the write fail: the bucket table is gone
    await dbRun('DROP TABLE query_buckets');
    await expect(buffer.flush()).rejects.toThrow();

    // Nothing half-written, and the key is still waiting
    expect(await dbAll('SELECT * FROM queries')).toHaveLength(0);
    expect(buffer.getBufferSize()).toBe(1);

    // Once the table is back, the retry succeeds
    await initDb();
    await buffer.flush();
    expect(await dbAll('SELECT * FROM queries')).toEqual([{ query: 'swift', count: 3 }]);
  });

  test('writes the bucket of the hour the search happened in, even when flushed an hour later', async () => {
    const realNow = Date.now();
    const hour = Math.floor(realNow / 3600000) * 3600000;
    trie.insert('scala', 2, new Map([[hour, 2]]));
    buffer.add('scala');

    // Flush runs just after the hour boundary (search at 10:59, flush at 11:00)
    const spy = jest.spyOn(Date, 'now').mockReturnValue(hour + 3600000 + 1000);
    await buffer.flush();
    spy.mockRestore();

    const buckets = await dbAll('SELECT hour_timestamp, count FROM query_buckets WHERE query = ?', ['scala']);
    expect(buckets).toEqual([{ hour_timestamp: hour, count: 2 }]);
  });

  test('two overlapping flushes both complete without nesting transactions', async () => {
    trie.insert('alpha', 1);
    trie.insert('beta', 2);
    buffer.add('alpha');
    const first = buffer.flush();
    buffer.add('beta');
    const second = buffer.flush();

    await Promise.all([first, second]);
    const rows = await dbAll('SELECT * FROM queries ORDER BY query');
    expect(rows).toEqual([{ query: 'alpha', count: 1 }, { query: 'beta', count: 2 }]);
  });

  test('shutdown() stops the timer and flushes everything still buffered', async () => {
    buffer.start();
    trie.insert('elixir', 4);
    buffer.add('elixir');

    await buffer.shutdown();
    expect(await dbAll('SELECT * FROM queries')).toEqual([{ query: 'elixir', count: 4 }]);
    expect(buffer.getBufferSize()).toBe(0);

    // Timer is stopped: a later add is not flushed automatically
    trie.insert('erlang', 1);
    buffer.add('erlang');
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(await dbAll('SELECT * FROM queries WHERE query = ?', ['erlang'])).toHaveLength(0);
  });
});
