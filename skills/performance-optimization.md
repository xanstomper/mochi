---
name: performance-optimization
description: Performance profiling and optimization workflow. Measure first, then CPU/memory profiling, bundle/code analysis, query tuning, caching, lazy loading, and concurrency. Use when something is slow, uses too much memory, or scales badly.
tools:
  - perf
  - shell
  - analyze-code
  - benchmark
  - read
---

# Performance Optimization Skill

## When to Use
- A user reports slowness, high latency, or memory pressure.
- You anticipate a hot path (request handling, loop, DB query) will not scale.
- A CI timing/memory budget is being exceeded.

## Golden Rule: Measure Before You Optimize
Never optimize blind. Every claim of slowness starts with a **baseline number** captured under a realistic workload:
1. Capture the current latency/throughput/memory with `benchmark` or `perf`.
2. Record the number so the before/after is a fact, not a feeling.
3. Optimize, then re-measure to prove the gain and check for regressions.

## CPU Profiling
- Find the **hot path** first (where cumulative time is spent), not just the slowest single line.
- Look for `O(N^2)` loops, redundant work in tight loops, accidental re-computation, and per-call allocation churn.
- Fix algorithmic complexity before micro-optimizations; a constant factor is worth nothing on the wrong complexity class.
- Benchmark inside the loop; a micro-opt that is not measurable on the real path is not worth the added complexity.

## Memory Profiling
- Watch for **leaks** (objects never released), **excessive allocations/GC pressure** in hot loops, and unbounded caches.
- For JS: prefer object pools or reuse in invariants-ok loops; avoid creating closures/arrays in per-item loops when measurable.
- For native languages: watch buffer ownership, copy-on-write behavior, and reference cycles.

## Bundle / Code Analysis
- Analyze dependency weight; a "small" import can pull a surprising subtree.
- Enable tree-shaking-friendly imports and code-splitting at route/page boundaries.
- Remove dead code and duplicated logic; `analyze-code` can flag unreachable or copied blocks.

## Database Query Tuning
- Run `EXPLAIN (ANALYZE)` on slow queries; the sequence scan is usually the culprit.
- Add covering indexes for read-heavy filters; reduce row reads in `SELECT *` hot paths.
- Batch N+1 queries into set-based fetches; paginate large result sets.

## Caching Strategies
- Cache the **right layer** (in-memory, Redis, HTTP/CDN) closest to where the data is consumed.
- Choose the right policy: TTL for time-bound data, write-through for consistency, invalidation-by-key for derived values.
- Always bound cache size and set eviction; an unbounded cache is a memory leak.
- Cache misses on a cold key can cause thundering herds; consider single-flight/locking around misses.

## Lazy Loading & Concurrency
- Defer expensive, non-critical work (logging, analytics, heavy imports) off the critical path.
- Parallelize independent work (Promise.all / goroutines / futures) but respect shared resources and DB connection limits.
- Use worker threads/processes only when the CPU-bound work justifies the overhead; measure first.

## Workflow
1. **Measure** and record a baseline.
2. **Profile** to locate the true hot path.
3. **Fix** the largest, lowest-risk bottleneck (complexity before micro-opt).
4. **Caching/concurrency** only where the profile justifies it.
5. **Re-measure**, confirm the gain, and add a regression guard (perf test/budget) so it does not slip back.