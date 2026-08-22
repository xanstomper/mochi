"""MoEFrontier — Frontier MoE techniques. See sub-modules for details."""
from __future__ import annotations
from typing import Any, Callable, Dict, List, Optional, Tuple
import math
import numpy as np
import random

from .optimizers.muon import MuonOptimizer
from .compression.alpha_q import AlphaQ
from .routing.romer import ROMER
from .routing.expert_choice import ExpertChoiceRouting
from .routing.progressive_sparse import ProgressiveSparsification
from .optimizers.mla import MLA
from .optimizers.moe_loss import MoELoss
from .routing.game_theory import MoEGameTheory
from .compression.wina import WINA
from .pipeline import MoEFrontierPipeline

__all__ = [
    "MuonOptimizer",
    "AlphaQ",
    "ROMER",
    "ExpertChoiceRouting",
    "ProgressiveSparsification",
    "MLA",
    "MoELoss",
    "MoEGameTheory",
    "WINA",
    "MoEFrontierPipeline",
]
