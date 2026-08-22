"""MoE training techniques complete reference."""
from __future__ import annotations
from typing import Any, Dict, List, Optional
import numpy as np


MOE_TRAINING_TECHNIQUES = {
    "load_balancing": {
        "auxiliary_loss": "Add load balancing loss to router (Mixtral style)",
        "z_loss": "Penalize extreme router logit values (DeepSeek-style)",
        "bias_adjustment": "Adjust bias terms instead of auxiliary loss (DeepSeek-V3)",
        "token_choice": "Let tokens choose experts, minimize overflow",
        "expert_choice": "Let experts choose tokens, guarantee balance",
    },
    "expert_architecture": {
        "fine_grained": "Many small experts (256 x 1/256) vs few large (64 x 1/64)",
        "shared_isolation": "Isolate shared experts for universal knowledge",
        "heterogeneous": "Varying expert sizes for different capability levels",
        "dynamic": "Create/destroy experts during training",
        "recursive": "Experts can spawn sub-experts for complex tasks",
    },
    "routing": {
        "top_k": "Route each token to top K experts (standard)",
        "expert_choice": "Each expert picks its top tokens (guaranteed balance)",
        "speculative": "Predict expert needs before full computation",
        "hash_based": "Use hash of input to determine expert (no training)",
        "learned": "Learned routing with gating network",
    },
    "training_stability": {
        "z_loss_coefficient": 0.001,
        "aux_loss_coefficient": 0.01,
        "capacity_factor": "2.0 → 0.5 progressive",
        "gradient_clipping": 1.0,
        "router_temperature": "1.0 → 0.3 annealing",
    },
    "optimization_targets": {
        "expert_utilization": "All experts should be used roughly equally",
        "specialization_quality": "Each expert should specialize in distinct domains",
        "communication_efficiency": "Minimize all-to-all communication between experts",
        "memory_efficiency": "Minimize total parameter memory",
        "inference_speed": "Maximize tokens per second",
    },
}

