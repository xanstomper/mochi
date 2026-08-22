"""Pipeline orchestration package for Lazy Chameleon.

Provides DAG-based data pipeline execution with scheduling, monitoring,
caching, quality gating, batch processing, and curriculum learning.

Exports
-------
Core pipeline components:
    PipelineStage, DataPipeline, PipelineContext, PipelineResult, StageStatus

Scheduling & dependency management:
    PipelineScheduler, StageDependency, ScheduleOptimizer, ResourceManager

Monitoring & alerting:
    PipelineMonitor, StageMetrics, AlertManager, DashboardData

Caching & artifact storage:
    PipelineCache, ArtifactStore, CacheKey, CacheStats

Quality gating:
    QualityGate, QualityScorer, ThresholdPolicy, DomainRouter

Batch processing:
    BatchProcessor, WorkQueue, WorkerPool, ProgressTracker

Curriculum learning:
    CurriculumScheduler, LessonPlan, DifficultyScaler, DomainBalancer
"""

from lazy_chameleon.pipeline.core import (
    PipelineStage,
    DataPipeline,
    PipelineContext,
    PipelineResult,
    StageStatus,
)
from lazy_chameleon.pipeline.scheduler import (
    PipelineScheduler,
    StageDependency,
    ScheduleOptimizer,
    ResourceManager,
)
from lazy_chameleon.pipeline.monitor import (
    PipelineMonitor,
    StageMetrics,
    AlertManager,
    DashboardData,
)
from lazy_chameleon.pipeline.cache import (
    PipelineCache,
    ArtifactStore,
    CacheKey,
    CacheStats,
)
from lazy_chameleon.pipeline.quality import (
    QualityGate,
    QualityScorer,
    ThresholdPolicy,
    DomainRouter,
)
from lazy_chameleon.pipeline.batch import (
    BatchProcessor,
    WorkQueue,
    WorkerPool,
    ProgressTracker,
)
from lazy_chameleon.pipeline.curriculum import (
    CurriculumScheduler,
    LessonPlan,
    DifficultyScaler,
    DomainBalancer,
)

__all__ = [
    # core
    "PipelineStage",
    "DataPipeline",
    "PipelineContext",
    "PipelineResult",
    "StageStatus",
    # scheduler
    "PipelineScheduler",
    "StageDependency",
    "ScheduleOptimizer",
    "ResourceManager",
    # monitor
    "PipelineMonitor",
    "StageMetrics",
    "AlertManager",
    "DashboardData",
    # cache
    "PipelineCache",
    "ArtifactStore",
    "CacheKey",
    "CacheStats",
    # quality
    "QualityGate",
    "QualityScorer",
    "ThresholdPolicy",
    "DomainRouter",
    # batch
    "BatchProcessor",
    "WorkQueue",
    "WorkerPool",
    "ProgressTracker",
    # curriculum
    "CurriculumScheduler",
    "LessonPlan",
    "DifficultyScaler",
    "DomainBalancer",
]
