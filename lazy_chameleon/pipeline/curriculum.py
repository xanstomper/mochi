"""Curriculum learning for progressive pipeline difficulty.
Provides difficulty-based scheduling, lesson planning, adaptive
difficulty scaling, and balanced sampling across domains.
Classes
-------
LessonPlan: Per-stage curriculum definition.
DifficultyScaler: Adaptive difficulty adjustment.
DomainBalancer: Balanced sampling across domains.
CurriculumScheduler: Difficulty progression orchestrator.
"""
from __future__ import annotations
import enum
import logging
import math
import random
import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Set, Tuple, TypeVar
from lazy_chameleon.pipeline.core import PipelineResult, StageStatus
logger = logging.getLogger(__name__); T = TypeVar("T")

class DifficultyLevel(enum.IntEnum):
    TRIVIAL = 1; EASY = 2; MEDIUM = 3; HARD = 4; EXPERT = 5; MASTER = 6

@dataclass
class LessonPlan:
    """Defines a curriculum lesson for a specific stage.
    Specifies difficulty range, content topics, success criteria, and
    progression rules for transitioning to the next lesson.
    Parameters
    ----------
    name: Lesson name.
    stage_name: Associated pipeline stage.
    min_difficulty: Minimum difficulty level.
    max_difficulty: Maximum difficulty level.
    topics: List of topic tags for content selection.
    required_mastery: Score required to pass (0.0 to 1.0).
    min_samples: Minimum samples before progression.
    max_repeats: Maximum repeats before forced progression.
    prerequisites: List of prerequisite lesson names.
    """
    name: str
    stage_name: str
    min_difficulty: int = DifficultyLevel.EASY.value
    max_difficulty: int = DifficultyLevel.HARD.value
    topics: List[str] = field(default_factory=list)
    required_mastery: float = 0.8
    min_samples: int = 10
    max_repeats: int = 50
    prerequisites: List[str] = field(default_factory=list)
    _attempts: int = 0; _successes: int = 0; _scores: deque = field(default_factory=lambda: deque(maxlen=100))
    _lock: Any = field(default_factory=threading.RLock)

    def record_attempt(self, score, passed):
        with self._lock:
            self._attempts += 1
            if passed: self._successes += 1
            self._scores.append(score)

    @property
    def mastery(self):
        if not self._scores: return 0.0
        return sum(self._scores) / len(self._scores)

    @property
    def pass_rate(self):
        if self._attempts == 0: return 0.0
        return self._successes / self._attempts

    @property
    def is_complete(self):
        if self._attempts < self.min_samples: return False
        if self.mastery >= self.required_mastery: return True
        if self._attempts >= self.max_repeats: return True
        return False

    @property
    def current_difficulty(self):
        if not self._scores: return self.min_difficulty
        ratio = self.mastery / max(self.required_mastery, 0.01)
        diff_range = self.max_difficulty - self.min_difficulty
        return min(self.max_difficulty, self.min_difficulty + int(diff_range * ratio))

    def to_dict(self):
        return {
            "name": self.name, "stage": self.stage_name,
            "difficulty": {"min": self.min_difficulty, "max": self.max_difficulty, "current": self.current_difficulty},
            "mastery": self.mastery, "pass_rate": self.pass_rate,
            "attempts": self._attempts, "is_complete": self.is_complete,
        }

class DifficultyScaler:
    """Adaptive difficulty adjustment based on performance history.
    Adjusts difficulty up or down based on rolling success rate,
    ensuring the learner is operating in the zone of proximal development.
    Parameters
    ----------
    initial_difficulty: Starting difficulty level.
    min_difficulty: Minimum allowed difficulty.
    max_difficulty: Maximum allowed difficulty.
    adjustment_rate: How quickly difficulty changes (0.0 to 1.0).
    window_size: Rolling window for success rate calculation.
    target_success_rate: Desired success rate (e.g. 0.8 = 80%).
    """
    def __init__(self, initial_difficulty=3, min_difficulty=1, max_difficulty=6, adjustment_rate=0.1, window_size=20, target_success_rate=0.8):
        self.current = initial_difficulty
        self.min_difficulty = min_difficulty; self.max_difficulty = max_difficulty
        self.adjustment_rate = adjustment_rate; self.target_success_rate = target_success_rate
        self._history = deque(maxlen=window_size)
        self._lock = threading.RLock()
        self._logger = logging.getLogger(f"{__name__}.DifficultyScaler")

    def record_outcome(self, success, difficulty=None):
        """Record whether the item was successfully processed.
        Parameters
        ----------
        success: True if successful, False otherwise.
        difficulty: The difficulty level at which the item was attempted.
        """
        diff = difficulty if difficulty is not None else self.current
        with self._lock: self._history.append({"success": success, "difficulty": diff})

    @property
    def success_rate(self):
        if not self._history: return 1.0
        return sum(1 for h in self._history if h["success"]) / len(self._history)

    def adjust(self):
        """Adjust difficulty based on recent success rate.
        Returns
        -------
        int: New difficulty level.
        """
        rate = self.success_rate
        with self._lock:
            if rate > self.target_success_rate + 0.05:
                self.current = min(self.max_difficulty, self.current + 1)
            elif rate < self.target_success_rate - 0.1:
                self.current = max(self.min_difficulty, self.current - 1)
        self._logger.debug("Difficulty adjusted to %d (rate=%.2f)", self.current, rate)
        return self.current

    def get_difficulty_for_item(self, item_features=None):
        """Get the recommended difficulty for the next item.
        Optionally adjusts based on item features.
        Parameters
        ----------
        item_features: Optional dict of item characteristics.
        Returns
        -------
        int: Recommended difficulty level.
        """
        return self.current

    def to_dict(self):
        return {
            "current_difficulty": self.current,
            "min_difficulty": self.min_difficulty,
            "max_difficulty": self.max_difficulty,
            "success_rate": self.success_rate,
            "target_success_rate": self.target_success_rate,
            "history_size": len(self._history),
        }


class DomainBalancer:
    """Balanced sampling across domains for curriculum learning.
    Ensures diverse training data by maintaining domain distribution
    targets and adaptively sampling underrepresented domains.
    Parameters
    ----------
    domain_targets: Dict mapping domain name -> target sampling fraction.
    default_weight: Weight for unknown domains.
    adapt: Whether to adaptively adjust based on history.
    """
    def __init__(self, domain_targets=None, default_weight=0.1, adapt=True):
        self.domain_targets = domain_targets or {"general": 0.5, "technical": 0.3, "creative": 0.2}
        self.default_weight = default_weight; self.adapt = adapt
        self._counts: Dict[str, int] = defaultdict(int)
        self._history: List[Dict] = []
        self._lock = threading.RLock()
        self._logger = logging.getLogger(f"{__name__}.DomainBalancer")

    def sample_domain(self, available_domains=None):
        """Sample a domain based on target distribution.
        Parameters
        ----------
        available_domains: Optional subset of domains to choose from.
        Returns
        -------
        str: Selected domain name.
        """
        with self._lock:
            domains = available_domains or list(self.domain_targets.keys())
            if not domains: return "general"
            if self.adapt and self._counts:
                total = sum(self._counts.values())
                weights = []
                for d in domains:
                    target = self.domain_targets.get(d, self.default_weight)
                    actual = self._counts.get(d, 0) / max(total, 1)
                    gap = max(0, target - actual)
                    weights.append(gap + 0.01)
                total_w = sum(weights)
                if total_w > 0:
                    r = random.random() * total_w
                    cumulative = 0.0
                    for d, w in zip(domains, weights):
                        cumulative += w
                        if r <= cumulative: return d
            return random.choices(domains, weights=[self.domain_targets.get(d, self.default_weight) for d in domains])[0]

    def record_sample(self, domain, metadata=None):
        """Record a domain sample for tracking distribution.
        Parameters
        ----------
        domain: Domain name.
        metadata: Optional metadata dict.
        """
        with self._lock:
            self._counts[domain] += 1
            self._history.append({"domain": domain, "time": time.time(), "metadata": metadata or {}})

    def get_distribution(self):
        with self._lock:
            total = sum(self._counts.values()) or 1
            return {d: c / total for d, c in self._counts.items()}

    def get_underrepresented(self, threshold=None):
        """Return domains below their target fraction.
        Parameters
        ----------
        threshold: Override threshold (default: target * 0.8).
        Returns
        -------
        List[str]: Underrepresented domain names.
        """
        dist = self.get_distribution()
        under = []
        for domain, target in self.domain_targets.items():
            actual = dist.get(domain, 0)
            if actual < (threshold or target * 0.8):
                under.append(domain)
        return under

    def reset_counts(self):
        with self._lock: self._counts.clear(); self._history.clear()

    def to_dict(self):
        return {
            "targets": dict(self.domain_targets),
            "distribution": self.get_distribution(),
            "underrepresented": self.get_underrepresented(),
            "total_samples": sum(self._counts.values()),
        }

class CurriculumScheduler:
    """Orchestrates difficulty progression across pipeline stages.
    Manages lesson plans, difficulty scaling, domain balancing, and
    progression logic for curriculum-based data processing.
    Parameters
    ----------
    lessons: List of LessonPlan objects.
    scaler: Optional DifficultyScaler instance.
    balancer: Optional DomainBalancer instance.
    """
    def __init__(self, lessons=None, scaler=None, balancer=None):
        self._lessons: Dict[str, LessonPlan] = {}
        self._stage_lessons: Dict[str, List[str]] = defaultdict(list)
        self.scaler = scaler or DifficultyScaler()
        self.balancer = balancer or DomainBalancer()
        self._current_lesson: Optional[str] = None
        self._completed_lessons: List[str] = []
        self._lock = threading.RLock()
        self._logger = logging.getLogger(f"{__name__}.CurriculumScheduler")
        if lessons:
            for lesson in lessons: self.add_lesson(lesson)

    def add_lesson(self, lesson):
        """Add a lesson plan.
        Parameters
        ----------
        lesson: LessonPlan instance.
        """
        self._lessons[lesson.name] = lesson
        self._stage_lessons[lesson.stage_name].append(lesson.name)
        self._logger.info("Added lesson %s for stage %s", lesson.name, lesson.stage_name)

    def get_next_lesson(self, stage_name=None):
        """Get the next lesson to execute.
        Considers prerequisites, completion status, and stage.
        Parameters
        ----------
        stage_name: Optional stage filter.
        Returns
        -------
        Optional[LessonPlan]: The next lesson, or None.
        """
        candidates = []
        for name, lesson in self._lessons.items():
            if name in self._completed_lessons: continue
            if stage_name and lesson.stage_name != stage_name: continue
            prereqs_done = all(p in self._completed_lessons for p in lesson.prerequisites)
            if not prereqs_done: continue
            if lesson.is_complete:
                self._completed_lessons.append(name)
                continue
            candidates.append(lesson)
        if not candidates: return None
        # Pick lesson with lowest completion ratio
        candidates.sort(key=lambda L: L._attempts / max(L.min_samples, 1))
        selected = candidates[0]
        self._current_lesson = selected.name
        return selected

    def record_attempt(self, lesson_name, score, passed):
        """Record an attempt for a lesson.
        Parameters
        ----------
        lesson_name: Lesson name.
        score: Quality score (0.0 to 1.0).
        passed: Whether the lesson was passed.
        """
        lesson = self._lessons.get(lesson_name)
        if not lesson:
            self._logger.warning("Unknown lesson: %s", lesson_name)
            return
        lesson.record_attempt(score, passed)
        self.scaler.record_outcome(passed, lesson.current_difficulty)
        if lesson.is_complete:
            self._completed_lessons.append(lesson_name)
            self._logger.info("Lesson %s completed!", lesson_name)

    def get_difficulty(self, stage_name=None):
        """Get the current recommended difficulty.
        Parameters
        ----------
        stage_name: Optional stage for lesson-specific difficulty.
        Returns
        -------
        int: Difficulty level.
        """
        if stage_name:
            lesson_names = self._stage_lessons.get(stage_name, [])
            if lesson_names:
                lesson = self._lessons.get(lesson_names[0])
                if lesson: return lesson.current_difficulty
        return self.scaler.current

    def sample_domain(self, stage_name=None):
        """Sample a domain for the next item.
        Parameters
        ----------
        stage_name: Optional stage filter for domain selection.
        Returns
        -------
        str: Selected domain.
        """
        return self.balancer.sample_domain()

    @property
    def all_lessons_complete(self):
        return all(L.is_complete for L in self._lessons.values())

    @property
    def completion_summary(self):
        complete = sum(1 for L in self._lessons.values() if L.is_complete)
        return f"{complete}/{len(self._lessons)} lessons complete"

    def to_dict(self):
        return {
            "lessons": {n: L.to_dict() for n, L in self._lessons.items()},
            "completed": list(self._completed_lessons),
            "current_lesson": self._current_lesson,
            "all_complete": self.all_lessons_complete,
            "difficulty": self.scaler.to_dict(),
            "domain_distribution": self.balancer.to_dict(),
        }

    def get_stage_curriculum(self, stage_name):
        """Get the curriculum for a specific stage.
        Parameters
        ----------
        stage_name: Stage name.
        Returns
        -------
        List[LessonPlan]: Lessons for the stage.
        """
        names = self._stage_lessons.get(stage_name, [])
        return [self._lessons[n] for n in names if n in self._lessons]

    def __repr__(self):
        return f"CurriculumScheduler(lessons={len(self._lessons)}, completed={len(self._completed_lessons)})"

class SkillTree:
    """Represents a tree of skills for curriculum progression.
    Each skill has prerequisites, difficulty, and mastery tracking.
    Parameters
    ----------
    name: Skill tree name.
    """
    def __init__(self, name="default"):
        self.name = name; self._skills = {}; self._lock = threading.RLock()
        self._logger = logging.getLogger(f"{__name__}.SkillTree")

    def add_skill(self, skill_id, name, difficulty=1, prerequisites=None, metadata=None):
        with self._lock:
            self._skills[skill_id] = {
                "id": skill_id, "name": name, "difficulty": difficulty,
                "prerequisites": set(prerequisites or []),
                "metadata": metadata or {}, "mastery": 0.0, "attempts": 0
            }

    def record_mastery(self, skill_id, score):
        with self._lock:
            skill = self._skills.get(skill_id)
            if skill:
                skill["mastery"] = max(skill["mastery"], score)
                skill["attempts"] += 1

    def get_available_skills(self, min_mastery=0.7):
        with self._lock:
            available = []
            for sid, skill in self._skills.items():
                if skill["mastery"] >= min_mastery: continue
                prereqs_met = all(self._skills.get(p, {}).get("mastery", 0) >= min_mastery for p in skill["prerequisites"])
                if prereqs_met: available.append(skill)
            return sorted(available, key=lambda s: s["difficulty"])

    def get_next_skill(self, min_mastery=0.7):
        available = self.get_available_skills(min_mastery)
        return available[0] if available else None

    def to_dict(self):
        with self._lock: return {"name": self.name, "skills": dict(self._skills), "available": len(self.get_available_skills())}


class PerformanceTracker:
    """Tracks learner performance across curriculum stages.
    Stores scores, latencies, and domain performance for analysis.
    """
    def __init__(self, window_size=1000):
        self._records = deque(maxlen=window_size)
        self._domain_stats = defaultdict(lambda: {"count": 0, "total_score": 0.0, "max_score": 0.0})
        self._lock = threading.RLock()

    def record(self, lesson_name, score, passed, difficulty, domain="general", latency=0.0):
        with self._lock:
            self._records.append({
                "lesson": lesson_name, "score": score, "passed": passed,
                "difficulty": difficulty, "domain": domain, "latency": latency,
                "timestamp": time.time()
            })
            ds = self._domain_stats[domain]
            ds["count"] += 1; ds["total_score"] += score
            ds["max_score"] = max(ds["max_score"], score)

    def get_domain_performance(self, domain):
        with self._lock:
            ds = self._domain_stats.get(domain)
            if not ds or ds["count"] == 0: return {"avg_score": 0, "count": 0}
            return {"avg_score": ds["total_score"] / ds["count"], "max_score": ds["max_score"], "count": ds["count"]}

    def get_recent_performance(self, n=100):
        with self._lock: return list(self._records)[-n:]

    def get_summary(self):
        with self._lock:
            if not self._records: return {"avg_score": 0, "pass_rate": 0, "total": 0}
            scores = [r["score"] for r in self._records]
            passed = sum(1 for r in self._records if r["passed"])
            return {
                "avg_score": sum(scores) / len(scores),
                "pass_rate": passed / len(self._records),
                "total": len(self._records),
                "domains": dict(self._domain_stats),
            }
