import db, { initDb } from './db';
import { generateDataset } from './dataset';

/**
 * Fills the queries table with a deterministic Zipf-distributed data set
 * (see dataset.ts). Same numQueries and seed -> same rows.
 */
export const runSeeder = async (numQueries = 105000, seed = 42): Promise<void> => {
  console.log(`Initializing database and starting seeder for ${numQueries} entries (seed ${seed})...`);
  await initDb();

  const dataset = generateDataset(numQueries, seed);
  console.log(`Built ${dataset.length} unique queries with Zipf counts.`);

  console.log('Inserting into database via transaction...');
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION');
      
      const stmt = db.prepare('INSERT OR REPLACE INTO queries (query, count) VALUES (?, ?)');
      
      dataset.forEach(({ query, count }) => {
        stmt.run(query, count);
      });
      
      stmt.finalize();
      
      db.run('COMMIT', (err) => {
        if (err) {
          console.error('Failed to commit transaction:', err);
          db.run('ROLLBACK');
          reject(err);
        } else {
          const duration = ((Date.now() - startTime) / 1000).toFixed(2);
          console.log(`Successfully seeded ${dataset.length} queries in ${duration} seconds.`);
          
          // Print sample of top queries
          console.log('\nTop 5 queries by count:');
          dataset.slice(0, 5).forEach((item, i) => {
            console.log(`  Rank ${i + 1}: "${item.query}" (Count: ${item.count})`);
          });
          
          resolve();
        }
      });
    });
  });
};

// If run directly
if (require.main === module) {
  runSeeder(Number(process.env.SEED_TERMS) || 105000)
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error('Seeder execution failed:', err);
      process.exit(1);
    });
}
