"""Mass Distillation Pipeline — 480B-10T model scale data collection.

Research basis (2025):
  - DeepSeek-R1 (arXiv 2501.12948): 671B MoE → 800K samples via rejection
    sampling (600K CoT + 200K instruction), SFT on Qwen2.5/Llama, 2 epochs.
  - DASD (arXiv 2601.09088): Distribution-Aligned Sequence Distillation —
    temperature-scheduled collection, divergence-aware sampling, 448K samples
    → SOTA on 4B student (88.5 AIME24, 69.3 LiveCodeBench v5).
  - Qwen3 (arXiv 2505.09388): 36T token pre-training with specialized
    sub-model generation (math, coder, VL sub-models).
  - On-Policy Distillation (arXiv 2604.00626): mixing teacher and student
    rollouts during training.

This module provides:
  MassDistillationConfig — hyper-parameters for large-scale collection
  MassDistillationOrchestrator — orchestrates multi-domain, multi-teacher,
    multi-stage collection inspired by the above papers.
  DomainSampler — balanced cross-domain task sampling
  QualityGate — multi-signal rejection sampling gate
  DASDScheduler — temperature and diversity scheduling per DASD paper
"""
from __future__ import annotations

import asyncio
import json
import math
import random
import re
import sqlite3
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from .distillation_dataset import DistillationDataset, TrajectoryRecord
from .cloud_teacher import (
    CloudTeacherAdapter as CloudTeacher,
    CloudTeacherConfig as TeacherConfig,
    CloudTeacherEnsemble as MultiTeacherEnsemble,
)


# ─────────────────────────────────────────────────────────────────────────────
# Domain task banks  (seeded prompts covering all major reasoning domains)
# ─────────────────────────────────────────────────────────────────────────────

DOMAIN_TASK_SEEDS: Dict[str, List[str]] = {
    "math_competition": [
        "Find all integer solutions to x³ + y³ = z³ + 1 where 1 ≤ x,y,z ≤ 100.",
        "Prove that for any prime p > 3, p² ≡ 1 (mod 24).",
        "A regular polygon has interior angles summing to 3240°. How many sides does it have?",
        "Find the sum of all positive integers n such that n² + 19n + 99 is a perfect square.",
        "In triangle ABC, ∠A = 60°. The angle bisectors from B and C meet at I. Prove BI·IC = AI².",
    ],
    "math_reasoning": [
        "Explain why 0.999... = 1 using at least 3 different proof methods.",
        "Derive the formula for the sum of the first n squares: 1² + 2² + … + n².",
        "Why does differentiating sin(x) give cos(x)? Give an intuitive geometric explanation.",
        "Solve the recurrence T(n) = 2T(n/2) + n and explain each step.",
        "What is the expected number of coin flips to get two heads in a row?",
    ],
    "coding": [
        "Implement a thread-safe LRU cache in Python with O(1) get/put. Include tests.",
        "Write a Python function that finds the longest palindromic substring in O(n) time.",
        "Implement binary search on a sorted rotated array. Handle duplicates. Include edge cases.",
        "Design a rate limiter that allows N requests per minute using a sliding window log approach.",
        "Build a minimal async job queue in Python with priority support and worker pool.",
        "Implement merge sort. Then explain its time complexity with a recurrence tree.",
        "Write a Python class for a min-heap. Support push, pop, and peek. Add unit tests.",
    ],
    "science_reasoning": [
        "Explain how mRNA vaccines work, from injection to immune response. Be precise.",
        "Why does increasing pressure increase the boiling point of water? Use thermodynamics.",
        "Describe the double-slit experiment and what it reveals about quantum mechanics.",
        "How does a transformer neural network's attention mechanism differ from RNN memory?",
        "Explain CRISPR-Cas9 gene editing: mechanism, delivery, off-target risks, ethical limits.",
    ],
    "logic_reasoning": [
        "100 prisoners each pick one box from 100 numbered boxes containing their number. "
        "They use the cycle strategy. What is the success probability? Prove it.",
        "You have 12 balls, one heavier or lighter. Find it in 3 weighings. Give the full algorithm.",
        "A knight always tells truth, a knave always lies. You meet two people: A says "
        "'We are both knaves.' What is each?",
        "Prove by contradiction that √2 is irrational.",
        "There are 3 doors: behind one is a car, two have goats. You pick door 1. "
        "Host opens door 3 (goat). Should you switch? Why?",
    ],
    "instruction_following": [
        "Summarize the key differences between TCP and UDP in a table with 5 columns.",
        "Write a professional email declining a job offer while leaving the door open for future roles.",
        "Explain recursion to a 10-year-old using a real-world analogy. Keep it under 150 words.",
        "List 10 Python anti-patterns with a bad example and corrected version for each.",
        "Write a git commit message for: fix authentication bypass in JWT verification logic.",
    ],
    "security": [
        "Explain SQL injection with a vulnerable PHP snippet, the attack vector, and the fix.",
        "What is a timing side-channel attack? Give a Python example and mitigation.",
        "Describe the OWASP Top 10 2025 vulnerabilities. For each: what it is, an example, the fix.",
        "How does certificate pinning prevent MitM attacks? When is it appropriate?",
        "Explain heap spray attacks and modern mitigations (ASLR, DEP, CFI).",
    ],
    "architecture": [
        "Design a distributed rate limiter for a 100K RPS API. Discuss Redis vs. token bucket vs. sliding window.",
        "Explain the CAP theorem with concrete examples of databases in each partition.",
        "How would you design YouTube's video upload and encoding pipeline?",
        "Describe event sourcing vs. CQRS. When would you use each? Give a concrete example.",
        "Design a search autocomplete system for 1B queries/day. Walk through each component.",
    ],
    "analysis": [
        "Analyze the trade-offs between microservices and monolithic architecture for a 5-person startup.",
        "Compare transformer, RNN, and SSM architectures for long-context modeling. Which wins and why?",
        "What are the limitations of current LLMs for mathematical reasoning? Be specific.",
        "Analyze the Byzantine Generals Problem and how consensus protocols solve it.",
        "Compare gradient descent variants (SGD, Adam, AdaGrad, RMSProp) with convergence guarantees.",
    ],
}

# Difficulty levels for DASD-style staging
DIFFICULTY_LEVELS = {
    "easy":   {"temp_range": (0.3, 0.6), "min_quality": 0.45, "weight": 0.2},
    "medium": {"temp_range": (0.6, 0.8), "min_quality": 0.55, "weight": 0.5},
    "hard":   {"temp_range": (0.7, 1.0), "min_quality": 0.60, "weight": 0.3},
}


# ─────────────────────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class MassDistillationConfig:
    """
    Configuration for a large-scale mass distillation run.

    Inspired by:
      - DeepSeek-R1: 800K samples, rejection sampling, 2-epoch SFT
      - DASD: 448K samples, temperature scheduling, multi-stage
      - Qwen3: domain-specialized generation
    """
    # ── Target scale ─────────────────────────────────────────────────────────
    target_samples: int = 10_000      # total samples to collect
    n_per_task: int = 8              # samples per task (DeepSeek-R1 style)

    # ── Teacher ──────────────────────────────────────────────────────────────
    teacher_provider: str = "deepseek"
    teacher_model: str = "deepseek-reasoner"   # R1 671B MoE default
    teacher_api_key: str = ""
    teacher_base_url: str = ""
    extract_thinking: bool = True    # extract <think> CoT traces

    # ── Multi-teacher ensemble ────────────────────────────────────────────────
    use_ensemble: bool = False
    ensemble_teachers: List[Dict[str, str]] = field(default_factory=list)
    # e.g. [{"provider": "anthropic", "model": "claude-opus-4-8", "key": "..."},
    #        {"provider": "google", "model": "gemini-2.5-pro", "key": "..."}]

    # ── Domain balancing ─────────────────────────────────────────────────────
    domains: List[str] = field(default_factory=lambda: [
        "math_reasoning", "coding", "logic_reasoning",
        "science_reasoning", "instruction_following",
    ])
    domain_weights: Dict[str, float] = field(default_factory=dict)
    # e.g. {"math_reasoning": 0.3, "coding": 0.3, ...}  — auto-balanced if empty

    # ── Quality / rejection sampling ─────────────────────────────────────────
    min_quality: float = 0.55        # DeepSeek-R1 style: filter low-quality
    max_attempts_per_sample: int = 3 # rejection sampling retries
    dedup_threshold: float = 0.85   # near-duplicate removal threshold

    # ── DASD temperature scheduling ──────────────────────────────────────────
    use_dasd_schedule: bool = True
    # Stage 1: low-temp (exploit) → Stage 2: high-temp (explore) → Stage 3: mixed
    dasd_stages: List[Dict[str, Any]] = field(default_factory=lambda: [
        {"name": "low_temp",   "temperature": 0.3, "fraction": 0.35},
        {"name": "high_temp",  "temperature": 0.9, "fraction": 0.40},
        {"name": "mixed_policy","temperature": 0.6, "fraction": 0.25},
    ])

    # ── Concurrency / rate limiting ──────────────────────────────────────────
    concurrency: int = 12
    rate_limit_rpm: int = 60
    batch_size: int = 50

    # ── Budget ───────────────────────────────────────────────────────────────
    max_cost_usd: float = 500.0
    max_tokens_per_call: int = 8192

    # ── Output ───────────────────────────────────────────────────────────────
    output_dir: str = "~/.lazy_chameleon/mass_distillation"
    db_path: str = "~/.lazy_chameleon/mass_distillation.db"
    checkpoint_every: int = 100      # save checkpoint every N samples
    export_formats: List[str] = field(
        default_factory=lambda: ["alpaca", "sharegpt", "jsonl"])
    include_thinking_in_sft: bool = True  # include CoT in training data

    # ── Student target ───────────────────────────────────────────────────────
    student_model_size: str = "7B"   # for recommendations
    student_epochs: int = 2          # DeepSeek-R1 style: 2 epochs SFT


# ─────────────────────────────────────────────────────────────────────────────
# DASD Scheduler
# ─────────────────────────────────────────────────────────────────────────────

class DASDScheduler:
    """
    Distribution-Aligned Sequence Distillation temperature scheduler.

    Per arXiv:2601.09088:
      Stage 1 (low temp, 35%): exploit teacher's most likely responses.
        Produces high-consistency, easy-to-learn examples.
      Stage 2 (high temp, 40%): diverse exploration of teacher distribution.
        Produces harder, more diverse examples.
      Stage 3 (mixed policy, 25%): blend of both for calibration.

    Result: student learns both the mode (easy) AND the tails (hard)
    of the teacher's distribution.
    """

    def __init__(self, stages: List[Dict[str, Any]], total_samples: int):
        self.stages = stages
        self.total = total_samples
        self._plan: List[Tuple[str, float]] = []  # (stage_name, temperature)
        self._build_plan()

    def _build_plan(self):
        for stage in self.stages:
            n = int(self.total * stage["fraction"])
            temp = stage["temperature"]
            self._plan.extend([(stage["name"], temp)] * n)
        # fill remainder with last stage
        while len(self._plan) < self.total:
            last = self.stages[-1]
            self._plan.append((last["name"], last["temperature"]))

    def temperature_for(self, sample_idx: int) -> Tuple[str, float]:
        """Return (stage_name, temperature) for sample index."""
        if sample_idx < len(self._plan):
            return self._plan[sample_idx]
        return self._plan[-1]

    def get_stage_summary(self) -> Dict[str, int]:
        counts: Dict[str, int] = {}
        for name, _ in self._plan:
            counts[name] = counts.get(name, 0) + 1
        return counts


# ─────────────────────────────────────────────────────────────────────────────
# Domain Sampler
# ─────────────────────────────────────────────────────────────────────────────

class DomainSampler:
    """
    Balanced cross-domain task sampler.

    Uses weighted sampling to ensure the distillation dataset covers
    all requested domains proportionally (Qwen3-style domain specialization).
    Augments seed tasks with paraphrase variations.
    """

    def __init__(
        self,
        domains: List[str],
        weights: Optional[Dict[str, float]] = None,
        custom_tasks: Optional[Dict[str, List[str]]] = None,
    ):
        self.domains = domains
        self.weights = weights or {d: 1.0 / len(domains) for d in domains}
        # Merge custom tasks with built-in seeds
        self.task_banks: Dict[str, List[str]] = {}
        for d in domains:
            bank = list(DOMAIN_TASK_SEEDS.get(d, []))
            if custom_tasks and d in custom_tasks:
                bank.extend(custom_tasks[d])
            self.task_banks[d] = bank

    def sample(self, n: int, augment: bool = True) -> List[Tuple[str, str]]:
        """
        Sample n (task, domain) pairs with domain balancing.
        Returns list of (task_text, domain_name).
        """
        domain_list = list(self.weights.keys())
        wt_list = [self.weights.get(d, 0.0) for d in domain_list]
        total_wt = sum(wt_list)
        wt_list = [w / total_wt for w in wt_list]

        result: List[Tuple[str, str]] = []
        for _ in range(n):
            domain = random.choices(domain_list, weights=wt_list, k=1)[0]
            bank = self.task_banks.get(domain, [])
            if not bank:
                continue
            task = random.choice(bank)
            if augment:
                task = self._augment(task, domain)
            result.append((task, domain))
        return result

    def _augment(self, task: str, domain: str) -> str:
        """Light augmentation: add difficulty or perspective variation."""
        augmentations = [
            lambda t: t,  # identity (keep original)
            lambda t: f"Think step by step. {t}",
            lambda t: f"{t}\n\nBe thorough and show all your work.",
            lambda t: f"{t}\n\nInclude edge cases and error handling.",
            lambda t: f"Give a detailed explanation. {t}",
        ]
        # 60% keep original, 40% augment
        if random.random() < 0.6:
            return task
        return random.choice(augmentations)(task)

    def add_custom_tasks(self, domain: str, tasks: List[str]):
        """Add custom tasks to a domain bank."""
        if domain not in self.task_banks:
            self.task_banks[domain] = []
            self.domains.append(domain)
        self.task_banks[domain].extend(tasks)

    def stats(self) -> Dict[str, int]:
        return {d: len(bank) for d, bank in self.task_banks.items()}


# ─────────────────────────────────────────────────────────────────────────────
# Quality Gate
# ─────────────────────────────────────────────────────────────────────────────

class QualityGate:
    """
    Multi-signal quality gate for rejection sampling.

    Inspired by DeepSeek-R1's rejection sampling approach:
    only ~75% of generated samples pass quality filtering.

    Signals:
      - Length (too short = low quality, optimal range = 300-8000 tokens)
      - Thinking trace presence and depth (CoT → better distillation)
      - Format quality (structure, code blocks, lists)
      - Domain keyword relevance
      - Diversity vs. existing samples (deduplication)
      - Correctness signals (math: does it contain a final boxed answer?)
    """

    def __init__(self, min_quality: float = 0.55,
                 dedup_threshold: float = 0.85):
        self.min_quality = min_quality
        self.dedup_threshold = dedup_threshold
        self._seen_shingles: set = set()
        self.n_passed = 0
        self.n_rejected = 0
        self.rejection_reasons: Dict[str, int] = {}

    def passes(self, record: TrajectoryRecord) -> Tuple[bool, str]:
        """
        Returns (pass, reason).
        Reason is empty string on pass, rejection reason on fail.
        """
        answer = record.answer
        thinking = record.thinking

        # ── Hard filters ─────────────────────────────────────────────────────
        if len(answer.strip()) < 30:
            return self._reject("too_short")

        if len(answer) > 64_000:
            return self._reject("too_long")

        # ── Quality score ────────────────────────────────────────────────────
        if record.quality < self.min_quality:
            return self._reject(f"low_quality:{record.quality:.2f}")

        # ── Near-duplicate check ─────────────────────────────────────────────
        shingles = self._shingle(answer)
        overlap = len(shingles & self._seen_shingles)
        if shingles and overlap / len(shingles) > self.dedup_threshold:
            return self._reject("near_duplicate")

        # ── Pass ─────────────────────────────────────────────────────────────
        self._seen_shingles.update(shingles)
        self.n_passed += 1
        return True, ""

    def _reject(self, reason: str) -> Tuple[bool, str]:
        self.n_rejected += 1
        self.rejection_reasons[reason] = (
            self.rejection_reasons.get(reason, 0) + 1)
        return False, reason

    def _shingle(self, text: str, k: int = 6) -> set:
        """4-gram shingles for near-duplicate detection."""
        words = text.lower().split()
        if len(words) < k:
            return set()
        return {tuple(words[i:i+k]) for i in range(len(words) - k + 1)}

    def stats(self) -> Dict[str, Any]:
        total = self.n_passed + self.n_rejected
        return {
            "passed": self.n_passed,
            "rejected": self.n_rejected,
            "pass_rate": self.n_passed / max(total, 1),
            "rejection_reasons": dict(self.rejection_reasons),
        }

    def reset(self):
        """Reset duplicate tracking (use between separate collection runs)."""
        self._seen_shingles.clear()
        self.n_passed = 0
        self.n_rejected = 0
        self.rejection_reasons.clear()


# ─────────────────────────────────────────────────────────────────────────────
# SFT Formatter
# ─────────────────────────────────────────────────────────────────────────────

class SFTFormatter:
    """
    Format distillation records for supervised fine-tuning.

    Supports:
      alpaca    {"instruction": ..., "input": "", "output": ...}
      sharegpt  {"conversations": [{"from": "human", "value": ...}, ...]}
      jsonl     raw JSON lines
      openai    {"messages": [{"role": "user"/"assistant", "content": ...}]}
      thinking  include full thinking trace in assistant turn (for reasoning SFT)
    """

    @staticmethod
    def to_alpaca(record: TrajectoryRecord,
                  include_thinking: bool = True) -> Dict[str, Any]:
        output = record.answer
        if include_thinking and record.thinking:
            output = (f"<thinking>\n{record.thinking}\n</thinking>\n\n"
                      + record.answer)
        return {
            "instruction": record.task,
            "input": "",
            "output": output,
            "metadata": {
                "source": record.provider,
                "model": record.model,
                "quality": record.quality,
                "domain": record.metadata.get("domain", ""),
                "has_thinking": bool(record.thinking),
            },
        }

    @staticmethod
    def to_sharegpt(record: TrajectoryRecord,
                    include_thinking: bool = True) -> Dict[str, Any]:
        output = record.answer
        if include_thinking and record.thinking:
            output = (f"<thinking>\n{record.thinking}\n</thinking>\n\n"
                      + record.answer)
        return {
            "conversations": [
                {"from": "human",    "value": record.task},
                {"from": "gpt",      "value": output},
            ],
            "source": record.provider,
            "model": record.model,
        }

    @staticmethod
    def to_openai_messages(record: TrajectoryRecord,
                           system: str = "",
                           include_thinking: bool = True) -> Dict[str, Any]:
        output = record.answer
        if include_thinking and record.thinking:
            output = (f"<thinking>\n{record.thinking}\n</thinking>\n\n"
                      + record.answer)
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": record.task})
        messages.append({"role": "assistant", "content": output})
        return {"messages": messages}

    @classmethod
    def export(
        cls,
        records: List[TrajectoryRecord],
        path: str,
        fmt: str = "alpaca",
        include_thinking: bool = True,
        system_prompt: str = "",
    ) -> int:
        """Export records to file. Returns number written."""
        out = Path(path).expanduser()
        out.parent.mkdir(parents=True, exist_ok=True)
        written = 0
        with open(out, "w", encoding="utf-8") as f:
            for rec in records:
                if fmt == "alpaca":
                    obj = cls.to_alpaca(rec, include_thinking)
                elif fmt == "sharegpt":
                    obj = cls.to_sharegpt(rec, include_thinking)
                elif fmt in ("openai", "messages"):
                    obj = cls.to_openai_messages(
                        rec, system_prompt, include_thinking)
                else:  # jsonl / raw
                    obj = rec.to_dict()
                f.write(json.dumps(obj, ensure_ascii=False) + "\n")
                written += 1
        return written


# ─────────────────────────────────────────────────────────────────────────────
# Mass Distillation Orchestrator
# ─────────────────────────────────────────────────────────────────────────────

class MassDistillationOrchestrator:
    """
    Orchestrates large-scale distillation data collection.

    Implements the DeepSeek-R1 + DASD pipeline:
      1. Domain-balanced task sampling (DomainSampler)
      2. DASD temperature scheduling across stages
      3. Async batch collection from cloud teacher(s)
      4. Rejection sampling with QualityGate
      5. Near-duplicate removal
      6. SQLite checkpointing
      7. Multi-format export (alpaca, sharegpt, openai, jsonl)

    Supports:
      - Single teacher (DeepSeek-R1-671B, Claude Opus, Gemini 2.5 Pro, etc.)
      - Multi-teacher ensemble for diversity
      - MOE teachers (DeepSeek-R1, Qwen3-235B, Llama4-Maverick)
      - Custom task banks per domain
      - Resume from checkpoint

    Scale targets:
      - 10K samples   → 7B student (1-2 hours, ~$5-20 depending on teacher)
      - 100K samples  → 13B student (~$50-200)
      - 800K samples  → DeepSeek-R1 scale, 32B+ student (~$400-1600)
      - 1M+ samples   → frontier student training
    """

    def __init__(
        self,
        config: MassDistillationConfig,
        progress_cb: Optional[Callable] = None,
    ):
        self.cfg = config
        self.progress_cb = progress_cb or self._default_progress

        # Build teacher(s)
        if config.use_ensemble and config.ensemble_teachers:
            teachers = [
                CloudTeacher(TeacherConfig(
                    provider=t["provider"],
                    model=t["model"],
                    api_key=t.get("key", ""),
                    extract_thinking=config.extract_thinking,
                    min_quality=config.min_quality,
                    max_cost_usd=config.max_cost_usd / len(config.ensemble_teachers),
                ))
                for t in config.ensemble_teachers
            ]
            self.teacher: Any = MultiTeacherEnsemble(teachers)
        else:
            self.teacher = CloudTeacher(TeacherConfig(
                provider=config.teacher_provider,
                model=config.teacher_model,
                api_key=config.teacher_api_key,
                base_url=config.teacher_base_url,
                extract_thinking=config.extract_thinking,
                min_quality=0.0,  # gate applied separately
                max_cost_usd=config.max_cost_usd,
                max_tokens=config.max_tokens_per_call,
            ))

        self.sampler = DomainSampler(
            domains=config.domains,
            weights=config.domain_weights or None,
        )
        self.quality_gate = QualityGate(
            min_quality=config.min_quality,
            dedup_threshold=config.dedup_threshold,
        )
        self.scheduler = (
            DASDScheduler(config.dasd_stages, config.target_samples)
            if config.use_dasd_schedule else None
        )
        self.formatter = SFTFormatter()

        # Output paths
        self._out_dir = Path(config.output_dir).expanduser()
        self._out_dir.mkdir(parents=True, exist_ok=True)
        self._db_path = str(Path(config.db_path).expanduser())

        self._dataset = DistillationDataset(self._db_path)
        self._collected: List[TrajectoryRecord] = []
        self._start_time = 0.0

    # ── Main entry point ─────────────────────────────────────────────────────

    async def run(
        self,
        extra_tasks: Optional[Dict[str, List[str]]] = None,
    ) -> Dict[str, Any]:
        """
        Run full mass distillation pipeline.

        Args:
            extra_tasks: optional dict of domain → [task strings]

        Returns:
            Summary dict with counts, paths, cost, quality stats.
        """
        self._start_time = time.time()
        self.progress_cb("START", (
            f"Mass distillation: target={self.cfg.target_samples:,} samples, "
            f"teacher={self.cfg.teacher_model}, "
            f"domains={self.cfg.domains}"
        ))

        # Merge custom tasks
        if extra_tasks:
            for domain, tasks in extra_tasks.items():
                self.sampler.add_custom_tasks(domain, tasks)

        # Sample task list
        n_tasks = max(
            self.cfg.target_samples // self.cfg.n_per_task, 1)
        task_pairs = self.sampler.sample(n_tasks, augment=True)
        self.progress_cb("TASKS", f"Sampled {len(task_pairs)} tasks across domains")

        # DASD stage summary
        if self.scheduler:
            stage_sum = self.scheduler.get_stage_summary()
            self.progress_cb("DASD", f"Stage plan: {stage_sum}")

        # Collect in batches
        sample_idx = 0
        for batch_start in range(0, len(task_pairs), self.cfg.batch_size):
            batch = task_pairs[batch_start:batch_start + self.cfg.batch_size]
            tasks_only = [t for t, _ in batch]
            domain_map = {t: d for t, d in batch}

            # Get DASD temperature for this batch
            stage_name, temp = (
                self.scheduler.temperature_for(sample_idx)
                if self.scheduler else ("default", self.cfg.dasd_stages[1]["temperature"])
            )

            self.progress_cb("BATCH", (
                f"Batch {batch_start//self.cfg.batch_size + 1}: "
                f"stage={stage_name} temp={temp:.2f} "
                f"tasks={len(tasks_only)}"
            ))

            # Collect from teacher
            try:
                if isinstance(self.teacher, MultiTeacherEnsemble):
                    records = await self.teacher.collect(
                        tasks_only,
                        n_per_teacher=max(self.cfg.n_per_task // 2, 1),
                        concurrency=self.cfg.concurrency,
                    )
                else:
                    # Override temperature for this batch
                    orig_temp = self.teacher.cfg.temperature
                    self.teacher.cfg.temperature = temp
                    records = await self.teacher.collect(
                        tasks_only,
                        n_per_task=self.cfg.n_per_task,
                        concurrency=self.cfg.concurrency,
                    )
                    self.teacher.cfg.temperature = orig_temp
            except RuntimeError as e:
                if "Cost cap" in str(e):
                    self.progress_cb("STOP", f"Budget reached: {e}")
                    break
                raise

            # Tag records with domain metadata
            for rec in records:
                domain = domain_map.get(rec.task, "general")
                if rec.metadata is None:
                    rec.metadata = {}
                rec.metadata["domain"] = domain
                rec.metadata["dasd_stage"] = stage_name

            # Quality gate (rejection sampling)
            passed = []
            for rec in records:
                ok, reason = self.quality_gate.passes(rec)
                if ok:
                    passed.append(rec)
                    self._dataset.add(rec)
                    self._collected.append(rec)

            sample_idx += len(passed)
            gate_stats = self.quality_gate.stats()
            self.progress_cb("GATE", (
                f"Batch: {len(passed)}/{len(records)} passed "
                f"(cumulative pass_rate={gate_stats['pass_rate']:.1%})"
            ))

            # Checkpoint
            if len(self._collected) % self.cfg.checkpoint_every < self.cfg.batch_size:
                self._checkpoint(len(self._collected))

            # Check if we've hit target
            if len(self._collected) >= self.cfg.target_samples:
                self.progress_cb("DONE", f"Target reached: {len(self._collected):,}")
                break

        # Export
        export_paths = self._export_all()

        # Final summary
        return self._build_summary(export_paths)

    # ── Export ───────────────────────────────────────────────────────────────

    def _export_all(self) -> Dict[str, str]:
        paths: Dict[str, str] = {}
        for fmt in self.cfg.export_formats:
            out_path = str(
                self._out_dir / f"distillation_{fmt}.jsonl")
            n = self.formatter.export(
                self._collected, out_path, fmt=fmt,
                include_thinking=self.cfg.include_thinking_in_sft,
            )
            paths[fmt] = out_path
            self.progress_cb("EXPORT", f"{fmt}: {n} records → {out_path}")
        return paths

    def _checkpoint(self, n: int):
        cp = self._out_dir / f"checkpoint_{n}.jsonl"
        with open(cp, "w") as f:
            for rec in self._collected:
                f.write(json.dumps(rec.to_dict()) + "\n")
        self.progress_cb("CKPT", f"Checkpoint: {n} samples → {cp}")

    # ── Summary ──────────────────────────────────────────────────────────────

    def _build_summary(self, export_paths: Dict[str, str]) -> Dict[str, Any]:
        elapsed = time.time() - self._start_time
        gate = self.quality_gate.stats()

        # Domain distribution
        domain_counts: Dict[str, int] = {}
        quality_sum = 0.0
        thinking_count = 0
        for rec in self._collected:
            d = rec.metadata.get("domain", "unknown") if rec.metadata else "unknown"
            domain_counts[d] = domain_counts.get(d, 0) + 1
            quality_sum += rec.quality
            if rec.thinking:
                thinking_count += 1

        # Teacher cost stats
        if isinstance(self.teacher, MultiTeacherEnsemble):
            cost_stats = self.teacher.get_stats()
            total_cost = sum(s.get("total_cost_usd", 0) for s in cost_stats)
        else:
            cost_stats = self.teacher.get_stats()
            total_cost = cost_stats.get("total_cost_usd", 0)

        n = len(self._collected)
        summary = {
            "total_samples": n,
            "target_samples": self.cfg.target_samples,
            "elapsed_seconds": round(elapsed, 1),
            "samples_per_minute": round(n / max(elapsed / 60, 0.01), 1),
            "total_cost_usd": round(total_cost, 4),
            "cost_per_sample": round(total_cost / max(n, 1), 6),
            "avg_quality": round(quality_sum / max(n, 1), 3),
            "pct_with_thinking": round(thinking_count / max(n, 1) * 100, 1),
            "pass_rate": round(gate["pass_rate"] * 100, 1),
            "rejection_reasons": gate["rejection_reasons"],
            "domain_distribution": domain_counts,
            "teacher_stats": cost_stats,
            "export_paths": export_paths,
            "db_path": self._db_path,
            "dasd_stages": self.scheduler.get_stage_summary() if self.scheduler else {},
            "recommendations": self._get_training_recs(n),
        }
        self.progress_cb("SUMMARY", json.dumps(summary, indent=2))
        return summary

    def _get_training_recs(self, n: int) -> Dict[str, str]:
        """Return training recommendations based on sample count."""
        if n < 1_000:
            return {
                "student_size": "1B-3B (proof of concept)",
                "epochs": "3-5",
                "method": "Full SFT",
                "note": "Collect more data for better results",
            }
        elif n < 10_000:
            return {
                "student_size": "3B-7B",
                "epochs": "2-3",
                "method": "LoRA or full SFT",
                "note": "Good for domain-specific fine-tuning",
            }
        elif n < 100_000:
            return {
                "student_size": "7B-13B",
                "epochs": "2",
                "method": "Full SFT (DeepSeek-R1 style)",
                "note": "Include thinking traces in training data",
            }
        elif n < 500_000:
            return {
                "student_size": "13B-34B",
                "epochs": "2",
                "method": "Full SFT + optional RL stage",
                "note": f"~DeepSeek-R1 scale ({n:,} vs 800K). Ready for strong student.",
            }
        else:
            return {
                "student_size": "34B-70B+",
                "epochs": "1-2",
                "method": "Full SFT + RLHF/GRPO",
                "note": "Frontier-scale distillation dataset",
            }

    @staticmethod
    def _default_progress(prefix: str, msg: str):
        ts = time.strftime("%H:%M:%S")
        print(f"[{ts}][{prefix}] {msg}")

    # ── Quick stats ──────────────────────────────────────────────────────────

    def get_collected(self) -> List[TrajectoryRecord]:
        return list(self._collected)

    def get_live_stats(self) -> Dict[str, Any]:
        n = len(self._collected)
        gate = self.quality_gate.stats()
        if isinstance(self.teacher, MultiTeacherEnsemble):
            cost = sum(s.get("total_cost_usd", 0) for s in self.teacher.get_stats())
        else:
            cost = self.teacher.get_stats().get("total_cost_usd", 0)
        return {
            "collected": n,
            "cost_usd": round(cost, 4),
            "pass_rate": round(gate["pass_rate"] * 100, 1),
            "elapsed_s": round(time.time() - self._start_time, 0),
        }


# ─────────────────────────────────────────────────────────────────────────────
# Convenience run function
# ─────────────────────────────────────────────────────────────────────────────

async def run_mass_distillation(
    teacher_provider: str,
    teacher_model: str,
    api_key: str,
    target_samples: int = 10_000,
    domains: Optional[List[str]] = None,
    output_dir: str = "~/.lazy_chameleon/mass_distillation",
    max_cost_usd: float = 200.0,
    use_dasd: bool = True,
    extra_tasks: Optional[Dict[str, List[str]]] = None,
    progress_cb: Optional[Callable] = None,
    resume: bool = False,
) -> Dict[str, Any]:
    """
    One-line entry point for mass distillation.

    Example — distill DeepSeek-R1 at 10K scale:
        results = await run_mass_distillation(
            teacher_provider="deepseek",
            teacher_model="deepseek-reasoner",
            api_key="sk-...",
            target_samples=10_000,
            domains=["math_reasoning", "coding", "logic_reasoning"],
        )

    Example — distill Claude Opus 4.8 at 100K scale:
        results = await run_mass_distillation(
            teacher_provider="anthropic",
            teacher_model="claude-opus-4-8",
            api_key="sk-ant-...",
            target_samples=100_000,
            max_cost_usd=1500.0,
        )
    """
    cfg = MassDistillationConfig(
        teacher_provider=teacher_provider,
        teacher_model=teacher_model,
        teacher_api_key=api_key,
        target_samples=target_samples,
        domains=domains or [
            "math_reasoning", "coding", "logic_reasoning",
            "science_reasoning", "instruction_following",
        ],
        output_dir=output_dir,
        max_cost_usd=max_cost_usd,
        use_dasd_schedule=use_dasd,
    )
    orch = MassDistillationOrchestrator(cfg, progress_cb=progress_cb)
    return await orch.run(extra_tasks=extra_tasks, resume=resume)
