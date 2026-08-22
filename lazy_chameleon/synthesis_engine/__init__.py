"""Synthesis Engine — Scales 480B MoE to 1-5T using real synthetic parameters.

Components:
- ParamScaleEngine: Scales architecture (experts, layers, hidden size)
- FrontierMimic: Main agent mimics frontier models using synthesized params
- LazySynthesisCluster: 64 lazy synthesizers generating in parallel
- ParameterBrewingPipeline: End-to-end pipeline
- Merging: Model weight merging (SLERP, TIES, DARE, Task Arithmetic, etc.)
- MoEEvolution: Expert spawning, splitting, merging, evolution
- NAS: Neural Architecture Search
- SyntheticData: Self-Instruct, Evol-Instruct, Constitutional AI, etc.
- Distillation: Knowledge distillation methods
- Memory: Vector store and RAG system
- HyperNetwork: Weight generation hypernetwork
- MetaLearning: MAML, Reptile, few-shot learning
- Evolutionary: NEAT, CMA-ES, MAP-Elites, Genetic Programming
- TestTimeCompute: Tree-of-Thoughts, MCTS, Self-Consistency, etc.
- ParameterEfficiency: LoRA, QLoRA, DoRA, AdaLoRA, Prefix/Prompt Tuning
- KnowledgeInjection: RAG, Tool Augmentation, Knowledge Graph, Neuro-Symbolic
"""
from __future__ import annotations

from .param_scale_engine import ParamScaleEngine, ParamScaleConfig, ScaledConfig
from .frontier_mimic import FrontierMimic, FrontierProfile, FRONTIER_PROFILES
from .lazy_synthesis_cluster import LazySynthesisCluster, LazySynthesizer
from .brewing_pipeline import ParameterBrewingPipeline, PipelineResult

from .merging.model_merger import (
    slerp, ties_merge, dare_merge, task_arithmetic,
    weight_averaging, fisher_merge, regmean_merge, MergedWeights,
)
from .moe_evolution.expert_spawner import (
    ExpertSpawner, ExpertPool, ExpertRoutingTable,
    spawn_expert, split_expert, merge_experts, evolve_pool,
)
from .nas.neural_arch_search import (
    LayerConfig, AttentionConfig, RoutingNetworkConfig,
    ArchitectureSpec, ArchitectureGenerator,
    generate_layer, generate_attention_block, generate_routing_network,
    mutate_architecture, crossover_architectures,
    estimate_latency, estimate_memory,
)
from .synthetic_data.data_generator import (
    SynthDataGenerator, SynthSample, SynthDataset,
    self_instruct, evol_instruct, constitutional_ai,
    rejection_sampling, self_play, debate_data,
    cot_distillation, reflection_data,
)
from .distillation.knowledge_distiller import (
    DistillationResult, KnowledgeDistiller,
    teacher_student_distill, progressive_distill, layer_distill,
    attention_distill, feature_distill, hidden_state_distill,
    logit_distill, speculative_distill,
)
from .memory.vector_store import (
    VectorStore, VectorIndex, FlatIndex, IVFIndex,
    HNSWIndex, CollectionManager, EmbeddingManager,
)
from .memory.rag_system import (
    RAGSystem, GraphRAG, LightRAG,
    retrieve, augment, graph_rag, lightrag,
)
from .hypernetwork.hypernetwork import (
    HyperNetwork, DynamicHyperNetwork, ContextEncoder, ParameterDecoder,
    generate_mlp_weights, generate_attention_weights, generate_expert_weights,
)
from .meta_learning.meta_learner import (
    MAML, Reptile, InnerLoopOptimizer,
    TaskDistribution, TaskSampler, QuickAdaptationModule,
)
from .evolutionary.evolution_engine import (
    NEATEvolution, CMAES, MAPElites, GeneticProgram,
    PopulationManager, Individual, FitnessEvaluator,
)
from .test_time_compute.compute_expander import (
    TreeOfThoughts, GraphOfThoughts, SelfConsistency,
    Reflection, ReAct, MCTS, SearchAugmentedReasoning,
)
from .parameter_efficiency.adapter_generator import (
    LoRA, QLoRA, DoRA, AdaLoRA, VeRA, LoHa, LoKr,
    PrefixTuning, PromptTuning, AdapterGenerator,
    AdapterConfig, AdapterWeights,
    combine_adapters, merge_adapters, generate_batch_adapters,
)
from .knowledge_injection.knowledge_injector import (
    RAGInjector, ToolAugmentedLLM, GraphMemory,
    KnowledgeGraph, NeuroSymbolicSystem, SymbolicDistillation,
)

__all__ = [
    "ParamScaleEngine", "ParamScaleConfig", "ScaledConfig",
    "FrontierMimic", "FrontierProfile", "FRONTIER_PROFILES",
    "LazySynthesisCluster", "LazySynthesizer",
    "ParameterBrewingPipeline", "PipelineResult",
    "slerp", "ties_merge", "dare_merge", "task_arithmetic",
    "weight_averaging", "fisher_merge", "regmean_merge", "MergedWeights",
    "ExpertSpawner", "ExpertPool", "ExpertRoutingTable",
    "spawn_expert", "split_expert", "merge_experts", "evolve_pool",
    "LayerConfig", "AttentionConfig", "RoutingNetworkConfig",
    "ArchitectureSpec", "ArchitectureGenerator",
    "generate_layer", "generate_attention_block", "generate_routing_network",
    "mutate_architecture", "crossover_architectures",
    "estimate_latency", "estimate_memory",
    "SynthDataGenerator", "SynthSample", "SynthDataset",
    "self_instruct", "evol_instruct", "constitutional_ai",
    "rejection_sampling", "self_play", "debate_data",
    "cot_distillation", "reflection_data",
    "DistillationResult", "KnowledgeDistiller",
    "teacher_student_distill", "progressive_distill", "layer_distill",
    "attention_distill", "feature_distill", "hidden_state_distill",
    "logit_distill", "speculative_distill",
    "VectorStore", "VectorIndex", "FlatIndex", "IVFIndex",
    "HNSWIndex", "CollectionManager", "EmbeddingManager",
    "RAGSystem", "GraphRAG", "LightRAG",
    "retrieve", "augment", "graph_rag", "lightrag",
    "HyperNetwork", "DynamicHyperNetwork", "ContextEncoder", "ParameterDecoder",
    "generate_mlp_weights", "generate_attention_weights", "generate_expert_weights",
    "MAML", "Reptile", "InnerLoopOptimizer",
    "TaskDistribution", "TaskSampler", "QuickAdaptationModule",
    "NEATEvolution", "CMAES", "MAPElites", "GeneticProgram",
    "PopulationManager", "Individual", "FitnessEvaluator",
    "TreeOfThoughts", "GraphOfThoughts", "SelfConsistency",
    "Reflection", "ReAct", "MCTS", "SearchAugmentedReasoning",
    "LoRA", "QLoRA", "DoRA", "AdaLoRA", "VeRA", "LoHa", "LoKr",
    "PrefixTuning", "PromptTuning", "AdapterGenerator",
    "AdapterConfig", "AdapterWeights",
    "combine_adapters", "merge_adapters", "generate_batch_adapters",
    "RAGInjector", "ToolAugmentedLLM", "GraphMemory",
    "KnowledgeGraph", "NeuroSymbolicSystem", "SymbolicDistillation",
]
