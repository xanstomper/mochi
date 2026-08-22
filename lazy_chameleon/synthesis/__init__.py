"""Parameter Synthesis Engine — inference-time compute expansion strategies."""

from .hypernet import HypernetworkSynthesizer
from .distillation import DistillationEngine
from .rag import RAGEngine
from .adapters import DynamicAdapterManager
from .router import MoERouter
from .compute import DynamicComputeScheduler
from .adaptive_moe import AdaptiveMoE, MoEConfig, MicroExpert
from .evolution_engine import EvolutionEngine, StrategyGene, EvolutionConfig
from .mcts import MCTSSearch, MCTSConfig, MCTSResult
from .prompt_compiler import DynamicPromptCompiler, PromptComponent

__all__ = [
    "HypernetworkSynthesizer", "DistillationEngine", "RAGEngine",
    "DynamicAdapterManager", "MoERouter", "DynamicComputeScheduler",
    # v3 Engines
    "AdaptiveMoE", "MoEConfig", "MicroExpert",
    "EvolutionEngine", "StrategyGene", "EvolutionConfig",
    "MCTSSearch", "MCTSConfig", "MCTSResult",
    "DynamicPromptCompiler", "PromptComponent",
]
