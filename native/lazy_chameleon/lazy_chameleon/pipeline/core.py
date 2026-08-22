"""Core pipeline orchestration components.

Defines the fundamental building blocks for DAG-based data pipelines:
- StageStatus: Enum for pipeline stage lifecycle states.
- PipelineResult: Rich result object for success/failure tracking.
- PipelineContext: Thread-safe shared state across pipeline stages.
- PipelineStage: Abstract base class for pipeline processing stages.
- DataPipeline: DAG-based pipeline orchestrator with checkpoint/resume.
"""

from __future__ import annotations

import abc
import enum
import logging
import threading
import time
import traceback
from dataclasses import dataclass, field
from typing import Any, Dict, Generic, List, Optional, Set, Tuple, TypeVar, Union

logger = logging.getLogger(__name__)

T = TypeVar("T")
U = TypeVar("U")
StageName = str


class StageStatus(enum.Enum):
    """Lifecycle status of a pipeline stage.

    Attributes
    ----------
    PENDING: Stage registered but not started.
    READY: All upstream dependencies satisfied.
    RUNNING: Stage is currently executing.
    SUCCESS: Stage completed without errors.
    FAILED: Stage encountered an unrecoverable error.
    SKIPPED: Stage was skipped by a conditional gate.
    RETRYING: Stage failed and is being retried.
    CANCELLED: Stage was cancelled before completion.
    TIMEOUT: Stage exceeded maximum allowed runtime.
    CHECKPOINTED: Stage produced a checkpoint mid-execution.
    """

    PENDING = "pending"
    READY = "ready"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"
    SKIPPED = "skipped"
    RETRYING = "retrying"
    CANCELLED = "cancelled"
    TIMEOUT = "timeout"
    CHECKPOINTED = "checkpointed"

    def is_terminal(self) -> bool:
        """Return True if this status represents a terminal state."""
        return self in {self.SUCCESS, self.FAILED, self.SKIPPED, self.CANCELLED, self.TIMEOUT}

    def is_active(self) -> bool:
        """Return True if stage is in an active (non-terminal, non-pending) state."""
        return self in {self.READY, self.RUNNING, self.RETRYING, self.CHECKPOINTED}

    def requires_retry(self) -> bool:
        """Return True if the status warrants a retry attempt."""
        return self in {self.FAILED, self.TIMEOUT}



@dataclass
class PipelineResult(Generic[T]):
    """Rich result object bundling output data with execution metadata.

    Parameters
    ----------
    data: The output data produced by the stage or pipeline.
    stage_name: Name of the stage that produced this result.
    status: Terminal status of the stage.
    start_time: Unix timestamp when execution began.
    end_time: Unix timestamp when execution ended.
    duration_seconds: Wall-clock execution duration.
    artifacts: Dict of named artifacts produced.
    metrics: Arbitrary key-value metrics captured during run.
    errors: List of error messages that occurred.
    warnings: List of warning messages.
    checkpoint_path: Path to a saved checkpoint, if any.
    """

    data: Optional[T] = None
    stage_name: str = ""
    status: StageStatus = StageStatus.PENDING
    start_time: float = 0.0
    end_time: float = 0.0
    duration_seconds: float = 0.0
    artifacts: Dict[str, Any] = field(default_factory=dict)
    metrics: Dict[str, float] = field(default_factory=dict)
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    checkpoint_path: Optional[str] = None

    def __post_init__(self) -> None:
        """Auto-compute duration if timestamps are set."""
        if self.start_time and self.end_time and not self.duration_seconds:
            self.duration_seconds = max(0.0, self.end_time - self.start_time)

    @property
    def success(self) -> bool:
        """Return True if the result indicates success."""
        return self.status == StageStatus.SUCCESS

    @property
    def failed(self) -> bool:
        """Return True if the result indicates failure."""
        return self.status in (StageStatus.FAILED, StageStatus.TIMEOUT)

    def merge(self, other: "PipelineResult") -> "PipelineResult":
        """Merge another result into this one.

        Parameters
        ----------
        other: Another PipelineResult to merge.

        Returns
        -------
        PipelineResult: self for chaining.
        """
        if other.data is not None:
            self.data = other.data
        self.artifacts.update(other.artifacts)
        self.metrics.update(other.metrics)
        self.errors.extend(other.errors)
        self.warnings.extend(other.warnings)
        if other.end_time > self.end_time:
            self.end_time = other.end_time
        if self.start_time and self.end_time:
            self.duration_seconds = max(0.0, self.end_time - self.start_time)
        if other.checkpoint_path:
            self.checkpoint_path = other.checkpoint_path
        return self

    def to_dict(self) -> Dict[str, Any]:
        """Serialize result to a plain dict for logging or persistence.

        Returns
        -------
        Dict[str, Any]: Serializable representation.
        """
        return {
            "stage_name": self.stage_name,
            "status": self.status.value,
            "duration_seconds": self.duration_seconds,
            "success": self.success,
            "error_count": len(self.errors),
            "warning_count": len(self.warnings),
            "artifact_keys": list(self.artifacts.keys()),
            "metrics": dict(self.metrics),
            "checkpoint_path": self.checkpoint_path,
        }

    @classmethod
    def error_result(cls, stage_name: str, message: str, exc_info: Optional[BaseException] = None) -> "PipelineResult":
        """Create a failed result for the given error.

        Parameters
        ----------
        stage_name: Name of the stage.
        message: Human-readable error description.
        exc_info: Optional exception that caused the failure.

        Returns
        -------
        PipelineResult: Pre-populated failure result.
        """
        errors = [message]
        if exc_info:
            tb = "".join(traceback.format_exception(type(exc_info), exc_info, exc_info.__traceback__))
            errors.append(tb)
        return cls(stage_name=stage_name, status=StageStatus.FAILED, end_time=time.time(), errors=errors)

    @classmethod
    def empty(cls, stage_name: str = "") -> "PipelineResult":
        """Create a blank successful result.

        Parameters
        ----------
        stage_name: Optional stage name.

        Returns
        -------
        PipelineResult: Empty success result.
        """
        now = time.time()
        return cls(stage_name=stage_name, status=StageStatus.SUCCESS, start_time=now, end_time=now)


class PipelineContext:
    """Thread-safe shared state container for a single pipeline run.

    PipelineContext lives for the duration of a pipeline execution and is
    passed to every stage. Stages read from and write to the context to
    exchange intermediate results, artifacts, configuration overrides, and
    execution metadata.

    Parameters
    ----------
    config: Optional top-level configuration dict.
    initial_data: Optional dict of seed data to populate the context.
    """

    def __init__(self, config: Optional[Dict[str, Any]] = None, initial_data: Optional[Dict[str, Any]] = None):
        self._lock = threading.RLock()
        self._data: Dict[str, Any] = {}
        self._artifacts: Dict[str, Any] = {}
        self._stage_results: Dict[str, PipelineResult] = {}
        self._checkpoints: Dict[str, str] = {}
        self.config: Dict[str, Any] = dict(config or {})
        self.metadata: Dict[str, Any] = {}
        self._run_id: str = f"run_{int(time.time() * 1000)}"
        self._cancelled = False
        if initial_data:
            self._data.update(initial_data)

    # -- data accessors --

    def get(self, key: str, default: Any = None) -> Any:
        """Retrieve a value from the shared context.

        Parameters
        ----------
        key: The data key.
        default: Value returned when key is not found.

        Returns
        -------
        Any: The stored value or default.
        """
        with self._lock:
            return self._data.get(key, default)

    def set(self, key: str, value: Any) -> None:
        """Store a value in the shared context.

        Parameters
        ----------
        key: The data key.
        value: Value to store.
        """
        with self._lock:
            self._data[key] = value

    def update(self, mapping: Dict[str, Any]) -> None:
        """Batch-update the shared context.

        Parameters
        ----------
        mapping: Dict of key-value pairs to store.
        """
        with self._lock:
            self._data.update(mapping)

    def keys(self) -> List[str]:
        """Return a snapshot of all keys in the context.

        Returns
        -------
        List[str]: List of data keys.
        """
        with self._lock:
            return list(self._data.keys())

    def __contains__(self, key: str) -> bool:
        with self._lock:
            return key in self._data

    def __getitem__(self, key: str) -> Any:
        with self._lock:
            return self._data[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self.set(key, value)

    def __len__(self) -> int:
        with self._lock:
            return len(self._data)

    # -- artifacts --

    def store_artifact(self, name: str, artifact: Any) -> None:
        """Store a named artifact in the context.

        Parameters
        ----------
        name: Unique artifact name.
        artifact: The artifact object (any type).
        """
        with self._lock:
            self._artifacts[name] = artifact

    def get_artifact(self, name: str, default: Any = None) -> Any:
        """Retrieve a previously stored artifact.

        Parameters
        ----------
        name: Artifact name.
        default: Fallback value.

        Returns
        -------
        Any: The artifact or default.
        """
        with self._lock:
            return self._artifacts.get(name, default)

    def list_artifacts(self) -> List[str]:
        """Return all artifact names.

        Returns
        -------
        List[str]: Artifact name list.
        """
        with self._lock:
            return list(self._artifacts.keys())

    # -- stage results --

    def record_stage_result(self, stage_name: str, result: PipelineResult) -> None:
        """Record the result of a completed stage.

        Parameters
        ----------
        stage_name: Stage identifier.
        result: The result produced by the stage.
        """
        with self._lock:
            self._stage_results[stage_name] = result

    def get_stage_result(self, stage_name: str) -> Optional[PipelineResult]:
        """Retrieve the result for a given stage.

        Parameters
        ----------
        stage_name: Stage identifier.

        Returns
        -------
        Optional[PipelineResult]: The result, or None.
        """
        with self._lock:
            return self._stage_results.get(stage_name)

    def all_stage_results(self) -> Dict[str, PipelineResult]:
        """Return a snapshot of all stage results.

        Returns
        -------
        Dict[str, PipelineResult]: Mapping of stage name to result.
        """
        with self._lock:
            return dict(self._stage_results)
    # -- checkpoints --

    def set_checkpoint(self, stage_name: str, path: str) -> None:
        """Record a checkpoint location for a stage.

        Parameters
        ----------
        stage_name: Stage identifier.
        path: Filesystem path (or URI) where the checkpoint lives.
        """
        with self._lock:
            self._checkpoints[stage_name] = path

    def get_checkpoint(self, stage_name: str) -> Optional[str]:
        """Return the checkpoint path for a stage, if any.

        Parameters
        ----------
        stage_name: Stage identifier.

        Returns
        -------
        Optional[str]: Checkpoint path or None.
        """
        with self._lock:
            return self._checkpoints.get(stage_name)

    def list_checkpoints(self) -> Dict[str, str]:
        """Return all checkpoint paths.

        Returns
        -------
        Dict[str, str]: Stage name -> checkpoint path.
        """
        with self._lock:
            return dict(self._checkpoints)

    @property
    def run_id(self) -> str:
        """Return the unique run identifier."""
        return self._run_id

    def cancel(self) -> None:
        """Request cancellation of the current pipeline run."""
        with self._lock:
            self._cancelled = True

    @property
    def cancelled(self) -> bool:
        """Return True if a cancellation was requested."""
        with self._lock:
            return self._cancelled

    def snapshot(self) -> Dict[str, Any]:
        """Return a complete serializable snapshot of context state.

        Returns
        -------
        Dict[str, Any]: Snapshot dict.
        """
        with self._lock:
            return {
                "run_id": self._run_id,
                "config": dict(self.config),
                "metadata": dict(self.metadata),
                "data_keys": list(self._data.keys()),
                "artifact_names": list(self._artifacts.keys()),
                "stage_results": {k: v.to_dict() for k, v in self._stage_results.items()},
                "checkpoints": dict(self._checkpoints),
                "cancelled": self._cancelled,
            }



class PipelineStage(abc.ABC, Generic[T, U]):
    """Abstract base class for a single processing stage in a pipeline.

    Subclasses must implement process(). Optionally override
    validate() for input validation, checkpoint() for mid-run
    persistence, and resume() to restore from a checkpoint.

    Parameters
    ----------
    name: Human-readable stage name, used as identifier in the DAG.
    config: Optional dict of stage-specific configuration.
    max_retries: Maximum retry attempts on failure (0 = no retry).
    timeout_seconds: Maximum wall-clock time before timeout.
    tags: Optional set of tags for filtering and routing.
    """

    def __init__(
        self,
        name: str,
        config: Optional[Dict[str, Any]] = None,
        max_retries: int = 0,
        timeout_seconds: Optional[float] = None,
        tags: Optional[Set[str]] = None,
    ):
        self.name = name
        self.config: Dict[str, Any] = dict(config or {})
        self.max_retries = max_retries
        self.timeout_seconds = timeout_seconds
        self.tags: Set[str] = set(tags or set())
        self.status: StageStatus = StageStatus.PENDING
        self._retry_count = 0
        self._logger = logging.getLogger(f"{__name__}.{type(self).__name__}[{name}] ")

    @abc.abstractmethod
    def process(self, context: PipelineContext, data: T) -> U:
        """Execute stage logic. This is the only method subclasses must implement.

        Parameters
        ----------
        context: Shared pipeline context for the current run.
        data: Input data from upstream stages or the pipeline entry.

        Returns
        -------
        U: Processed output data.

        Raises
        ------
        Exception: Any error will be caught by the pipeline runner.
        """
        ...

    def validate(self, context: PipelineContext, data: T) -> bool:
        """Validate input data before processing.

        Override to add lightweight pre-checks. Return False to skip.

        Parameters
        ----------
        context: Shared pipeline context.
        data: Input data to validate.

        Returns
        -------
        bool: True if data is valid, False to skip the stage.
        """
        _ = context
        return data is not None

    def checkpoint(self, context: PipelineContext, data: T) -> Optional[str]:
        """Persist mid-execution state for later resume.

        Override to write state to disk/database and return a path.

        Parameters
        ----------
        context: Shared pipeline context.
        data: Current stage data to checkpoint.

        Returns
        -------
        Optional[str]: Path or URI to the checkpoint, or None.
        """
        _ = context, data
        return None

    def resume(self, context: PipelineContext, checkpoint_path: str) -> Optional[U]:
        """Restore stage output from a previous checkpoint.

        Override to load state written by checkpoint().

        Parameters
        ----------
        context: Shared pipeline context.
        checkpoint_path: Path returned by a prior checkpoint() call.

        Returns
        -------
        Optional[U]: Restored output, or None if resume is not supported.
        """
        _ = context, checkpoint_path
        return None

    def cleanup(self, context: PipelineContext) -> None:
        """Tear down resources after the stage finishes.

        Parameters
        ----------
        context: Shared pipeline context.
        """
        _ = context

    def should_retry(self) -> bool:
        """Return True if the stage can be retried.

        Returns
        -------
        bool: True if retry count is below max_retries.
        """
        return self._retry_count < self.max_retries

    def increment_retry(self) -> int:
        """Increment the internal retry counter.

        Returns
        -------
        int: The new retry count.
        """
        self._retry_count += 1
        self.status = StageStatus.RETRYING
        return self._retry_count

    def reset_status(self) -> None:
        """Reset status to PENDING (used before re-execution)."""
        self.status = StageStatus.PENDING
        self._retry_count = 0

    def __repr__(self) -> str:
        return f"{type(self).__name__}(name={self.name!r}, status={self.status.value}, retries={self._retry_count}/{self.max_retries})"

    def __eq__(self, other: object) -> bool:
        if isinstance(other, PipelineStage):
            return self.name == other.name
        return NotImplemented

    def __hash__(self) -> int:
        return hash(self.name)


class DataPipeline(Generic[T, U]):
    """DAG-based pipeline orchestrator with checkpoint/resume support.

    DataPipeline manages a directed acyclic graph of PipelineStage
    instances. It handles topological execution order, dependency
    resolution, retry logic, checkpointing, and result aggregation.

    Parameters
    ----------
    name: Human-readable pipeline name.
    config: Optional global configuration dict.
    max_concurrency: Maximum number of stages to run in parallel.
    """

    def __init__(
        self,
        name: str,
        config: Optional[Dict[str, Any]] = None,
        max_concurrency: int = 1,
    ):
        self.name = name
        self.config: Dict[str, Any] = dict(config or {})
        self.max_concurrency = max(max_concurrency, 1)
        self._stages: Dict[str, PipelineStage] = {}
        self._dependencies: Dict[str, Set[str]] = {}
        self._dependents: Dict[str, Set[str]] = {}
        self.context: Optional[PipelineContext] = None
        self.results: Dict[str, PipelineResult] = {}
        self._status: StageStatus = StageStatus.PENDING
        self._logger = logging.getLogger(f"{__name__}.DataPipeline[{name}] ")

    # -- DAG construction --

    def add_stage(self, stage: PipelineStage, depends_on: Optional[List[str]] = None) -> None:
        """Register a stage and its upstream dependencies.

        Parameters
        ----------
        stage: PipelineStage instance to add.
        depends_on: Names of stages that must complete before stage runs.

        Raises
        ------
        ValueError: If a stage with the same name already exists, or if
            a dependency references a non-existent stage.
        """
        if stage.name in self._stages:
            raise ValueError(f"Stage {stage.name!r} is already registered.")
        deps = set(depends_on or [])
        unknown = deps - set(self._stages.keys())
        if unknown:
            raise ValueError(f"Cannot add stage {stage.name!r}: unknown dependencies: {sorted(unknown)}")
        self._stages[stage.name] = stage
        self._dependencies[stage.name] = deps
        self._dependents.setdefault(stage.name, set())
        for dep in deps:
            self._dependents.setdefault(dep, set()).add(stage.name)

    def get_stage(self, name: str) -> Optional[PipelineStage]:
        """Look up a stage by name.

        Parameters
        ----------
        name: Stage identifier.

        Returns
        -------
        Optional[PipelineStage]: The stage, or None.
        """
        return self._stages.get(name)

    @property
    def stage_names(self) -> List[str]:
        """Return all registered stage names in registration order."""
        return list(self._stages.keys())

    @property
    def entry_stages(self) -> List[str]:
        """Return stages that have no upstream dependencies.

        Returns
        -------
        List[str]: Names of entry-point stages.
        """
        return [s for s, deps in self._dependencies.items() if not deps]

    @property
    def leaf_stages(self) -> List[str]:
        """Return stages with no downstream dependents.

        Returns
        -------
        List[str]: Names of leaf (terminal) stages.
        """
        return [s for s, children in self._dependents.items() if not children]

    def topological_sort(self) -> List[str]:
        """Return a topologically sorted list of stage names (Kahn algorithm).

        Returns
        -------
        List[str]: Stage names in valid execution order.

        Raises
        ------
        ValueError: If the dependency graph contains a cycle.
        """
        in_degree = {name: len(deps) for name, deps in self._dependencies.items()}
        queue = [name for name, deg in in_degree.items() if deg == 0]
        order = []
        while queue:
            node = queue.pop(0)
            order.append(node)
            for child in self._dependents.get(node, set()):
                in_degree[child] -= 1
                if in_degree[child] == 0:
                    queue.append(child)
        if len(order) != len(self._stages):
            raise ValueError(f"Cycle detected. Processable: {len(order)}/{len(self._stages)}")
        return order
    def run(self, initial_data: Optional[T] = None, config_override: Optional[Dict[str, Any]] = None) -> PipelineResult[U]:
        """Execute the entire pipeline from start to finish.

        Parameters
        ----------
        initial_data: Data passed to entry-point stages.
        config_override: Optional dict merged into pipeline config.

        Returns
        -------
        PipelineResult[U]: Combined result from leaf stages.
        """
        self._status = StageStatus.RUNNING
        config = dict(self.config)
        if config_override:
            config.update(config_override)
        ctx = PipelineContext(config=config, initial_data={"input": initial_data})
        self.context = ctx
        self.results.clear()
        self._logger.info("Pipeline %s started (run_id=%s, %d stages)", self.name, ctx.run_id, len(self._stages))
        try:
            order = self.topological_sort()
        except ValueError as exc:
            self._status = StageStatus.FAILED
            return PipelineResult.error_result(self.name, str(exc))
        batches = self._resolve_batches(order)
        for batch_index, batch in enumerate(batches):
            self._logger.debug("Executing batch %d: %s", batch_index, batch)
            if ctx.cancelled:
                self._logger.warning("Pipeline cancelled during batch %d", batch_index)
                self._status = StageStatus.CANCELLED
                break
            batch_results = []
            for stage_name in batch:
                result = self._run_single_stage(ctx, stage_name, initial_data)
                batch_results.append(result)
                self.results[stage_name] = result
                if result.status == StageStatus.FAILED:
                    self._logger.error("Stage %s failed: %s", stage_name, result.errors)
            if any(r.failed for r in batch_results):
                self._logger.warning("Batch %d had failures; aborting.", batch_index)
                self._status = StageStatus.FAILED
                break
        final_result = self._aggregate_results()
        self._status = final_result.status
        self._logger.info("Pipeline %s finished: status=%s, duration=%.2fs", self.name, final_result.status.value, final_result.duration_seconds)
        return final_result

    def resume_from_checkpoint(self, checkpoint_stage: str, initial_data: Optional[T] = None) -> PipelineResult[U]:
        """Resume pipeline execution from a previously checkpointed stage.

        All stages before checkpoint_stage are skipped; their results
        are loaded from checkpoints stored in the context.

        Parameters
        ----------
        checkpoint_stage: Name of the stage to resume from (inclusive).
        initial_data: Optional seed data for the resumed run.

        Returns
        -------
        PipelineResult[U]: Combined result from leaf stages.

        Raises
        ------
        RuntimeError: If no prior context exists.
        ValueError: If checkpoint_stage not in the pipeline.
        """
        if not self.context:
            raise RuntimeError("No prior context. Run pipeline once before resuming.")
        ctx = self.context
        order = self.topological_sort()
        if checkpoint_stage not in order:
            raise ValueError(f"checkpoint_stage {checkpoint_stage!r} not in pipeline order.")
        resume_idx = order.index(checkpoint_stage)
        for stage_name in order[:resume_idx]:
            stage = self._stages[stage_name]
            ckpt = ctx.get_checkpoint(stage_name)
            if ckpt:
                self._logger.info("Restoring stage %s from checkpoint %s", stage_name, ckpt)
                restored = stage.resume(ctx, ckpt)
                if restored is not None:
                    ctx.set(stage_name, restored)
                    ctx.record_stage_result(stage_name, PipelineResult(data=restored, stage_name=stage_name, status=StageStatus.SUCCESS))
                    continue
            self._logger.error("No checkpoint for stage %s; cannot resume.", stage_name)
            return PipelineResult.error_result(self.name, f"Missing checkpoint for stage {stage_name!r}")
        remaining = order[resume_idx:]
        batches = self._resolve_batches(remaining)
        for batch_index, batch in enumerate(batches):
            if ctx.cancelled:
                break
            for stage_name in batch:
                data = ctx.get(stage_name, initial_data)
                result = self._run_single_stage(ctx, stage_name, data)
                self.results[stage_name] = result
        return self._aggregate_results()
    def _run_single_stage(self, ctx: PipelineContext, stage_name: str, data: Any) -> PipelineResult:
        """Execute one stage with retry, timeout, checkpoint support.

        Parameters
        ----------
        ctx: Pipeline context.
        stage_name: Name of the stage to run.
        data: Input data for the stage.

        Returns
        -------
        PipelineResult: Result of stage execution.
        """
        stage = self._stages[stage_name]
        stage.status = StageStatus.READY
        start_time = time.time()
        errors = []
        warnings = []
        # Validation gate
        try:
            if not stage.validate(ctx, data):
                stage.status = StageStatus.SKIPPED
                self._logger.info("Stage %s skipped by validation.", stage_name)
                return PipelineResult(data=None, stage_name=stage_name, status=StageStatus.SKIPPED, start_time=start_time, end_time=time.time())
        except Exception as exc:
            errors.append(f"Validation error: {exc}")
            stage.status = StageStatus.FAILED
            return PipelineResult(stage_name=stage_name, status=StageStatus.FAILED, start_time=start_time, end_time=time.time(), errors=errors)
        # Execution loop with retries
        output = None
        while True:
            stage.status = StageStatus.RUNNING
            exc_info = None
            try:
                if stage.timeout_seconds:
                    output = self._run_with_timeout(stage, ctx, data)
                else:
                    output = stage.process(ctx, data)
                stage.status = StageStatus.SUCCESS
                break
            except Exception as exc:
                exc_info = exc
                tb = traceback.format_exc()
                errors.append(f"Execution error (attempt {stage._retry_count + 1}): {exc}{tb}")
                if stage.should_retry():
                    stage.increment_retry()
                    self._logger.warning("Stage %s retrying (%d/%d)", stage_name, stage._retry_count, stage.max_retries)
                    time.sleep(min(2 ** stage._retry_count, 60))
                    continue
                else:
                    stage.status = StageStatus.FAILED
                    break
        end_time = time.time()
        # Checkpoint on success
        checkpoint_path = None
        if stage.status == StageStatus.SUCCESS:
            try:
                checkpoint_path = stage.checkpoint(ctx, output)
                if checkpoint_path:
                    ctx.set_checkpoint(stage_name, checkpoint_path)
            except Exception as exc:
                warnings.append(f"Checkpoint failed: {exc}")
        # Cleanup
        try:
            stage.cleanup(ctx)
        except Exception as exc:
            warnings.append(f"Cleanup error: {exc}")
        result = PipelineResult(data=output, stage_name=stage_name, status=stage.status, start_time=start_time, end_time=end_time, duration_seconds=end_time - start_time, errors=errors, warnings=warnings, checkpoint_path=checkpoint_path)
        ctx.record_stage_result(stage_name, result)
        if output is not None:
            ctx.set(stage_name, output)
        self._logger.info("Stage %s -> %s (%.2fs)%s", stage_name, stage.status.value, end_time - start_time, f" [{len(errors)} err]" if errors else "")
        return result

    def _run_with_timeout(self, stage: PipelineStage, ctx: PipelineContext, data: Any) -> Any:
        """Execute stage.process with a wall-clock timeout.

        Parameters
        ----------
        stage: The stage to run.
        ctx: Pipeline context.
        data: Input data.

        Returns
        -------
        Any: Stage output.

        Raises
        ------
        TimeoutError: If execution exceeds stage.timeout_seconds.
        """
        result_holder = []
        exception_holder = []
        def target():
            try:
                result_holder.append(stage.process(ctx, data))
            except BaseException as exc:
                exception_holder.append(exc)
        thread = threading.Thread(target=target, daemon=True)
        thread.start()
        thread.join(timeout=stage.timeout_seconds)
        if thread.is_alive():
            raise TimeoutError(f"Stage {stage.name} exceeded timeout of {stage.timeout_seconds}s")
        if exception_holder:
            raise exception_holder[0]
        return result_holder[0]

    def _resolve_batches(self, order: List[str]) -> List[List[str]]:
        """Group topologically-sorted stages into concurrency batches.

        Parameters
        ----------
        order: Topologically sorted stage names.

        Returns
        -------
        List[List[str]]: Batches of stages to execute in parallel.
        """
        batches = []
        in_degree = {n: len(self._dependencies[n]) for n in order}
        queue = [n for n in order if in_degree[n] == 0]
        while queue:
            batch = []
            for _ in range(min(self.max_concurrency, len(queue))):
                if not queue:
                    break
                batch.append(queue.pop(0))
            batches.append(batch)
            for node in batch:
                for child in self._dependents.get(node, set()):
                    in_degree[child] -= 1
                    if in_degree[child] == 0:
                        queue.append(child)
            queue.sort(key=lambda x: order.index(x))
        return batches

    def _aggregate_results(self) -> PipelineResult:
        """Combine leaf-stage results into a single pipeline result.

        Returns
        -------
        PipelineResult: Aggregated result.
        """
        leaves = self.leaf_stages
        if not leaves:
            return PipelineResult.empty(self.name)
        aggregated = PipelineResult(stage_name=self.name, status=StageStatus.SUCCESS)
        for name in leaves:
            result = self.results.get(name)
            if result is None:
                continue
            aggregated.merge(result)
            if result.failed:
                aggregated.status = StageStatus.FAILED
        if aggregated.start_time == 0.0:
            aggregated.start_time = time.time()
        if aggregated.end_time == 0.0:
            aggregated.end_time = time.time()
        return aggregated

    @property
    def status(self) -> StageStatus:
        """Return the overall pipeline status."""
        return self._status

    def cancel(self) -> None:
        """Request cancellation of the running pipeline."""
        if self.context:
            self.context.cancel()
        self._status = StageStatus.CANCELLED

    def __repr__(self) -> str:
        return f"DataPipeline(name={self.name!r}, stages={len(self._stages)}, status={self._status.value})"
