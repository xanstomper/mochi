"""OptimizerChameleon — multi-dimensional improvement analysis as synthetic parameters."""
from .base import LazyAgent

_SYSTEM = (
    "You are a performance engineer and code quality specialist who has optimized "
    "systems from 100ms to 1ms and from $1M/month cloud bills to $50k. "
    "You think in concrete numbers: latency percentiles, throughput, cost per request."
)

_PROMPT = """\
TASK: {task}

You are the OPTIMIZER agent. Find every improvement opportunity across all dimensions.

## ALGORITHMIC OPTIMIZATIONS
Current complexity analysis: O(?).
- What is the theoretical minimum complexity for this problem?
- Which data structures reduce constant factors most?
- Where can we avoid redundant computation (memoization, caching, lazy evaluation)?
- Where can we batch instead of iterate individually?
- [List 5–8 concrete algorithmic improvements with expected impact]

## CACHING STRATEGIES
- What data is expensive to compute but read frequently?
- Cache key design: how to key it (to avoid stale data)
- Invalidation: when/how to invalidate correctly
- Layer: L1 (in-process) / L2 (Redis/Memcached) / L3 (CDN)
- TTL recommendations with justification

## PARALLELISM & CONCURRENCY
- Which operations are independent and can run concurrently?
- I/O-bound vs CPU-bound split — optimal thread/process/async strategy
- Connection pooling: pool size, idle timeout, health checks
- Batch size recommendations for I/O operations

## MEMORY OPTIMIZATIONS
- Where are we allocating more than needed?
- Data structure choices that reduce memory (e.g., slots, arrays vs dicts)
- Streaming instead of buffering where feasible
- GC pressure reduction techniques

## METRICS TO TRACK
Specific KPIs — with target values — that would confirm these optimizations worked:
- Latency: p50 / p95 / p99 targets
- Throughput: requests/sec target
- Memory: peak RSS target
- Cost: $/1M operations target

## SUCCESS METRICS
[List 5–10 changes with expected gains]
| Change | Current | Expected | Effort |
|--------|---------|----------|--------|
| ...    | ...     | ...      | S/M/L  |
"""


class OptimizerChameleon(LazyAgent):
    def __init__(self, model_api=None, mode="auto"):
        super().__init__("optimizer", model_api, mode)

    def generate_synthetic_params(self, task: str) -> dict:
        content = self._call_api(
            _PROMPT.format(task=task),
            max_tokens=4000,
            system=_SYSTEM,
        )

        improvements = max(
            content.count("##") * 3
            + content.count("improve") + content.count("Improve")
            + content.count("optim") + content.count("Optim")
            + content.count("cache") + content.count("Cache"),
            5,
        )

        param_eq = improvements * 22_000_000_000 * self._mode_mult()
        self.synthetic_params_generated += param_eq

        return {
            "summary": (
                f"Found {improvements} optimisation opportunities "
                f"(algo, cache, parallel, memory)"
            ),
            "details": content,
            "param_equivalent": param_eq,
            "confidence": min(0.60 + improvements * 0.015, 0.92),
            "tokens": len(content) // 4,
        }
