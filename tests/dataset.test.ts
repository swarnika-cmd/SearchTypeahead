import { generateDataset, vocabulary } from '../src/dataset';
import { normalizeQuery } from '../src/normalize';

describe('Seed data set', () => {
  test('same size and seed give exactly the same queries and counts', () => {
    expect(generateDataset(2000, 7)).toEqual(generateDataset(2000, 7));
    expect(generateDataset(2000, 7)).not.toEqual(generateDataset(2000, 8));
  });

  test('queries are unique, already normalised, and counts follow Zipf', () => {
    const data = generateDataset(5000);
    expect(data).toHaveLength(5000);
    expect(new Set(data.map(d => d.query)).size).toBe(5000);
    data.forEach(d => expect(normalizeQuery(d.query)).toBe(d.query));

    expect(data[0].count).toBe(1000000);
    for (let i = 1; i < data.length; i++) {
      expect(data[i].count).toBeLessThanOrEqual(data[i - 1].count);
    }
  });

  test('vocabulary has no punctuation left', () => {
    vocabulary.forEach(word => expect(word).toMatch(/^[a-z0-9 ]+$/));
  });
});
