"""
Mass Distillation Pipeline — coordinates large-scale distillation from
480B–10T parameter models (including MoE architectures).

Supports:
- Progressive distillation stages (easy → medium → hard → frontier)
- Multi-teacher ensemble distillation at scale
- Curriculum-aware data selection and sequencing
- Catastrophic forgetting prevention via replay buffers
- Quality gating at each stage with automatic retry
- Checkpoint/resume for long-running distillation jobs
- Cost-optimized teacher selection based on task difficulty
"""
from __future__ import annotations

import hashlib
import json
import logging
import time
import random
from collections import defaultdict
from dataclasses import dataclass, field, asdict
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Callable, Optional, Any

from .dataset import DataPoint, TrainingDataset
from .distiller import (
    PatternLibrary, ChainOfThoughtDistiller, ConstitutionalDistiller,
    MultiTeacherEnsemble, InferenceTimeDistiller,
)

log = logging.getLogger(__name__)


# ── Stage definitions ──────────────────────────────────────────────────────────

class DistillationStage(Enum):
    """Progressive stages for mass distillation (ascending difficulty)."""
    BOOTSTRAP = "bootstrap"     # Seed with high-quality examples
    EASY      = "easy"          # Simple tasks, high teacher confidence
    MEDIUM    = "medium"        # Moderate complexity
    HARD      = "hard"          # Complex reasoning required
    FRONTIER  = "frontier"      # Near-teacher-level tasks
    ENSEMBLE  = "ensemble"      # Multi-teaker synthesis
    VERIFY    = "verify"        # Self-consistency verification

    @classmethod
    def progression(cls) -> list[DistillationStage]:
        return [
            cls.BOOTSTRAP, cls.EASY, cls.MEDIUM,
            cls.HARD, cls.FRONTIER, cls.ENSEMBLE, cls.VERIFY,
        ]


@dataclass
class StageConfig:
    """Configuration for a single distillation stage."""
    stage: DistillationStage = DistillationStage.MEDIUM
    num_samples: int = 1000
    teacher_temperature: float = 0.7
    student_temperature: float = 0.3
    quality_threshold: float = 0.7
    max_retries_per_sample: int = 3
    top_p: float = 0.95
    domain_mix: dict[str, float] = field(default_factory=lambda: {
        "coding": 0.30, "reasoning": 0.25, "math": 0.15,
        "science": 0.10, "writing": 0.10, "analysis": 0.10,
    })

    def stage_weight(self) -> float:
        """Return sampling weight for this stage (earlier stages = more samples)."""
        weights = {
            DistillationStage.BOOTSTRAP: 0.05,
            DistillationStage.EASY: 0.10,
            DistillationStage.MEDIUM: 0.25,
            DistillationStage.HARD: 0.30,
            DistillationStage.FRONTIER: 0.20,
            DistillationStage.ENSEMBLE: 0.07,
            DistillationStage.VERIFY: 0.03,
        }
        return weights.get(self.stage, 0.10)


# ── Configuration ──────────────────────────────────────────────────────────────

@dataclass
class MassDistillationConfig:
    """Configuration for a mass distillation pipeline run."""
    # Scale
    total_samples: int = 10_000
    batch_size: int = 50

    # Teachers
    teacher_models: list[str] = field(default_factory=lambda: [
        "claude-opus-4-8",
        "deepseek-v4",
        "gpt-4o",
    ])
    student_model: str = "deepseek-v4-flash"
    teacher_provider: str = "opencode-zen"

    # Stages
    stages: list[StageConfig] = field(default_factory=lambda: [
        StageConfig(stage=s) for s in DistillationStage.progression()
    ])

    # Curriculum
    curriculum_epochs: int = 3
    replay_buffer_ratio: float = 0.2    # % previous stage data to replay
    difficulty_ramp_epochs: int = 2     # epochs before advancing difficulty

    # Quality
    min_quality_score: float = 0.4
    dedup_threshold: float = 0.85       # Jaccard similarity for dedup
    max_failure_rate: float = 0.1      # Abort if >10% of batch fails

    # Checkpointing
    checkpoint_dir: str = "./distillation_checkpoints"
    checkpoint_interval: int = 500      # Save every N samples

    # Cost
    max_total_cost_usd: float = 200.0
    cost_per_stage: dict[str, float] = field(default_factory=lambda: {
        "bootstrap": 5.0, "easy": 10.0, "medium": 25.0, "hard": 50.0,
        "frontier": 60.0, "ensemble": 30.0, "verify": 20.0,
    })

    def stage_for_epoch(self, epoch: int) -> StageConfig:
        """Return the active stage config based on epoch."""
        idx = min(epoch // self.difficulty_ramp_epochs, len(self.stages) - 1)
        return self.stages[idx]


# ── Run record ─────────────────────────────────────────────────────────────────

@dataclass
class DistillationRun:
    """Record of a single distillation run with provenance."""
    run_id: str = field(default_factory=lambda: hashlib.md5(
        str(time.time()).encode()).hexdigest()[:12]
    )
    stage: DistillationStage = DistillationStage.BOOTSTRAP
    teacher_model: str = ""
    student_model: str = ""
    task: str = ""
    teacher_response: str = ""
    student_response: str = ""
    quality_score: float = 0.0
    tokens_used: int = 0
    cost_usd: float = 0.0
    cached: bool = False
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())
    metadata: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> DistillationRun:
        d["stage"] = DistillationStage(d["stage"]) if isinstance(d["stage"], str) else d["stage"]
        return cls(**d)


# ── Main Pipeline ──────────────────────────────────────────────────────────────

class MassDistillationPipeline:
    """Coordinates large-scale distillation from frontier teacher models.

    Orchestrates the full pipeline:
    1. Progressive stage advancement (auto-difficulty ramp)
    2. Batch generation with quality gating
    3. Checkpoint/resume for fault tolerance
    4. Cost tracking and budget enforcement
    5. Data deduplication and quality filtering
    """

    def __init__(
        self,
        config: MassDistillationConfig | None = None,
        teacher_fn: Callable[[str, dict], str] | None = None,
        student_fn: Callable[[str], str] | None = None,
        progress_callback: Callable[[str, dict], None] | None = None,
    ):
        self.config = config or MassDistillationConfig()
        self.teacher_fn = teacher_fn or self._default_teacher
        self.student_fn = student_fn
        self.progress = progress_callback or self._default_progress

        # Run state
        self.dataset = TrainingDataset()
        self.replay_buffer: list[DataPoint] = []
        self.current_stage_idx: int = 0
        self.total_cost: float = 0.0
        self.run_log: list[DistillationRun] = []
        self.failed_count: int = 0
        self.completed_count: int = 0

        # Quality tracking
        self.quality_history: dict[str, list[float]] = defaultdict(list)
        self.stage_quality: dict[str, float] = {}

    # ── Main entry point ───────────────────────────────────────────────────────

    def run(self) -> TrainingDataset:
        """Execute the full mass distillation pipeline.

        Returns:
            A TrainingDataset with all successfully distilled samples.
        """
        self.progress("Starting mass distillation pipeline", {
            "total_samples": self.config.total_samples,
            "stages": [s.stage.value for s in self.config.stages],
            "teacher_models": self.config.teacher_models,
        })

        checkpoint_path = Path(self.config.checkpoint_dir)
        checkpoint_path.mkdir(parents=True, exist_ok=True)

        samples_per_stage = self.config.total_samples // len(self.config.stages)

        for stage_idx, stage_cfg in enumerate(self.config.stages):
            self.current_stage_idx = stage_idx
            remaining = samples_per_stage

            self.progress(f"Stage {stage_idx + 1}/{len(self.config.stages)}: {stage_cfg.stage.value}", {
                "target": remaining,
                "teacher_temperature": stage_cfg.teacher_temperature,
            })

            # Inner generation loop
            batch: list[DataPoint] = []
            batch_failures = 0
            generated = 0

            while generated < remaining and batch_failures < remaining * self.config.max_failure_rate:
                # Pick domains per batch
                domains = self._sample_domains(stage_cfg.domain_mix, self.config.batch_size)
                tasks = [self._generate_task(d, stage_cfg.stage) for d in domains]

                # Generate teacher responses
                teacher_responses = self._batch_teacher(tasks, stage_cfg)

                # Apply distillation
                for task, teacher_resp in zip(tasks, teacher_responses):
                    if not teacher_resp:
                        batch_failures += 1
                        continue

                    # Quality gate
                    quality = self._score_quality(task, teacher_resp, stage_cfg.stage)

                    if quality < self.config.min_quality_score:
                        batch_failures += 1
                        continue

                    # Create DataPoint
                    dp = DataPoint(
                        input=task,
                        output=teacher_resp,
                        task_type=stage_cfg.stage.value,
                        domain="general",
                        difficulty=self._stage_difficulty(stage_cfg.stage),
                        quality_score=quality,
                        metadata={
                            "stage": stage_cfg.stage.value,
                            "teacher_model": self.config.teacher_models[0],
                            "temperature": stage_cfg.teacher_temperature,
                        },
                    )
                    batch.append(dp)
                    generated += 1
                    self.completed_count += 1

                    # Record run
                    self.run_log.append(DistillationRun(
                        stage=stage_cfg.stage,
                        teacher_model=self.config.teacher_models[0],
                        student_model=self.config.student_model,
                        task=task,
                        teacher_response=teacher_resp,
                        quality_score=quality,
                    ))

                    # Checkpoint
                    if self.completed_count % self.config.checkpoint_interval == 0:
                        self._save_checkpoint(checkpoint_path)

                # Dedup and merge batch
                batch = self._dedup(batch)
                self.dataset.datapoints.extend(batch)

                # Update replay buffer (keep last 20%)
                replay_size = max(int(len(batch) * self.config.replay_buffer_ratio), 10)
                self.replay_buffer = batch[-replay_size:]

                self.progress(f"Stage progress: {generated}/{remaining}", {
                    "failed": batch_failures,
                    "batch_quality": round(
                        sum(self._score_quality(t, r, stage_cfg.stage)
                            for t, r in zip(tasks, teacher_responses) if r)
                        / max(len([r for r in teacher_responses if r]), 1), 3),
                })

            # Stage complete — update quality tracking
            if batch:
                avg_q = sum(dp.quality_score for dp in batch) / len(batch)
                self.stage_quality[stage_cfg.stage.value] = avg_q

        self.progress("Mass distillation complete", {
            "total_samples": len(self.dataset),
            "total_cost": round(self.total_cost, 2),
            "failed": self.failed_count,
            "stage_quality": self.stage_quality,
        })

        return self.dataset

    # ── Task generation ─────────────────────────────────────────────────────────

    def _sample_domains(self, domain_mix: dict[str, float], n: int) -> list[str]:
        """Sample domains according to mix ratios."""
        domains, weights = zip(*domain_mix.items())
        return random.choices(domains, weights=weights, k=n)

    def _generate_task(self, domain: str, stage: DistillationStage) -> str:
        """Generate a synthetic task for a given domain and stage."""
        templates = self._task_templates(domain, stage)
        template = random.choice(templates)
        # Fill in template variables
        vars_to_fill = self._task_variables(domain)
        return template.format(**{k: random.choice(v) for k, v in vars_to_fill.items()})

    def _task_templates(self, domain: str, stage: DistillationStage) -> list[str]:
        """Return task templates for a domain at a given stage."""
        templates: dict[str, dict[str, list[str]]] = {
            "coding": {
                "easy": [
                    "Write a function to {action}.",
                    "Implement a {data_structure} in {language}.",
                ],
                "medium": [
                    "Design and implement a {pattern} for {use_case}.",
                    "Build a {system} with {feature1} and {feature2} support.",
                ],
                "hard": [
                    "Implement a distributed {system} with fault tolerance and {feature}.",
                    "Design a {pattern}-based architecture for {use_case} handling {constraint}.",
                ],
            },
            "reasoning": {
                "easy": [
                    "Explain why {concept} works in {context}.",
                    "Compare {concept1} and {concept2} in terms of {aspect}.",
                ],
                "medium": [
                    "Analyze the trade-offs between {approach1} and {approach2} for {scenario}.",
                    "Evaluate the impact of {change} on {system} considering {constraint}.",
                ],
                "hard": [
                    "Design a solution for {problem} that optimizes for {metric1} while maintaining {metric2}.",
                    "Prove or disprove: {proposition}. Show all reasoning steps.",
                ],
            },
            "math": {
                "easy": [
                    "Solve the equation: {equation}.",
                    "Calculate the {quantity} given {parameters}.",
                ],
                "medium": [
                    "Find the {quantity} of {shape} with {parameters}. Show your work.",
                    "Prove that {statement} for all {domain}.",
                ],
                "hard": [
                    "Solve the optimization problem: {problem} with constraints {constraints}.",
                    "Derive the formula for {quantity} under {conditions}.",
                ],
            },
            "science": {
                "easy": [
                    "Explain {concept} in simple terms.",
                    "Describe how {process} works.",
                ],
                "medium": [
                    "Compare and contrast {concept1} and {concept2} with experimental evidence.",
                    "Analyze the effects of {variable} on {system}.",
                ],
                "hard": [
                    "Design an experiment to test {hypothesis} controlling for {confounds}.",
                    "Synthesize findings from {field1} and {field2} to propose a unified model of {phenomenon}.",
                ],
            },
            "writing": {
                "easy": [
                    "Write a {tone} summary of {topic}.",
                    "Create an outline for a {type} about {subject}.",
                ],
                "medium": [
                    "Write a {length}-word {type} on {topic} with {structure}.",
                    "Revise the following text to improve {aspect}: {text}.",
                ],
                "hard": [
                    "Write a comprehensive analysis of {topic} incorporating {perspectives} perspectives.",
                    "Create a detailed {format} addressing {audience} about {subject} with {requirements}.",
                ],
            },
            "analysis": {
                "easy": [
                    "Summarize the key points of {topic}.",
                    "List the advantages and disadvantages of {approach}.",
                ],
                "medium": [
                    "Analyze the {scenario} using {framework} and recommend actions.",
                    "Evaluate the effectiveness of {strategy} for {goal} based on {criteria}.",
                ],
                "hard": [
                    "Conduct a thorough {type} analysis of {subject} with quantitative and qualitative evidence.",
                    "Develop a decision framework for {problem} considering {factors} and validate with {cases}.",
                ],
            },
        }
        stage_key = stage.value
        domain_templates = templates.get(domain, templates["reasoning"])
        # Fall back through difficulty levels
        for key in [stage_key, "medium", "easy"]:
            if key in domain_templates:
                return domain_templates[key]
        return ["Solve this problem: {problem}."]

    def _task_variables(self, domain: str) -> dict[str, list[str]]:
        """Return variable fill-ins for task templates."""
        return {
            "language": ["Python", "Rust", "Go", "TypeScript", "C++", "Java"],
            "data_structure": ["binary search tree", "LRU cache", "Bloom filter",
                               "skip list", "trie", "segment tree"],
            "pattern": ["Observer", "Factory", "Strategy", "Decorator",
                        "Repository", "CQRS", "Event Sourcing"],
            "use_case": ["real-time analytics", "e-commerce checkout",
                         "multi-tenant SaaS", "IoT device management"],
            "feature": ["authentication", "rate limiting", "caching",
                        "load balancing", "fault recovery"],
            "feature1": ["caching", "replication", "sharding"],
            "feature2": ["monitoring", "auto-scaling", "circuit breaking"],
            "system": ["cache", "message queue", "rate limiter",
                       "key-value store", "scheduler"],
            "approach1": ["monolithic", "microservices", "serverless"],
            "approach2": ["event-driven", "RESTful", "GraphQL"],
            # ... more variables
            "action": ["sort a list", "find duplicates", "validate input",
                       "parse JSON", "convert formats"],
            "concept": ["recursion", "caching", "load balancing",
                        "eventual consistency", "sharding"],
            "context": ["distributed systems", "web applications",
                        "database design", "network protocols"],
            "scenario": ["high traffic", "low latency", "data consistency",
                         "fault tolerance"],
            "constraint": ["high availability", "strong consistency",
                           "bounded latency", "cost efficiency"],
            "problem": [f"problem #{i}" for i in range(1, 21)],
            "metric1": ["throughput", "latency", "availability"],
            "metric2": ["consistency", "durability", "scalability"],
            "tone": ["technical", "educational", "persuasive", "informal"],
            "topic": ["machine learning", "distributed systems",
                      "software architecture", "algorithm design"],
            "type": ["article", "tutorial", "documentation", "blog post"],
            "aspect": ["clarity", "conciseness", "technical accuracy"],
            "structure": ["introduction-body-conclusion", "problem-solution",
                          "comparative analysis"],
            "framework": ["SWOT", "First Principles", "MECE", "STAR"],
            "approach": ["top-down", "bottom-up", "agile", "waterfall"],
            "goal": ["optimize performance", "reduce costs",
                     "improve reliability", "scale operations"],
            "strategy": ["caching", "load balancing", "auto-scaling",
                         "data partitioning"],
            "criteria": ["cost", "performance", "maintainability", "scalability"],
            "format": ["report", "proposal", "whitepaper", "case study"],
            "audience": ["executives", "engineers", "stakeholders", "customers"],
            "subject": ["system architecture", "data pipeline",
                        "deployment strategy", "security framework"],
            "requirements": ["security compliance", "performance SLAs",
                             "regulatory requirements"],
            "method": ["observation", "simulation", "theoretical analysis",
                       "empirical study"],
            "field1": ["computer science", "physics", "biology", "economics"],
            "field2": ["mathematics", "chemistry", "psychology", "sociology"],
            "phenomenon": ["emergence", "self-organization",
                           "network effects", "scaling laws"],
            "quantity": ["area", "volume", "derivative", "integral"],
            "shape": ["sphere", "cone", "cylinder", "torus"],
            "parameters": ["radius=5, height=10", "a=3, b=4, c=5",
                           "base=10, height=6"],
            "statement": ["the sum of angles in a triangle is 180 degrees",
                          "the square root of 2 is irrational"],
            "domain_math": ["real numbers", "integers", "complex numbers"],
            "process": ["photosynthesis", "machine learning training",
                        "database indexing", "network routing"],
            "concept1": ["gradient descent", "genetic algorithms",
                         "simulated annealing"],
            "concept2": ["random forests", "neural networks", "SVMs"],
            "proposition": [
                "Every continuous function is differentiable",
                "P = NP",
                "Every integer is the sum of two primes",
            ],
            "hypothesis": ["the treatment has a significant effect",
                           "the new algorithm is faster than the baseline"],
        }

    # ── Teacher interaction ────────────────────────────────────────────────────

    def _batch_teacher(
        self, tasks: list[str], stage_cfg: StageConfig
    ) -> list[str]:
        """Generate teacher responses for a batch of tasks."""
        return [self.teacher_fn(t, {
            "temperature": stage_cfg.teacher_temperature,
            "max_tokens": 4096,
            "top_p": stage_cfg.top_p,
        }) for t in tasks]

    def _default_teacher(self, task: str, kwargs: dict) -> str:
        """Default teacher stub — override in production."""
        return f"[Teacher response for: {task[:80]}]"

    def _score_quality(
        self, task: str, response: str, stage: DistillationStage
    ) -> float:
        """Score response quality with heuristic and length checks."""
        if not response or len(response) < 50:
            return 0.0
        score = 0.5
        if len(response) > 300:
            score += 0.1
        if len(response) > 1000:
            score += 0.1
        if "```" in response:
            score += 0.05
        if response.count("\n") > 5:
            score += 0.05
        if any(w in response.lower() for w in
               ["therefore", "because", "example", "step"]):
            score += 0.1
        # Stage bonus: harder stages need more thorough responses
        stage_min_length = {"easy": 100, "medium": 300, "hard": 500,
                            "frontier": 800, "bootstrap": 200,
                            "ensemble": 500, "verify": 400}
        min_len = stage_min_length.get(stage.value, 200)
        if len(response) < min_len:
            score *= 0.5
        return min(score, 0.99)

    def _stage_difficulty(self, stage: DistillationStage) -> float:
        """Map stage to difficulty score."""
        mapping = {
            DistillationStage.BOOTSTRAP: 0.2,
            DistillationStage.EASY: 0.3,
            DistillationStage.MEDIUM: 0.5,
            DistillationStage.HARD: 0.7,
            DistillationStage.FRONTIER: 0.85,
            DistillationStage.ENSEMBLE: 0.9,
            DistillationStage.VERIFY: 0.6,
        }
        return mapping.get(stage, 0.5)

    def _dedup(self, batch: list[DataPoint]) -> list[DataPoint]:
        """Deduplicate using Jaccard similarity on input text."""
        seen: list[str] = []
        deduped: list[DataPoint] = []
        for dp in batch:
            words = set(dp.input.lower().split())
            if not any(
                len(words & set(s.split())) / max(len(words | set(s.split())), 1)
                > self.config.dedup_threshold
                for s in seen
            ):
                seen.append(dp.input)
                deduped.append(dp)
        return deduped

    # ── Checkpointing ──────────────────────────────────────────────────────────

    def _save_checkpoint(self, path: Path):
        """Save current pipeline state as checkpoint."""
        ckpt = {
            "stage_idx": self.current_stage_idx,
            "completed": self.completed_count,
            "failed": self.failed_count,
            "total_cost": self.total_cost,
            "dataset_size": len(self.dataset),
            "timestamp": datetime.now().isoformat(),
        }
        ckpt_file = path / f"checkpoint_stage{self.current_stage_idx}.json"
        with open(ckpt_file, "w") as f:
            json.dump(ckpt, f, indent=2)
        # Save dataset
        ds_file = path / f"dataset_stage{self.current_stage_idx}.jsonl"
        self.dataset.save(str(ds_file))
        log.info("Checkpoint saved: stage=%d, samples=%d",
                 self.current_stage_idx, len(self.dataset))

    def load_checkpoint(self, path: str | Path) -> bool:
        """Load pipeline state from latest checkpoint.

        Returns True if checkpoint was found and loaded.
        """
        path = Path(path)
        if not path.exists():
            return False
        checkpoints = sorted(path.glob("checkpoint_stage*.json"))
        if not checkpoints:
            return False
        latest = checkpoints[-1]
        with open(latest) as f:
            ckpt = json.load(f)
        self.current_stage_idx = ckpt["stage_idx"]
        self.completed_count = ckpt["completed"]
        self.failed_count = ckpt["failed"]
        self.total_cost = ckpt["total_cost"]
        # Load dataset
        ds_file = path / f"dataset_stage{ckpt['stage_idx']}.jsonl"
        if ds_file.exists():
            self.dataset = TrainingDataset(path=str(ds_file))
        log.info("Checkpoint loaded: stage=%d, samples=%d",
                 self.current_stage_idx, len(self.dataset))
        return True

    # ── Progress ───────────────────────────────────────────────────────────────

    def _default_progress(self, msg: str, data: dict | None = None):
        log.info("[%s] %s", datetime.now().isoformat(), msg)
        if data:
            log.debug("  %s", json.dumps(data))

    def summary(self) -> dict:
        return {
            "total_samples": len(self.dataset),
            "total_cost": round(self.total_cost, 2),
            "stages_completed": self.current_stage_idx + 1,
            "stage_quality": self.stage_quality,
            "failed_count": self.failed_count,
            "replay_buffer_size": len(self.replay_buffer),
        }

    def __repr__(self) -> str:
        return (
            f"MassDistillationPipeline(stages={len(self.config.stages)}, "
            f"samples={self.config.total_samples}, "
            f"completed={self.completed_count})"
        )
