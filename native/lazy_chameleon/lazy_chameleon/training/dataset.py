"""
Dataset management for training data.
Handles loading, filtering, splitting, merging, and augmentation of training datasets.
"""

import json
import logging
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Optional, Callable, Any, Dict, List, Tuple
import random
from collections import defaultdict, Counter
import hashlib

logger = logging.getLogger(__name__)


@dataclass
class DataPoint:
    """Single training data point."""
    input: str
    output: str
    task_type: str = "general"
    domain: str = "general"
    difficulty: float = 0.5
    quality_score: float = 1.0
    metadata: Dict[str, Any] = field(default_factory=dict)
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return asdict(self)
    
    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "DataPoint":
        """Create from dictionary."""
        return DataPoint(**d)
    
    def hash(self) -> str:
        """Get hash for deduplication."""
        text = f"{self.input}||{self.output}"
        return hashlib.md5(text.encode()).hexdigest()


class TrainingDataset:
    """Manages training dataset."""
    
    def __init__(self, datapoints: Optional[List[DataPoint]] = None, path: Optional[str] = None):
        """Initialize dataset.
        
        Args:
            datapoints: List of DataPoint objects
            path: Path to JSONL file to load
        """
        if path:
            self.datapoints = self.load(path)
        else:
            self.datapoints = datapoints or []
    
    def save(self, path: str):
        """Save dataset to JSONL."""
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        
        with open(path, "w") as f:
            for dp in self.datapoints:
                f.write(json.dumps(dp.to_dict()) + "\n")
        
        logger.info(f"Saved {len(self.datapoints)} datapoints to {path}")
    
    @staticmethod
    def load(path: str) -> List[DataPoint]:
        """Load dataset from JSONL."""
        datapoints = []
        
        with open(path, "r") as f:
            for line in f:
                if line.strip():
                    try:
                        data = json.loads(line)
                        dp = DataPoint.from_dict(data)
                        datapoints.append(dp)
                    except json.JSONDecodeError as e:
                        logger.warning(f"Failed to parse line: {e}")
        
        logger.info(f"Loaded {len(datapoints)} datapoints from {path}")
        return datapoints
    
    def split(
        self,
        val_ratio: float = 0.1,
        seed: int = 42
    ) -> Tuple["TrainingDataset", "TrainingDataset"]:
        """Split into train/eval datasets.
        
        Args:
            val_ratio: Fraction for validation
            seed: Random seed
        
        Returns:
            (train_dataset, eval_dataset)
        """
        random.seed(seed)
        
        # Stratify by domain if possible
        by_domain = defaultdict(list)
        for dp in self.datapoints:
            by_domain[dp.domain].append(dp)
        
        train_dps = []
        eval_dps = []
        
        for domain, dps in by_domain.items():
            random.shuffle(dps)
            split_idx = int(len(dps) * (1 - val_ratio))
            train_dps.extend(dps[:split_idx])
            eval_dps.extend(dps[split_idx:])
        
        return TrainingDataset(train_dps), TrainingDataset(eval_dps)
    
    def filter(self, fn: Callable[[DataPoint], bool]) -> "TrainingDataset":
        """Filter datapoints by predicate.
        
        Args:
            fn: Function that returns True to keep datapoint
        
        Returns:
            Filtered dataset
        """
        filtered = [dp for dp in self.datapoints if fn(dp)]
        logger.info(f"Filtered from {len(self.datapoints)} to {len(filtered)} datapoints")
        return TrainingDataset(filtered)
    
    def sample(
        self,
        n: int,
        strategy: str = "uniform",
        seed: int = 42
    ) -> "TrainingDataset":
        """Sample n datapoints.
        
        Args:
            n: Number of samples
            strategy: "uniform" (random), "stratified" (by domain/difficulty),
                     or "quality_weighted" (prefer high quality)
            seed: Random seed
        
        Returns:
            Sampled dataset
        """
        random.seed(seed)
        
        if n >= len(self.datapoints):
            return TrainingDataset(self.datapoints.copy())
        
        if strategy == "uniform":
            sampled = random.sample(self.datapoints, n)
        
        elif strategy == "stratified":
            # Sample evenly from each domain/difficulty level
            by_domain = defaultdict(list)
            for dp in self.datapoints:
                by_domain[dp.domain].append(dp)
            
            sampled = []
            samples_per_domain = n // len(by_domain)
            
            for domain, dps in by_domain.items():
                domain_samples = min(samples_per_domain, len(dps))
                sampled.extend(random.sample(dps, domain_samples))
            
            # Fill remaining with random samples
            if len(sampled) < n:
                remaining = [dp for dp in self.datapoints if dp not in sampled]
                sampled.extend(random.sample(remaining, n - len(sampled)))
        
        elif strategy == "quality_weighted":
            # Weight by quality_score
            weights = [dp.quality_score for dp in self.datapoints]
            sampled = random.choices(self.datapoints, weights=weights, k=n)
        
        else:
            raise ValueError(f"Unknown strategy: {strategy}")
        
        logger.info(f"Sampled {len(sampled)} datapoints using {strategy}")
        return TrainingDataset(sampled)
    
    def merge(self, other: "TrainingDataset") -> "TrainingDataset":
        """Merge with another dataset.
        
        Args:
            other: Another TrainingDataset
        
        Returns:
            Merged dataset
        """
        merged = self.datapoints + other.datapoints
        logger.info(f"Merged datasets: {len(self.datapoints)} + {len(other.datapoints)} = {len(merged)}")
        return TrainingDataset(merged)
    
    def get_stats(self) -> Dict[str, Any]:
        """Get dataset statistics.
        
        Returns:
            Dict with stats: size, domains, difficulties, quality scores, etc.
        """
        if not self.datapoints:
            return {
                "total": 0,
                "domains": {},
                "difficulties": {"min": 0, "max": 0, "mean": 0},
                "quality_scores": {"min": 0, "max": 0, "mean": 0},
                "task_types": {},
                "avg_input_length": 0,
                "avg_output_length": 0,
            }
        
        domains = Counter(dp.domain for dp in self.datapoints)
        task_types = Counter(dp.task_type for dp in self.datapoints)
        
        difficulties = [dp.difficulty for dp in self.datapoints]
        quality_scores = [dp.quality_score for dp in self.datapoints]
        
        input_lengths = [len(dp.input.split()) for dp in self.datapoints]
        output_lengths = [len(dp.output.split()) for dp in self.datapoints]
        
        stats = {
            "total": len(self.datapoints),
            "domains": dict(domains),
            "task_types": dict(task_types),
            "difficulties": {
                "min": min(difficulties),
                "max": max(difficulties),
                "mean": sum(difficulties) / len(difficulties),
            },
            "quality_scores": {
                "min": min(quality_scores),
                "max": max(quality_scores),
                "mean": sum(quality_scores) / len(quality_scores),
            },
            "input_lengths": {
                "min": min(input_lengths),
                "max": max(input_lengths),
                "mean": sum(input_lengths) / len(input_lengths),
            },
            "output_lengths": {
                "min": min(output_lengths),
                "max": max(output_lengths),
                "mean": sum(output_lengths) / len(output_lengths),
            },
        }
        
        return stats
    
    def __len__(self) -> int:
        """Return number of datapoints."""
        return len(self.datapoints)
    
    def __iter__(self):
        """Iterate over datapoints."""
        return iter(self.datapoints)
    
    def __getitem__(self, idx: int) -> DataPoint:
        """Get datapoint by index."""
        return self.datapoints[idx]


class DataMixer:
    """Mix and combine multiple datasets."""
    
    @staticmethod
    def mix(
        datasets: List[TrainingDataset],
        weights: Optional[List[float]] = None
    ) -> TrainingDataset:
        """Combine multiple datasets with given weights.
        
        Args:
            datasets: List of datasets to mix
            weights: Relative weights (will be normalized)
        
        Returns:
            Mixed dataset
        """
        if not datasets:
            return TrainingDataset([])
        
        if weights is None:
            weights = [1.0] * len(datasets)
        
        # Normalize weights
        total_weight = sum(weights)
        weights = [w / total_weight for w in weights]
        
        mixed_dps = []
        
        for dataset, weight in zip(datasets, weights):
            # Sample proportional to weight
            n_samples = int(len(dataset) * weight * 10)  # Scale up for mixing
            sampled = dataset.sample(min(n_samples, len(dataset)))
            mixed_dps.extend(sampled.datapoints)
        
        logger.info(f"Mixed {len(datasets)} datasets into {len(mixed_dps)} datapoints")
        return TrainingDataset(mixed_dps)
    
    @staticmethod
    def curriculum_sort(dataset: TrainingDataset) -> TrainingDataset:
        """Sort dataset by difficulty for curriculum learning.
        
        Easier examples first, progressively harder.
        
        Args:
            dataset: Dataset to sort
        
        Returns:
            Sorted dataset (easy to hard)
        """
        sorted_dps = sorted(dataset.datapoints, key=lambda dp: dp.difficulty)
        logger.info(f"Sorted dataset by difficulty (curriculum learning)")
        return TrainingDataset(sorted_dps)
    
    @staticmethod
    def dedup(
        dataset: TrainingDataset,
        threshold: float = 0.8
    ) -> TrainingDataset:
        """Remove near-duplicate datapoints.
        
        Args:
            dataset: Dataset to deduplicate
            threshold: Similarity threshold (0.8 = 80% similar is duplicate)
        
        Returns:
            Deduplicated dataset
        """
        seen_hashes = set()
        deduped = []
        
        for dp in dataset.datapoints:
            dp_hash = dp.hash()
            
            # Simple dedup: exact hash match
            if dp_hash not in seen_hashes:
                seen_hashes.add(dp_hash)
                deduped.append(dp)
        
        logger.info(f"Deduplicated from {len(dataset.datapoints)} to {len(deduped)} datapoints")
        return TrainingDataset(deduped)
    
    @staticmethod
    def balance_domains(
        dataset: TrainingDataset,
        target_ratio: Optional[Dict[str, float]] = None
    ) -> TrainingDataset:
        """Balance representation across domains.
        
        Args:
            dataset: Dataset to balance
            target_ratio: Target ratio dict (e.g., {"coding": 0.4, "reasoning": 0.6})
        
        Returns:
            Balanced dataset
        """
        # Group by domain
        by_domain = defaultdict(list)
        for dp in dataset.datapoints:
            by_domain[dp.domain].append(dp)
        
        if target_ratio is None:
            # Equal representation
            target_ratio = {domain: 1.0 / len(by_domain) for domain in by_domain}
        
        balanced = []
        total_size = len(dataset.datapoints)
        
        for domain, dps in by_domain.items():
            target_count = int(total_size * target_ratio.get(domain, 0))
            
            if len(dps) <= target_count:
                balanced.extend(dps)
            else:
                # Sample down
                balanced.extend(random.sample(dps, target_count))
        
        logger.info(f"Balanced dataset by domain: {dict(Counter(dp.domain for dp in balanced))}")
        return TrainingDataset(balanced)
    
    @staticmethod
    def filter_by_quality(
        dataset: TrainingDataset,
        min_score: float = 0.5
    ) -> TrainingDataset:
        """Keep only high-quality datapoints.
        
        Args:
            dataset: Dataset to filter
            min_score: Minimum quality score (0-1)
        
        Returns:
            Filtered dataset
        """
        filtered = dataset.filter(lambda dp: dp.quality_score >= min_score)
        return filtered
    
    @staticmethod
    def augment_with_variations(
        dataset: TrainingDataset,
        augmentation_fn: Callable[[DataPoint], List[DataPoint]],
        augment_factor: float = 0.5
    ) -> TrainingDataset:
        """Augment dataset with variations.
        
        Args:
            dataset: Original dataset
            augmentation_fn: Function to generate variations of a datapoint
            augment_factor: Fraction of data to augment (0.5 = augment 50% of data)
        
        Returns:
            Augmented dataset
        """
        n_to_augment = int(len(dataset) * augment_factor)
        to_augment = random.sample(dataset.datapoints, n_to_augment)
        
        augmented_dps = dataset.datapoints.copy()
        
        for dp in to_augment:
            try:
                variations = augmentation_fn(dp)
                augmented_dps.extend(variations)
            except Exception as e:
                logger.warning(f"Failed to augment datapoint: {e}")
        
        logger.info(f"Augmented dataset from {len(dataset)} to {len(augmented_dps)} datapoints")
        return TrainingDataset(augmented_dps)
