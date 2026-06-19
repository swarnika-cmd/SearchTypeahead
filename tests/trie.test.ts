import { Trie } from '../src/trie';

describe('Trie Prefix Suggestion System', () => {
  let trie: Trie;

  beforeEach(() => {
    trie = new Trie();
  });

  test('should insert and retrieve a direct matching query', () => {
    trie.insert('apple', 10);
    const suggestions = trie.getSuggestions('apple');
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].query).toBe('apple');
    expect(suggestions[0].count).toBe(10);
  });

  test('should suggest prefix matches sorted by count descending', () => {
    trie.insert('apple', 10);
    trie.insert('apricot', 50);
    trie.insert('application', 30);
    trie.insert('banana', 100);

    const suggestions = trie.getSuggestions('ap');
    expect(suggestions).toHaveLength(3);
    expect(suggestions[0].query).toBe('apricot');
    expect(suggestions[1].query).toBe('application');
    expect(suggestions[2].query).toBe('apple');
  });

  test('should limit suggestions to top 10', () => {
    // Insert 12 matches for prefix 'test'
    for (let i = 1; i <= 12; i++) {
      trie.insert(`test${i}`, i * 10);
    }

    const suggestions = trie.getSuggestions('test');
    expect(suggestions).toHaveLength(10);
    // The top one should be test12 (count 120), lowest should be test3 (count 30). test1 and test2 should be excluded.
    expect(suggestions[0].query).toBe('test12');
    expect(suggestions[9].query).toBe('test3');
  });

  test('should handle empty or missing prefix by returning top queries overall', () => {
    trie.insert('apple', 10);
    trie.insert('banana', 20);

    const suggestions = trie.getSuggestions('');
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0].query).toBe('banana');
  });

  test('should be case insensitive and handle spacing', () => {
    trie.insert('iPhone 15', 500);
    trie.insert('iphone charger', 200);

    const suggestions = trie.getSuggestions('IPHONE');
    expect(suggestions).toHaveLength(2);
    expect(suggestions[0].query).toBe('iphone 15');
    expect(suggestions[1].query).toBe('iphone charger');
  });

  test('should sanitize punctuation characters to spaces', () => {
    trie.insert('c++ tutorial', 80);
    trie.insert('c# developer', 90);

    // Both should be routed since '+' and '#' map to space
    const suggestions = trie.getSuggestions('c');
    expect(suggestions).toHaveLength(2);
    // Since 'c++ tutorial' maps to 'c   tutorial' and 'c# developer' to 'c  developer'
    expect(suggestions[0].query).toBe('c# developer');
    expect(suggestions[1].query).toBe('c++ tutorial');
  });

  test('should perform stable lexicographical sorting when counts are equal', () => {
    trie.insert('apricot', 50);
    trie.insert('apple', 50);

    const suggestions = trie.getSuggestions('ap');
    expect(suggestions).toHaveLength(2);
    // 'apple' comes before 'apricot' lexicographically
    expect(suggestions[0].query).toBe('apple');
    expect(suggestions[1].query).toBe('apricot');
  });

  test('should return correct query counts using getCount', () => {
    expect(trie.getCount('apple')).toBe(0);
    trie.insert('apple', 15);
    expect(trie.getCount('apple')).toBe(15);
    expect(trie.getCount('apricot')).toBe(0);
  });

  test('should sort by decayed score in trending mode and all-time in basic mode', () => {
    const currentHour = Math.floor(Date.now() / 3600000) * 3600000;
    
    // Apple: 10000 all-time, 0 recent. Score = 10000 * 0.05 = 500
    trie.insert('apple', 10000);
    
    // Apricot: 10 all-time, but 60 searches in current hour. Score = 60 * 10 + 10 * 0.05 = 600.5
    const apricotRecent = new Map<number, number>([[currentHour, 60]]);
    trie.insert('apricot', 10, apricotRecent);

    // Basic mode: apple wins (10000 > 10)
    const basic = trie.getSuggestions('ap', 'basic');
    expect(basic[0].query).toBe('apple');

    // Trending mode: apricot wins (600.5 > 500)
    const trending = trie.getSuggestions('ap', 'trending');
    expect(trending[0].query).toBe('apricot');
  });
});
