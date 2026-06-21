import { useState, useEffect, useCallback, useRef } from 'react';
import { debounce } from './utils/debounce';

interface Suggestion {
  query: string;
  count: number;
  score?: number;
}

interface Metrics {
  p95LatencyMs: number;
  cacheHitRatePercent: number;
  cacheHits: number;
  cacheMisses: number;
  dbReads: number;
  dbWrites: number;
  totalRequests: number;
}

export default function App() {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [trending, setTrending] = useState<Suggestion[]>([]);
  const [mode, setMode] = useState<'trending' | 'basic'>('trending');
  const [metrics, setMetrics] = useState<Metrics>({
    p95LatencyMs: 0,
    cacheHitRatePercent: 0,
    cacheHits: 0,
    cacheMisses: 0,
    dbReads: 0,
    dbWrites: 0,
    totalRequests: 0,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [showDropdown, setShowDropdown] = useState(false);
  const [searchMessage, setSearchMessage] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  // Poll metrics from backend
  const fetchMetrics = async () => {
    try {
      const res = await fetch('/api/metrics');
      if (res.ok) {
        const data = await res.json();
        setMetrics(data);
      }
    } catch (err) {
      console.error('Failed to fetch metrics:', err);
    }
  };

  // Fetch trending (overall top queries) based on active mode
  const fetchTrending = async (activeMode: 'basic' | 'trending') => {
    try {
      const res = await fetch(`/suggest?q=&mode=${activeMode}`);
      if (res.ok) {
        const data = await res.json();
        setTrending(data.suggestions || []);
      }
    } catch (err) {
      console.error('Failed to fetch trending:', err);
    }
  };

  // Trigger loading at start
  useEffect(() => {
    fetchTrending(mode);
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 1000);
    return () => clearInterval(interval);
  }, []);

  // Reload suggestions and trending whenever algorithm mode changes
  useEffect(() => {
    fetchTrending(mode);
    if (query.trim()) {
      getSuggestionsApi(query, mode);
    }
  }, [mode]);

  // Debounced API call for suggestions, taking activeMode parameter to prevent stale closures
  const getSuggestionsApi = useCallback(
    debounce(async (val: string, activeMode: 'basic' | 'trending') => {
      if (!val.trim()) {
        setSuggestions([]);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/suggest?q=${encodeURIComponent(val)}&mode=${activeMode}`);
        if (!res.ok) throw new Error('Network error fetching suggestions');
        const data = await res.json();
        setSuggestions(data.suggestions || []);
        setSelectedIndex(-1);
      } catch (err: any) {
        setError(err.message || 'Error occurred');
      } finally {
        setLoading(false);
      }
    }, 200),
    []
  );

  // Handle typing changes
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setQuery(val);
    setShowDropdown(true);
    getSuggestionsApi(val, mode);
  };

  // Trigger search submission (POST /search)
  const submitSearch = async (searchQuery: string) => {
    const trimmed = searchQuery.trim();
    if (!trimmed) return;
    
    setShowDropdown(false);
    setSearchMessage(`Searching for "${trimmed}"...`);
    
    try {
      const res = await fetch('/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: trimmed }),
      });
      
      if (res.ok) {
        const data = await res.json();
        setSearchMessage(`${data.message}: "${trimmed}"`);
        // Refresh trending and metrics
        fetchTrending(mode);
        fetchMetrics();
      } else {
        setSearchMessage('Search submission failed');
      }
    } catch (err) {
      console.error('Failed to submit search:', err);
      setSearchMessage('Network error submitting search');
    }
  };

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showDropdown || suggestions.length === 0) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(prev => (prev < suggestions.length - 1 ? prev + 1 : 0));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(prev => (prev > 0 ? prev - 1 : suggestions.length - 1));
        break;
      case 'Enter':
        e.preventDefault();
        if (selectedIndex >= 0 && selectedIndex < suggestions.length) {
          const selected = suggestions[selectedIndex].query;
          setQuery(selected);
          submitSearch(selected);
        } else {
          submitSearch(query);
        }
        break;
      case 'Escape':
        setShowDropdown(false);
        break;
      default:
        break;
    }
  };

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col items-center p-6 md:p-12 selection:bg-cyan-500 selection:text-slate-900">
      
      {/* Header */}
      <header className="w-full max-w-6xl mb-12 text-center md:text-left">
        <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight bg-gradient-to-r from-cyan-400 via-teal-400 to-indigo-400 bg-clip-text text-transparent drop-shadow-md">
          AURA SEARCH
        </h1>
        <p className="mt-2 text-sm md:text-base text-slate-400 font-medium">
          Distributed Autocomplete & Real-Time Performance Analytics Dashboard
        </p>
      </header>

      {/* Main Grid Layout */}
      <main className="w-full max-w-6xl grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        
        {/* Left Side: Search Panel */}
        <section className="lg:col-span-7 flex flex-col gap-6 w-full">
          
          {/* Search Box Glass Card */}
          <div ref={containerRef} className="relative z-20 bg-slate-900/60 backdrop-blur-xl border border-slate-800 p-6 rounded-2xl shadow-xl flex flex-col gap-3">
            
            <div className="flex justify-between items-center mb-1">
              <h2 className="text-lg font-bold text-slate-200 font-sans">Search Interface</h2>
              
              {/* Algorithm Switcher Segment Control */}
              <div className="flex bg-slate-950/80 p-0.5 rounded-lg border border-slate-850">
                <button
                  onClick={() => setMode('trending')}
                  className={`px-3 py-1 rounded-md text-[10px] font-bold tracking-wider uppercase transition-all ${
                    mode === 'trending'
                      ? 'bg-gradient-to-r from-cyan-500 to-teal-500 text-slate-950 shadow'
                      : 'text-slate-400 hover:text-slate-250'
                  }`}
                >
                  Trending
                </button>
                <button
                  onClick={() => setMode('basic')}
                  className={`px-3 py-1 rounded-md text-[10px] font-bold tracking-wider uppercase transition-all ${
                    mode === 'basic'
                      ? 'bg-slate-800 text-slate-250 shadow'
                      : 'text-slate-400 hover:text-slate-250'
                  }`}
                >
                  All-time
                </button>
              </div>
            </div>

            <div className="relative">
              {/* Search Icon */}
              <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-slate-400">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-5 h-5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.602 10.602Z" />
                </svg>
              </div>

              {/* Input */}
              <input
                type="text"
                value={query}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onFocus={() => setShowDropdown(true)}
                placeholder="Type your search query..."
                className="w-full pl-12 pr-4 py-3 bg-slate-950/80 border border-slate-800 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 rounded-xl outline-none transition-all text-slate-100 placeholder-slate-500 font-medium text-lg font-sans"
              />

              {/* Suggestions Dropdown */}
              {showDropdown && (query || suggestions.length > 0) && (
                <div className="absolute left-0 right-0 mt-2 bg-slate-950/95 backdrop-blur-md border border-slate-800 rounded-xl shadow-2xl overflow-hidden z-50">
                  {loading && suggestions.length === 0 ? (
                    <div className="px-4 py-3 text-slate-400 flex items-center gap-2">
                      <div className="w-4 h-4 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin"></div>
                      <span>Loading suggestions...</span>
                    </div>
                  ) : error ? (
                    <div className="px-4 py-3 text-rose-400 font-medium">{error}</div>
                  ) : suggestions.length === 0 ? (
                    <div className="px-4 py-3 text-slate-500">No suggestions match "{query}"</div>
                  ) : (
                    <ul>
                      {suggestions.map((item, index) => (
                        <li
                          key={index}
                          onClick={() => {
                            setQuery(item.query);
                            submitSearch(item.query);
                          }}
                          onMouseEnter={() => setSelectedIndex(index)}
                          className={`px-4 py-3 cursor-pointer flex justify-between items-center transition-all ${
                            index === selectedIndex
                              ? 'bg-slate-850 text-cyan-400 font-semibold font-sans'
                              : 'text-slate-300 font-sans'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span className={index === selectedIndex ? 'text-cyan-400' : 'text-slate-500'}>
                              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-4 h-4">
                                <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.602 10.602Z" />
                              </svg>
                            </span>
                            <span>{item.query}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            {mode === 'trending' && item.score !== undefined && (
                              <span className="text-[10px] text-teal-400 font-mono bg-teal-950/40 border border-teal-900/60 px-2 py-0.5 rounded-full">
                                Score: {item.score.toFixed(1)}
                              </span>
                            )}
                            <span className="text-xs text-slate-500 font-mono bg-slate-900 border border-slate-800 px-2 py-0.5 rounded-full">
                              Count: {item.count.toLocaleString()}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
            <div className="text-xs text-slate-500 flex justify-between px-1">
              <span>Use <kbd className="bg-slate-950 px-1 rounded border border-slate-800 font-mono">↑</kbd> <kbd className="bg-slate-950 px-1 rounded border border-slate-800 font-mono">↓</kbd> to navigate</span>
              <span>Press <kbd className="bg-slate-950 px-1 rounded border border-slate-800 font-mono">Enter</kbd> to search</span>
            </div>
          </div>

          {/* Search Submission Response */}
          {searchMessage && (
            <div className="bg-slate-900/40 border border-slate-800/80 px-6 py-4 rounded-xl flex items-center gap-3 animate-fade-in shadow-md">
              <span className="flex-shrink-0 text-cyan-400 bg-cyan-950/50 p-2 rounded-lg">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-5 h-5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                </svg>
              </span>
              <span className="text-sm font-semibold text-slate-300 font-sans">{searchMessage}</span>
            </div>
          )}

          {/* Trending Panel */}
          <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800 p-6 rounded-2xl shadow-xl flex flex-col gap-4">
            <h3 className="text-lg font-bold text-slate-200 flex items-center gap-2 font-sans">
              <span className="text-orange-400 animate-pulse">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
                  <path fillRule="evenodd" d="M12.963 2.285a.75.75 0 0 0-1.071-.165 8.625 8.625 0 0 1-1.916 1.139 7.62 7.62 0 0 0-1.92 1.417 9.751 9.751 0 0 0-2.14 4.084 7.75 7.75 0 0 0-.07 2.137 3.75 3.75 0 0 0 .507 1.228 9.74 9.74 0 0 0 2.657-1.086 1.2 1.2 0 0 1 1.552 1.8c-.5.413-1.064.756-1.688 1.025a3.75 3.75 0 0 0 2.631 3.58 3.9 3.9 0 0 0 3.7-1.009 3.75 3.75 0 0 0 .957-2.909 10.002 10.002 0 0 1-.16-1.517 7.62 7.62 0 0 1 1.15-4.507 8.761 8.761 0 0 1 1.838-2.051.75.75 0 0 0-.111-1.288 8.614 8.614 0 0 0-2.383-.846 9.725 9.725 0 0 1-1.196-1.835 7.56 7.56 0 0 0-1.886-2.287Z" clipRule="evenodd" />
                </svg>
              </span>
              <span>{mode === 'trending' ? 'Trending Right Now' : 'Most Popular All-time'}</span>
            </h3>
            {trending.length === 0 ? (
              <div className="text-slate-500 text-sm">No trending search data.</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {trending.slice(0, 8).map((item, index) => (
                  <button
                    key={index}
                    onClick={() => {
                      setQuery(item.query);
                      submitSearch(item.query);
                    }}
                    className="px-4 py-2 bg-slate-950 hover:bg-slate-800 text-slate-350 hover:text-cyan-400 border border-slate-800 rounded-xl transition-all text-sm font-semibold flex items-center gap-2 shadow font-sans"
                  >
                    <span>{item.query}</span>
                    <span className="text-[10px] text-slate-500 bg-slate-900 border border-slate-800 px-1.5 py-0.2 rounded-full">
                      {mode === 'trending' && item.score !== undefined
                        ? `Score: ${item.score.toFixed(0)}`
                        : item.count >= 1000 ? `${(item.count / 1000).toFixed(0)}k` : item.count}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Right Side: Performance Dashboard */}
        <section className="lg:col-span-5 flex flex-col gap-6 w-full">
          <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800 p-6 rounded-2xl shadow-xl flex flex-col gap-6">
            <div className="flex justify-between items-center border-b border-slate-800 pb-4">
              <h2 className="text-lg font-bold text-slate-200 font-sans">System Analytics</h2>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-950/50 text-emerald-400 border border-emerald-800">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping"></span>
                Live
              </span>
            </div>

            {/* Gauge for Latency */}
            <div className="flex flex-col gap-2">
              <div className="flex justify-between text-sm font-sans">
                <span className="text-slate-400 font-medium">Suggestion API Latency (p95)</span>
                <span className={`font-mono font-bold ${
                  metrics.p95LatencyMs < 5 ? 'text-emerald-400' : metrics.p95LatencyMs < 20 ? 'text-amber-400' : 'text-rose-400'
                }`}>
                  {metrics.p95LatencyMs.toFixed(2)} ms
                </span>
              </div>
              <div className="w-full bg-slate-950 rounded-full h-2 overflow-hidden border border-slate-850">
                <div
                  className={`h-full transition-all duration-500 ${
                    metrics.p95LatencyMs < 5 ? 'bg-emerald-400' : metrics.p95LatencyMs < 20 ? 'bg-amber-400' : 'bg-rose-400'
                  }`}
                  style={{ width: `${Math.min(100, (metrics.p95LatencyMs / 50) * 100)}%` }}
                ></div>
              </div>
              <span className="text-[10px] text-slate-500 font-sans">Benchmark target: &lt; 10ms for search auto-suggest.</span>
            </div>

            {/* Progress bar for Cache Hit Rate */}
            <div className="flex flex-col gap-2">
              <div className="flex justify-between text-sm font-sans">
                <span className="text-slate-400 font-medium">Cache Hit Rate</span>
                <span className="text-cyan-400 font-mono font-bold">
                  {metrics.cacheHitRatePercent.toFixed(1)}%
                </span>
              </div>
              <div className="w-full bg-slate-950 rounded-full h-3.5 overflow-hidden border border-slate-850 p-[2px]">
                <div
                  className="bg-gradient-to-r from-indigo-500 to-cyan-500 h-full rounded-full transition-all duration-500"
                  style={{ width: `${metrics.cacheHitRatePercent}%` }}
                ></div>
              </div>
            </div>

            {/* Metrics Counters Table */}
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-slate-950 border border-slate-850 p-4 rounded-xl shadow-inner flex flex-col gap-1">
                <span className="text-xs text-slate-500 font-medium uppercase tracking-wider font-sans">Cache Hits</span>
                <span className="text-2xl font-bold font-mono text-emerald-400">{metrics.cacheHits.toLocaleString()}</span>
              </div>
              <div className="bg-slate-950 border border-slate-850 p-4 rounded-xl shadow-inner flex flex-col gap-1">
                <span className="text-xs text-slate-500 font-medium uppercase tracking-wider font-sans">Cache Misses</span>
                <span className="text-2xl font-bold font-mono text-indigo-400">{metrics.cacheMisses.toLocaleString()}</span>
              </div>
              <div className="bg-slate-950 border border-slate-850 p-4 rounded-xl shadow-inner flex flex-col gap-1 col-span-2">
                <span className="text-xs text-slate-500 font-medium uppercase tracking-wider font-sans">Total Suggestions Served</span>
                <span className="text-2xl font-bold font-mono text-slate-200">{metrics.totalRequests.toLocaleString()}</span>
              </div>
            </div>

            {/* DB Reads and Writes */}
            <div className="border-t border-slate-850 pt-4 flex flex-col gap-3 font-sans">
              <h4 className="text-sm font-bold text-slate-400 uppercase tracking-wider">SQLite Database Load</h4>
              <div className="flex justify-between text-sm">
                <span className="text-slate-400">Database Reads (Sync)</span>
                <span className="font-mono text-slate-200 font-bold">{metrics.dbReads}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-slate-400">Database Writes (Flush)</span>
                <span className="font-mono text-slate-200 font-bold">{metrics.dbWrites}</span>
              </div>
            </div>
            
          </div>
        </section>

      </main>
    </div>
  );
}
