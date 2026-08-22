"""TrainingMethods — Fine-tuning and training approaches."""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

@dataclass
class TrainingConfig:
    method: str = "sft"
    learning_rate: float = 2e-5
    batch_size: int = 8
    epochs: int = 3
    warmup_ratio: float = 0.05
    max_seq_length: int = 4096
    gradient_checkpointing: bool = True
    mixed_precision: str = "bf16"
    optimizer: str = "adamw"
    lr_scheduler: str = "cosine"
    weight_decay: float = 0.01
    logging_steps: int = 10
    save_steps: int = 500
    eval_steps: int = 500

@dataclass
class FineTuneConfig:
    method: str = "lora"
    r: int = 16
    alpha: int = 32
    dropout: float = 0.05
    target_modules: List[str] = field(default_factory=lambda: ["q_proj", "v_proj"])

class TrainingMethod:
    METHODS = ["sft", "dpo", "ppo", "rejection_sampling", "emulator", "online_dpo"]

    def __init__(self):
        self.config = TrainingConfig()

    def get_method(self, name: str) -> Dict:
        return {"name": name, "config": self.config.__dict__}

class FineTuneMethod:
    METHODS = ["lora", "qlora", "lora+", "dora", "loha", "lokr", "oft", "boft"]

    def __init__(self):
        self.config = FineTuneConfig()

    def recommend(self, model_size: str) -> str:
        if model_size == "7B":
            return "lora"
        elif model_size == "13B":
            return "lora"
        elif model_size == "34B":
            return "qlora"
        elif model_size == "70B":
            return "qlora"
        return "lora"
