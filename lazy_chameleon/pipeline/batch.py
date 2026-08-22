"""Batch processing with async work queue and worker pool.
Provides priority-based work queues, configurable worker pools,
async batch processors, and per-batch progress tracking.
Classes
-------
WorkQueue: Priority-based work queue.
WorkerPool: Configurable worker pool.
ProgressTracker: Per-batch progress tracking.
BatchProcessor: Async batch processing orchestrator.
"""
from __future__ import annotations
import enum
import logging
import queue
import threading
import time
import traceback
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Set, Tuple, TypeVar
from lazy_chameleon.pipeline.core import PipelineResult, StageStatus
logger = logging.getLogger(__name__); T = TypeVar("T")

class Priority(enum.IntEnum):
    LOW = 0; MEDIUM = 5; HIGH = 10; CRITICAL = 20

@dataclass(order=True)
class WorkItem:
    priority: int = field(default=5, compare=True)
    timestamp: float = field(default_factory=time.time, compare=False)
    item_id: str = field(default="", compare=False)
    data: Any = field(default=None, compare=False)
    callback: Optional[Callable] = field(default=None, compare=False)
    metadata: Dict[str, Any] = field(default_factory=dict, compare=False)

class WorkQueue:
    """Priority-based work queue for batch processing.
    Supports priority ordering, batching, and lifecycle management.
    """
    def __init__(self, maxsize=0):
        self._queue = queue.PriorityQueue(maxsize=maxsize)
        self._enqueued = 0; self._dequeued = 0; self._lock = threading.RLock()
        self._logger = logging.getLogger(f"{__name__}.WorkQueue"); self._closed = False

    def put(self, item, priority=Priority.MEDIUM, block=True, timeout=None):
        if self._closed: raise RuntimeError("Queue is closed")
        work = WorkItem(priority=priority.value if isinstance(priority, Priority) else priority, data=item)
        self._queue.put(work, block=block, timeout=timeout)
        with self._lock: self._enqueued += 1

    def get(self, block=True, timeout=None):
        try:
            item = self._queue.get(block=block, timeout=timeout)
            with self._lock: self._dequeued += 1
            return item
        except queue.Empty: return None

    def get_batch(self, max_items=10, timeout=0.1):
        batch = []
        item = self.get(timeout=timeout)
        if item is None: return batch
        batch.append(item)
        while len(batch) < max_items:
            item = self.get(block=False)
            if item is None: break
            batch.append(item)
        return batch

    @property
    def qsize(self): return self._queue.qsize()
    @property
    def enqueued(self): return self._enqueued
    @property
    def dequeued(self): return self._dequeued
    @property
    def pending(self): return self._enqueued - self._dequeued

    def close(self):
        self._closed = True

    def clear(self):
        while not self._queue.empty():
            try: self._queue.get_nowait()
            except queue.Empty: break


class WorkerPool:
    """Configurable thread pool for processing work items.
    Manages a pool of worker threads that consume from a WorkQueue.
    Parameters
    ----------
    num_workers: Number of worker threads.
    worker_fn: Callable to process each work item.
    """
    def __init__(self, num_workers=4, worker_fn=None):
        self.num_workers = max(1, num_workers)
        self.worker_fn = worker_fn
        self._work_queue = WorkQueue()
        self._threads: List[threading.Thread] = []
        self._stop_event = threading.Event()
        self._results: Dict[str, Any] = {}
        self._errors: Dict[str, List[str]] = defaultdict(list)
        self._processed = 0; self._failed = 0
        self._lock = threading.RLock()
        self._logger = logging.getLogger(f"{__name__}.WorkerPool")

    def start(self):
        self._stop_event.clear()
        for i in range(self.num_workers):
            t = threading.Thread(target=self._worker_loop, name=f"worker-{i}", daemon=True)
            t.start(); self._threads.append(t)
        self._logger.info("Started %d workers", self.num_workers)

    def _worker_loop(self):
        while not self._stop_event.is_set():
            item = self._work_queue.get(timeout=0.5)
            if item is None: continue
            try:
                if self.worker_fn:
                    result = self.worker_fn(item.data)
                else:
                    result = item.data
                with self._lock:
                    self._results[item.item_id or str(id(item))] = result
                    self._processed += 1
                if item.callback:
                    try: item.callback(item.item_id, result, None)
                    except Exception as exc: self._logger.error("Callback failed: %s", exc)
            except Exception as exc:
                with self._lock:
                    self._errors[item.item_id or str(id(item))].append(str(exc))
                    self._failed += 1
                if item.callback:
                    try: item.callback(item.item_id, None, exc)
                    except: pass

    def submit(self, item, priority=Priority.MEDIUM):
        self._work_queue.put(item, priority=priority)

    def submit_batch(self, items, priority=Priority.MEDIUM):
        for item in items: self.submit(item, priority)

    @property
    def processed(self): return self._processed
    @property
    def failed(self): return self._failed
    @property
    def pending(self): return self._work_queue.pending

    def stop(self, wait=True):
        self._stop_event.set()
        if wait:
            for t in self._threads: t.join(timeout=5.0)
        self._threads.clear()
        self._logger.info("Stopped worker pool: %d processed, %d failed", self._processed, self._failed)

    def get_results(self):
        with self._lock: return dict(self._results)

    def get_errors(self):
        with self._lock: return dict(self._errors)

@dataclass
class ProgressTracker:
    """Tracks per-batch progress, completion, and statistics.
    Attributes
    ----------
    batch_id: Batch identifier.
    total_items: Total items in the batch.
    completed: Number of completed items.
    failed: Number of failed items.
    start_time: Unix timestamp when batch started.
    end_time: Unix timestamp when batch ended.
    """
    batch_id: str = ""
    total_items: int = 0
    completed: int = 0
    failed: int = 0
    start_time: float = 0.0
    end_time: float = 0.0
    _lock: Any = field(default_factory=threading.RLock)
    _item_status: Dict[str, str] = field(default_factory=dict)

    def start(self):
        self.start_time = time.time()

    def mark_done(self, item_id, status="success"):
        with self._lock:
            self._item_status[item_id] = status
            if status == "success": self.completed += 1
            elif status == "failed": self.failed += 1

    @property
    def progress(self) -> float:
        if self.total_items == 0: return 0.0
        return min(1.0, (self.completed + self.failed) / self.total_items)

    @property
    def elapsed(self) -> float:
        if self.start_time == 0.0: return 0.0
        end = self.end_time or time.time()
        return end - self.start_time

    @property
    def eta(self) -> float:
        if self.progress == 0.0 or self.progress == 1.0: return 0.0
        return (self.elapsed / self.progress) * (1.0 - self.progress)

    @property
    def throughput(self) -> float:
        if self.elapsed == 0: return 0.0
        return (self.completed + self.failed) / self.elapsed

    def to_dict(self):
        return {
            "batch_id": self.batch_id, "total_items": self.total_items,
            "completed": self.completed, "failed": self.failed,
            "progress": self.progress, "elapsed_seconds": self.elapsed,
            "eta_seconds": self.eta, "throughput": self.throughput,
        }

    def finish(self):
        self.end_time = time.time()


class BatchProcessor:
    """Async batch processing orchestrator with work queue and worker pool.
    Processes items in batches with configurable concurrency, retries,
    and progress tracking.
    Parameters
    ----------
    worker_fn: Function to process each item.
    num_workers: Number of concurrent workers.
    max_retries: Max retries per item.
    batch_size: Default batch size.
    """
    def __init__(self, worker_fn=None, num_workers=4, max_retries=0, batch_size=100):
        self.worker_fn = worker_fn
        self.num_workers = max(1, num_workers)
        self.max_retries = max_retries
        self.batch_size = batch_size
        self._pool = WorkerPool(num_workers=self.num_workers, worker_fn=self._process_with_retry)
        self._trackers: Dict[str, ProgressTracker] = {}
        self._lock = threading.RLock()
        self._logger = logging.getLogger(f"{__name__}.BatchProcessor")

    def _process_with_retry(self, item):
        if isinstance(item, dict) and "data" in item:
            data = item["data"]; item_id = item.get("item_id", str(id(data)))
        else:
            data = item; item_id = str(id(item))
        retries = 0
        while retries <= self.max_retries:
            try:
                return self.worker_fn(data) if self.worker_fn else data
            except Exception as exc:
                retries += 1
                if retries > self.max_retries: raise
                self._logger.warning("Retry %d/%d for %s: %s", retries, self.max_retries, item_id, exc)
                time.sleep(2 ** retries)
        return None

    def process_batch(self, items, batch_id=None, priority=Priority.MEDIUM):
        """Process a batch of items asynchronously.
        Parameters
        ----------
        items: List of items to process.
        batch_id: Optional batch identifier.
        priority: Priority level.
        Returns
        -------
        ProgressTracker: Tracker for this batch.
        """
        bid = batch_id or f"batch_{int(time.time() * 1000)}"
        tracker = ProgressTracker(batch_id=bid, total_items=len(items))
        with self._lock: self._trackers[bid] = tracker
        tracker.start()
        for i, item in enumerate(items):
            wrapped = {"data": item, "item_id": f"{bid}_{i}", "batch_id": bid}
            cb = lambda iid, res, err, t=tracker, iid2=f"{bid}_{i}": t.mark_done(iid2, "failed" if err else "success")
            work_item = WorkItem(priority=priority.value if isinstance(priority, Priority) else priority, item_id=f"{bid}_{i}", data=wrapped, callback=cb)
            self._pool._work_queue.put(work_item)
        return tracker

    def process_batch_sync(self, items, batch_id=None):
        """Process a batch synchronously and wait for completion.
        Parameters
        ----------
        items: List of items to process.
        batch_id: Optional batch identifier.
        Returns
        -------
        List[Any]: Processed results.
        """
        results = []
        for item in items:
            try:
                result = self._process_with_retry(item)
                results.append(result)
            except Exception as exc:
                self._logger.error("Item failed: %s", exc)
                results.append(None)
        return results

    def start(self):
        self._pool.start()

    def stop(self, wait=True):
        self._pool.stop(wait=wait)

    def get_tracker(self, batch_id):
        with self._lock: return self._trackers.get(batch_id)

    @property
    def active_batches(self):
        with self._lock: return list(self._trackers.keys())

    def get_all_results(self):
        return self._pool.get_results()

    def get_all_errors(self):
        return self._pool.get_errors()

class BatchAccumulator:
    """Accumulates items into batches for efficient processing.
    Supports size-based, time-based, and count-based batching strategies.
    Parameters
    ----------
    batch_size: Maximum items per batch.
    max_wait: Maximum seconds to wait before flushing.
    """
    def __init__(self, batch_size=32, max_wait=5.0):
        self.batch_size = batch_size; self.max_wait = max_wait
        self._buffer = []; self._last_flush = time.time()
        self._lock = threading.RLock(); self._batches_created = 0
        self._logger = logging.getLogger(f"{__name__}.BatchAccumulator")

    def add(self, item):
        with self._lock: self._buffer.append(item)
        if self._ready_to_flush(): return self.flush()
        return None

    def _ready_to_flush(self):
        with self._lock:
            if len(self._buffer) >= self.batch_size: return True
            if self._buffer and (time.time() - self._last_flush) >= self.max_wait: return True
        return False

    def flush(self):
        with self._lock:
            if not self._buffer: return []
            batch = list(self._buffer)
            self._buffer.clear(); self._last_flush = time.time()
            self._batches_created += 1
        return batch

    @property
    def buffer_size(self): return len(self._buffer)
    @property
    def batches_created(self): return self._batches_created


class BatchResultCollector:
    """Collects and aggregates results from batch processing.
    Parameters
    ----------
    collect_errors: Whether to collect error details.
    """
    def __init__(self, collect_errors=True):
        self._results = {}; self._errors = {}
        self._lock = threading.RLock(); self.collect_errors = collect_errors

    def add_result(self, item_id, result):
        with self._lock: self._results[item_id] = result

    def add_error(self, item_id, error):
        with self._lock: self._errors[item_id] = error

    def get_results(self, clear=False):
        with self._lock:
            r = dict(self._results)
            if clear: self._results.clear()
        return r

    def get_errors(self, clear=False):
        with self._lock:
            e = dict(self._errors)
            if clear: self._errors.clear()
        return e

    @property
    def success_count(self): return len(self._results)
    @property
    def error_count(self): return len(self._errors)
    @property
    def total_count(self): return self.success_count + self.error_count


class RateLimiter:
    """Rate limiter for controlling batch processing speed.
    Enforces items-per-second and concurrency limits.
    Parameters
    ----------
    max_rate: Maximum items per second.
    max_concurrency: Maximum parallel operations.
    """
    def __init__(self, max_rate=100, max_concurrency=10):
        self.max_rate = max_rate; self.max_concurrency = max_concurrency
        self._tokens = max_rate; self._last_refill = time.time()
        self._active = 0; self._lock = threading.RLock()

    def _refill(self):
        now = time.time(); elapsed = now - self._last_refill
        self._tokens = min(self.max_rate, self._tokens + elapsed * self.max_rate)
        self._last_refill = now

    def acquire(self, tokens=1):
        with self._lock:
            self._refill()
            if self._tokens >= tokens and self._active < self.max_concurrency:
                self._tokens -= tokens; self._active += 1
                return True
        return False

    def release(self):
        with self._lock: self._active = max(0, self._active - 1)

    def wait_acquire(self, tokens=1, timeout=None):
        deadline = time.time() + timeout if timeout else float("inf")
        while time.time() < deadline:
            if self.acquire(tokens): return True
            time.sleep(0.01)
        return False

    @property
    def available_tokens(self):
        with self._lock: self._refill(); return self._tokens
