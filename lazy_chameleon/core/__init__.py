"""Core type definitions and reasoning engines for Lazy Chameleon."""

from .types import (
    LazyOutput, CompressedIntelligence, Solution, Result,
    ProviderConfig, AgentChainConfig,
)
from .compute_currency import ComputeCurrency, CreditLedger
from .debate_engine import DebateEngine, DebateRound, DebateResult
from .expert_genome import ExpertGenome, ExpertGenomeLibrary, ExpertGene
from .failure_predictor import FailurePredictor, FailurePrediction
from .latent_workspace import LatentWorkspace, WorkspaceEntry
from .neural_cache import NeuralCache, CachedPattern
from .recursive_planner import RecursivePlanner, ExecutionPlan, PlanNode
from .simulation_engine import SimulationEngine, SimulatedFuture, SimulationResult
from .skill_library import SkillLibrary, Skill
from .thought_market import ThoughtMarket, ThoughtCandidate
from .world_state import WorldStateGraph, StateNode, StateEdge

__all__ = [
    # Types
    "LazyOutput", "CompressedIntelligence", "Solution", "Result",
    "ProviderConfig", "AgentChainConfig",
    # Compute Currency
    "ComputeCurrency", "CreditLedger",
    # Debate
    "DebateEngine", "DebateRound", "DebateResult",
    # Expert Genome
    "ExpertGenome", "ExpertGenomeLibrary", "ExpertGene",
    # Failure Predictor
    "FailurePredictor", "FailurePrediction",
    # Latent Workspace
    "LatentWorkspace", "WorkspaceEntry",
    # Neural Cache
    "NeuralCache", "CachedPattern",
    # Recursive Planner
    "RecursivePlanner", "ExecutionPlan", "PlanNode",
    # Simulation
    "SimulationEngine", "SimulatedFuture", "SimulationResult",
    # Skill Library
    "SkillLibrary", "Skill",
    # Thought Market
    "ThoughtMarket", "ThoughtCandidate",
    # World State
    "WorldStateGraph", "StateNode", "StateEdge",
]
