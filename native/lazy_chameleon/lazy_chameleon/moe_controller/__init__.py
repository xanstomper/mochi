"""MoE Controller — Expert splitting, routing, and management system.

Architecture:
- 1 expert = Main Agent (reasoning, decision-making, output)
- N experts = Data Synthesizers (distillation pots that brew training data)

The synthesizers generate parameters from real data, the main agent reasons with them.
"""
from .split_merge_moe import SplitMergeMoE
from .expert_splitter import ExpertSplitter, SplitConfig, ExpertRole, ExpertAssignment
from .auto_moe import AutoMoE
from .moe_controller import MoEController
from .split_merge_moe import SplitMergeMoE
from .expert_splitter import ExpertSplitter, SplitConfig
from .data_brewer import DataBrewer, BrewingConfig
from .distillation_pot import DistillationPot, PotConfig
from .agent_orchestrator import AgentOrchestrator
__all__ = ["MoEController", "ExpertRole", "ExpertAssignment", "ExpertSplitter", "SplitConfig", "AutoMoE",
           "DataBrewer", "BrewingConfig", "DistillationPot", "PotConfig", "AgentOrchestrator"]
