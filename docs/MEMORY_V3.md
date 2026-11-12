# V3: radix trie to cut trie memory

## Problem

The trie stores one node per character, and every node carries a 37-slot child array
(`src/trie-array.ts`, class `ArrayTrie`). Committed baseline, from `bench/results/trie-bench-full.json`
(Apple M4 Pro, Docker Desktop, Node 20.20.2, `--cpus=2`, 2026-11-06):

| Terms | Trie nodes | Heap after build | Bytes per term | Build | Lookup p99 |
|---:|---:|---:|---:|---:|---:|
| 100,000 | 558,714 | 531.9 MiB | 5,578 | 2,475 ms | 2.75 us |
| 1,000,000 | 4,850,630 | 4,394 MiB | 4,607 | 132,258 ms | 35.04 us |

The JSON field is called `heapMB`, but the code divides bytes by 1024 x 1024, so the unit is MiB.
Heap divided by nodes is 998 bytes per node at 100k terms and 950 at 1M. A 1M-term trie needs 4,394 MiB,
which is why the benchmark needs a 6 GB Node heap. The hourly `refreshScores()` rebuild re-inserts every term.

The baseline harness had a small bias: the generated data set was reachable when the heap was measured
before the build but collectable when it was measured after, so the data set's size was subtracted from the
trie's heap. `bench/trie-bench.ts` now keeps it reachable. The array rows of `bench/results/trie-bench-v3.json`
come from the fixed harness and supersede the baseline figures above for the array-versus-radix comparison.

Most nodes sit on single-child chains. The 37-slot array is paid on every one of them, although a node
on a chain has one child.

## Design

Implemented in `src/trie-radix.ts` (class `RadixTrie`). The methods of `Trie` are unchanged; `root` is now
opaque (typed `object`).

- **Path compression.** A node stores the edge label that leads to it (a string), not one character.
  A chain of single-child nodes becomes one node. Nodes remain only where a query ends or where two
  queries diverge, so there are at most about 2 x terms nodes.
- **Sorted child arrays.** `children` is `null` on a leaf, otherwise a small array sorted by the first
  character of each child's label (at most 37 entries, binary search). It is always rebuilt at exact size.
- **Top-K on every node.** Both lists (basic and trending), same semantics as before: top 10, same
  comparators, same tie-break on query text. A prefix that ends in the middle of an edge uses the list
  of the node at the end of that edge. That is correct because every stored query under that point
  passes through that node. A split creates the new middle node with the child's lists, because the set
  of queries underneath is identical.
- **`recentCounts`** stays `null` except on nodes where a query ends.
- **Shared entries.** Each stored query has one `{query, count, score}` object, referenced from every list
  on its path in both modes, and updated in place. In the array trie each of those lists holds its own copy.
  Lists are copy-on-write (a change builds a new exact-size array), so a split can share the child's lists
  and a node with one entry uses one array for both modes. This sharing is a saving separate from path
  compression; the estimate below shows both.
- **Selecting the implementation.** `TRIE_IMPL=radix` (default) or `TRIE_IMPL=array` picks what `Trie`
  is. Both classes are also exported, so `bench/trie-bench.ts` runs both in one invocation, each in its
  own process.

Not changed: lookup is still a walk of the prefix and a copy of one stored list. The insert path still
touches every node on the path, now fewer of them.

## Estimate: bytes per node

Method: unit costs measured on this Node build with `bench/v8-unit-costs.ts` (no trie involved; output in
`bench/results/v8-unit-costs.json`, which varies by 1 to 2 bytes between runs), applied to structure counts
from `bench/trie-shape.ts` (counts only, no timing; output in `bench/results/trie-shape.json`).

Assumptions about V8 as shipped in the `node:20` image:

- **No pointer compression.** Node's official builds do not enable it, so every tagged field and array
  slot is 8 bytes (measured: an empty array is 32 bytes = map, properties, elements, length).
- Object header is 24 bytes (map, properties, elements) plus 8 per field. A class instance with 6 fields
  is 72 bytes (136 with its two empty arrays, measured).
- Array: 32-byte `JSArray` plus a backing store of 16 + 8 x capacity bytes. `push` on an empty array
  grows the capacity to 17 (measured: 183 bytes for a one-element array built with `push`). An array of
  37 slots is 344 bytes (measured 343.6). An exact-size array of n elements is 48 + 8n (measured: 64 for two).
- `{query, count}` is 40 bytes (measured). `{query, count, score}` is 64 bytes (measured 62.7 to 64):
  the `score` double is a separate 16-byte boxed number.
- Strings: measured 24 bytes for a copied 6-character label and 32 bytes for a copied 12-character one
  (16-byte header plus one byte per character, rounded up to 8). Single-character strings are shared, so
  a one-character label costs nothing. Labels of 13 or more characters are sliced strings (32 bytes) that
  point into the full query, which the query's entry keeps alive anyway. The estimate charges 24 bytes for
  every label, which is too high for one-character labels and too low for labels of 9 or more characters.
- An empty `Map` is 182.6 bytes (`v8-unit-costs.json`). The benchmark inserts every term with a default empty
  map, and both tries keep it, so it is a fixed cost per term in both columns.
- The query string itself is not counted: in the benchmark it is the same string object as the data set
  entry, which stays reachable through the measurement.

### Old trie (per node, 100k terms)

| Part | Bytes |
|---|---:|
| Node object (header + 6 fields) | 72 |
| 37-slot child array | 344 |
| Two list arrays (grown by `push`, capacity 17) | 368 |
| List entries: 1.857 slots per list per node x (40 + 64) | 193 |
| Estimated per node | 977 |

The 100k data set has 558,714 nodes and 1,037,766 list slots per list (`trie-shape.json`).
977 x 558,714 bytes = 520.6 MiB, plus 100,000 empty maps (17.4 MiB) = 538.0 MiB. The committed baseline
measured 531.9 MiB, so the estimate is 1.1% above it.

### Radix trie (100k terms)

`trie-shape.json` gives 131,876 nodes (82,102 leaves, 49,774 with children), 352,638 list slots per
list, average label length 4.24 characters.

| Part | Bytes |
|---|---:|
| Node objects, 131,876 x 72 | 9,495,072 |
| Labels, 131,875 x 24 | 3,165,000 |
| Child arrays: 49,774 x 48 + 131,875 slots x 8 | 3,444,152 |
| List arrays: 82,102 one-entry nodes x 56, plus 49,774 nodes x 2 lists x 48, plus 8 x 2 x 270,536 slots | 13,704,592 |
| Shared entries, 100,000 x 64 | 6,400,000 |
| Empty maps, 100,000 x 182.6 | 18,260,000 |
| Estimated total | 54,468,816 = 51.9 MiB |

That is 413 bytes per node or 545 bytes per term. Without the entry sharing (one entry per list slot, as in the
array trie) the entries would cost 352,638 x 104 = 36,674,352 bytes instead of 6,400,000, giving 84,743,168
bytes = 80.8 MiB.

### Expected reduction

| | Old | Radix, shared entries | Radix, per-list entries |
|---|---:|---:|---:|
| Nodes, 100k terms | 558,714 | 131,876 (4.24x fewer) | 131,876 |
| Heap, 100k terms (estimate) | 538.0 MiB | 51.9 MiB | 80.8 MiB |
| Heap ratio | | 10.4x | 6.7x |

Node count at 1M terms (`trie-shape.json`, `nodeCounts`): 4,850,630 for the array trie (equal to the
committed baseline) and 1,396,994 for the radix trie, 3.47x fewer. The reduction shrinks with size
(5.25x at 10k, 4.24x at 100k, 3.47x at 1M).

Extrapolation to 1M terms, an estimate made before the 1M run, in two ways:

- per term: 544.7 bytes x 1,000,000 = 519 MiB
- per node: 413.0 bytes x 1,396,994 = 550 MiB

So the estimate is 519 to 550 MiB, against 4,394 MiB for the old trie in the baseline. Neither figure is a
measurement.

The estimate does not cover lookup latency. Each step of a lookup now does a binary search over a
sorted child array and a label comparison instead of one array index, but visits fewer nodes.
That has to be measured.

### Where the memory goes after this change

The empty `Map` per term (182.6 bytes, a third of the radix total) is now the largest single item.
Allocating `recentCounts` lazily would remove it for queries that were never searched this or last hour,
but `getRecentCounts()` returns the stored map and `POST /search` mutates it before re-inserting, so
that changes the behaviour of `Trie` and is out of scope here.
