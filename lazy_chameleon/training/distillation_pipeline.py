"""Distillation Pipeline — end-to-end: teacher → trajectories → filtered dataset."""
from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional

from .distillation_dataset import (
    DistillationDataset, TrajectoryQualityScorer, TrajectoryRecord,
)
from .trajectory_collector import CollectionConfig, TrajectoryCollector


@dataclass
class PipelineConfig:
    """Full pipeline configuration."""
    # Teacher
    teacher_provider: str = "anthropic"
    teacher_model: str = "claude-opus-4-8"
    n_samples_per_task: int = 8
    temperature: float = 0.9
    max_tokens: int = 8192

    # Filtering
    min_quality: float = 0.55
    diversity_weight: float = 0.3
    difficulty_filter: str = "medium_hard"   # easy | medium | hard | medium_hard | all
    dedup_threshold: float = 0.85
    min_tokens: int = 100
    max_tokens_filter: int = 16_000

    # Budget
    max_cost_usd: float = 100.0
    rate_limit_rpm: int = 60
    batch_size: int = 10

    # Output
    output_dir: str = "~/.lazy_chameleon/distillation_data"
    db_path: str = "~/.lazy_chameleon/distillation.db"
    export_formats: List[str] = field(default_factory=lambda: ["alpaca", "sharegpt"])
    domain: str = "general"
    source_name: str = ""


class DistillationPipeline:
    """
    End-to-end distillation data pipeline.

    Connects to any cloud model/API and generates high-quality
    distillation datasets for training local models.

    Supports:
    - Anthropic (Claude Opus / Sonnet / Haiku)
    - OpenAI (GPT-4o, o3, o4-mini)
    - DeepSeek (R1, V3)
    - Google (Gemini 2.5 Pro, Flash)
    - OpenRouter (any model via unified API)
    - Together AI (open-source models)
    - Any OpenAI-compatible endpoint

    Usage:
        pipeline = DistillationPipeline(api_key="sk-...", config=PipelineConfig(
            teacher_provider="anthropic",
            teacher_model="claude-opus-4-8",
            n_samples_per_task=8,
        ))

        records = await pipeline.collect_traces(task_bank)
        filtered = await pipeline.filter_trajectories(records)
        dataset = pipeline.build_sft_dataset(filtered)
        pipeline.export(filtered, "training_data.jsonl")
    """

    def __init__(
        self,
        api_key: str = "",
        config: PipelineConfig = None,
        progress_fn: Optional[Callable] = None,
    ):
        self.api_key = api_key
        self.config = config or PipelineConfig()
        self.progress = progress_fn or (lambda msg: print(f"[pipeline] {msg}"))
        self.scorer = TrajectoryQualityScorer()

        # Build collector config
        self._coll_config = CollectionConfig(
            teacher_provider=self.config.teacher_provider,
            teacher_model=self.config.teacher_model,
            n_samples_per_task=self.config.n_samples_per_task,
            temperature=self.config.temperature,
            max_tokens=self.config.max_tokens,
            max_cost_usd=self.config.max_cost_usd,
            rate_limit_rpm=self.config.rate_limit_rpm,
            batch_size=self.config.batch_size,
            domain=self.config.domain,
            source_name=self.config.source_name,
        )

        self.collector = TrajectoryCollector(
            api_key=api_key,
            config=self._coll_config,
            progress_fn=lambda msg: self.progress(f"  [collect] {msg}"),
        )

        self.dataset = DistillationDataset(self.config.db_path)
        self._output_dir = Path(self.config.output_dir).expanduser()
        self._output_dir.mkdir(parents=True, exist_ok=True)

    # ── Core pipeline stages ─────────────────────────────────────────────────

    async def collect_traces(
        self,
        task_bank: List[str],
        resume: bool = True,
    ) -> List[TrajectoryRecord]:
        """
        Stage 1: Collect reasoning traces from the teacher model.

        Sends each task in task_bank to the teacher API n_samples_per_task
        times to get diverse reasoning trajectories.
        """
        self.progress(
            f"Collecting traces: {len(task_bank)} tasks × "
            f"{self.config.n_samples_per_task} samples = "
            f"{len(task_bank) * self.config.n_samples_per_task} API calls"
        )

        # Cost estimate upfront
        est = self.collector.estimate_cost(len(task_bank))
        self.progress(
            f"Estimated cost: ${est['total_cost_usd']:.2f} "
            f"(${est['cost_per_call_usd']:.5f}/call)"
        )

        records = await self.collector.collect(task_bank, resume=resume)
        self.progress(f"Collected {len(records)} raw trajectories")

        # Store all to dataset
        inserted = self.dataset.add_bulk(records)
        self.progress(f"Stored {inserted} new records to dataset")

        return records

    async def filter_trajectories(
        self,
        trajectories: List[TrajectoryRecord],
        quality_threshold: Optional[float] = None,
        diversity_weight: Optional[float] = None,
        difficulty_filter: Optional[str] = None,
        dedup: bool = True,
    ) -> List[TrajectoryRecord]:
        """
        Stage 2: Filter trajectories for quality, diversity, difficulty.

        Removes:
        - Low-quality outputs (below quality_threshold)
        - Near-duplicates (above dedup_threshold similarity)
        - Wrong difficulty tier (if difficulty_filter specified)
        - Too short or too long

        Returns filtered list sorted by composite score.
        """
        qt = quality_threshold if quality_threshold is not None else self.config.min_quality
        dw = diversity_weight if diversity_weight is not None else self.config.diversity_weight
        df = difficulty_filter if difficulty_filter is not None else self.config.difficulty_filter

        self.progress(f"Filtering {len(trajectories)} trajectories (min_quality={qt}, difficulty={df})…")

        # Step 1: Quality filter
        quality_filtered = [r for r in trajectories if r.quality_score >= qt]
        self.progress(f"After quality filter: {len(quality_filtered)} (dropped {len(trajectories) - len(quality_filtered)})")

        # Step 2: Token length filter
        length_filtered = [
            r for r in quality_filtered
            if self.config.min_tokens <= r.token_count <= self.config.max_tokens_filter
        ]
        self.progress(f"After length filter: {len(length_filtered)}")

        # Step 3: Difficulty filter
        diff_buckets = {
            "easy": ["easy"],
            "medium": ["medium"],
            "hard": ["hard", "extreme"],
            "medium_hard": ["medium", "hard", "extreme"],
            "all": ["easy", "medium", "hard", "extreme"],
        }
        allowed_buckets = diff_buckets.get(df, ["easy", "medium", "hard", "extreme"])
        diff_filtered = [r for r in length_filtered if r.difficulty_bucket in allowed_buckets]
        self.progress(f"After difficulty filter ({df}): {len(diff_filtered)}")

        # Step 4: Score diversity and compute composite score
        scored: List[tuple[float, TrajectoryRecord]] = []
        for i, rec in enumerate(diff_filtered):
            div_score = self.scorer.score_diversity(rec, diff_filtered[:i])
            composite = (
                rec.quality_score * (1 - dw) +
                div_score * dw
            )
            rec.diversity_score = div_score
            scored.append((composite, rec))

        # Sort by composite score descending
        scored.sort(key=lambda x: x[0], reverse=True)
        result = [r for _, r in scored]

        # Step 5: Dedup
        if dedup:
            before = len(result)
            result = self._dedup_in_memory(result)
            self.progress(f"After dedup: {len(result)} (removed {before - len(result)})")

        self.progress(f"Final filtered set: {len(result)} trajectories")
        return result

    def build_sft_dataset(
        self,
        trajectories: List[TrajectoryRecord],
        format: str = "alpaca",
    ) -> List[dict]:
        """
        Stage 3a: Build SFT (supervised fine-tuning) dataset.

        Returns list of dicts ready for SFT training with axolotl, LlamaFactory, etc.

        Formats: alpaca | sharegpt | openai | axolotl
        """
        return [r.to_sft_pair(format) for r in trajectories]

    def build_distillation_dataset(
        self,
        trajectories: List[TrajectoryRecord],
        include_token_logprobs: bool = False,
        include_reasoning_steps: bool = True,
    ) -> List[dict]:
        """
        Stage 3b: Build knowledge distillation dataset.

        Includes full reasoning traces for sequence-level KD.
        Compatible with DistiLLM, SelecTKD, and custom KD training loops.
        """
        pairs = []
        for r in trajectories:
            pair = r.to_distillation_pair(include_reasoning=include_reasoning_steps)
            if include_token_logprobs and r.metadata.get("logprobs"):
                pair["teacher_logprobs"] = r.metadata["logprobs"]
            pairs.append(pair)
        return pairs

    def export(
        self,
        trajectories: List[TrajectoryRecord],
        filename_base: str = "distillation",
        formats: Optional[List[str]] = None,
    ) -> Dict[str, str]:
        """Export dataset in multiple formats. Returns {format: path}."""
        fmts = formats or self.config.export_formats
        paths: Dict[str, str] = {}

        for fmt in fmts:
            out_path = self._output_dir / f"{filename_base}_{fmt}.jsonl"
            data = self.build_sft_dataset(trajectories, format=fmt)
            with open(out_path, "w") as f:
                for row in data:
                    f.write(json.dumps(row, ensure_ascii=False) + "\n")
            paths[fmt] = str(out_path)
            self.progress(f"Exported {len(data)} records → {out_path}")

        # Always export raw distillation format
        raw_path = self._output_dir / f"{filename_base}_distillation.jsonl"
        dist_data = self.build_distillation_dataset(trajectories)
        with open(raw_path, "w") as f:
            for row in dist_data:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
        paths["distillation"] = str(raw_path)
        self.progress(f"Exported {len(dist_data)} distillation pairs → {raw_path}")

        # Export stats
        stats = self.get_stats(trajectories)
        stats_path = self._output_dir / f"{filename_base}_stats.json"
        with open(stats_path, "w") as f:
            json.dump(stats, f, indent=2)
        paths["stats"] = str(stats_path)

        return paths

    async def run_full_pipeline(
        self,
        task_bank: List[str],
        output_name: str = "distillation",
        resume: bool = True,
    ) -> Dict[str, object]:
        """
        Run the complete pipeline end-to-end:
        1. Collect traces from teacher
        2. Filter for quality/diversity/difficulty
        3. Export in all configured formats

        Returns summary dict.
        """
        t0 = time.time()

        # Stage 1: Collect
        raw = await self.collect_traces(task_bank, resume=resume)

        # Stage 2: Filter
        filtered = await self.filter_trajectories(raw)

        # Stage 3: Export
        paths = self.export(filtered, filename_base=output_name)

        elapsed = time.time() - t0
        stats = self.get_stats(filtered)

        summary = {
            "elapsed_s": round(elapsed, 1),
            "raw_collected": len(raw),
            "after_filter": len(filtered),
            "filter_rate": round(len(filtered) / max(len(raw), 1), 3),
            "total_cost_usd": self.collector.get_stats()["total_cost_usd"],
            "output_paths": paths,
            "dataset_stats": stats,
        }

        self.progress(
            f"\n{'='*60}\n"
            f"Pipeline complete in {elapsed:.1f}s\n"
            f"  Raw: {len(raw)} → Filtered: {len(filtered)} "
            f"({summary['filter_rate']:.1%} kept)\n"
            f"  Cost: ${summary['total_cost_usd']:.4f}\n"
            f"  Avg quality: {stats['avg_quality']:.3f}\n"
            f"  Outputs: {list(paths.values())}\n"
            f"{'='*60}"
        )
        return summary

    # ── Helpers ──────────────────────────────────────────────────────────────

    def get_stats(self, trajectories: List[TrajectoryRecord]) -> dict:
        if not trajectories:
            return {"total": 0}
        qualities = [r.quality_score for r in trajectories]
        difficulties = [r.difficulty_score for r in trajectories]
        tokens = [r.token_count for r in trajectories]
        costs = [r.cost_usd for r in trajectories]
        domains = {}
        for r in trajectories:
            domains[r.domain] = domains.get(r.domain, 0) + 1
        buckets = {}
        for r in trajectories:
            buckets[r.difficulty_bucket] = buckets.get(r.difficulty_bucket, 0) + 1

        return {
            "total": len(trajectories),
            "avg_quality": round(sum(qualities) / len(qualities), 4),
            "min_quality": round(min(qualities), 4),
            "max_quality": round(max(qualities), 4),
            "avg_difficulty": round(sum(difficulties) / len(difficulties), 4),
            "avg_tokens": round(sum(tokens) / len(tokens), 1),
            "total_tokens": sum(tokens),
            "total_cost_usd": round(sum(costs), 6),
            "domain_distribution": domains,
            "difficulty_distribution": buckets,
            "teacher_model": self.config.teacher_model,
            "teacher_provider": self.config.teacher_provider,
        }

    def _dedup_in_memory(self, records: List[TrajectoryRecord]) -> List[TrajectoryRecord]:
        """Remove near-duplicates using token overlap."""
        threshold = self.config.dedup_threshold
        kept: List[TrajectoryRecord] = []
        seen_tokens: List[set] = []

        for rec in records:
            tokens = set(rec.prompt.lower().split())
            is_dup = False
            for st in seen_tokens:
                if tokens and st:
                    overlap = len(tokens & st) / max(len(tokens | st), 1)
                    if overlap >= threshold:
                        is_dup = True
                        break
            if not is_dup:
                kept.append(rec)
                seen_tokens.append(tokens)

        return kept

    def estimate_pipeline_cost(self, n_tasks: int) -> dict:
        """Estimate full pipeline cost before running."""
        return self.collector.estimate_cost(n_tasks)

    def __repr__(self) -> str:
        return (
            f"DistillationPipeline("
            f"teacher={self.config.teacher_provider}/{self.config.teacher_model}, "
            f"n_samples={self.config.n_samples_per_task}, "
            f"min_quality={self.config.min_quality}"
            f")"
        )
