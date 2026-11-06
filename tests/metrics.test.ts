import { MetricsTracker } from '../src/metrics';

describe('MetricsTracker', () => {
  test('totalRequests counts every request, not only the kept latency samples', () => {
    const m = new MetricsTracker();
    for (let i = 0; i < 12000; i++) m.recordLatency(1);
    expect(m.getSnapshot().totalRequests).toBe(12000);
  });

  test('p95 is computed over the most recent 10,000 samples', () => {
    const m = new MetricsTracker();
    for (let i = 0; i < 10000; i++) m.recordLatency(100); // old, slow
    for (let i = 0; i < 10000; i++) m.recordLatency(1);   // recent, fast
    expect(m.getP95Latency()).toBe(1);
  });

  test('cache hit rate is a percentage of all lookups', () => {
    const m = new MetricsTracker();
    m.cacheHits = 3;
    m.cacheMisses = 1;
    expect(m.getCacheHitRate()).toBe(75);
  });
});
