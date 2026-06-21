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
    for (let i = 1; i <= 5; i++) {
      metrics.searchesSubmitted++;
      trie.insert('python', i); // increment trie count
      buffer.add('python');     // mark key as dirty
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
});
