import db from './db';
import { metrics } from './metrics';
import { Trie } from './trie';

/**
 * SearchBuffer implements a Write-Behind Cache pattern.
 * Instead of writing to SQLite synchronously on every user search submission,
 * we update the in-memory Trie immediately so suggestions stay fresh, and mark
 * the search query as "dirty" in a Set.
 *
 * A background worker periodically flushes the aggregated state of all dirty keys
 * into SQLite within a single transaction, reducing write Disk I/O significantly.
 */
export class SearchBuffer {
  private trie: Trie;
  private dirtyKeys: Set<string>;
  private flushIntervalMs: number;
  private maxBufferSize: number;
  private timer: NodeJS.Timeout | null;

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
   * Flushes all aggregated query counts to the database in a single transaction.
   * Clears the dirty buffer set before database processing to avoid race conditions.
   */
  async flush(): Promise<void> {
    if (this.dirtyKeys.size === 0) return;

    // 1. Snapshot and clear the buffer set immediately.
    // This ensures any new requests arriving while DB I/O is executing
    // are safely captured in the next batch rather than overwritten.
    const keysToFlush = Array.from(this.dirtyKeys);
    this.dirtyKeys.clear();

    const startTime = Date.now();
    const currentHour = Math.floor(Date.now() / 3600000) * 3600000;

    console.log(`Flushing batch of ${keysToFlush.length} unique queries to database...`);

    return new Promise<void>((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        const stmtQueries = db.prepare('INSERT OR REPLACE INTO queries (query, count) VALUES (?, ?)');
        const stmtBuckets = db.prepare('INSERT OR REPLACE INTO query_buckets (query, hour_timestamp, count) VALUES (?, ?, ?)');

        keysToFlush.forEach(query => {
          // Read current aggregated metrics directly from the in-memory Trie
          const allTimeCount = this.trie.getCount(query);
          const recentCounts = this.trie.getRecentCounts(query);
          const hourCount = recentCounts.get(currentHour) || 0;

          // Record database writes
          metrics.dbWrites += 2; // Incremented for both queries and query_buckets upserts
          
          stmtQueries.run(query, allTimeCount);
          stmtBuckets.run(query, currentHour, hourCount);
        });

        stmtQueries.finalize();
        stmtBuckets.finalize();

        db.run('COMMIT', (err) => {
          if (err) {
            console.error('Batch write commit failed, rolling back:', err);
            db.run('ROLLBACK');
            reject(err);
          } else {
            const duration = Date.now() - startTime;
            console.log(`Batch write completed: flushed ${keysToFlush.length} items in ${duration}ms.`);
            resolve();
          }
        });
      });
    });
  }

  /**
   * Utility to check the size of the current buffer.
   */
  getBufferSize(): number {
    return this.dirtyKeys.size;
  }
}
