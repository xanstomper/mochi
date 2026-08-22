"""DataMixer — Advanced dataset mixing, blending, and curriculum scheduling."""

from __future__ import annotations

import json
import logging
import math
import os
import random
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

from lazy_chameleon.training.dataset import DataPoint, TrainingDataset
from lazy_chameleon.training.dataset_registry import (
    DATASET_REGISTRY,
    DatasetMix,
    DistillationDataset,
    MixComponent,
    load_dataset,
)

logger = logging.getLogger(__name__)


@dataclass
class BlendComponent:
    """A single component in a data blend."""
    source_key: str
    """Registry key for the dataset source."""
    
    weight: float = 1.0
    """Relative sampling weight."""
    
    domain: str = "general"
    """Primary domain label."""
    
    max_samples: Optional[int] = None
    """Maximum samples to draw from this source."""
    
    quality_threshold: float = 0.0
    """Minimum quality score to include."""
    
    deduplicate: bool = True
    """Whether to deduplicate against other components."""


@dataclass
class BlendRecipe:
    """A dataset blending recipe with multiple components."""
    
    name: str
    """Unique name for this blend."""
    
    description: str
    """Human-readable description."""
    
    components: List[BlendComponent]
    """Sources to blend."""
    
    target_size: int = 100_000
    """Target total number of examples after blending."""
    
    seed: int = 42
    """Random seed for reproducibility."""
    
    shuffle: bool = True
    """Whether to shuffle the final blend."""
    
    tags: List[str] = field(default_factory=list)
    """Tags for categorization."""


class DataMixer:
    """
    Advanced data blending engine.
    
    Supports:
    - Weighted sampling from multiple sources
    - Domain balancing
    - Quality filtering
    - Deduplication across sources
    - Curriculum ordering
    - Streaming and non-streaming modes
    """
    
    def __init__(self, cache_dir: Optional[str] = None):
        self.cache_dir = Path(cache_dir) if cache_dir else Path.home() / ".lazy_chameleon" / "data_cache"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._cache: Dict[str, TrainingDataset] = {}
        self._stats: Dict[str, Any] = {"total_blended": 0, "blends_created": 0}
    
    def blend(self, recipe: BlendRecipe, streaming: bool = False) -> TrainingDataset:
        """Blend multiple sources into a single dataset."""
        logger.info("Blending '%s': %d components, target %d samples",
                    recipe.name, len(recipe.components), recipe.target_size)
        
        rng = random.Random(recipe.seed)
        all_samples: List[DataPoint] = []
        
        total_weight = sum(c.weight for c in recipe.components)
        
        for comp in recipe.components:
            # Calculate how many samples to take from this component
            target = max(1, int(recipe.target_size * comp.weight / total_weight))
            if comp.max_samples is not None:
                target = min(target, comp.max_samples)
            
            try:
                dd = load_dataset(comp.source_key, split="train", streaming=streaming)
                td = dd.to_training_dataset()
                
                if len(td) == 0:
                    logger.warning("Component '%s' has no samples, skipping", comp.source_key)
                    continue
                
                # Quality filter
                if comp.quality_threshold > 0:
                    td.datapoints = [
                        dp for dp in td.datapoints
                        if dp.difficulty >= comp.quality_threshold
                    ]
                    logger.info("  %s: %d after quality filter (>=%.2f)",
                                comp.source_key, len(td), comp.quality_threshold)
                
                # Sample
                actual = min(target, len(td))
                sampled = rng.sample(td.datapoints, actual)
                
                # Mark source
                for dp in sampled:
                    dp.metadata["blend_source"] = comp.source_key
                    dp.metadata["blend_weight"] = comp.weight
                    if not dp.domain or dp.domain == "unknown":
                        dp.domain = comp.domain
                
                all_samples.extend(sampled)
                logger.info("  %s: took %d/%d samples", comp.source_key, actual, len(td))
                
            except Exception as e:
                logger.error("  %s: FAILED - %s", comp.source_key, e)
                continue
        
        # Deduplicate
        if any(c.deduplicate for c in recipe.components):
            all_samples = self._deduplicate(all_samples)
        
        # Shuffle
        if recipe.shuffle:
            rng.shuffle(all_samples)
        
        result = TrainingDataset(all_samples)
        self._stats["total_blended"] += len(result)
        self._stats["blends_created"] += 1
        
        logger.info("Blend '%s': created %d samples from %d sources",
                    recipe.name, len(result), len(recipe.components))
        return result
    
    def _deduplicate(self, samples: List[DataPoint]) -> List[DataPoint]:
        """Remove duplicate or near-duplicate samples."""
        seen: set[int] = set()
        unique: List[DataPoint] = []
        
        for dp in samples:
            # Hash the first 100 chars of input as a simple fingerprint
            fp = hash(dp.input_[:100].lower())
            if fp not in seen:
                seen.add(fp)
                unique.append(dp)
        
        deduped = len(samples) - len(unique)
        if deduped > 0:
            logger.info("  Deduplication: removed %d/%d duplicates", deduped, len(samples))
        return unique
    
    def create_curriculum(
        self,
        recipes: List[BlendRecipe],
        curriculum_order: List[str],
    ) -> List[TrainingDataset]:
        """Create a curriculum: ordered list of blended datasets."""
        recipe_map = {r.name: r for r in recipes}
        result: List[TrainingDataset] = []
        
        for name in curriculum_order:
            if name not in recipe_map:
                logger.warning("Curriculum step '%s' not found, skipping", name)
                continue
            dataset = self.blend(recipe_map[name])
            result.append(dataset)
            self._stats["curriculum_steps"] = self._stats.get("curriculum_steps", 0) + 1
        
        return result
    
    def get_stats(self) -> Dict[str, Any]:
        """Get mixer statistics."""
        return dict(self._stats)
    
    def save_blend(self, dataset: TrainingDataset, path: str) -> str:
        """Save a blended dataset to disk."""
        path = os.path.expanduser(path)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        
        records = []
        for dp in dataset.datapoints:
            records.append({
                "instruction": dp.input_,
                "response": dp.output,
                "domain": dp.domain,
                "difficulty": dp.difficulty,
                "metadata": dp.metadata,
            })
        
        with open(path, "w", encoding="utf-8") as f:
            for r in records:
                f.write(json.dumps(r) + "\n")
        
        return path


# ═════════════════════════════════════════════════════════════════════════════
# PRE-BUILT BLEND RECIPES — Ready-to-use dataset blends
# ═════════════════════════════════════════════════════════════════════════════

FRONTIER_BLENDS: Dict[str, BlendRecipe] = {
    "math_master": BlendRecipe(
        name="math_master",
        description="Comprehensive math blend from frontier models",
        target_size=100_000,
        components=[
            BlendComponent(source_key="numinamath-cot", weight=3.0, domain="math", quality_threshold=0.6),
            BlendComponent(source_key="metamath-qa", weight=2.0, domain="math"),
            BlendComponent(source_key="orca-math", weight=1.5, domain="math"),
            BlendComponent(source_key="mathinstruct", weight=2.0, domain="math"),
            BlendComponent(source_key="prm800k", weight=1.5, domain="math", quality_threshold=0.5),
        ],
        tags=["math", "reasoning", "frontier"],
    ),
    "code_ace": BlendRecipe(
        name="code_ace",
        description="Code generation blend from frontier models",
        target_size=100_000,
        components=[
            BlendComponent(source_key="magicoder-evol-instruct", weight=3.0, domain="code"),
            BlendComponent(source_key="codealpaca-20k", weight=1.0, domain="code"),
            BlendComponent(source_key="gpt-5.4-code-distill", weight=2.0, domain="code", max_samples=500),
        ],
        tags=["code", "frontier"],
    ),
    "reasoning_generalist": BlendRecipe(
        name="reasoning_generalist",
        description="General reasoning blend across all frontier datasets",
        target_size=200_000,
        components=[
            BlendComponent(source_key="ultrachat-200k", weight=2.0, domain="general"),
            BlendComponent(source_key="openhermes-2.5", weight=2.0, domain="general"),
            BlendComponent(source_key="dolly-15k", weight=1.0, domain="general"),
            BlendComponent(source_key="sharegpt-90k", weight=1.5, domain="general"),
            BlendComponent(source_key="helpsteer2", weight=1.0, domain="general", quality_threshold=0.5),
            BlendComponent(source_key="orca-dpo-pairs", weight=1.0, domain="alignment"),
        ],
        tags=["general", "reasoning", "instruction"],
    ),
    "science_explorer": BlendRecipe(
        name="science_explorer",
        description="Science and reasoning blend",
        target_size=50_000,
        components=[
            BlendComponent(source_key="numinamath-cot", weight=1.0, domain="science"),
            BlendComponent(source_key="sciq", weight=2.0, domain="science"),
            BlendComponent(source_key="capybara", weight=1.5, domain="reasoning"),
            BlendComponent(source_key="lima", weight=1.0, domain="reasoning", quality_threshold=0.5),
        ],
        tags=["science", "reasoning"],
    ),
    "frontier_complete": BlendRecipe(
        name="frontier_complete",
        description="Complete frontier blend — all available datasets",
        target_size=500_000,
        components=[
            BlendComponent(source_key="claude-opus-4-7-reasoning", weight=3.0, domain="reasoning"),
            BlendComponent(source_key="anthropic-hh-rlhf", weight=1.0, domain="alignment"),
            BlendComponent(source_key="deepseek-r1-distill", weight=3.0, domain="reasoning"),
            BlendComponent(source_key="gpt-5.5-mega-distill", weight=5.0, domain="frontier"),
            BlendComponent(source_key="grok-4.4-distilled", weight=2.0, domain="reasoning"),
            BlendComponent(source_key="numinamath-cot", weight=2.0, domain="math"),
            BlendComponent(source_key="magicoder-evol-instruct", weight=2.0, domain="code"),
            BlendComponent(source_key="ultrachat-200k", weight=2.0, domain="general"),
            BlendComponent(source_key="helpsteer2", weight=1.0, domain="alignment"),
            BlendComponent(source_key="orca-dpo-pairs", weight=1.0, domain="alignment"),
        ],
        tags=["frontier", "complete", "all"],
    ),
}


# ═════════════════════════════════════════════════════════════════════════════
# CURRICULUM SCHEDULES — Learning progression plans
# ═════════════════════════════════════════════════════════════════════════════

CURRICULUM_SCHEDULES: Dict[str, List[str]] = {
    "fast_track": [
        "reasoning_generalist",  # Week 1: broad foundation
        "math_master",           # Week 2: math focus
        "code_ace",              # Week 3: code focus
        "frontier_complete",     # Week 4: complete blend
    ],
    "thorough": [
        "reasoning_generalist",  # Week 1-2
        "math_master",           # Week 3-4
        "code_ace",              # Week 5-6
        "science_explorer",      # Week 7
        "frontier_complete",     # Week 8-10
    ],
    "math_focused": [
        "math_master",           # Week 1-3
        "reasoning_generalist",  # Week 4
        "frontier_complete",     # Week 5-6
    ],
    "code_focused": [
        "code_ace",              # Week 1-3
        "reasoning_generalist",  # Week 4
        "frontier_complete",     # Week 5-6
    ],
}
