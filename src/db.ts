import sqlite3 from 'sqlite3';

// Connect to in-memory DB during tests to ensure isolation, otherwise typeahead.db local file
const dbPath = process.env.NODE_ENV === 'test' ? ':memory:' : 'typeahead.db';
const db = new sqlite3.Database(dbPath);

/**
 * Promisified wrapper for db.run (for INSERT, UPDATE, CREATE TABLE)
 */
export const dbRun = (sql: string, params: any[] = []): Promise<any> => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this); // 'this' contains lastID and changes
    });
  });
};

/**
 * Promisified wrapper for db.all (for SELECT returning multiple rows)
 */
export const dbAll = (sql: string, params: any[] = []): Promise<any[]> => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

/**
 * Initializes the database tables.
 */
export const initDb = async (): Promise<void> => {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS queries (
      query TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS query_buckets (
      query TEXT,
      hour_timestamp INTEGER,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (query, hour_timestamp)
    )
  `);
};

/**
 * Closes the database connection. Useful for test teardowns.
 */
export const closeDb = (): Promise<void> => {
  return new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
};

export default db;
