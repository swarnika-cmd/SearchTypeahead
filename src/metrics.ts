class MetricsTracker {
  private latencies: number[] = [];
  public cacheHits = 0;
  public cacheMisses = 0;
  public dbReads = 0;
  public dbWrites = 0;
  public searchesSubmitted = 0;

  /**
   * Records a latency measurement in milliseconds.
   */
  recordLatency(ms: number): void {
    this.latencies.push(ms);
    // Limit array size to prevent memory leaks in production-like tests
    if (this.latencies.length > 10000) {
      this.latencies.shift();
    }
  }

  /**
   * Computes the 95th percentile (p95) latency of recorded suggestion requests.
   */
  getP95Latency(): number {
    if (this.latencies.length === 0) return 0;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const index = Math.floor(sorted.length * 0.95);
    return parseFloat(sorted[index].toFixed(2));
  }

  /**
   * Calculates the cache hit rate as a percentage.
   */
  getCacheHitRate(): number {
    const total = this.cacheHits + this.cacheMisses;
    return total === 0 ? 0 : parseFloat(((this.cacheHits / total) * 100).toFixed(2));
  }

  /**
   * Returns a snapshot of all tracked metrics.
   */
  getSnapshot() {
    return {
      p95LatencyMs: this.getP95Latency(),
      cacheHitRatePercent: this.getCacheHitRate(),
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      dbReads: this.dbReads,
      dbWrites: this.dbWrites,
      searchesSubmitted: this.searchesSubmitted,
      totalRequests: this.latencies.length,
    };
  }
}

export const metrics = new MetricsTracker();
export default metrics;
