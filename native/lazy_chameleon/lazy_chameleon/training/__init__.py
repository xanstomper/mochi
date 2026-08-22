"""Lazy Chameleon Training Infrastructure.

Comprehensive training pipeline for distilling teacher model reasoning into
faster student models. Includes:

- Synthetic data generation with task taxonomies
- Knowledge distillation (Chain-of-Thought, Constitutional AI)
- Training via LoRA or OpenAI fine-tuning API
- Multi-benchmark evaluation framework
- Dataset management and mixing
- Mass distillation pipeline (480B-10T scale)
- MoE (Mixture-of-Experts) distillation
- Cloud teacher adapter (OpenAI-compatible, Anthropic)
"""
from __future__ import annotations

from .synthetic_data_generator import (
    SyntheticDataGenerator,
    TaskTaxonomy,
    DataPoint,
    DataAugmentor,
    DatasetExporter,
)
from .distiller import (
    ChainOfThoughtDistiller,
    ConstitutionalDistiller,
    MultiTeacherEnsemble,
    InferenceTimeDistiller,
    PatternLibrary,
)
from .trainer import TrainingConfig, LoRATrainer, OpenAIFineTuner, DataPreparer
from .evaluator import (
    BenchmarkEvaluator,
    PairwiseEvaluator,
    ConstitutionalEvaluator,
    EvalResult,
)
from .dataset import TrainingDataset, DataMixer

# ── v2.5: Mass distillation components ─────────────────────────────────────────
from .mass_distiller import (
    MassDistillationPipeline,
    MassDistillationConfig,
    DistillationStage,
    StageConfig,
    DistillationRun,
)
from .moe_distiller import (
    MoEDistillationPipeline,
    MoERoutingDistiller,
    MoEDistillationConfig,
    ExpertRoutingRecord,
    ExpertPattern,
    ExpertDomain,
)
from .cloud_teacher import (
    CloudTeacherAdapter,
    CloudTeacherConfig,
    CloudTeacherEnsemble,
    TeacherEnsembleConfig,
    TeacherResponseCache,
    TeacherCall,
)

__all__ = [
    # Data Generation
    "SyntheticDataGenerator",
    "TaskTaxonomy",
    "DataPoint",
    "DataAugmentor",
    "DatasetExporter",
    # Distillation
    "ChainOfThoughtDistiller",
    "ConstitutionalDistiller",
    "MultiTeacherEnsemble",
    "InferenceTimeDistiller",
    "PatternLibrary",
    # Training
    "TrainingConfig",
    "LoRATrainer",
    "OpenAIFineTuner",
    "DataPreparer",
    # Evaluation
    "BenchmarkEvaluator",
    "PairwiseEvaluator",
    "ConstitutionalEvaluator",
    "EvalResult",
    # Dataset
    "TrainingDataset",
    "DataMixer",
    # Mass Distillation (v2.5)
    "MassDistillationPipeline",
    "MassDistillationConfig",
    "DistillationStage",
    "StageConfig",
    "DistillationRun",
    # MoE Distillation (v2.5)
    "MoEDistillationPipeline",
    "MoERoutingDistiller",
    "MoEDistillationConfig",
    "ExpertRoutingRecord",
    "ExpertPattern",
    "ExpertDomain",
    # Cloud Teacher (v2.5)
    "CloudTeacherAdapter",
    "CloudTeacherConfig",
    "CloudTeacherEnsemble",
    "TeacherEnsembleConfig",
    "TeacherResponseCache",
    "TeacherCall",
]

from .data_recipes import DataRecipe
from .distillation_dataset import (
    TrajectoryRecord, DistillationDataset as DistillationDatasetV2,
    TrajectoryQualityScorer,
)
from .distillation_pipeline import (
    DistillationPipeline, PipelineConfig as DistillationConfig,
)
from .mass_distillation import (
    MassDistillationOrchestrator as MassDistillationPipeline,
    MassDistillationConfig as MassDistillationConfigV2,
    DASDScheduler,
    DomainSampler,
    QualityGate,
    SFTFormatter,
    run_mass_distillation,
)
from .trajectory_collector import (
    TrajectoryCollector, CollectionConfig as CollectorConfig,
    estimate_cost,
)

__all__ = [
    # Data Recipes
    "DataRecipe",
    # Distillation Dataset
    "TrajectoryRecord", "DistillationDatasetV2", "TrajectoryQualityScorer",
    # Distillation Pipeline
    "DistillationPipeline", "DistillationConfig",
    # Mass Distillation
    "MassDistillationPipeline", "MassDistillationConfigV2",
    "DASDScheduler", "DomainSampler", "QualityGate", "SFTFormatter",
    "run_mass_distillation",
    # Trajectory Collector
    "TrajectoryCollector", "CollectorConfig", "estimate_cost",
]
# ── Real dataset registry (30+ frontier model datasets) ──────────────────────
from .dataset_registry import (
    DATASET_REGISTRY, DatasetSource, DistillationDataset,
    load_dataset, list_available_datasets, search_datasets,
    register_custom_source, get_source, UnifiedDatasetLoader, DatasetMix,
)
from .download_real_data import main as download_data_cli, DEFAULT_DATA_DIR

__all__ += [
    # Dataset Registry
    "DATASET_REGISTRY", "DatasetSource", "DistillationDataset",
    "load_dataset", "list_available_datasets", "search_datasets",
    "register_custom_source", "get_source", "UnifiedDatasetLoader", "DatasetMix",
    # Data Downloader
    "download_data_cli", "DEFAULT_DATA_DIR",
]


__version__ = "2.5.0"
