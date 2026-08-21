---
name: performance-profiling
description: Performance optimization, CPU hotspot analysis, memory leak detection, database query optimization, flamegraph analysis, and latency reduction.
tools: [read, edit, patch, shell, glob, search, perf_audit]
---

# Performance Optimization & Profiling Skill

## Optimization Methodology
1. **Measure First:** Never optimize based on intuition alone. Obtain objective benchmarks or profile data.
2. **Identify Bottleneck Tier:**
   - **Algorithmic:** $O(N^2)$ to $O(N \log N)$ or $O(N)$ via hash maps, sets, or indexed lookups.
   - **I/O & Network:** Excessive round-trips, N+1 queries, unbatched API calls, uncompressed payloads.
   - **Memory & Allocation:** Excessive allocations in hot loops, garbage collection thrashing, memory leaks (unbound caches, event listener leaks).
   - **Concurrency:** Lock contention, thread pool starvation, sequential async `await` chains.

## Key Optimization Strategies
- **Batching & Concurrency:** Replace sequential `for (const x of arr) await fetch(x)` with `Promise.allSettled()` or worker pools with concurrency limits.
- **Caching & Memoization:** Use LRU caches with explicit TTLs and maximum capacity bounds to avoid unbounded RAM consumption.
- **Lazy Evaluation & Streaming:** Stream large datasets/files chunk-by-chunk instead of loading full payloads into memory (`fs.createReadStream`, generator pipelines).
