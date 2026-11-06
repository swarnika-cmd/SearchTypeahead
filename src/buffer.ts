import { dbRun } from './db';
import { metrics } from './metrics';
import { Trie } from './trie';

/**
 * SearchBuffer implements a Write-Behind Cache pattern.
 * Instead of writing to SQLite synchronously on every user search submission,
 * we update the in-memory Trie immediately so suggestions stay fresh, and mark
 * the search query as "dirty" in a Set.
 *
 * A background timer flushes the aggregated state of all dirty keys into SQLite
 * within a single transaction, either every `flushIntervalMs` or as soon as
 * `maxBufferSize` unique queries are waiting. 1,000 searches for the same query
 * between two flushes become one row write.
 *
 * Durability window: if the process is killed (crash, SIGKILL) everything added
 * since the last successful flush is lost. On SIGTERM/SIGINT the server calls
 * shutdown(), which flushes first.
 */
export class SearchBuffer {
  private trie: Trie;
  private dirtyKeys: Set<string>;
  private flushIntervalMs: number;
  private maxBufferSize: number;
  private timer: NodeJS.Timeout | null;
  private flushing: Promise<void> | null = null; // the flush currently writing, if any

  constructor(trie: Trie, flushIntervalMs = 5000, maxBufferSize = 50) {
    this.trie = trie;
    this.dirtyKeys = new Set();
    this.flushIntervalMs = flushIntervalMs;
    this.maxBufferSize = maxBufferSize;
    this.timer = null;
  }

  /**
   * Starts the background periodic flush timer.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.flush().catch(err => console.error('Periodic flush failed:', err));
    }, this.flushIntervalMs);
  }

  /**
   * Stops the background flush timer.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Adds a query to the dirty key set.
   * Flushes immediately if the unique items threshold is reached.
   */
  add(query: string): void {
    this.dirtyKeys.add(query);
    if (this.dirtyKeys.size >= this.maxBufferSize) {
      this.flush().catch(err => console.error('Size-triggered flush failed:', err));
    }
  }

  /**
   * Stops the timer and writes everything still buffered.
   * Call this on graceful shutdown (SIGTERM / SIGINT) so no searches are lost.
   */
  async shutdown(): Promise<void> {
    this.stop();
    await this.flush();
  }

  /**
   * Flushes all aggregated query counts to the database in a single transaction.
   *
   * Only one flush writes at a time: SQLite cannot nest transactions on one
   * connection, so a second caller waits for the running flush, then writes
   * whatever is left. If the write fails, the transaction is rolled back and the
   * keys go back into the buffer so the next flush retries them.
   */
  async flush(): Promise<void> {
    // Wait for any flush that is already writing
    while (this.flushing) {
      await this.flushing.catch(() => {});
    }
    if (this.dirtyKeys.size === 0) return;

    // Snapshot and clear the buffer. Searches that arrive while we are writing
    // go into the fresh set and are written by the next flush.
    const keysToFlush = Array.from(this.dirtyKeys);
    this.dirtyKeys.clear();

    this.flushing = this.writeBatch(keysToFlush);
    try {
      await this.flushing;
    } catch (err) {
      // Put the keys back so they are retried. The trie still holds their
      // latest counts, so nothing is double counted.
      keysToFlush.forEach(key => this.dirtyKeys.add(key));
      throw err;
    } finally {
      this.flushing = null;
    }
  }

  /**
   * Writes the current trie counts for `keys` inside one transaction.
   * For each query: one upsert of the all-time count, and one upsert per hourly
   * bucket the trie holds (at most this hour and the previous one). Writing the
   * previous hour too matters when a search at 10:59 is flushed at 11:00.
   */
  private async writeBatch(keys: string[]): Promise<void> {
    const startTime = Date.now();
    await dbRun('BEGIN TRANSACTION');
    try {
      for (const query of keys) {
        // Read current aggregated values directly from the in-memory Trie
        await dbRun('INSERT OR REPLACE INTO queries (query, count) VALUES (?, ?)', [
          query,
          this.trie.getCount(query),
        ]);
        metrics.dbWrites++;

        for (const [hour, count] of this.trie.getRecentCounts(query)) {
          await dbRun(
            'INSERT OR REPLACE INTO query_buckets (query, hour_timestamp, count) VALUES (?, ?, ?)',
            [query, hour, count]
          );
          metrics.dbWrites++;
        }
      }
      await dbRun('COMMIT');
    } catch (err) {
      console.error('Batch write failed, rolling back:', err);
      await dbRun('ROLLBACK').catch(() => {});
      throw err;
    }
    if (process.env.NODE_ENV !== 'test') {
      console.log(`Flushed ${keys.length} queries in ${Date.now() - startTime}ms.`);
    }
  }

  /**
   * Utility to check the size of the current buffer.
   */
  getBufferSize(): number {
    return this.dirtyKeys.size;
  }
}
