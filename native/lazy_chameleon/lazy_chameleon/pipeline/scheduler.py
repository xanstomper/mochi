"""DAG scheduling and dependency management for pipelines.

Provides topological scheduling, dependency tracking, parallel stage
optimization, and resource allocation for pipeline stages.

Classes
-------
StageDependency: Tracks dependency relationships between stages.
ScheduleOptimizer: Detects parallelizable stage groups.
ResourceManager: Allocates CPU/memory per stage.
PipelineScheduler: Full DAG scheduler with topological ordering.
"""

from __future__ import annotations

import enum
import heapq
import logging
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Set, Tuple, TypeVar

from lazy_chameleon.pipeline.core import PipelineStage, StageStatus

logger = logging.getLogger(__name__)

T = TypeVar("T")

class DependencyType(enum.Enum):
    """Type of dependency between two stages.
    Attributes
    ----------
    DATA_FLOW: Upstream produces data consumed by downstream.
    RESOURCE: Stages share a constrained resource.
    CONTROL: Logical ordering constraint.
    CONDITIONAL: Conditional dependency.
    """
    DATA_FLOW = "data_flow"
    RESOURCE = "resource"
    CONTROL = "control"
    CONDITIONAL = "conditional"


@dataclass
class StageDependency:
    """Represents a directed dependency between two pipeline stages.
    Parameters
    ----------
    upstream: Name of the upstream stage.
    downstream: Name of the downstream stage.
    dep_type: Type of dependency.
    weight: Scheduling priority weight (higher = more important).
    metadata: Additional dependency metadata.
    """
    upstream: str
    downstream: str
    dep_type: DependencyType = DependencyType.DATA_FLOW
    weight: float = 1.0
    metadata: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.weight <= 0:
            raise ValueError(f"Weight must be positive, got {self.weight}")

    @property
    def is_critical(self) -> bool:
        return self.dep_type in (DependencyType.DATA_FLOW, DependencyType.CONTROL)

    def to_tuple(self) -> Tuple[str, str]:
        return (self.upstream, self.downstream)

    def __hash__(self) -> int:
        return hash((self.upstream, self.downstream, self.dep_type.value))

    def __repr__(self) -> str:
        return f"StageDependency({self.upstream} -> {self.downstream}, {self.dep_type.value})"

@dataclass
class ScheduleOptimizer:
    """Detects parallelizable stage groups and optimizes schedule.
    Analyzes the DAG to find independent stages that can run concurrently,
    identifies critical paths, and produces optimized execution plans.
    Parameters
    ----------
    max_parallel: Maximum stages to parallelize (0 = unlimited).
    critical_path_weight: Threshold for critical path detection.
    """
    max_parallel: int = 0
    critical_path_weight: float = 0.8

    def __post_init__(self) -> None:
        if self.max_parallel < 0:
            raise ValueError(f"max_parallel must be >= 0, got {self.max_parallel}")

    def find_parallel_groups(self, dependencies):
        """Group stages that can safely run in parallel.
        Uses topological depth: stages at same depth with non-overlapping
        transitive dependencies can be parallelized.
        Parameters
        ----------
        dependencies: Dict[str, Set[str]] of upstream names.
        Returns
        -------
        List[List[str]]: Groups of parallel-compatible stage names.
        """
        if not dependencies:
            return []
        depth = {}
        for name, deps in dependencies.items():
            if not deps:
                depth[name] = 0
        changed = True
        while changed:
            changed = False
            for name, deps in dependencies.items():
                if deps and name not in depth:
                    if all(d in depth for d in deps):
                        depth[name] = max(depth[d] for d in deps) + 1
                        changed = True
        max_depth = max(depth.values()) if depth else 0
        groups = []
        for d in range(max_depth + 1):
            group = [n for n, dep in depth.items() if dep == d]
            if group:
                if self.max_parallel > 0 and len(group) > self.max_parallel:
                    group = group[:self.max_parallel]
                groups.append(group)
        return groups

    def find_critical_path(self, dependencies, weights):
        """Find the critical path through the DAG using DP.
        Parameters
        ----------
        dependencies: Dict[str, Set[str]] of upstream names.
        weights: Dict[str, float] per-stage weights.
        Returns
        -------
        List[str]: Critical path stage names in execution order.
        """
        if not dependencies:
            return []
        dependents = defaultdict(set)
        for name, deps in dependencies.items():
            for d in deps:
                dependents[d].add(name)
        in_deg = {n: len(d) for n, d in dependencies.items()}
        queue = deque([n for n, d in in_deg.items() if d == 0])
        topo = []
        while queue:
            n = queue.popleft()
            topo.append(n)
            for child in dependents.get(n, set()):
                in_deg[child] -= 1
                if in_deg[child] == 0:
                    queue.append(child)
        dist = {n: weights.get(n, 1.0) for n in dependencies}
        parent = {n: None for n in dependencies}
        for n in topo:
            for child in dependents.get(n, set()):
                if dist[n] + weights.get(child, 1.0) > dist[child]:
                    dist[child] = dist[n] + weights.get(child, 1.0)
                    parent[child] = n
        if not dist:
            return []
        end = max(dist, key=dist.get)
        path = []
        while end is not None:
            path.append(end)
            end = parent[end]
        path.reverse()
        return path

    def optimize_schedule(self, dependencies, weights):
        """Produce an optimized batch schedule.
        Combines critical path prioritization with parallel groups.
        Parameters
        ----------
        dependencies: Dict[str, Set[str]] of upstream names.
        weights: Dict[str, float] per-stage weights.
        Returns
        -------
        List[List[str]]: Optimized batches of stage names.
        """
        groups = self.find_parallel_groups(dependencies)
        if not groups:
            return []
        critical = set(self.find_critical_path(dependencies, weights))
        optimized = []
        for group in groups:
            crit_in_group = [s for s in group if s in critical]
            non_crit = [s for s in group if s not in critical]
            optimized.append(crit_in_group + non_crit)
        return optimized

    def estimate_makespan(self, batches, stage_times):
        """Estimate total pipeline runtime given batch schedule.
        Parameters
        ----------
        batches: List[List[str]] of stage name batches.
        stage_times: Dict[str, float] predicted runtime in seconds.
        Returns
        -------
        float: Total estimated makespan in seconds.
        """
        total = 0.0
        for batch in batches:
            if not batch:
                continue
            total += max(stage_times.get(s, 0.0) for s in batch)
        return total

@dataclass
class ResourceManager:
    """Allocates and tracks CPU/memory resources per pipeline stage.
    Manages resource budgets, constraints, and usage tracking
    to prevent resource contention and ensure fair allocation.
    Parameters
    ----------
    total_cpu: Total available CPU cores (fractional allowed).
    total_memory_gb: Total available memory in GB.
    oversubscribe: Allow oversubscription factor (e.g. 1.5 = 150%).
    """
    total_cpu: float = 8.0
    total_memory_gb: float = 32.0
    oversubscribe: float = 1.0
    _allocated_cpu: float = 0.0
    _allocated_memory: float = 0.0
    _lock: object = None

    def __post_init__(self) -> None:
        if self.total_cpu <= 0:
            raise ValueError(f"total_cpu must be positive, got {self.total_cpu}")
        if self.total_memory_gb <= 0:
            raise ValueError(f"total_memory_gb must be positive, got {self.total_memory_gb}")
        if self.oversubscribe < 1.0:
            raise ValueError(f"oversubscribe must be >= 1.0, got {self.oversubscribe}")
        self._lock = threading.RLock()
        self._allocated_cpu = 0.0
        self._allocated_memory = 0.0

    @property
    def available_cpu(self) -> float:
        with self._lock:
            return self.total_cpu * self.oversubscribe - self._allocated_cpu

    @property
    def available_memory(self) -> float:
        with self._lock:
            return self.total_memory_gb * self.oversubscribe - self._allocated_memory

    def can_allocate(self, cpu=0.0, memory_gb=0.0) -> bool:
        with self._lock:
            eff_cpu = self.total_cpu * self.oversubscribe
            eff_mem = self.total_memory_gb * self.oversubscribe
            return (self._allocated_cpu + cpu <= eff_cpu and
                    self._allocated_memory + memory_gb <= eff_mem)

    def allocate(self, stage_name, cpu=0.0, memory_gb=0.0) -> bool:
        if not self.can_allocate(cpu, memory_gb):
            logger.warning("Cannot alloc %.1f CPU/%.1f GB for %s", cpu, memory_gb, stage_name)
            return False
        with self._lock:
            self._allocated_cpu += cpu
            self._allocated_memory += memory_gb
        logger.debug("Allocated %.1f CPU / %.1f GB to %s", cpu, memory_gb, stage_name)
        return True

    def release(self, stage_name, cpu=0.0, memory_gb=0.0) -> None:
        with self._lock:
            self._allocated_cpu = max(0.0, self._allocated_cpu - cpu)
            self._allocated_memory = max(0.0, self._allocated_memory - memory_gb)
        logger.debug("Released %.1f CPU / %.1f GB from %s", cpu, memory_gb, stage_name)

    def get_usage(self) -> Dict[str, float]:
        with self._lock:
            return {
                "cpu_allocated": self._allocated_cpu,
                "cpu_total": self.total_cpu,
                "cpu_available": self.total_cpu * self.oversubscribe - self._allocated_cpu,
                "memory_allocated_gb": self._allocated_memory,
                "memory_total_gb": self.total_memory_gb,
                "memory_available_gb": self.total_memory_gb * self.oversubscribe - self._allocated_memory,
            }

    def allocate_for_stage(self, stage) -> bool:
        cpu = float(stage.config.get("cpu", 1.0))
        mem = float(stage.config.get("memory_gb", 1.0))
        return self.allocate(stage.name, cpu, mem)

    def release_stage(self, stage) -> None:
        cpu = float(stage.config.get("cpu", 1.0))
        mem = float(stage.config.get("memory_gb", 1.0))
        self.release(stage.name, cpu, mem)

    def __repr__(self) -> str:
        return f"ResourceManager(cpu={self.available_cpu:.1f}/{self.total_cpu:.1f}, mem={self.available_memory:.1f}/{self.total_memory_gb:.1f} GB)"


class PipelineScheduler:
    """Full DAG scheduler that manages stage execution order and resources.

    Combines topological sorting, critical path analysis, and resource
    allocation to produce efficient execution schedules.

    Parameters
    ----------
    resource_manager: Optional ResourceManager for resource allocation.
    optimizer: Optional ScheduleOptimizer for schedule optimization.
    default_parallelism: Default number of parallel stages.
    """

    def __init__(
        self,
        resource_manager: Optional[ResourceManager] = None,
        optimizer: Optional[ScheduleOptimizer] = None,
        default_parallelism: int = 1,
    ):
        self.resource_manager = resource_manager or ResourceManager()
        self.optimizer = optimizer or ScheduleOptimizer()
        self.default_parallelism = max(1, default_parallelism)
        self._stages: Dict[str, PipelineStage] = {}
        self._dependencies: Dict[str, Set[str]] = {}
        self._dependents: Dict[str, Set[str]] = {}
        self._stage_configs: Dict[str, Dict[str, Any]] = {}
        self._stage_weights: Dict[str, float] = {}
        self._lock = threading.RLock()
        self._logger = logging.getLogger(f"{__name__}.PipelineScheduler")

    def register_stage(self, stage, depends_on=None, weight=1.0, config_override=None):
        """Register a stage with optional dependencies and weight.

        Parameters
        ----------
        stage: PipelineStage to register.
        depends_on: List of upstream stage names.
        weight: Scheduling weight (higher = more critical).
        config_override: Optional stage config overrides.

        Raises
        ------
        ValueError: If stage already registered or dependency unknown.
        """
        if stage.name in self._stages:
            raise ValueError(f"Stage {stage.name!r} already registered.")
        deps = set(depends_on or [])
        unknown = deps - set(self._stages.keys())
        if unknown:
            raise ValueError(f"Unknown dependencies: {unknown}")
        self._stages[stage.name] = stage
        self._dependencies[stage.name] = deps
        self._dependents.setdefault(stage.name, set())
        for dep in deps:
            self._dependents.setdefault(dep, set()).add(stage.name)
        self._stage_weights[stage.name] = max(0.1, weight)
        if config_override:
            stage.config.update(config_override)
        self._stage_configs[stage.name] = dict(stage.config)

    def build_schedule(self, max_parallel=None):
        """Build an optimized execution schedule.

        Returns a list of batches where each batch contains stage names
        that can execute in parallel.

        Parameters
        ----------
        max_parallel: Override max parallelism (None = use default).

        Returns
        -------
        List[List[str]]: Batches of stage names.
        """
        if not self._stages:
            return []
        if max_parallel is not None:
            old = self.optimizer.max_parallel
            self.optimizer.max_parallel = max_parallel
            result = self.optimizer.optimize_schedule(self._dependencies, self._stage_weights)
            self.optimizer.max_parallel = old
        else:
            result = self.optimizer.optimize_schedule(self._dependencies, self._stage_weights)
        self._logger.info("Built schedule with %d batches", len(result))
        return result

    def validate_schedule(self, schedule):
        """Validate that a schedule satisfies all dependencies.

        Parameters
        ----------
        schedule: List[List[str]] of stage name batches.

        Returns
        -------
        Tuple[bool, List[str]]: (is_valid, list_of_errors).
        """
        errors = []
        executed = set()
        for batch in schedule:
            for stage_name in batch:
                if stage_name not in self._stages:
                    errors.append(f"Stage {stage_name!r} not registered.")
                    continue
                deps = self._dependencies.get(stage_name, set())
                missing = deps - executed
                if missing:
                    errors.append(f"Stage {stage_name!r} has unsatisfied deps: {missing}")
            for stage_name in batch:
                executed.add(stage_name)
        return (len(errors) == 0, errors)

    def allocate_resources(self, stage_name):
        """Allocate resources for a scheduled stage.

        Parameters
        ----------
        stage_name: Name of the stage.

        Returns
        -------
        bool: True if allocation successful.
        """
        stage = self._stages.get(stage_name)
        if stage:
            return self.resource_manager.allocate_for_stage(stage)
        return False

    def release_resources(self, stage_name):
        """Release resources for a completed stage.

        Parameters
        ----------
        stage_name: Name of the stage.
        """
        stage = self._stages.get(stage_name)
        if stage:
            self.resource_manager.release_stage(stage)

    def get_dependency_graph(self):
        """Return the dependency graph as adjacency dicts.

        Returns
        -------
        Dict[str, Dict]: Graph info.
        """
        return {
            "stages": list(self._stages.keys()),
            "dependencies": {k: list(v) for k, v in self._dependencies.items()},
            "dependents": {k: list(v) for k, v in self._dependents.items()},
            "weights": dict(self._stage_weights),
            "entry_stages": [s for s, d in self._dependencies.items() if not d],
            "leaf_stages": [s for s, c in self._dependents.items() if not c],
        }

    def find_stage_level(self, stage_name):
        """Return the topological level (depth) of a stage.

        Parameters
        ----------
        stage_name: Name of the stage.

        Returns
        -------
        int: Topological depth (0 = entry stage).
        """
        if stage_name not in self._dependencies:
            return -1
        deps = self._dependencies[stage_name]
        if not deps:
            return 0
        return 1 + max(self.find_stage_level(d) for d in deps)

    def get_critical_path_stages(self):
        """Return stage names on the critical path.

        Returns
        -------
        List[str]: Critical path stage names.
        """
        return self.optimizer.find_critical_path(self._dependencies, self._stage_weights)

    def get_parallel_groups(self):
        """Return groups of stages that can run in parallel.

        Returns
        -------
        List[List[str]]: Parallel groups.
        """
        return self.optimizer.find_parallel_groups(self._dependencies)

    def estimate_duration(self, stage_times):
        """Estimate total pipeline duration given per-stage times.

        Parameters
        ----------
        stage_times: Dict[str, float] predicted runtime per stage.

        Returns
        -------
        float: Estimated total pipeline duration in seconds.
        """
        schedule = self.build_schedule()
        return self.optimizer.estimate_makespan(schedule, stage_times)

    def __repr__(self) -> str:
        return f"PipelineScheduler(stages={len(self._stages)}, resources={self.resource_manager})"
