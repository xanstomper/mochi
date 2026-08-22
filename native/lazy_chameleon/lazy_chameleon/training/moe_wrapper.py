"""
MoE Wrapper Engine — combines IGUANA-style expert streaming with HuggingFace datasets
for large-scale Mixture-of-Experts distillation pipelines.

Architecture:
  1. ExpertStreamLoader        — IGUANA-inspired streaming expert loader (simulates
     disk-streamed experts, 744B total / ~40B active per token).
  2. MoEDatasetAdapter         — Adapts HuggingFace datasets (via DistillationDataset)
     into MoE-specific training examples with expert routing.
  3. MultiSourceMoEPipeline    — Orchestrates training from multiple registry sources,
     staged distillation, cloud teacher distillation, and evaluation.
  4. MoEIGUANAEngine           — Full MoE engine wrapper (expert count, top-k routing,
     parameter accounting, checkpointing).
  5. create_default_pipeline() — Factory that wires everything together.
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import random
import threading
import time
from collections import defaultdict
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

from lazy_chameleon.training.dataset_registry import (
    DATASET_REGISTRY,
    DistillationDataset,
    DatasetMix,
    load_dataset,
    UnifiedDatasetLoader,
)
from lazy_chameleon.training.moe_distiller import (
    MoEDistillationPipeline,
    MoEDistillationConfig,
    MoERoutingDistiller,
    ExpertDomain,
    ExpertPattern,
)
from lazy_chameleon.training.mass_distiller import (
    DistillationStage,
    MassDistillationConfig,
    MassDistillationPipeline,
)
from lazy_chameleon.training.cloud_teacher import (
    CloudTeacherAdapter,
    CloudTeacherConfig,
    CloudTeacherEnsemble,
)
from lazy_chameleon.training.dataset import DataPoint, TrainingDataset

log = logging.getLogger(__name__)

# ──────────────────────────────────────────────────────────────────────────────
# Constants — IGUANA-inspired scale defaults
# ──────────────────────────────────────────────────────────────────────────────

_IGUANA_TOTAL_PARAMS: int = 744_000_000_000       # 744B total
_IGUANA_ACTIVE_PARAMS: int = 40_000_000_000        # ~40B active per token
_IGUANA_EXPERT_COUNT: int = 256                     # Experts (256 total)
_IGUANA_TOP_K: int = 2                             # Top-2 routing
_DEFAULT_EXPERT_PARAMS: int = 2_000_000_000          # ~2B params per expert
_ROUTER_PARAMS: int = 50_000_000                     # ~50M for the gating/routing net

# ══════════════════════════════════════════════════════════════════════════════
# 1  ExpertStreamLoader — IGUANA-style streaming expert loader
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class ExpertSpec:
    """Specification for a single MoE expert."""

    expert_id: str
    """Unique expert identifier (e.g. ``expert_0``)."""

    domain: ExpertDomain
    """Primary domain this expert specialises in."""

    capacity: int
    """Number of parameters in this expert's feed-forward network."""

    hidden_dim: int = 4096
    """Hidden dimension of the expert FFN."""

    intermediate_dim: int = 14336
    """Intermediate (expansion) dimension."""

    num_layers: int = 1
    """Number of FFN layers in this expert."""

    load_count: int = 0
    """Number of times this expert has been loaded (simulated streaming counter)."""

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> ExpertSpec:
        d = dict(d)
        d["domain"] = ExpertDomain(d["domain"]) if "domain" in d else ExpertDomain.MULTI
        return cls(**d)


class ExpertStreamLoader:
    """IGUANA-inspired streaming expert loader.

    Simulates the concept of streaming experts from disk (as described in the
    IGUANA 744B MoE architecture — 256 experts, ~40B active per token, experts
    streamed on-demand from off-chip memory).

    In a real deployment this class would wrap an actual disk-backed expert
    store (e.g. mmap'd weight files).  Here it provides a realistic simulation
    so that the pipeline can be developed and tested end-to-end.
    """

    def __init__(
        self,
        num_experts: int = _IGUANA_EXPERT_COUNT,
        top_k: int = _IGUANA_TOP_K,
        base_path: Optional[str | Path] = None,
        seed: int = 42,
    ) -> None:
        """
        Parameters
        ----------
        num_experts:
            Total number of simulated experts.
        top_k:
            Number of experts to activate per token (top-k routing).
        base_path:
            Optional path to a real expert weight directory.  When ``None``
            weights are simulated in-memory.
        seed:
            Random seed for reproducible expert-domain assignments.
        """
        self.num_experts = num_experts
        self.top_k = top_k
        self.base_path = Path(base_path) if base_path else None
        self._rng = random.Random(seed)
        self._lock = threading.Lock()

        # Build expert specs with domain assignments
        self._experts: dict[str, ExpertSpec] = {}
        self._build_expert_specs(seed)

        # Simulated weight cache (in-memory)
        self._weight_cache: dict[str, dict] = {}
        self._cache_hits = 0
        self._cache_misses = 0

    # ── Public API ──────────────────────────────────────────────────────────

    def load_expert_weights(self, expert_id: str) -> dict:
        """Load (or simulate loading) expert weights for *expert_id*.

        Returns a dictionary describing the expert's weight layout::

            {
                "expert_id": str,
                "domain": str,
                "capacity": int,
                "hidden_dim": int,
                "intermediate_dim": int,
                "num_layers": int,
                "weights": dict[str, list],   # simulated weight tensors
                "loaded_from_disk": bool,
            }

        If ``base_path`` is set, this would read the actual weights from disk;
        otherwise random normal tensors are generated once and cached.
        """
        if expert_id not in self._experts:
            raise KeyError(f"Unknown expert: {expert_id!r}. "
                           f"Available: {list(self._experts.keys())}")

        with self._lock:
            if expert_id in self._weight_cache:
                self._cache_hits += 1
                cached = dict(self._weight_cache[expert_id])
                cached["loaded_from_disk"] = False
                return cached

            self._cache_misses += 1
            spec = self._experts[expert_id]

            # Simulate loading from disk (or generating)
            if self.base_path is not None:
                weights = self._load_from_disk(expert_id, spec)
                loaded_from_disk = True
            else:
                weights = self._generate_weights(spec)
                loaded_from_disk = False

            result: dict = {
                "expert_id": expert_id,
                "domain": spec.domain.value,
                "capacity": spec.capacity,
                "hidden_dim": spec.hidden_dim,
                "intermediate_dim": spec.intermediate_dim,
                "num_layers": spec.num_layers,
                "weights": weights,
                "loaded_from_disk": loaded_from_disk,
            }
            self._weight_cache[expert_id] = result
            spec.load_count += 1
            return result

    def stream_experts(self, task: str, top_k: Optional[int] = None) -> list[str]:
        """Return which experts should be activated for a given *task*.

        This simulates the IGUANA routing logic: for a given input, the router
        selects the *top_k* most relevant experts.  The actual routing is
        delegated to :class:`MoERoutingDistiller` when available; otherwise a
        simple domain-keyword heuristic is used.

        Parameters
        ----------
        task:
            The input task / prompt text.
        top_k:
            Override for the number of experts to return (defaults to
            ``self.top_k``).

        Returns
        -------
        list[str]
            Sorted list of expert IDs that should be activated.
        """
        k = top_k if top_k is not None else self.top_k
        k = min(k, self.num_experts)

        # Simple domain-keyword heuristic
        task_lower = task.lower()
        domain_scores: dict[ExpertDomain, float] = {d: 0.0 for d in ExpertDomain}

        keyword_map: dict[str, ExpertDomain] = {
            "code": ExpertDomain.CODE,
            "program": ExpertDomain.CODE,
            "python": ExpertDomain.CODE,
            "javascript": ExpertDomain.CODE,
            "def ": ExpertDomain.CODE,
            "math": ExpertDomain.MATH,
            "equation": ExpertDomain.MATH,
            "calculate": ExpertDomain.MATH,
            "theorem": ExpertDomain.MATH,
            "reason": ExpertDomain.REASON,
            "think": ExpertDomain.REASON,
            "explain": ExpertDomain.REASON,
            "logic": ExpertDomain.REASON,
            "science": ExpertDomain.SCIENCE,
            "physics": ExpertDomain.SCIENCE,
            "chemistry": ExpertDomain.SCIENCE,
            "biology": ExpertDomain.SCIENCE,
            "write": ExpertDomain.WRITING,
            "essay": ExpertDomain.WRITING,
            "story": ExpertDomain.WRITING,
            "poem": ExpertDomain.WRITING,
            "analyze": ExpertDomain.ANALYSIS,
            "comparison": ExpertDomain.ANALYSIS,
            "evaluate": ExpertDomain.ANALYSIS,
            "safe": ExpertDomain.SAFETY,
            "harm": ExpertDomain.SAFETY,
            "ethical": ExpertDomain.SAFETY,
        }

        for kw, dom in keyword_map.items():
            if kw in task_lower:
                domain_scores[dom] += 1.0

        # Score each expert by domain match + small random jitter
        expert_scores: list[tuple[str, float]] = []
        for eid, spec in self._experts.items():
            score = domain_scores.get(spec.domain, 0.0)
            score += self._rng.gauss(0, 0.1)  # jitter for diversity
            expert_scores.append((eid, score))

        expert_scores.sort(key=lambda x: x[1], reverse=True)
        return [eid for eid, _ in expert_scores[:k]]

    def get_expert_capacity(self, expert_id: str) -> int:
        """Return the parameter count for *expert_id*.

        Raises :class:`KeyError` if the expert does not exist.
        """
        if expert_id not in self._experts:
            raise KeyError(f"Unknown expert: {expert_id!r}")
        return self._experts[expert_id].capacity

    def get_expert_spec(self, expert_id: str) -> ExpertSpec:
        """Return the full :class:`ExpertSpec` for *expert_id*."""
        if expert_id not in self._experts:
            raise KeyError(f"Unknown expert: {expert_id!r}")
        return self._experts[expert_id]

    def list_experts(self) -> list[ExpertSpec]:
        """Return specs for all managed experts."""
        return list(self._experts.values())

    def get_cache_stats(self) -> dict:
        """Return weight cache hit/miss statistics."""
        with self._lock:
            total = self._cache_hits + self._cache_misses
            return {
                "cache_hits": self._cache_hits,
                "cache_misses": self._cache_misses,
                "hit_ratio": round(self._cache_hits / total, 4) if total > 0 else 0.0,
                "cached_experts": len(self._weight_cache),
            }

    # ── Internal helpers ────────────────────────────────────────────────────

    def _build_expert_specs(self, seed: int) -> None:
        rng = random.Random(seed)
        domain_cycle = [
            ExpertDomain.CODE, ExpertDomain.MATH, ExpertDomain.REASON,
            ExpertDomain.SCIENCE, ExpertDomain.WRITING, ExpertDomain.ANALYSIS,
            ExpertDomain.SAFETY, ExpertDomain.MULTI,
        ]
        for i in range(self.num_experts):
            eid = f"expert_{i}"
            domain = domain_cycle[i % len(domain_cycle)]
            # Simulate varying capacity per expert (like IGUANA's heterogeneous experts)
            capacity = int(_DEFAULT_EXPERT_PARAMS * (0.8 + 0.4 * rng.random()))
            hidden_dim = int(4096 * (0.9 + 0.2 * rng.random()))
            intermediate_dim = int(14336 * (0.9 + 0.2 * rng.random()))
            self._experts[eid] = ExpertSpec(
                expert_id=eid,
                domain=domain,
                capacity=capacity,
                hidden_dim=hidden_dim,
                intermediate_dim=intermediate_dim,
                num_layers=1,
            )

    def _generate_weights(self, spec: ExpertSpec) -> dict:
        """Generate simulated weight tensors for an expert."""
        rng = random.Random(hash(spec.expert_id) & 0xFFFFFFFF)
        return {
            "gate_proj": [[rng.gauss(0, 0.02) for _ in range(spec.hidden_dim)]
                          for _ in range(spec.intermediate_dim)],
            "up_proj":   [[rng.gauss(0, 0.02) for _ in range(spec.hidden_dim)]
                          for _ in range(spec.intermediate_dim)],
            "down_proj": [[rng.gauss(0, 0.02) for _ in range(spec.intermediate_dim)]
                          for _ in range(spec.hidden_dim)],
            "shape": {
                "hidden_dim": spec.hidden_dim,
                "intermediate_dim": spec.intermediate_dim,
            },
        }

    def _load_from_disk(self, expert_id: str, spec: ExpertSpec) -> dict:
        """Attempt to load weights from ``self.base_path / {expert_id}.bin``."""
        bp = self.base_path
        path = bp / f"{expert_id}.bin" if bp else None
        if path is None or not path.exists():
            log.warning("Expert weight file not found: %%s — falling back to generated weights", path)
            return self._generate_weights(spec)
        log.info("Loading expert weights from %%s", path)
        return {"loaded_from": str(path), "expert_id": expert_id}

    def __repr__(self) -> str:
        return (
            f"ExpertStreamLoader(experts={self.num_experts}, "
            f"top_k={self.top_k}, cached={len(self._weight_cache)})"
        )

# ══════════════════════════════════════════════════════════════════════════════
# 2  MoEDatasetAdapter — adapts HuggingFace datasets for MoE training
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class MoETrainingExample:
    """A single MoE-specific training example derived from a distillation dataset.

    Attributes
    ----------
    task:
        The input / prompt text.
    teacher_response:
        The full teacher response to use as ground-truth.
    expert_ids:
        Which experts should be activated for this example (routing labels).
    routing_weights:
        Routing weights / logits for each active expert.
    domain:
        Detected domain for this example.
    routing_pattern:
        The routing strategy used (``top_k``, ``top_p``, etc.).
    metadata:
        Additional information preserved from the source datapoint.
    """
    task: str
    teacher_response: str
    expert_ids: list[str]
    routing_weights: list[float]
    domain: str
    routing_pattern: str = "top_k"
    metadata: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> MoETrainingExample:
        return cls(**d)


class MoEDatasetAdapter:
    """Adapts HuggingFace datasets (via :class:`DistillationDataset`) into
    MoE-specific training examples.

    For each source datapoint the adapter:
      1. Selects which experts should be active using the expert stream loader
         (or a provided :class:`MoERoutingDistiller`).
      2. Extracts expert routing patterns from the teacher response.
      3. Generates expert-conditional training data with routing labels.

    This allows the student model to learn both *what* the teacher output and
    *which experts* the MoE teacher activated.
    """

    def __init__(
        self,
        expert_loader: ExpertStreamLoader,
        routing_distiller: Optional[MoERoutingDistiller] = None,
    ) -> None:
        """
        Parameters
        ----------
        expert_loader:
            The streaming expert loader used to determine expert activations.
        routing_distiller:
            Optional :class:`MoERoutingDistiller` for more sophisticated
            routing pattern extraction.  If ``None``, patterns are extracted
            from the expert loader's keyword-based routing.
        """
        self.expert_loader = expert_loader
        self.routing_distiller = routing_distiller

    def adapt_dataset(
        self,
        dataset: DistillationDataset | TrainingDataset,
        *,
        max_examples: Optional[int] = None,
        streaming: bool = False,
        progress_callback: Optional[Callable[[int, int], None]] = None,
    ) -> list[MoETrainingExample]:
        """Convert a distillation dataset into MoE training examples.

        Parameters
        ----------
        dataset:
            Source dataset to adapt.  Can be a :class:`DistillationDataset`
            (from the registry) or a :class:`TrainingDataset` (from the core
            module).
        max_examples:
            Maximum number of MoE examples to produce.
        streaming:
            If ``True`` and *dataset* is a :class:`DistillationDataset` with a
            HuggingFace streaming iterable, process it in streaming fashion.
        progress_callback:
            Optional callback ``fn(current, total)`` for progress reporting.

        Returns
        -------
        list[MoETrainingExample]
        """
        if isinstance(dataset, DistillationDataset):
            return self._adapt_distillation_dataset(
                dataset,
                max_examples=max_examples,
                streaming=streaming,
                progress_callback=progress_callback,
            )
        elif isinstance(dataset, TrainingDataset):
            return self._adapt_training_dataset(
                dataset,
                max_examples=max_examples,
                progress_callback=progress_callback,
            )
        else:
            raise TypeError(
                f"Expected DistillationDataset or TrainingDataset, "
                f"got {type(dataset).__name__}"
            )

    def adapt_datapoints(
        self,
        datapoints: list[DataPoint],
        *,
        progress_callback: Optional[Callable[[int, int], None]] = None,
    ) -> list[MoETrainingExample]:
        """Convert a list of :class:`DataPoint` objects directly.

        This is a convenience wrapper around :meth:`adapt_dataset`.
        """
        return self._adapt_datapoints(datapoints, progress_callback=progress_callback)

    # ── Internal adapters ───────────────────────────────────────────────────

    def _adapt_distillation_dataset(
        self,
        dataset: DistillationDataset,
        *,
        max_examples: Optional[int] = None,
        streaming: bool = False,
        progress_callback: Optional[Callable[[int, int], None]] = None,
    ) -> list[MoETrainingExample]:
        examples: list[MoETrainingExample] = []

        if streaming and hasattr(dataset, "_hf_iterable") and dataset._hf_iterable is not None:
            it = iter(dataset._hf_iterable)
            count = 0
            while True:
                if max_examples is not None and count >= max_examples:
                    break
                try:
                    raw = next(it)
                except StopIteration:
                    break
                example = self._convert_raw_hf_example(raw, dataset)
                if example is not None:
                    examples.append(example)
                    count += 1
                    if progress_callback:
                        progress_callback(count, max_examples or 0)
        else:
            td = dataset.to_training_dataset()
            examples = self._adapt_training_dataset(
                td, max_examples=max_examples, progress_callback=progress_callback,
            )

        return examples

    def _adapt_training_dataset(
        self,
        dataset: TrainingDataset,
        *,
        max_examples: Optional[int] = None,
        progress_callback: Optional[Callable[[int, int], None]] = None,
    ) -> list[MoETrainingExample]:
        dps = dataset.datapoints
        if max_examples is not None:
            dps = dps[:max_examples]
        return self._adapt_datapoints(dps, progress_callback=progress_callback)

    def _adapt_datapoints(
        self,
        datapoints: list[DataPoint],
        *,
        progress_callback: Optional[Callable[[int, int], None]] = None,
    ) -> list[MoETrainingExample]:
        total = len(datapoints)
        examples: list[MoETrainingExample] = []

        for i, dp in enumerate(datapoints):
            task_text = dp.input
            teacher_response = dp.output
            domain = dp.domain

            if self.routing_distiller is not None:
                record = self.routing_distiller.router.record_routing(task_text)
                expert_ids = record.top_experts
                routing_weights = record.expert_weights
                routing_pattern = record.routing_pattern
                domain = record.domain.value
            else:
                expert_ids = self.expert_loader.stream_experts(task_text)
                routing_weights = [
                    round(1.0 / len(expert_ids), 4) for _ in expert_ids
                ]
                routing_pattern = "top_k"

            example = MoETrainingExample(
                task=task_text,
                teacher_response=teacher_response,
                expert_ids=expert_ids,
                routing_weights=routing_weights,
                domain=domain,
                routing_pattern=routing_pattern,
                metadata={
                    **dp.metadata,
                    "difficulty": dp.difficulty,
                    "quality_score": dp.quality_score,
                },
            )
            examples.append(example)

            if progress_callback:
                progress_callback(i + 1, total)

        return examples

    def _convert_raw_hf_example(
        self,
        raw: dict,
        dataset: DistillationDataset,
    ) -> Optional[MoETrainingExample]:
        """Convert a raw HuggingFace example dict using the dataset's field map."""
        try:
            task_text = self._get_field(raw, dataset.fields_map, "messages")
            if not task_text:
                task_text = self._get_field(raw, dataset.fields_map, "system", default="")
            teacher_response = self._get_field(raw, dataset.fields_map, "response")
            if not teacher_response:
                teacher_response = self._get_field(raw, dataset.fields_map, "output", default="")
        except (KeyError, IndexError, TypeError):
            return None

        if not task_text or not teacher_response:
            return None

        if isinstance(task_text, list):
            task_text = " ".join(
                m.get("content", "") if isinstance(m, dict) else str(m)
                for m in task_text
            )

        domain = self._infer_domain(task_text)
        expert_ids = self.expert_loader.stream_experts(task_text)
        routing_weights = [round(1.0 / len(expert_ids), 4) for _ in expert_ids]

        return MoETrainingExample(
            task=str(task_text),
            teacher_response=str(teacher_response),
            expert_ids=expert_ids,
            routing_weights=routing_weights,
            domain=domain,
            routing_pattern="top_k",
            metadata={"source": dataset.source_name},
        )

    @staticmethod
    def _get_field(
        raw: dict,
        fields_map: dict[str, str],
        logical: str,
        default: Any = "",
    ) -> Any:
        """Extract a field from *raw* using the logical-to-physical mapping."""
        physical = fields_map.get(logical, logical)
        return raw.get(physical, default)

    @staticmethod
    def _infer_domain(text: str) -> str:
        """Simple domain inference from text keywords."""
        text_lower = text.lower()
        domain_scores: dict[str, int] = {
            "code": sum(1 for kw in ["def ", "class ", "import ", "func", "var ", "const "]
                        if kw in text_lower),
            "math": sum(1 for kw in ["equation", "calculate", "derivative", "integral",
                                      "theorem", "proof", "matrix"]
                        if kw in text_lower),
            "reasoning": sum(1 for kw in ["reason", "think step", "explain", "analyze",
                                           "compare", "logic"]
                             if kw in text_lower),
            "writing": sum(1 for kw in ["write", "essay", "story", "poem", "article"]
                           if kw in text_lower),
            "science": sum(1 for kw in ["physics", "chemistry", "biology", "experiment",
                                         "scientific"]
                           if kw in text_lower),
        }
        best_domain = max(domain_scores, key=domain_scores.get)
        if domain_scores[best_domain] > 0:
            return best_domain
        return "general"

    def __repr__(self) -> str:
        return f"MoEDatasetAdapter(loader={self.expert_loader})"

# ══════════════════════════════════════════════════════════════════════════════
# 3  MultiSourceMoEPipeline — orchestrates training from multiple sources
# ══════════════════════════════════════════════════════════════════════════════

@dataclass
class PipelineStage:
    """A single stage definition for :meth:`MultiSourceMoEPipeline.run_staged`."""
    name: str
    registry_keys: list[str]
    ratios: list[float]
    num_samples: int
    teacher_config: Optional[CloudTeacherConfig] = None
    quality_threshold: float = 0.5
    use_streaming: bool = True


class MultiSourceMoEPipeline:
    """Orchestrates MoE distillation training from multiple HuggingFace dataset
    sources registered in :data:`DATASET_REGISTRY`.

    Key capabilities:
      - Multi-source dataset mixing with configurable ratios.
      - Router training on mixed data.
      - Cloud teacher distillation (live generation via :class:`CloudTeacherAdapter`).
      - Staged distillation (bootstrap → easy → … → frontier).
      - Evaluation of the student model.
      - Streaming architecture for 100K+ row datasets.
    """

    def __init__(
        self,
        expert_loader: ExpertStreamLoader,
        moe_pipeline: MoEDistillationPipeline,
        dataset_adapter: Optional[MoEDatasetAdapter] = None,
    ) -> None:
        """
        Parameters
        ----------
        expert_loader:
            Streaming expert loader for routing decisions.
        moe_pipeline:
            The existing :class:`MoEDistillationPipeline` that handles
            router training and pattern extraction.
        dataset_adapter:
            Optional adapter; created from *expert_loader* + *moe_pipeline*'s
            distiller if not provided.
        """
        self.expert_loader = expert_loader
        self.moe_pipeline = moe_pipeline
        self.dataset_adapter = dataset_adapter or MoEDatasetAdapter(
            expert_loader=expert_loader,
            routing_distiller=(
                moe_pipeline.distiller
                if hasattr(moe_pipeline, "distiller") and moe_pipeline.distiller is not None
                else None
            ),
        )

        # Internal state
        self._configured_sources: list[str] = []
        self._configured_ratios: list[float] = []
        self._routing_dataset: Optional[list[MoETrainingExample]] = None
        self._eval_results: list[dict] = []
        self._staged_results: dict[str, Any] = {}

    # ── Configuration ─────────────────────────────────────────

    def configure(
        self,
        registry_keys: list[str],
        ratios: list[float],
    ) -> MultiSourceMoEPipeline:
        """Select datasets from the registry and their mixing ratios.

        Parameters
        ----------
        registry_keys:
            Keys into :data:`DATASET_REGISTRY` (e.g.
            ``["reasoning-distill-opus-4-7-max", "deepseek-v4-distill-8000x"]``).
        ratios:
            Mixing ratios for each source (do not need to sum to 1).

        Returns
        -------
        MultiSourceMoEPipeline
            ``self`` for chaining.

        Raises
        ------
        KeyError
            If any *registry_keys* is not found in :data:`DATASET_REGISTRY`.
        ValueError
            If *registry_keys* and *ratios* have different lengths.
        """
        if len(registry_keys) != len(ratios):
            raise ValueError(
                f"Length mismatch: {len(registry_keys)} registry_keys vs "
                f"{len(ratios)} ratios"
            )

        for key in registry_keys:
            if key not in DATASET_REGISTRY:
                raise KeyError(
                    f"Unknown dataset key: {key!r}. "
                    f"Available: {list(DATASET_REGISTRY.keys())}"
                )

        self._configured_sources = list(registry_keys)
        self._configured_ratios = list(ratios)

        log.info(
            "MultiSourceMoEPipeline configured with %d sources: %s",
            len(registry_keys),
            list(zip(registry_keys, ratios)),
        )
        return self

    # ── Data Loading ───────────────────────────────────────────

    def load_mixed_dataset(
        self,
        total_samples: int = 10_000,
        streaming: bool = True,
        **load_kwargs: Any,
    ) -> list[MoETrainingExample]:
        """Load and mix datasets from configured sources.

        Uses :class:`DatasetMix` under the hood for proper interleaving,
        then adapts the result to MoE training examples via
        :class:`MoEDatasetAdapter`.

        Parameters
        ----------
        total_samples:
            Total number of MoE examples to produce across all sources.
        streaming:
            If ``True``, use HuggingFace streaming iterables to avoid loading
            the entire dataset into memory (supports 100K+ rows).
        **load_kwargs:
            Additional arguments forwarded to :func:`load_dataset`.

        Returns
        -------
        list[MoETrainingExample]
        """
        if not self._configured_sources:
            raise RuntimeError(
                "No sources configured. Call .configure(registry_keys, ratios) first."
            )

        total_ratio = sum(self._configured_ratios)
        norm_ratios = [r / total_ratio for r in self._configured_ratios]

        all_examples: list[MoETrainingExample] = []
        target_per_source = [
            max(1, int(total_samples * nr)) for nr in norm_ratios
        ]

        for key, target, ratio in zip(
            self._configured_sources,
            target_per_source,
            self._configured_ratios,
        ):
            try:
                source = DATASET_REGISTRY[key]
                log.info("Loading dataset '%s' (format=%s, target=%d examples)",
                         key, source.format_type, target)
            except KeyError:
                log.warning("Skipping unknown dataset '%s'", key)
                continue

            fetch = target * 2

            try:
                dd = load_dataset(
                    key,
                    streaming=streaming,
                    **load_kwargs,
                )
            except Exception as exc:
                log.error("Failed to load dataset '%s': %s", key, exc)
                continue

            adapted = self.dataset_adapter.adapt_dataset(
                dd,
                max_examples=fetch,
                streaming=streaming,
            )

            filtered = [
                ex for ex in adapted
                if len(ex.teacher_response) > 50
                and ex.teacher_response.strip()
            ]

            selected = filtered[:target]
            for ex in selected:
                ex.metadata["dataset_source"] = key
                ex.metadata["mix_ratio"] = ratio

            all_examples.extend(selected)
            log.info("  → Got %d MoE examples from '%s'", len(selected), key)

        random.shuffle(all_examples)
        log.info(
            "Mixed dataset created: %d MoE examples from %d sources",
            len(all_examples),
            len(self._configured_sources),
        )
        return all_examples

    # ── Router Training ───────────────────────────────────────────

    def train_router(
        self,
        dataset: list[MoETrainingExample] | TrainingDataset | DistillationDataset,
        num_samples: int = 5000,
    ) -> dict:
        """Train the MoE routing module on the provided data.

        Delegates to :meth:`MoEDistillationPipeline.extract_routing_patterns`
        for pattern extraction, then uses the patterns to train the router.

        Parameters
        ----------
        dataset:
            Training data.  Can be MoE examples (pre-adapted), a
            :class:`TrainingDataset`, or a :class:`DistillationDataset`.
        num_samples:
            Number of samples to use for router training.

        Returns
        -------
        dict
            Summary of router training (patterns extracted, experts, etc.).
        """
        if isinstance(dataset, list):
            moe_examples = dataset
        elif isinstance(dataset, DistillationDataset):
            moe_examples = self.dataset_adapter.adapt_dataset(
                dataset, max_examples=num_samples,
            )
        elif isinstance(dataset, TrainingDataset):
            moe_examples = self.dataset_adapter.adapt_dataset(
                dataset, max_examples=num_samples,
            )
        else:
            raise TypeError(f"Unsupported dataset type: {type(dataset).__name__}")

        tasks = [ex.task for ex in moe_examples[:num_samples]]
        patterns = self.moe_pipeline.extract_routing_patterns(tasks)
        self._routing_dataset = moe_examples

        summary = {
            "num_tasks": len(tasks),
            "num_patterns": sum(len(v) for v in patterns.values()),
            "num_experts": len(patterns),
            "experts_with_patterns": [eid for eid, pats in patterns.items() if pats],
        }
        log.info("Router training complete: %s", summary)
        return summary

    # ── Cloud Distillation ──────────────────────────────────────────

    def distill_from_cloud(
        self,
        teacher_config: CloudTeacherConfig | TeacherEnsembleConfig,
        prompts: list[str],
        *,
        system_prompt: str = "",
        temperature: float = 0.7,
        max_examples: Optional[int] = None,
        progress_callback: Optional[Callable[[int, int], None]] = None,
    ) -> list[MoETrainingExample]:
        """Use a cloud teacher to generate responses, then create MoE examples.

        Parameters
        ----------
        teacher_config:
            Config for a single model (:class:`CloudTeacherConfig`) or
            ensemble (:class:`TeacherEnsembleConfig`).
        prompts:
            List of prompt texts to send to the teacher.
        system_prompt:
            Optional system prompt prepended to each request.
        temperature:
            Sampling temperature for the teacher.
        max_examples:
            Maximum number of examples to produce.
        progress_callback:
            Optional progress callback ``fn(current, total)``.

        Returns
        -------
        list[MoETrainingExample]
        """
        from lazy_chameleon.training.cloud_teacher import TeacherEnsembleConfig

        if max_examples is not None:
            prompts = prompts[:max_examples]

        total = len(prompts)
        examples: list[MoETrainingExample] = []

        if isinstance(teacher_config, TeacherEnsembleConfig):
            teacher = CloudTeacherEnsemble(teacher_config)
            generate = teacher.generate
        else:
            teacher = CloudTeacherAdapter(teacher_config)
            generate = teacher.generate

        for i, prompt in enumerate(prompts):
            try:
                response = generate(prompt, system=system_prompt, temperature=temperature)
            except Exception as exc:
                log.warning("Teacher failed on prompt %d: %s", i, exc)
                continue

            if not response:
                continue

            expert_ids = self.expert_loader.stream_experts(prompt)
            routing_weights = [round(1.0 / len(expert_ids), 4) for _ in expert_ids]
            domain = MoEDatasetAdapter._infer_domain(prompt)

            example = MoETrainingExample(
                task=prompt,
                teacher_response=response,
                expert_ids=expert_ids,
                routing_weights=routing_weights,
                domain=domain,
                metadata={"teacher_type": "cloud"},
            )
            examples.append(example)

            if progress_callback:
                progress_callback(i + 1, total)

        log.info("Cloud distillation complete: %d examples generated", len(examples))
        return examples

    # ── Staged Distillation ──────────────────────────────────────────

    def run_staged(
        self,
        stages: list[PipelineStage],
        *,
        checkpoint_dir: Optional[str | Path] = None,
        progress_callback: Optional[Callable[[str, int, int], None]] = None,
    ) -> dict:
        """Run staged distillation (bootstrap → easy → … → frontier).

        Each stage loads its own data from the registry, adapts it for MoE
        training, optionally generates additional data from a cloud teacher,
        and trains the router.  Stages run sequentially with checkpointing.

        Parameters
        ----------
        stages:
            Ordered list of pipeline stages to execute.
        checkpoint_dir:
            Optional directory for saving stage checkpoints.
        progress_callback:
            Optional callback ``fn(stage_name, current, total)``.

        Returns
        -------
        dict
            Results summary per stage.
        """
        if checkpoint_dir is not None:
            checkpoint_dir = Path(checkpoint_dir)
            checkpoint_dir.mkdir(parents=True, exist_ok=True)

        staged_results: dict[str, Any] = {}

        for stage_idx, stage in enumerate(stages):
            stage_id = f"stage_{stage_idx}_{stage.name}"
            log.info("%s", "=" * 60)
            log.info("Starting stage: %s (%d samples)", stage.name, stage.num_samples)
            log.info("%s", "=" * 60)

            # Check for existing checkpoint
            if checkpoint_dir is not None:
                ckpt_file = checkpoint_dir / f"{stage_id}_checkpoint.json"
                if ckpt_file.exists():
                    log.info("Loading checkpoint for stage '%s'", stage.name)
                    with open(ckpt_file) as f:
                        staged_results[stage.name] = json.load(f)
                    continue

            # 1. Load and adapt dataset for this stage
            self.configure(stage.registry_keys, stage.ratios)
            moe_examples = self.load_mixed_dataset(
                total_samples=stage.num_samples,
                streaming=stage.use_streaming,
            )

            if progress_callback:
                progress_callback(stage.name, 0, len(moe_examples))

            # 2. Optionally augment with cloud teacher
            if stage.teacher_config is not None:
                prompts = [ex.task for ex in moe_examples]
                cloud_examples = self.distill_from_cloud(
                    stage.teacher_config,
                    prompts,
                    max_examples=stage.num_samples,
                    progress_callback=(
                        lambda c, t, _n=stage.name: progress_callback(_n, c, t)
                        if progress_callback else None
                    ),
                )
                moe_examples.extend(cloud_examples)

            # 3. Quality filter
            moe_examples = [
                ex for ex in moe_examples
                if len(ex.teacher_response) >= 50
            ]

            # 4. Train router on this stage's data
            router_summary = self.train_router(moe_examples, num_samples=len(moe_examples))

            stage_result = {
                "name": stage.name,
                "num_examples": len(moe_examples),
                "router_summary": router_summary,
                "completed_at": datetime.now().isoformat(),
            }
            staged_results[stage.name] = stage_result

            if progress_callback:
                progress_callback(stage.name, len(moe_examples), len(moe_examples))

            # Save checkpoint
            if checkpoint_dir is not None:
                ckpt_file = checkpoint_dir / f"{stage_id}_checkpoint.json"
                with open(ckpt_file, "w") as f:
                    json.dump(stage_result, f, indent=2, default=str)
                ex_file = checkpoint_dir / f"{stage_id}_examples.jsonl"
                with open(ex_file, "w") as f:
                    for ex in moe_examples:
                        f.write(json.dumps(ex.to_dict()) + "\n")
                log.info("Checkpoint saved: %s (%d examples)", ckpt_file, len(moe_examples))

        self._staged_results = staged_results

        summary = {
            "num_stages": len(stages),
            "stages": list(staged_results.keys()),
            "total_examples": sum(
                r.get("num_examples", 0) for r in staged_results.values()
            ),
        }
        log.info("Staged distillation complete: %s", summary)
        return staged_results

    # ── Evaluation ──────────────────────────────────────────────────────

    def evaluate(
        self,
        student_model: Any,
        eval_data: Optional[list[MoETrainingExample] | TrainingDataset] = None,
        *,
        metrics: Optional[list[str]] = None,
        num_samples: int = 200,
    ) -> dict:
        """Run evaluation on a student model.

        Parameters
        ----------
        student_model:
            The student model to evaluate.  Must have a ``generate(text) -> str``
            callable interface.
        eval_data:
            Evaluation data.  If ``None``, uses the configured routing dataset.
        metrics:
            List of metrics to compute.  Defaults to ``["accuracy",
            "expert_alignment"]``.
        num_samples:
            Number of samples to evaluate.

        Returns
        -------
        dict
            Evaluation results keyed by metric name.
        """
        if metrics is None:
            metrics = ["accuracy", "expert_alignment"]

        # Resolve eval data
        if eval_data is None:
            if self._routing_dataset is None:
                raise RuntimeError(
                    "No eval data provided and no routing dataset available. "
                    "Run train_router() first or pass eval_data."
                )
            eval_examples = self._routing_dataset[:num_samples]
        elif isinstance(eval_data, list):
            eval_examples = eval_data[:num_samples]
        elif isinstance(eval_data, TrainingDataset):
            eval_examples = self.dataset_adapter.adapt_dataset(
                eval_data, max_examples=num_samples,
            )
        else:
            raise TypeError(f"Unsupported eval_data type: {type(eval_data).__name__}")

        if not eval_examples:
            return {"error": "No evaluation data available", "samples": 0}

        results: dict[str, Any] = {
            "samples": len(eval_examples),
            "timestamp": datetime.now().isoformat(),
            "metrics": {},
        }

        # Run student model on each task
        student_outputs: list[str] = []
        for ex in eval_examples:
            try:
                if hasattr(student_model, "generate"):
                    out = student_model.generate(ex.task)
                elif callable(student_model):
                    out = student_model(ex.task)
                else:
                    out = f"<simulated response for: {ex.task[:50]}>"
            except Exception as exc:
                log.warning("Student model failed on task: %s", exc)
                out = ""
            student_outputs.append(out)

        # Compute metrics
        if "expert_alignment" in metrics:
            alignment = self._compute_expert_alignment(eval_examples, student_outputs)
            results["metrics"]["expert_alignment"] = alignment

        if "accuracy" in metrics:
            accuracy = self._compute_accuracy(eval_examples, student_outputs)
            results["metrics"]["accuracy"] = accuracy

        if "response_length" in metrics:
            lengths = [len(out) for out in student_outputs if out]
            results["metrics"]["avg_response_length"] = (
                sum(lengths) / len(lengths) if lengths else 0.0
            )
            results["metrics"]["max_response_length"] = max(lengths) if lengths else 0

        self._eval_results.append(results)
        log.info("Evaluation complete: %s", results)
        return results

    def get_eval_history(self) -> list[dict]:
        """Return the history of all evaluation runs."""
        return list(self._eval_results)

    # ── Internal metrics ───────────────────────────────────────────────

    def _compute_expert_alignment(
        self,
        examples: list[MoETrainingExample],
        student_outputs: list[str],
    ) -> dict:
        """Compute how well the student's responses align with the expert
        routing that the teacher used.

        Uses simple heuristics:
        - Domain keyword overlap between student output and expert domain.
        - Response structure similarity.
        """
        domain_keywords: dict[str, list[str]] = {
            "code": ["def ", "class ", "import", "return", "function"],
            "math": ["=", "+", "-", "*", "/", "equation", "solve"],
            "reasoning": ["step", "because", "therefore", "first", "second"],
            "writing": ["essay", "story", "paragraph", "describe"],
            "science": ["experiment", "theory", "observation", "data"],
            "general": ["the", "is", "are", "was"],
        }

        total = len(examples)
        aligned = 0

        for ex, out in zip(examples, student_outputs):
            if not out:
                continue
            domain = ex.domain
            keywords = domain_keywords.get(domain, domain_keywords["general"])
            match_count = sum(1 for kw in keywords if kw in out.lower())
            if match_count >= 2:
                aligned += 1

        alignment_rate = aligned / total if total > 0 else 0.0
        return {
            "aligned": aligned,
            "total": total,
            "alignment_rate": round(alignment_rate, 4),
        }

    def _compute_accuracy(
        self,
        examples: list[MoETrainingExample],
        student_outputs: list[str],
    ) -> dict:
        """Compute a simple accuracy proxy based on response presence."""
        total = len(examples)
        non_empty = sum(1 for out in student_outputs if out.strip())
        meaningful = sum(
            1 for out in student_outputs if len(out.strip()) > 20
        )
        return {
            "non_empty": non_empty,
            "meaningful": meaningful,
            "total": total,
            "response_rate": round(non_empty / total, 4) if total > 0 else 0.0,
            "meaningful_rate": round(meaningful / total, 4) if total > 0 else 0.0,
        }

    # ── Report ──────────────────────────────────────────────

    def summary(self) -> dict:
        """Return a high-level summary of the pipeline state."""
        return {
            "configured_sources": self._configured_sources,
            "configured_ratios": self._configured_ratios,
            "routing_dataset_size": len(self._routing_dataset) if self._routing_dataset else 0,
            "eval_runs": len(self._eval_results),
            "staged_results": self._staged_results,
            "expert_loader": repr(self.expert_loader),
            "moe_pipeline": repr(self.moe_pipeline),
        }

    def __repr__(self) -> str:
        return (
            f"MultiSourceMoEPipeline(sources={self._configured_sources}, "
            f"eval_runs={len(self._eval_results)})"
        )

# ══════════════════════════════════════════════════════════════════════════════
# 4  MoEIGUANAEngine — IGUANA-inspired full MoE engine wrapper
# ══════════════════════════════════════════════════════════════════════════════

class MoEIGUANAEngine:
    """IGUANA-inspired MoE engine wrapper.

    Models the key characteristics of the IGUANA architecture:
      - 744B total parameters (256 experts + shared layers + router)
      - ~40B active parameters per token (top-2 routing)
      - Heterogeneous expert sizes
      - Disk-streamed expert weights
      - Checkpoint / resume support

    This engine wraps :class:`ExpertStreamLoader` and provides high-level
    parameter counting, expert management, and state persistence.
    """

    def __init__(
        self,
        num_experts: int = _IGUANA_EXPERT_COUNT,
        top_k: int = _IGUANA_TOP_K,
        shared_params: int = 200_000_000_000,
        router_params: int = _ROUTER_PARAMS,
        base_path: Optional[str | Path] = None,
        seed: int = 42,
    ) -> None:
        """
        Parameters
        ----------
        num_experts:
            Total number of experts (IGUANA: 256).
        top_k:
            Number of active experts per token (IGUANA: 2).
        shared_params:
            Parameter count for shared (non-expert) layers.
        router_params:
            Parameter count for the routing network.
        base_path:
            Optional path for on-disk expert weights.
        seed:
            Random seed for reproducibility.
        """
        self.num_experts = num_experts
        self.top_k = top_k
        self.shared_params = shared_params
        self.router_params = router_params

        self.loader = ExpertStreamLoader(
            num_experts=num_experts,
            top_k=top_k,
            base_path=base_path,
            seed=seed,
        )

        # Pipeline components (can be set externally)
        self.moe_pipeline: Optional[MoEDistillationPipeline] = None
        self.multisource_pipeline: Optional[MultiSourceMoEPipeline] = None

        # Checkpointable state
        self._active_experts: set[str] = set()
        self._step_count: int = 0
        self._total_tokens_processed: int = 0
        self._state_metadata: dict = {}

    # ── Parameter Accounting ─────────────────────────────────────────────

    def get_total_parameter_count(self) -> int:
        """Return the total parameter count across all experts + shared layers.

        This mirrors IGUANA's ~744B total parameter count.
        """
        expert_total = sum(
            spec.capacity for spec in self.loader.list_experts()
        )
        return expert_total + self.shared_params + self.router_params

    def get_active_parameter_count(self) -> int:
        """Return the number of active parameters per token.

        This mirrors IGUANA's ~40B active parameter count
        (shared layers + top-k experts + router).
        """
        active_expert_params = sum(
            self.loader.get_expert_capacity(eid)
            for eid in self._active_experts
        )
        return active_expert_params + self.shared_params + self.router_params

    def get_parameter_breakdown(self) -> dict:
        """Return a detailed parameter breakdown."""
        return {
            "total": self.get_total_parameter_count(),
            "active_per_token": self.get_active_parameter_count(),
            "shared_layers": self.shared_params,
            "router": self.router_params,
            "experts": {
                "total_experts": self.num_experts,
                "per_expert": {
                    spec.expert_id: spec.capacity
                    for spec in self.loader.list_experts()
                },
                "total_expert_params": sum(
                    spec.capacity for spec in self.loader.list_experts()
                ),
            },
            "active_experts_count": len(self._active_experts),
            "top_k": self.top_k,
        }

    # ── Expert Management ─────────────────────────────────────────────

    def get_expert_specs(self) -> list[dict]:
        """Return per-expert information as a list of dictionaries.

        Each dict contains::

            {
                "expert_id": str,
                "domain": str,
                "capacity": int,
                "hidden_dim": int,
                "intermediate_dim": int,
                "num_layers": int,
                "load_count": int,
            }
        """
        return [spec.to_dict() for spec in self.loader.list_experts()]

    def activate_experts(self, task: str, top_k: Optional[int] = None) -> list[str]:
        """Determine which experts to activate for a given *task* and record
        them as the active set.

        Parameters
        ----------
        task:
            The input task / prompt.
        top_k:
            Override for the number of experts.

        Returns
        -------
        list[str]
            Activated expert IDs.
        """
        expert_ids = self.loader.stream_experts(task, top_k=top_k)
        self._active_experts = set(expert_ids)
        return expert_ids

    def get_active_experts(self) -> list[str]:
        """Return the currently active expert IDs."""
        return list(self._active_experts)

    def get_expert_weights(self, expert_id: str) -> dict:
        """Load (or retrieve from cache) the weights for *expert_id*."""
        return self.loader.load_expert_weights(expert_id)

    # ── Checkpointing ─────────────────────────────────────────────

    def save_state(self, path: str | Path) -> None:
        """Save the engine state to *path* for later resumption.

        The saved state includes:
          - Expert load counts (for cache warm-up)
          - Active expert set
          - Step count and metadata
          - Pipeline configuration references

        Parameters
        ----------
        path:
            File path for the checkpoint JSON.
        """
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)

        expert_specs = [spec.to_dict() for spec in self.loader.list_experts()]
        cache_stats = self.loader.get_cache_stats()

        state = {
            "version": "2.5.0",
            "engine_type": "MoEIGUANAEngine",
            "num_experts": self.num_experts,
            "top_k": self.top_k,
            "shared_params": self.shared_params,
            "router_params": self.router_params,
            "expert_specs": expert_specs,
            "active_experts": list(self._active_experts),
            "step_count": self._step_count,
            "total_tokens_processed": self._total_tokens_processed,
            "cache_stats": cache_stats,
            "metadata": self._state_metadata,
            "saved_at": datetime.now().isoformat(),
        }

        with open(path, "w") as f:
            json.dump(state, f, indent=2, default=str)

        log.info("Engine state saved to %s (step=%d)", path, self._step_count)

    def load_state(self, path: str | Path) -> bool:
        """Load engine state from a previously saved checkpoint.

        Parameters
        ----------
        path:
            File path to the checkpoint JSON.

        Returns
        -------
        bool
            ``True`` if the state was successfully loaded.
        """
        path = Path(path)
        if not path.exists():
            log.warning("No checkpoint found at %s", path)
            return False

        with open(path) as f:
            state = json.load(f)

        if state.get("engine_type") != "MoEIGUANAEngine":
            log.warning("Invalid checkpoint: not a MoEIGUANAEngine state")
            return False

        self.num_experts = state.get("num_experts", self.num_experts)
        self.top_k = state.get("top_k", self.top_k)
        self.shared_params = state.get("shared_params", self.shared_params)
        self.router_params = state.get("router_params", self.router_params)
        self._active_experts = set(state.get("active_experts", []))
        self._step_count = state.get("step_count", 0)
        self._total_tokens_processed = state.get("total_tokens_processed", 0)
        self._state_metadata = state.get("metadata", {})

        saved_specs = state.get("expert_specs", [])
        if saved_specs:
            self.loader = ExpertStreamLoader(
                num_experts=self.num_experts,
                top_k=self.top_k,
                seed=42,
            )
            for spec_dict in saved_specs:
                spec = ExpertSpec.from_dict(spec_dict)
                if spec.expert_id in self.loader._experts:
                    self.loader._experts[spec.expert_id] = spec

        log.info(
            "Engine state loaded from %s (step=%d, experts=%d)",
            path, self._step_count, self.num_experts,
        )
        return True

    # ── Training Step Tracking ───────────────────────────────────────────

    def record_step(self, tokens: int = 1) -> None:
        """Increment the training step and token counters.

        Parameters
        ----------
        tokens:
            Number of tokens processed in this step.
        """
        self._step_count += 1
        self._total_tokens_processed += tokens

    def get_training_progress(self) -> dict:
        """Return training progress statistics."""
        return {
            "step": self._step_count,
            "total_tokens_processed": self._total_tokens_processed,
            "active_params_per_token": self.get_active_parameter_count(),
            "total_params": self.get_total_parameter_count(),
            "active_ratio": round(
                self.get_active_parameter_count() / self.get_total_parameter_count(),
                6,
            ),
        }

    # ── Factory methods for pipeline integration ────────────────────────────────────────

    def create_moe_pipeline(
        self,
        config: Optional[MoEDistillationConfig] = None,
    ) -> MoEDistillationPipeline:
        """Create and wire a :class:`MoEDistillationPipeline` using this
        engine's expert configuration.

        Parameters
        ----------
        config:
            Optional :class:`MoEDistillationConfig`.  Defaults to using
            ``num_experts`` and ``top_k`` from this engine.

        Returns
        -------
        MoEDistillationPipeline
        """
        if config is None:
            config = MoEDistillationConfig(
                num_experts=self.num_experts,
                top_k=self.top_k,
            )
        pipeline = MoEDistillationPipeline(config)
        self.moe_pipeline = pipeline
        return pipeline

    def create_multisource_pipeline(
        self,
        moe_pipeline: Optional[MoEDistillationPipeline] = None,
    ) -> MultiSourceMoEPipeline:
        """Create and wire a :class:`MultiSourceMoEPipeline` using this engine.

        Parameters
        ----------
        moe_pipeline:
            An existing :class:`MoEDistillationPipeline`.  If ``None``, a new
            one is created via :meth:`create_moe_pipeline`.

        Returns
        -------
        MultiSourceMoEPipeline
        """
        if moe_pipeline is None and self.moe_pipeline is None:
            moe_pipeline = self.create_moe_pipeline()
        elif moe_pipeline is not None:
            self.moe_pipeline = moe_pipeline
        else:
            moe_pipeline = self.moe_pipeline

        pipeline = MultiSourceMoEPipeline(
            expert_loader=self.loader,
            moe_pipeline=moe_pipeline,
        )
        self.multisource_pipeline = pipeline
        return pipeline

    # ── Utility ──────────────────────────────────────────────

    def estimate_training_cost(self, num_tokens: int) -> dict:
        """Estimate the computational cost of training for *num_tokens*.

        Uses rough FLOP estimates (1 FLOP ≈ 2 * params * tokens).
        """
        active_params = self.get_active_parameter_count()
        total_params = self.get_total_parameter_count()

        forward_flops = 2 * active_params * num_tokens
        backward_flops = 4 * active_params * num_tokens

        total_flops = forward_flops + backward_flops

        expert_memory = sum(
            spec.capacity * 2 for spec in self.loader.list_experts()
        )
        shared_memory = self.shared_params * 2
        router_memory = self.router_params * 2
        total_memory = expert_memory + shared_memory + router_memory

        return {
            "total_params": total_params,
            "active_params_per_token": active_params,
            "num_tokens": num_tokens,
            "estimated_flops": total_flops,
            "estimated_flops_peta": round(total_flops / 1e15, 2),
            "estimated_memory_bytes": total_memory,
            "estimated_memory_gb": round(total_memory / (1024 ** 3), 2),
            "active_memory_gb": round(
                (active_params * 2) / (1024 ** 3), 2
            ),
        }

    def __repr__(self) -> str:
        return (
            f"MoEIGUANAEngine(experts={self.num_experts}, "
            f"top_k={self.top_k}, "
            f"total_params={self.get_total_parameter_count():,}, "
            f"active_params={self.get_active_parameter_count():,})"
        )

# ══════════════════════════════════════════════════════════════════════════════
# 5  create_default_pipeline — factory function
# ══════════════════════════════════════════════════════════════════════════════

def create_default_pipeline(
    num_experts: int = _IGUANA_EXPERT_COUNT,
    top_k: int = _IGUANA_TOP_K,
    shared_params: int = 200_000_000_000,
    router_params: int = _ROUTER_PARAMS,
    base_path: Optional[str | Path] = None,
    seed: int = 42,
) -> Tuple[MoEIGUANAEngine, MultiSourceMoEPipeline]:
    """Create a fully-configured MoE distillation pipeline ready for use.

    This factory function:
      1. Creates a :class:`MoEIGUANAEngine` with IGUANA-inspired defaults.
      2. Wires up a :class:`MoEDistillationPipeline` with expert routing.
      3. Creates a :class:`MultiSourceMoEPipeline` configured with three
         recommended datasets from the registry:
           - ``reasoning-distill-opus-4-7-max`` (Claude Opus reasoning traces)
           - ``deepseek-v4-distill-8000x`` (DeepSeek V4 synthetic data)
           - ``claude-mythos-distilled-25k`` (Claude Mythos broader coverage)
      4. Pre-configures equal mixing ratios.

    Parameters
    ----------
    num_experts:
        Total number of experts (default: 256, like IGUANA).
    top_k:
        Active experts per token (default: 2).
    shared_params:
        Parameter count for shared (non-expert) layers.
    router_params:
        Parameter count for the routing network.
    base_path:
        Optional path for on-disk expert weights.
    seed:
        Random seed for reproducibility.

    Returns
    -------
    tuple[MoEIGUANAEngine, MultiSourceMoEPipeline]
        A ready-to-use pipeline pair.  The engine handles parameter accounting
        and state persistence; the pipeline handles data loading, routing
        training, and staged distillation.

    Examples
    --------
    >>> engine, pipeline = create_default_pipeline()
    >>> pipeline.configure(
    ...     registry_keys=["reasoning-distill-opus-4-7-max", "deepseek-v4-distill-8000x"],
    ...     ratios=[0.6, 0.4],
    ... )
    >>> moe_data = pipeline.load_mixed_dataset(total_samples=5000)
    >>> router_summary = pipeline.train_router(moe_data)
    >>> engine.save_state("/tmp/moe_checkpoint.json")
    """
    log.info(
        "Creating default MoE pipeline (num_experts=%d, top_k=%d)",
        num_experts, top_k,
    )

    # 1. Create engine
    engine = MoEIGUANAEngine(
        num_experts=num_experts,
        top_k=top_k,
        shared_params=shared_params,
        router_params=router_params,
        base_path=base_path,
        seed=seed,
    )

    # 2. Create MoE pipeline with routing
    moe_config = MoEDistillationConfig(
        num_experts=num_experts,
        top_k=top_k,
    )
    moe_pipeline = MoEDistillationPipeline(moe_config)
    engine.moe_pipeline = moe_pipeline

    # 3. Create multi-source pipeline
    multisource_pipeline = MultiSourceMoEPipeline(
        expert_loader=engine.loader,
        moe_pipeline=moe_pipeline,
    )
    engine.multisource_pipeline = multisource_pipeline

    # 4. Pre-configure with recommended datasets (if they exist in the registry)
    recommended_sources = [
        "claude-opus-4-7-reasoning",    # Claude Opus 4.7 reasoning traces
        "deepseek-r1-distill",           # DeepSeek-R1 800K distilled
        "numinamath-cot",                # Competition math (AIME/AMC)
    ]
    available = [s for s in recommended_sources if s in DATASET_REGISTRY]
    if available:
        equal_ratio = 1.0 / len(available)
        ratios = [equal_ratio] * len(available)
        multisource_pipeline.configure(
            registry_keys=available,
            ratios=ratios,
        )
        log.info(
            "Default pipeline configured with %d registry sources: %s",
            len(available), available,
        )
    else:
        log.warning(
            "None of the recommended datasets found in registry. "
            "Available: %s. Call pipeline.configure(...) manually.",
            list(DATASET_REGISTRY.keys()),
        )

    return engine, multisource_pipeline


# ══════════════════════════════════════════════════════════════════════════════
# Module exports
# ══════════════════════════════════════════════════════════════════════════════

__all__ = [
    # 1. Expert streaming
    "ExpertSpec",
    "ExpertStreamLoader",
    # 2. Dataset adaptation
    "MoETrainingExample",
    "MoEDatasetAdapter",
    # 3. Multi-source pipeline
    "PipelineStage",
    "MultiSourceMoEPipeline",
    # 4. IGUANA engine
    "MoEIGUANAEngine",
    # 5. Factory
    "create_default_pipeline",
]
