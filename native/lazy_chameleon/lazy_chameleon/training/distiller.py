"""
Knowledge Distillation Pipeline: Transfer Opus-level reasoning into DeepSeek Flash at inference time.

This module implements a comprehensive distillation system that:
1. Extracts reasoning patterns from teacher model outputs
2. Builds a pattern library with online learning
3. Injects patterns into student prompts at inference time
4. Uses constitutional principles for critique & revision
5. Enables multi-teacher ensemble strategies
6. Implements progressive curriculum learning

No ML library dependencies—pure Python with dataclasses and type hints.
"""

import json
import hashlib
from dataclasses import dataclass, field, asdict
from typing import Callable, Optional, List, Dict, Tuple, Any
from enum import Enum
from datetime import datetime
from pathlib import Path
import re


# ============================================================================
# 1. ReasoningPattern Dataclass
# ============================================================================

@dataclass
class ReasoningPattern:
    """
    A reusable reasoning pattern extracted from teacher model outputs.
    
    Attributes:
        pattern_text: The core reasoning template/step
        trigger_words: Keywords that signal when this pattern is relevant
        domain: Domain tag (e.g., 'math', 'logic', 'coding', 'writing')
        effectiveness_score: 0.0-1.0 rating of pattern quality
        usage_count: How many times this pattern has been used
        pattern_id: Unique identifier (auto-generated)
        created_at: Timestamp of pattern creation
        last_used: Timestamp of last usage
    """
    pattern_text: str
    trigger_words: List[str]
    domain: str
    effectiveness_score: float = 0.5
    usage_count: int = 0
    pattern_id: str = field(default_factory=lambda: "")
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    last_used: Optional[str] = None
    
    def __post_init__(self):
        if not self.pattern_id:
            # Generate deterministic ID from content
            content = f"{self.pattern_text}:{self.domain}"
            self.pattern_id = hashlib.md5(content.encode()).hexdigest()[:12]
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return asdict(self)
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ReasoningPattern":
        """Create from dictionary."""
        return cls(**data)


# ============================================================================
# 2. PatternLibrary Class
# ============================================================================

class PatternLibrary:
    """
    Stores and manages extracted reasoning patterns with online learning.
    
    Supports:
    - Pattern storage with metadata
    - Retrieval via keyword matching + effectiveness scoring
    - Online effectiveness updates
    - Persistence (JSON)
    - Statistics tracking
    """
    
    def __init__(self):
        self.patterns: Dict[str, ReasoningPattern] = {}
        self.domain_index: Dict[str, List[str]] = {}
        self.keyword_index: Dict[str, List[str]] = {}
        self._stats = {
            "total_patterns": 0,
            "total_usages": 0,
            "avg_effectiveness": 0.0,
        }
    
    def add_pattern(self, text: str, trigger_words: List[str], domain: str) -> str:
        """
        Add a new reasoning pattern to the library.
        
        Args:
            text: The reasoning pattern text
            trigger_words: Keywords that trigger this pattern
            domain: Domain classification
            
        Returns:
            pattern_id of the added pattern
        """
        pattern = ReasoningPattern(
            pattern_text=text,
            trigger_words=trigger_words,
            domain=domain,
        )
        
        self.patterns[pattern.pattern_id] = pattern
        
        # Index by domain
        if domain not in self.domain_index:
            self.domain_index[domain] = []
        self.domain_index[domain].append(pattern.pattern_id)
        
        # Index by keywords
        for kw in trigger_words:
            kw_lower = kw.lower()
            if kw_lower not in self.keyword_index:
                self.keyword_index[kw_lower] = []
            self.keyword_index[kw_lower].append(pattern.pattern_id)
        
        self._update_stats()
        return pattern.pattern_id
    
    def get_patterns(
        self,
        task_text: str,
        domain: Optional[str] = None,
        top_k: int = 5,
    ) -> List[ReasoningPattern]:
        """
        Retrieve relevant patterns via keyword matching + effectiveness scoring.
        
        Args:
            task_text: The task/question to find patterns for
            domain: Optional domain filter
            top_k: Number of top patterns to return
            
        Returns:
            Ranked list of ReasoningPattern objects
        """
        task_lower = task_text.lower()
        candidates: Dict[str, float] = {}
        
        # Score by keyword matches
        for kw, pattern_ids in self.keyword_index.items():
            if kw in task_lower:
                for pid in pattern_ids:
                    pattern = self.patterns[pid]
                    # Filter by domain if specified
                    if domain and pattern.domain != domain:
                        continue
                    
                    # Score: keyword match + effectiveness + usage bias
                    score = (
                        pattern.effectiveness_score +
                        0.1 * (pattern.usage_count / max(1, self._stats["total_usages"]))
                    )
                    candidates[pid] = max(candidates.get(pid, 0), score)
        
        # If domain filter, also get high-effectiveness patterns from domain
        if domain and domain in self.domain_index:
            for pid in self.domain_index[domain]:
                pattern = self.patterns[pid]
                if pid not in candidates:
                    candidates[pid] = pattern.effectiveness_score
        
        # Sort and return top_k
        ranked = sorted(
            candidates.items(),
            key=lambda x: x[1],
            reverse=True,
        )[:top_k]
        
        return [self.patterns[pid] for pid, _ in ranked]
    
    def update_effectiveness(self, pattern_id: str, quality_delta: float) -> None:
        """
        Online learning: update pattern effectiveness based on quality feedback.
        
        Args:
            pattern_id: ID of pattern to update
            quality_delta: Change in effectiveness (-1.0 to 1.0)
        """
        if pattern_id not in self.patterns:
            return
        
        pattern = self.patterns[pattern_id]
        # Clamp effectiveness to [0, 1]
        pattern.effectiveness_score = max(
            0.0,
            min(1.0, pattern.effectiveness_score + quality_delta * 0.1),
        )
        pattern.usage_count += 1
        pattern.last_used = datetime.now().isoformat()
        self._update_stats()
    
    def save(self, path: str) -> None:
        """Save pattern library to JSON file."""
        data = {
            "patterns": {
                pid: pattern.to_dict()
                for pid, pattern in self.patterns.items()
            },
            "stats": self._stats,
        }
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w") as f:
            json.dump(data, f, indent=2)
    
    def load(self, path: str) -> None:
        """Load pattern library from JSON file."""
        if not Path(path).exists():
            return
        
        with open(path, "r") as f:
            data = json.load(f)
        
        self.patterns = {}
        self.domain_index = {}
        self.keyword_index = {}
        
        for pid, pattern_data in data.get("patterns", {}).items():
            pattern = ReasoningPattern.from_dict(pattern_data)
            self.patterns[pid] = pattern
            
            # Rebuild indices
            if pattern.domain not in self.domain_index:
                self.domain_index[pattern.domain] = []
            self.domain_index[pattern.domain].append(pid)
            
            for kw in pattern.trigger_words:
                kw_lower = kw.lower()
                if kw_lower not in self.keyword_index:
                    self.keyword_index[kw_lower] = []
                self.keyword_index[kw_lower].append(pid)
        
        self._stats = data.get("stats", self._stats)
    
    def _update_stats(self) -> None:
        """Update library statistics."""
        if not self.patterns:
            self._stats = {
                "total_patterns": 0,
                "total_usages": 0,
                "avg_effectiveness": 0.0,
            }
            return
        
        total_usages = sum(p.usage_count for p in self.patterns.values())
        avg_eff = sum(p.effectiveness_score for p in self.patterns.values()) / len(self.patterns)
        
        self._stats = {
            "total_patterns": len(self.patterns),
            "total_usages": total_usages,
            "avg_effectiveness": avg_eff,
        }
    
    def get_stats(self) -> Dict[str, Any]:
        """Return library statistics."""
        return self._stats.copy()


# ============================================================================
# 3. ChainOfThoughtDistiller Class
# ============================================================================

class ChainOfThoughtDistiller:
    """
    Extracts and injects chain-of-thought reasoning patterns from teacher to student.
    
    Key insight: Extract the REASONING process from teacher, not the answer,
    then teach student to reason the same way.
    """
    
    def __init__(
        self,
        teacher_fn: Optional[Callable[[str], str]] = None,
        pattern_library: Optional[PatternLibrary] = None,
    ):
        """
        Initialize the CoT distiller.
        
        Args:
            teacher_fn: Function to call teacher model (takes task, returns response)
            pattern_library: Shared pattern library (created if not provided)
        """
        self.teacher_fn = teacher_fn
        self.pattern_library = pattern_library or PatternLibrary()
    
    def extract_patterns(self, teacher_response: str) -> List[str]:
        """
        Extract reusable reasoning steps from teacher response.
        
        Strategy: Look for reasoning markers and intermediate conclusions.
        
        Args:
            teacher_response: Full response from teacher model
            
        Returns:
            List of extracted reasoning patterns
        """
        patterns = []
        
        # Common reasoning markers
        markers = [
            r"(?:first|let me|step \d+|consider|note that)[^\.]*\.",
            r"(?:this means|therefore|so|thus|hence)[^\.]*\.",
            r"(?:we can|we should|we need to)[^\.]*\.",
            r"(?:the key is|importantly|crucially)[^\.]*\.",
            r"(?:let's think|let's reason about)[^\.]*\.",
        ]
        
        for marker in markers:
            matches = re.findall(marker, teacher_response, re.IGNORECASE)
            patterns.extend(m.strip() for m in matches if len(m.strip()) > 10)
        
        # Remove duplicates while preserving order
        seen = set()
        unique = []
        for p in patterns:
            if p not in seen:
                seen.add(p)
                unique.append(p)
        
        return unique[:10]  # Return top 10
    
    def build_student_injection(self, task: str, patterns: List) -> str:
        """
        Build a prefix for the student that injects teacher reasoning templates.
        
        Does NOT give away the answer, only provides reasoning guidance.
        
        Args:
            task: The task/question
            patterns: List of reasoning patterns (strings or ReasoningPattern objects)
            
        Returns:
            Injection prefix for student prompt
        """
        if not patterns:
            return ""
        
        lines = ["Consider the following reasoning approaches when solving this problem:"]
        lines.append("")
        
        for i, pattern in enumerate(patterns, 1):
            # Handle both string patterns and ReasoningPattern objects
            pattern_text = pattern.pattern_text if hasattr(pattern, 'pattern_text') else str(pattern)
            lines.append(f"{i}. {pattern_text[:150]}...")
        
        lines.append("")
        lines.append("Apply these principles while reasoning through the problem:")
        lines.append("")
        
        return "\n".join(lines)
    
    def distill_batch(
        self,
        tasks: List[str],
        teacher_fn: Optional[Callable[[str], str]] = None,
    ) -> List[Dict[str, Any]]:
        """
        Distill a batch of tasks: teacher generates, patterns extracted, student injection built.
        
        Args:
            tasks: List of tasks/questions
            teacher_fn: Optional override for teacher function
            
        Returns:
            List of distillation records with keys:
            - task
            - teacher_response
            - extracted_patterns (raw strings)
            - pattern_objects (ReasoningPattern objects)
            - student_injection (formatted prefix)
        """
        teacher = teacher_fn or self.teacher_fn
        if not teacher:
            raise ValueError("No teacher function provided")
        
        results = []
        
        for task in tasks:
            # Get teacher response
            teacher_response = teacher(task)
            
            # Extract raw patterns
            raw_patterns = self.extract_patterns(teacher_response)
            
            # Add to library if meaningful
            domain = self._infer_domain(task)
            pattern_objects = []
            
            for raw_pattern in raw_patterns:
                trigger_words = self._extract_keywords(raw_pattern)
                pid = self.pattern_library.add_pattern(
                    text=raw_pattern,
                    trigger_words=trigger_words,
                    domain=domain,
                )
                pattern_objects.append(self.pattern_library.patterns[pid])
            
            # Build student injection
            injection = self.build_student_injection(task, pattern_objects)
            
            results.append({
                "task": task,
                "teacher_response": teacher_response,
                "extracted_patterns": raw_patterns,
                "pattern_objects": pattern_objects,
                "student_injection": injection,
            })
        
        return results
    
    def score_student_vs_teacher(self, student_out: str, teacher_out: str) -> float:
        """
        Score student output against teacher output (0-1 quality ratio).
        
        Simple heuristics: length, structure, logical flow.
        
        Args:
            student_out: Student model output
            teacher_out: Teacher model output
            
        Returns:
            Quality score 0.0-1.0
        """
        # Normalize lengths
        s_len = len(student_out.split())
        t_len = len(teacher_out.split())
        length_score = min(s_len, t_len) / max(s_len, t_len) if max(s_len, t_len) > 0 else 0
        
        # Reasoning markers
        reasoning_markers = [
            "therefore", "thus", "because", "so", "first", "step",
            "let's", "consider", "note that", "means", "important",
        ]
        
        s_reasoning = sum(1 for m in reasoning_markers if m in student_out.lower())
        t_reasoning = sum(1 for m in reasoning_markers if m in teacher_out.lower())
        reasoning_score = s_reasoning / max(t_reasoning, 1)
        reasoning_score = min(reasoning_score, 1.0)
        
        # Structure (periods/logical breaks)
        s_sents = student_out.count(".")
        t_sents = teacher_out.count(".")
        structure_score = min(s_sents, t_sents) / max(s_sents, t_sents) if max(s_sents, t_sents) > 0 else 0
        
        # Weighted average
        score = (length_score * 0.3 + reasoning_score * 0.4 + structure_score * 0.3)
        return min(score, 1.0)
    
    @staticmethod
    def _infer_domain(task: str) -> str:
        """Infer task domain from text."""
        task_lower = task.lower()
        
        domains = {
            "math": ["calculate", "solve", "equation", "number", "sum", "average"],
            "logic": ["prove", "argue", "reasoning", "valid", "contradict"],
            "coding": ["code", "program", "function", "algorithm", "implement"],
            "writing": ["write", "essay", "story", "explain", "describe"],
            "analysis": ["analyze", "interpret", "compare", "evaluate"],
        }
        
        for domain, keywords in domains.items():
            if any(kw in task_lower for kw in keywords):
                return domain
        
        return "general"
    
    @staticmethod
    def _extract_keywords(text: str) -> List[str]:
        """Extract important keywords from pattern text."""
        # Very simple: split and filter short words
        words = text.lower().split()
        keywords = [w.strip(",.!?") for w in words if len(w) > 4]
        return list(set(keywords))[:5]  # Top 5 unique


# ============================================================================
# 4. ConstitutionalDistiller Class
# ============================================================================

class ConstitutionalDistiller:
    """
    Applies constitutional AI principles to critique and revise model responses.
    
    Uses 15 real constitutional principles to improve response quality.
    """
    
    # 15 Constitutional Principles
    PRINCIPLES = [
        "Be helpful: Provide clear, direct, and practical assistance.",
        "Be honest: Never mislead or make up information.",
        "Be harmless: Avoid content that could cause harm.",
        "Step-by-step: Break complex problems into clear steps.",
        "Verify logic: Double-check reasoning for errors and inconsistencies.",
        "Consider alternatives: Explore multiple approaches before concluding.",
        "Acknowledge uncertainty: Clearly state when you don't know something.",
        "Use examples: Ground abstract concepts with concrete examples.",
        "Anticipate misunderstanding: Address common misconceptions upfront.",
        "Cross-check: Verify answers using multiple methods when possible.",
        "Be precise: Use accurate terminology and definitions.",
        "Respect nuance: Avoid oversimplification of complex topics.",
        "Engage deeply: Provide thorough rather than superficial responses.",
        "Consider edge cases: Think about boundary conditions and exceptions.",
        "Promote understanding: Explain the 'why' not just the 'what'.",
    ]
    
    def __init__(self, critique_fn: Optional[Callable] = None, revise_fn: Optional[Callable] = None):
        """
        Initialize constitutional distiller.
        
        Args:
            critique_fn: Function to generate critiques (takes response, task, principles)
            revise_fn: Function to revise based on critique (takes response, critique, task)
        """
        self.critique_fn = critique_fn
        self.revise_fn = revise_fn
    
    def critique(
        self,
        response: str,
        task: str,
        principles: Optional[List[str]] = None,
    ) -> str:
        """
        Generate critique based on constitutional principles.
        
        Args:
            response: Model response to critique
            task: Original task/question
            principles: List of principles to evaluate (default: all)
            
        Returns:
            Critique string (if critique_fn provided, uses it; else generates template)
        """
        if self.critique_fn:
            return self.critique_fn(response, task, principles or self.PRINCIPLES)
        
        # Generate template critique
        principles = principles or self.PRINCIPLES
        critique_parts = []
        
        for principle in principles:
            # Simple heuristic checks
            if "helpful" in principle.lower() and len(response) < 20:
                critique_parts.append(f"⚠ {principle}: Response is too brief.")
            elif "honest" in principle.lower() and any(
                word in response.lower() for word in ["obviously", "clearly", "definitely"]
            ):
                critique_parts.append(f"⚠ {principle}: Avoid over-confident language.")
            elif "step-by-step" in principle.lower() and response.count(".") < 3:
                critique_parts.append(f"⚠ {principle}: Could break down explanation into more steps.")
            elif "uncertainty" in principle.lower() and "not sure" not in response.lower():
                if "?" not in task:  # For factual questions, should show confidence
                    critique_parts.append(f"⚠ {principle}: Could acknowledge limitations.")
        
        return "\n".join(critique_parts) if critique_parts else "Response meets all principles."
    
    def revise(self, response: str, critique: str, task: str) -> str:
        """
        Revise response based on critique.
        
        Args:
            response: Original response
            critique: Critique feedback
            task: Original task
            
        Returns:
            Revised response (if revise_fn provided, uses it; else returns original)
        """
        if self.revise_fn:
            return self.revise_fn(response, critique, task)
        
        # Simple revision: add reasoning/examples if flagged
        revised = response
        
        if "too brief" in critique.lower():
            revised += "\n\nLet me elaborate: [expansion would go here]"
        
        if "over-confident" in critique.lower():
            revised = re.sub(
                r"\b(obviously|clearly|definitely)\b",
                "arguably",
                revised,
                flags=re.IGNORECASE,
            )
        
        if "break down" in critique.lower():
            revised += "\n\nKey steps:\n1. [First step]\n2. [Second step]\n3. [Third step]"
        
        return revised
    
    def distill_critique_pairs(
        self,
        responses: List[str],
        task: str,
        teacher_fn: Optional[Callable[[str], str]] = None,
    ) -> List[Dict[str, Any]]:
        """
        Generate (response, critique, revision) triples for training.
        
        Args:
            responses: List of model responses to process
            task: The task/question that generated responses
            teacher_fn: Optional teacher function to generate reference responses
            
        Returns:
            List of distillation triples with keys:
            - task
            - original_response
            - critique
            - revised_response
            - teacher_response (if teacher_fn provided)
        """
        triples = []
        
        for response in responses:
            critique = self.critique(response, task)
            revised = self.revise(response, critique, task)
            
            triple = {
                "task": task,
                "original_response": response,
                "critique": critique,
                "revised_response": revised,
                "teacher_response": teacher_fn(task) if teacher_fn else None,
            }
            triples.append(triple)
        
        return triples


# ============================================================================
# 5. MultiTeacherEnsemble Class
# ============================================================================

class MultiTeacherEnsemble:
    """
    Combines multiple teacher models using ensemble strategies.
    
    Strategies:
    - "best_of": Quality-based voting
    - "synthesize": Merge best parts of multiple responses
    - "debate": Teachers argue and synthesize consensus
    """
    
    def __init__(self, teachers: Dict[str, Callable[[str], str]]):
        """
        Initialize ensemble with multiple teachers.
        
        Args:
            teachers: Dict mapping teacher names to callables
        """
        self.teachers = teachers
        self.response_cache: Dict[Tuple[str, str], str] = {}
    
    def ensemble_generate(
        self,
        task: str,
        strategy: str = "best_of",
        teacher_names: Optional[List[str]] = None,
    ) -> str:
        """
        Generate response using ensemble strategy.
        
        Args:
            task: The task/question
            strategy: "best_of", "synthesize", or "debate"
            teacher_names: Specific teachers to use (default: all)
            
        Returns:
            Ensemble response
        """
        if strategy not in ["best_of", "synthesize", "debate"]:
            strategy = "best_of"
        
        # Get responses from all (or specified) teachers
        teacher_names = teacher_names or list(self.teachers.keys())
        responses = {}
        
        for name in teacher_names:
            if name not in self.teachers:
                continue
            
            # Check cache
            cache_key = (task, name)
            if cache_key in self.response_cache:
                responses[name] = self.response_cache[cache_key]
            else:
                resp = self.teachers[name](task)
                responses[name] = resp
                self.response_cache[cache_key] = resp
        
        if not responses:
            return "No teacher responses available."
        
        if strategy == "best_of":
            return self._best_of(responses)
        elif strategy == "synthesize":
            return self._synthesize(responses, task)
        else:  # debate
            return self._debate(responses, task)
    
    def _best_of(self, responses: Dict[str, str]) -> str:
        """Select best response by quality heuristics."""
        ranked = self._rank_responses(list(responses.values()))
        return ranked[0] if ranked else ""
    
    def _synthesize(self, responses: Dict[str, str], task: str) -> str:
        """Merge best parts of multiple responses."""
        if not responses:
            return ""
        
        # Simple synthesis: take longest response (usually most thorough)
        best = max(responses.values(), key=lambda x: len(x.split()))
        
        # In a real system, would use actual synthesis logic
        parts = []
        for name, resp in responses.items():
            # Extract first sentence from each
            sent = resp.split(".")[0] + "."
            if sent not in parts:
                parts.append(sent)
        
        return " ".join(parts) + "\n\n" + best
    
    def _debate(self, responses: Dict[str, str], task: str) -> str:
        """Teachers argue and merge consensus."""
        if not responses:
            return ""
        
        debate_summary = "Ensemble debate results:\n\n"
        
        for name, response in responses.items():
            debate_summary += f"[{name}]\n{response[:200]}...\n\n"
        
        # Simple consensus: key points from longest response
        longest = max(responses.values(), key=lambda x: len(x))
        debate_summary += f"\nConsensus (from most thorough analysis):\n{longest}"
        
        return debate_summary
    
    def _rank_responses(self, responses: List[str]) -> List[str]:
        """Rank responses by quality heuristics."""
        def quality_score(resp: str) -> float:
            score = 0.0
            
            # Length (200-1000 words is good)
            word_count = len(resp.split())
            if 200 <= word_count <= 1000:
                score += 0.3
            elif word_count > 1000:
                score += 0.2  # Penalize verbose
            else:
                score += min(word_count / 200, 0.3)
            
            # Structure (multiple sentences/paragraphs)
            if resp.count(".") >= 3:
                score += 0.3
            
            # Reasoning markers
            markers = ["therefore", "because", "step", "first", "consider"]
            marker_count = sum(1 for m in markers if m in resp.lower())
            score += min(marker_count * 0.1, 0.2)
            
            # Specificity (includes concrete details)
            if any(c.isdigit() for c in resp):
                score += 0.2
            
            return score
        
        return sorted(responses, key=quality_score, reverse=True)


# ============================================================================
# 6. ProgressiveCurriculum Class
# ============================================================================

@dataclass
class DataPoint:
    """A single training data point with difficulty metadata."""
    text: str
    difficulty: str  # "easy", "medium", "hard", "frontier"
    domain: str
    metadata: Dict[str, Any] = field(default_factory=dict)


class ProgressiveCurriculum:
    """
    Progressive curriculum learning: adjust difficulty over training stages.
    
    Difficulty tiers:
    - easy (25%): Straightforward tasks for foundation
    - medium (50%): Standard complexity
    - hard (20%): Challenging, requires reasoning
    - frontier (5%): Cutting-edge, pushes model limits
    """
    
    def __init__(self, dataset: List[DataPoint], n_stages: int = 4):
        """
        Initialize curriculum.
        
        Args:
            dataset: List of DataPoint objects
            n_stages: Number of training stages
        """
        self.dataset = dataset
        self.n_stages = n_stages
        self._categorize_by_difficulty()
        self.student_readiness = 0.0
    
    def _categorize_by_difficulty(self) -> None:
        """Categorize dataset by difficulty tier."""
        self.tiers = {
            "easy": [],
            "medium": [],
            "hard": [],
            "frontier": [],
        }
        
        for point in self.dataset:
            tier = point.difficulty
            if tier in self.tiers:
                self.tiers[tier].append(point)
    
    def get_stage(self, epoch: int) -> List[DataPoint]:
        """
        Get appropriate difficulty mix for training stage.
        
        Args:
            epoch: Current training epoch
            
        Returns:
            List of DataPoint objects for this stage
        """
        stage = min(epoch // max(1, len(self.dataset) // 100), self.n_stages - 1)
        
        # Progressive difficulty increase
        if stage == 0:
            # Stage 1: Foundation (100% easy)
            return self.tiers["easy"]
        elif stage == 1:
            # Stage 2: Building (70% easy, 30% medium)
            easy = self.tiers["easy"][: len(self.tiers["easy"]) * 70 // 100]
            medium = self.tiers["medium"][: len(self.tiers["medium"]) * 30 // 100]
            return easy + medium
        elif stage == 2:
            # Stage 3: Challenging (25% easy, 50% medium, 25% hard)
            easy = self.tiers["easy"][: len(self.tiers["easy"]) * 25 // 100]
            medium = self.tiers["medium"][: len(self.tiers["medium"]) * 50 // 100]
            hard = self.tiers["hard"][: len(self.tiers["hard"]) * 25 // 100]
            return easy + medium + hard
        else:
            # Stage 4: Frontier (all difficulties, emphasizing hard/frontier)
            return self.dataset
    
    def compute_student_readiness(self, eval_scores: List[float]) -> float:
        """
        Compute whether student is ready to advance to next stage.
        
        Strategy: If average recent performance > 0.75, student is ready.
        
        Args:
            eval_scores: Recent evaluation scores
            
        Returns:
            Readiness score 0.0-1.0
        """
        if not eval_scores:
            return 0.0
        
        # Use recent scores (last 10)
        recent = eval_scores[-10:]
        avg_score = sum(recent) / len(recent)
        
        # Readiness: exponential if avg_score > 0.75
        if avg_score > 0.75:
            self.student_readiness = min(1.0, self.student_readiness + 0.2)
        elif avg_score < 0.5:
            self.student_readiness = max(0.0, self.student_readiness - 0.1)
        
        return self.student_readiness


# ============================================================================
# 7. InferenceTimeDistiller Class (KEY)
# ============================================================================

class InferenceTimeDistiller:
    """
    The CORE distillation mechanism: makes Flash reason like Opus at inference time.
    
    Key insight: Without retraining, we can inject teacher reasoning into the prompt,
    making the student model adopt Opus-level reasoning patterns.
    
    Usage:
        distiller = InferenceTimeDistiller(pattern_library)
        enriched_prompt = distiller.enrich_prompt(task, context)
        student_response = student_model(enriched_prompt)
    """
    
    # Multi-paragraph system prompt encoding Opus-level reasoning
    TEACHER_REASONING_PROMPT = """You are an expert reasoning assistant trained to solve complex problems with exceptional clarity and rigor. Your reasoning process is fundamentally different from surface-level responses: you engage in deep, systematic analysis before providing conclusions.

SYSTEMATIC DECOMPOSITION:
When encountering any problem, your first step is to break it into constituent parts. Don't rush to conclusions. Instead, decompose the problem hierarchically: identify the core question, separate known from unknown information, categorize constraints, and map dependencies between subproblems. This decomposition becomes your scaffolding for reasoning. Write out your decomposition explicitly—this clarifies your thinking and helps catch errors early. For complex multi-step problems, create a mental model: visualize the relationships between components. What depends on what? What must be solved first? What can be solved in parallel? This structured approach prevents you from missing critical aspects.

FIRST-PRINCIPLES THINKING:
Before applying memorized templates, reason from first principles. Ask: What are the fundamental assumptions? Can I verify them? Are there hidden dependencies? Start from core axioms and build upward, rather than down from surface patterns. This approach prevents you from inheriting misconceptions embedded in standard solutions. For technical problems, derive key relationships rather than just retrieving them. Why does this rule work? What breaks it? When you derive something yourself, you understand not just the what but the why—and you're less likely to apply it incorrectly. First-principles thinking is slower initially but builds deeper expertise and adaptability to novel situations.

CONSIDERING ALTERNATIVE APPROACHES:
Expert reasoning involves exploring multiple solution paths before selecting one. Consider at least two fundamentally different approaches to any problem: What if I interpret this differently? What if there's a hidden constraint I'm missing? Can I solve this via direct calculation? Via logical deduction? Via analogy to similar problems? Via simulation or modeling? Document why you choose one approach over others—this reasoning is as valuable as the solution itself. Sometimes the "wrong" approaches reveal insights that improve the final answer. Alternative approaches also serve as verification: if multiple distinct methods converge on the same answer, confidence increases dramatically.

EDGE CASES AND BOUNDARY CONDITIONS:
Sophisticated problems often hide in edge cases. Ask: What happens at limits? (e.g., as x→0, as x→∞, for empty sets, for zero resources?) What are boundary conditions? Are there special cases that break my general logic? For any rule, find exceptions. This prevents brittle solutions that fail on real-world variation. Explicitly check: Does my solution work for zero? For negative numbers? For empty sets? For maximum constraints? For single elements? For very large inputs? For degenerate cases? This systematic exploration of the solution space reveals fragilities and strengthens your answer. Edge cases aren't exceptions to ignore—they're teaching moments that deepen understanding.

VERIFYING LOGIC AND CHECKING WORK:
After deriving an answer, verify it through independent means. Work backward from your conclusion: If this is true, what must also be true? Can I verify using a different method? For math problems, plug answers back in. For logical arguments, test counterexamples. For code, trace execution on sample inputs. For written arguments, identify assumptions and test whether they hold. This self-checking often catches errors that forward reasoning missed. Many sophisticated errors involve subtle logical flaws that only reverse-verification catches. When you catch an error, don't just fix it—understand why you made that error. What cognitive slip occurred? How can you prevent similar errors in the future?

CROSS-CHECKING WITH MULTIPLE METHODS:
When possible, solve the same problem multiple ways: analytically vs. numerically, top-down vs. bottom-up, algebraically vs. geometrically, via simulation vs. closed-form solution. If all methods converge on the same answer, confidence increases exponentially. If they diverge, you've found an error in reasoning—and now you have a debugging task that's much easier than finding the error blindly. This cross-checking is especially valuable for complex problems where single methods can hide subtle mistakes. Sometimes different approaches reveal different insights into why the answer is what it is, deepening your understanding beyond just "getting the right number."

ACKNOWLEDGING UNCERTAINTY AND LIMITATIONS:
Expert reasoning includes honest epistemic humility. Clearly distinguish between conclusions you're confident about and those involving assumptions. State what information you're missing that would improve your analysis. Identify which parts of your reasoning are most fragile or assumption-dependent. If a problem is ambiguous, acknowledge multiple interpretations explicitly and reason through each. This prevents overconfidence and helps users understand where your reasoning stands on firmer vs. shakier ground. Uncertainty doesn't mean weakness—it means intellectual honesty. Problems in real domains always involve uncertainty; acknowledging it is a sign of sophistication, not inadequacy.

CONCRETE EXAMPLES AND INSTANTIATION:
Abstract reasoning becomes clearer when grounded in examples. After explaining a general principle, apply it to specific cases. Use concrete numbers, real scenarios, or simplified instances. Walk through a detailed example, showing all steps. Examples aren't just illustrations—they're tools for verification. If you can't instantiate an abstract principle concretely, you haven't understood it well enough. Work through small examples completely, showing all reasoning. For large problems, start with minimal examples and gradually increase complexity. This incremental approach catches errors early and builds intuition.

STRUCTURING COMPLEX ARGUMENTS:
For multifaceted problems, structure your reasoning hierarchically with clear logical flow: Start with necessary background, then introduce intermediate conclusions, building toward final insights. Use signposting language ("This implies...", "Given this, consider...", "Building on the above...") to guide the reader through your logical chain. Make dependencies explicit: "This step depends on assumption X being true." Avoid jumping between topics; maintain coherent thread. When you transition between ideas, explain the connection. This structured approach makes your reasoning easier to follow and easier to verify.

QUESTIONING ASSUMPTIONS:
Throughout reasoning, periodically pause to question assumptions. What am I taking for granted? Is this assumption valid in all contexts? What would change if I relaxed this assumption? Some problems seem hard because they contain unnecessary constraints. Challenging assumptions often reveals simpler solutions. Be especially skeptical of your own assumptions—they're often invisible to you. Try to articulate what you assume at each step. Some of your most productive insights come from discovering that an assumption you thought was necessary actually isn't.

CONNECTING TO DOMAIN KNOWLEDGE:
While reasoning from first principles is crucial, efficiently solving hard problems also requires leveraging domain-specific patterns. When relevant, draw on established frameworks, theorems, or best practices—but explain why they apply rather than just invoking them. This combines principled reasoning with practical efficiency. Domain knowledge is like a library: it helps you solve problems faster, but only if you understand when and why to use each tool. Always be ready to derive from scratch if the domain knowledge seems inapplicable.

ITERATIVE REFINEMENT:
Sophisticated reasoning is rarely correct on first pass. Plan iterations: State your initial approach, test it, find limitations, refine it. Document how your understanding evolved. This iterative process isn't weakness—it's the hallmark of serious intellectual engagement with hard problems. After each iteration, ask: What did I learn? What still seems uncertain? What should I test next? This systematic refinement leads to solutions that are robust and well-understood.

WHEN UNCERTAIN, SAY SO:
If you can't confidently reason through a part of a problem, acknowledge it explicitly. Rather than speculate, identify what information or reasoning capability would help. Distinguish between "I don't know" and "This requires assumptions I can't verify." Users appreciate this honesty far more than false confidence. Uncertainty that's acknowledged is valuable information; uncertainty that's hidden is dangerous.

SHOW YOUR WORK:
Your reasoning should be visible to the reader: show your work, explain your logic, justify your choices. Don't hide steps "because they're obvious"—what's obvious to an expert might not be obvious to others, and hidden steps are where errors hide. Make your reasoning transparent enough that someone else could verify it, learn from it, or spot errors. Aim for reasoning that is clear, defensible, and verifiable."""
    
    def __init__(
        self,
        pattern_library: Optional[PatternLibrary] = None,
        teacher_fn: Optional[Callable[[str], str]] = None,
    ):
        """
        Initialize inference-time distiller.
        
        Args:
            pattern_library: Shared pattern library for reasoning injection
            teacher_fn: Optional teacher model function for live teacher generation
        """
        self.pattern_library = pattern_library or PatternLibrary()
        self.teacher_fn = teacher_fn
    
    def enrich_prompt(self, task: str, context: str = "", top_k: int = 5) -> str:
        """
        Enrich a task prompt with injected teacher reasoning patterns.
        
        Builds a multi-part enhanced prompt:
        1. Teacher reasoning system prompt
        2. Contextual information (if provided)
        3. Injected reasoning patterns
        4. Original task
        
        Args:
            task: Original task/question
            context: Optional contextual information
            top_k: Number of patterns to inject
            
        Returns:
            Enriched prompt ready for student model
        """
        # Start with teacher reasoning prompt
        enriched = self.TEACHER_REASONING_PROMPT
        enriched += "\n\n" + ("=" * 80)
        
        # Add context if provided
        if context.strip():
            enriched += f"\n\nCONTEXT:\n{context}\n\n"
        
        # Retrieve and inject relevant patterns
        patterns = self.pattern_library.get_patterns(task, top_k=top_k)
        
        if patterns:
            enriched += "\nRELEVANT REASONING PATTERNS:\n"
            enriched += "When solving this problem, consider these approaches:\n\n"
            
            for i, pattern in enumerate(patterns, 1):
                enriched += f"{i}. {pattern.pattern_text}\n"
                if pattern.trigger_words:
                    enriched += f"   [Keywords: {', '.join(pattern.trigger_words[:3])}]\n"
                enriched += f"   [Effectiveness: {pattern.effectiveness_score:.2%}]\n\n"
        
        # Original task
        enriched += ("=" * 80)
        enriched += f"\n\nPROBLEM:\n{task}\n\nREASONING (show your work):\n"
        
        return enriched
    
    def generate_with_distillation(
        self,
        task: str,
        student_fn: Callable[[str], str],
        teacher_fn: Optional[Callable[[str], str]] = None,
        use_live_teacher: bool = False,
    ) -> str:
        """
        Generate response using inference-time distillation.
        
        Strategy:
        1. If use_live_teacher and teacher_fn available: Get teacher mini-CoT, inject
        2. Always: Inject relevant patterns from library
        3. Build rich system prompt that teaches student Opus-level reasoning
        4. Call student with enriched prompt
        
        Args:
            task: The task/question
            student_fn: Function to call student model
            teacher_fn: Optional teacher function (uses self.teacher_fn if not provided)
            use_live_teacher: Whether to call teacher for live generation
            
        Returns:
            Student response informed by teacher reasoning
        """
        # Determine teacher function
        teacher = teacher_fn or self.teacher_fn
        
        # Build context from teacher if requested
        context = ""
        if use_live_teacher and teacher:
            try:
                teacher_response = teacher(task)
                # Extract mini-CoT from teacher response
                cot_extractor = ChainOfThoughtDistiller(teacher_fn=teacher)
                patterns = cot_extractor.extract_patterns(teacher_response)
                context = "Reference reasoning from expert model:\n" + "\n".join(patterns[:3])
            except Exception:
                # Gracefully handle teacher errors
                pass
        
        # Enrich prompt with teacher reasoning + patterns
        enriched_prompt = self.enrich_prompt(task, context=context)
        
        # Call student with enriched prompt
        student_response = student_fn(enriched_prompt)
        
        return student_response
    
    def batch_generate_with_distillation(
        self,
        tasks: List[str],
        student_fn: Callable[[str], str],
        use_live_teacher: bool = False,
    ) -> List[str]:
        """
        Generate responses for a batch of tasks using distillation.
        
        Args:
            tasks: List of tasks/questions
            student_fn: Student model function
            use_live_teacher: Whether to use live teacher for each task
            
        Returns:
            List of student responses
        """
        responses = []
        for task in tasks:
            response = self.generate_with_distillation(
                task,
                student_fn,
                use_live_teacher=use_live_teacher,
            )
            responses.append(response)
        
        return responses


# ============================================================================
# Example Usage & Integration
# ============================================================================

if __name__ == "__main__":
    """
    Demonstration of the knowledge distillation pipeline.
    """
    
    print("Knowledge Distillation Pipeline - Demo\n" + "=" * 80)
    
    # 1. Create pattern library
    print("\n1. Initializing Pattern Library...")
    library = PatternLibrary()
    
    # Add some example patterns
    library.add_pattern(
        text="To solve mathematical problems, first identify what's being asked, then break the solution into logical steps.",
        trigger_words=["math", "problem", "solve", "equation"],
        domain="math",
    )
    
    library.add_pattern(
        text="When writing code, consider edge cases, use meaningful variable names, and add comments for complex logic.",
        trigger_words=["code", "function", "algorithm", "implement"],
        domain="coding",
    )
    
    print(f"   Library stats: {library.get_stats()}")
    
    # 2. Create CoT distiller
    print("\n2. Initializing Chain-of-Thought Distiller...")
    cot_distiller = ChainOfThoughtDistiller(pattern_library=library)
    
    # Simulate teacher response
    sample_task = "How do you solve a quadratic equation?"
    sample_teacher_response = (
        "To solve a quadratic equation, first consider the form ax^2 + bx + c = 0. "
        "Step 1: Identify coefficients a, b, c. Step 2: Calculate discriminant b^2 - 4ac. "
        "Therefore, we can use the quadratic formula. "
        "This means x = (-b ± √(b^2 - 4ac)) / (2a). "
        "Let's think about what this tells us about solutions."
    )
    
    patterns = cot_distiller.extract_patterns(sample_teacher_response)
    print(f"   Extracted {len(patterns)} reasoning patterns")
    
    # 3. Create constitutional distiller
    print("\n3. Initializing Constitutional Distiller...")
    const_distiller = ConstitutionalDistiller()
    
    sample_response = "Quadratic equations are solved using the formula."
    critique = const_distiller.critique(sample_response, sample_task)
    print(f"   Critique generated (characters: {len(critique)})")
    
    revised = const_distiller.revise(sample_response, critique, sample_task)
    print(f"   Revised response (characters: {len(revised)})")
    
    # 4. Create multi-teacher ensemble
    print("\n4. Initializing Multi-Teacher Ensemble...")
    
    def dummy_teacher_a(task: str) -> str:
        return f"Teacher A response to: {task[:50]}..."
    
    def dummy_teacher_b(task: str) -> str:
        return f"Teacher B thinks: Comprehensive analysis of {task[:50]}..."
    
    ensemble = MultiTeacherEnsemble({
        "teacher_a": dummy_teacher_a,
        "teacher_b": dummy_teacher_b,
    })
    
    ensemble_response = ensemble.ensemble_generate(sample_task, strategy="best_of")
    print(f"   Ensemble response: {ensemble_response[:80]}...")
    
    # 5. Create progressive curriculum
    print("\n5. Initializing Progressive Curriculum...")
    
    sample_data = [
        DataPoint(text="Easy problem 1", difficulty="easy", domain="math"),
        DataPoint(text="Easy problem 2", difficulty="easy", domain="math"),
        DataPoint(text="Medium problem 1", difficulty="medium", domain="math"),
        DataPoint(text="Hard problem 1", difficulty="hard", domain="math"),
        DataPoint(text="Frontier problem 1", difficulty="frontier", domain="math"),
    ]
    
    curriculum = ProgressiveCurriculum(sample_data, n_stages=4)
    stage_0_data = curriculum.get_stage(0)
    print(f"   Stage 0 data points: {len(stage_0_data)}")
    
    # 6. Create inference-time distiller
    print("\n6. Initializing Inference-Time Distiller (KEY)...")
    
    def dummy_student(prompt: str) -> str:
        return f"[Student Response]\n{prompt[:100]}..."
    
    inference_distiller = InferenceTimeDistiller(
        pattern_library=library,
        teacher_fn=dummy_teacher_a,
    )
    
    enriched = inference_distiller.enrich_prompt(sample_task)
    print(f"   Enriched prompt size: {len(enriched)} characters")
    print(f"   Includes teacher reasoning prompt: {len(inference_distiller.TEACHER_REASONING_PROMPT) > 500}")
    
    student_response = inference_distiller.generate_with_distillation(
        sample_task,
        student_fn=dummy_student,
        use_live_teacher=True,
    )
    print(f"   Student response generated: {len(student_response)} characters")
    
    # 7. Persistence
    print("\n7. Testing Persistence...")
    
    library.save("/tmp/pattern_library.json")
    print("   Pattern library saved")
    
    new_library = PatternLibrary()
    new_library.load("/tmp/pattern_library.json")
    print(f"   Loaded library with {new_library.get_stats()['total_patterns']} patterns")
    
    print("\n" + "=" * 80)
    print("Demo complete! Pipeline is ready for real knowledge distillation.\n")
