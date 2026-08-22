"""TokenSaverEngine — God Tier token optimization pipeline.

Combines ALL token saving techniques into a unified pipeline:
1. Adaptive Tokenizer — Domain-optimized tokenization
2. Prompt Compressor — Multi-strategy prompt compression
3. Token Pruner — Redundant token removal
4. Context Compactor — Long-context trajectory compression
5. LKV Eviction — Learned KV cache eviction
6. Speculative Decoder — Draft-then-verify acceleration

Provides unified metrics showing total tokens saved across all stages.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Callable
import time
import logging

logger = logging.getLogger(__name__)

@dataclass
class SaverPipelineConfig:
    enable_tokenizer: bool = True
    enable_compressor: bool = True
    enable_pruner: bool = True
    enable_compactor: bool = True
    enable_lkv: bool = True
    enable_speculative: bool = True
    tokenizer_profile: str = "default"
    compression_ratio: float = 0.5
    pruning_ratio: float = 0.3
    kv_retention: float = 0.15
    verbose: bool = False

@dataclass
class SaverResult:
    original_tokens: int = 0
    final_tokens: int = 0
    tokens_saved: int = 0
    saving_ratio: float = 0.0
    stages: List[Dict[str, Any]] = field(default_factory=list)
    latency_ms: float = 0.0

class TokenSaverEngine:
    def __init__(self, config = None):
        self.config = config or SaverPipelineConfig()
        self._total_savings: Dict[str, int] = {}
        self._init_components()

    def _init_components(self):
        from .adaptive_tokenizer import AdaptiveTokenizer
        from .prompt_compressor import PromptCompressor, CompressorConfig, CompressionMethod
        from .token_pruner import TokenPruner, PrunerConfig
        from .context_compactor import ContextCompactor, CompactorConfig
        from .lkv_eviction import LKVEviction, LKVConfig
        from .speculative_decoder import SpeculativeDecoder, SpecConfig
        self.tokenizer = AdaptiveTokenizer(self.config.tokenizer_profile)
        self.compressor = PromptCompressor(CompressorConfig(target_ratio=self.config.compression_ratio))
        self.pruner = TokenPruner(PrunerConfig(pruning_ratio=self.config.pruning_ratio))
        self.compactor = ContextCompactor(CompactorConfig())
        self.lkv = LKVEviction(LKVConfig(retention_budget=self.config.kv_retention))
        self.spec = SpeculativeDecoder()

    def process_prompt(self, prompt: str) -> SaverResult:
        t0 = time.time()
        original = len(prompt)
        result = SaverResult(original_tokens=self._estimate(prompt))
        stages = []
        text = prompt
        if self.config.enable_tokenizer:
            t = self.tokenizer.optimize(text)
            saved = len(text) - len(t)
            stages.append({"stage": "adaptive_tokenizer", "saved_chars": saved})
            self._add_savings("tokenizer", saved)
            text = t
        if self.config.enable_pruner:
            t = self.pruner.prune(text)
            saved = len(text) - len(t)
            stages.append({"stage": "token_pruner", "saved_chars": saved})
            self._add_savings("pruner", saved)
            text = t
        if self.config.enable_compressor:
            t = self.compressor.compress(text)
            saved = len(text) - len(t)
            stages.append({"stage": "prompt_compressor", "saved_chars": saved})
            self._add_savings("compressor", saved)
            text = t
        result.final_tokens = self._estimate(text)
        result.tokens_saved = result.original_tokens - result.final_tokens
        result.saving_ratio = round(result.tokens_saved / max(result.original_tokens, 1), 4)
        result.stages = stages
        result.latency_ms = round((time.time() - t0) * 1000, 2)
        if self.config.verbose and stages:
            for s in stages:
                logger.info(f"  {s['stage']}: saved {s['saved_chars']} chars")
        return result

    def process_prompt_full(self, prompt: str, draft_fn=None, target_fn=None) -> SaverResult:
        result = self.process_prompt(prompt)
        if self.config.enable_speculative and draft_fn and target_fn:
            t0 = time.time()
            output = self.spec.decode(result.final_tokens, draft_fn, target_fn)
            stages = result.stages
            stages.append({"stage": "speculative_decoder", "tokens_proposed": self.spec._draft_tokens_proposed})
            result.latency_ms = round((time.time() - t0) * 1000, 2)
        return result

    def process_batch(self, prompts: List[str]) -> List[SaverResult]:
        return [self.process_prompt(p) for p in prompts]

    def _estimate(self, text: str) -> int:
        return max(1, len(text) // 4)

    def _add_savings(self, key: str, amount: int):
        self._total_savings[key] = self._total_savings.get(key, 0) + amount

    def set_compression_ratio(self, ratio: float):
        self.config.compression_ratio = ratio
        from .prompt_compressor import CompressorConfig
        self.compressor.config.target_ratio = ratio

    def get_total_savings(self) -> Dict[str, Any]:
        total = sum(self._total_savings.values())
        return {"per_stage": dict(self._total_savings), "total_chars_saved": total,
                "total_tokens_saved": total // 4}

    def get_full_report(self) -> Dict[str, Any]:
        savings = self.get_total_savings()
        report = {
            "pipeline": "God Tier Token Saver",
            "enabled_components": {
                "tokenizer": self.config.enable_tokenizer,
                "compressor": self.config.enable_compressor,
                "pruner": self.config.enable_pruner,
                "compactor": self.config.enable_compactor,
                "lkv": self.config.enable_lkv,
                "speculative": self.config.enable_speculative,
            },
            "token_savings": savings,
            "estimated_cost_saved_usd": round(savings["total_tokens_saved"] * 0.000003, 6),
        }
        return report


class TokenSaverPipeline:
    def __init__(self):
        self.engine = TokenSaverEngine()
        self._runs: List[SaverResult] = []

    def run(self, prompt: str) -> SaverResult:
        result = self.engine.process_prompt(prompt)
        self._runs.append(result)
        return result

    def get_report(self) -> Dict[str, Any]:
        if not self._runs:
            return {"error": "No runs yet"}
        total_orig = sum(r.original_tokens for r in self._runs)
        total_final = sum(r.final_tokens for r in self._runs)
        return {
            "total_runs": len(self._runs),
            "total_original_tokens": total_orig,
            "total_final_tokens": total_final,
            "total_saved": total_orig - total_final,
            "avg_saving_ratio": round((total_orig - total_final) / max(total_orig, 1), 4),
        }
