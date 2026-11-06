import { createRng } from './rng';
import { normalizeQuery } from './normalize';

// Curated vocabulary of tech, shopping, food and general search words.
// Queries are built by joining 1-3 of these words.
const rawVocabulary = [
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
  'cricket', 'fitness', 'workout', 'diet', 'health', 'travel', 'jobs', 'remote', 'work',
];

// Normalised and de-duplicated ('c++' and 'c#' both become 'c')
export const vocabulary = Array.from(new Set(rawVocabulary.map(normalizeQuery)));

/** Upper bound on distinct 1-3 word queries the vocabulary can produce. */
export const MAX_UNIQUE_QUERIES = vocabulary.length ** 3 + vocabulary.length ** 2 + vocabulary.length;

/**
 * Generates `countNeeded` unique queries by joining 1-3 random vocabulary words.
 * Every single word is included first.
 */
export function generateQueries(countNeeded: number, rng: () => number): string[] {
  if (countNeeded > MAX_UNIQUE_QUERIES * 0.6) {
    // Beyond this, finding unseen combinations by random sampling gets very slow
    throw new Error(`Can generate at most ~${Math.floor(MAX_UNIQUE_QUERIES * 0.6)} unique queries`);
  }
  const querySet = new Set<string>(vocabulary);

  while (querySet.size < countNeeded) {
    const numWords = 1 + Math.floor(rng() * 3);
    const words: string[] = [];
    for (let i = 0; i < numWords; i++) {
      words.push(vocabulary[Math.floor(rng() * vocabulary.length)]);
    }
    querySet.add(words.join(' '));
  }

  return Array.from(querySet).slice(0, countNeeded);
}

/**
 * Assigns counts with Zipf's law: count(rank) = C / rank^s, minimum 1.
 * With C = 1,000,000 and s = 0.9:
 *   rank 1 -> 1,000,000, rank 100 -> 15,848, rank 100,000 -> 31
 * Queries are shuffled first (Fisher-Yates) so popular ones are not all single words.
 */
export function applyZipfDistribution(
  queries: string[],
  rng: () => number,
  C = 1000000,
  s = 0.9
): Array<{ query: string; count: number }> {
  const shuffled = [...queries];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  return shuffled.map((query, index) => ({
    query,
    count: Math.max(1, Math.floor(C / Math.pow(index + 1, s))),
  }));
}

/** Deterministic data set: the same (count, seed) always returns the same queries and counts. */
export function generateDataset(count: number, seed = 42): Array<{ query: string; count: number }> {
  const rng = createRng(seed);
  return applyZipfDistribution(generateQueries(count, rng), rng);
}
