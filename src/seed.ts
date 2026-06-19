import db, { initDb } from './db';

// Curated list of 150+ vocabulary words representing tech, shopping, and search terms
const vocabulary = [
  // Tech
  'python', 'javascript', 'react', 'node', 'typescript', 'java', 'golang', 'rust', 'c++', 'c#',
  'api', 'database', 'sql', 'sqlite', 'server', 'aws', 'docker', 'git', 'github', 'viva',
  'hld', 'system', 'design', 'interview', 'tutorial', 'course', 'documentation', 'library',
  'framework', 'compiler', 'bug', 'debugging', 'performance', 'latency', 'cache', 'redis',
  'mongodb', 'postgresql', 'cloud', 'security', 'encryption', 'token', 'auth', 'oauth',
  
  // Shopping & Products
  'iphone', 'samsung', 'charger', 'laptop', 'mouse', 'keyboard', 'monitor', 'headphone',
  'shoe', 'shirt', 'pants', 'bag', 'watch', 'camera', 'phone', 'tv', 'book', 'coffee',
  'cup', 'table', 'chair', 'desk', 'lamp', 'macbook', 'ipad', 'android', 'headphones',
  'speaker', 'cable', 'adapter', 'case', 'glass', 'screen', 'protector', 'battery',
  
  // Actions & Modifiers
  'best', 'cheap', 'fast', 'learn', 'how to', 'buy', 'online', 'free', 'review', 'price',
  'vs', 'alternative', 'guide', 'example', 'code', 'download', 'install', 'setup', 'fix',
  'error', 'latest', 'old', 'new', 'trending', 'top', 'simple', 'advanced', 'easy', 'quick',
  
  // General & Categories
  'weather', 'news', 'google', 'youtube', 'map', 'translate', 'mail', 'game', 'movie',
  'song', 'flight', 'hotel', 'food', 'recipe', 'restaurant', 'sports', 'football',
  'cricket', 'fitness', 'workout', 'diet', 'health', 'travel', 'jobs', 'remote', 'work'
];

/**
 * Generates unique random queries by combining 1 to 3 words from vocabulary.
 */
function generateQueries(countNeeded: number): string[] {
  const querySet = new Set<string>();
  
  // 1. Add all single vocabulary words first
  vocabulary.forEach(word => querySet.add(word));
  
  // 2. Generate multi-word phrases until we meet countNeeded
  while (querySet.size < countNeeded) {
    const numWords = Math.floor(Math.random() * 3) + 1; // 1 to 3 words
    const phraseWords: string[] = [];
    
    for (let i = 0; i < numWords; i++) {
      const randWord = vocabulary[Math.floor(Math.random() * vocabulary.length)];
      phraseWords.push(randWord);
    }
    
    const query = phraseWords.join(' ');
    // Filter out long duplicate queries and empty strings
    if (query.trim()) {
      querySet.add(query.trim());
    }
  }
  
  return Array.from(querySet);
}

/**
 * Assigns counts according to Zipf's Law: Count(rank) = C / (rank ^ s)
 * For s = 0.9 and C = 1,000,000:
 * Rank 1 => 1,000,000
 * Rank 10 => 125,892
 * Rank 100 => 15,848
 * Rank 10,000 => 251
 * Rank 100,000 => 31
 */
function applyZipfDistribution(queries: string[], C = 1000000, s = 0.9): Array<{ query: string; count: number }> {
  // Shuffle queries first so tech terms aren't all clustered at the top
  const shuffled = [...queries].sort(() => Math.random() - 0.5);
  
  return shuffled.map((query, index) => {
    const rank = index + 1;
    const count = Math.max(1, Math.floor(C / Math.pow(rank, s)));
    return { query, count };
  });
}

export const runSeeder = async (numQueries = 105000): Promise<void> => {
  console.log(`Initializing database and starting seeder for ${numQueries} entries...`);
  await initDb();

  console.log('Generating unique queries...');
  const uniqueQueries = generateQueries(numQueries);
  console.log(`Generated ${uniqueQueries.length} unique queries.`);

  console.log('Applying Zipfian distribution counts...');
  const dataset = applyZipfDistribution(uniqueQueries);

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
          console.log('\nTop 5 generated queries:');
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
  runSeeder()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error('Seeder execution failed:', err);
      process.exit(1);
    });
}
