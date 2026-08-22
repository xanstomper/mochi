"""Synthetic data generation: Self-Instruct, Evol-Instruct, Constitutional AI,
Rejection Sampling, Self-Play, Debate, CoT Distillation, Reflection."""
from __future__ import annotations

import json
import math
import random
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np


@dataclass
class SynthSample:
    """A single synthetic training sample."""
    instruction: str
    response: str
    source: str  # e.g., "self_instruct", "evol_instruct"
    metadata: Dict[str, Any] = field(default_factory=dict)
    score: Optional[float] = None
    parent_instruction: Optional[str] = None
    constraint: Optional[str] = None

default_system_prompt: str = "You are a helpful AI assistant."


@dataclass
class SynthDataset:
    """A collection of synthetic training samples."""
    samples: List[SynthSample] = field(default_factory=list)
    config: Dict[str, Any] = field(default_factory=dict)

    def add(self, sample: SynthSample) -> None:
        self.samples.append(sample)

    def extend(self, samples: List[SynthSample]) -> None:
        self.samples.extend(samples)

    def filter_by_score(self, min_score: float = 0.5) -> SynthDataset:
        filtered = [s for s in self.samples if s.score is not None and s.score >= min_score]
        return SynthDataset(samples=filtered, config=self.config)

    def filter_by_source(self, source: str) -> SynthDataset:
        filtered = [s for s in self.samples if s.source == source]
        return SynthDataset(samples=filtered, config=self.config)

    def deduplicate(self, threshold: float = 0.85) -> SynthDataset:
        """Simple dedup by instruction similarity (Jaccard on tokens)."""
        unique: List[SynthSample] = []
        for sample in self.samples:
            is_dup = False
            tokens_a = set(sample.instruction.lower().split())
            for existing in unique:
                tokens_b = set(existing.instruction.lower().split())
                intersection = tokens_a & tokens_b
                union = tokens_a | tokens_b
                if len(union) > 0 and len(intersection) / len(union) > threshold:
                    is_dup = True
                    break
            if not is_dup:
                unique.append(sample)
        return SynthDataset(samples=unique, config=self.config)

    def __len__(self) -> int:
        return len(self.samples)

    def to_jsonl(self, filepath: str) -> None:
        with open(filepath, "w") as f:
            for sample in self.samples:
                f.write(json.dumps({
                    "instruction": sample.instruction,
                    "response": sample.response,
                    "source": sample.source,
                    "score": sample.score,
                    "metadata": sample.metadata,
                }) + "\n")

    @classmethod
    def from_jsonl(cls, filepath: str) -> SynthDataset:
        samples: List[SynthSample] = []
        with open(filepath, "r") as f:
            for line in f:
                data = json.loads(line.strip())
                samples.append(SynthSample(
                    instruction=data["instruction"],
                    response=data["response"],
                    source=data.get("source", "unknown"),
                    score=data.get("score"),
                    metadata=data.get("metadata", {}),
                ))
        return SynthDataset(samples=samples)


class SynthDataGenerator:
    """Generates synthetic training data using various methods."""

    def __init__(
        self,
        llm_call: Optional[Callable[[str], str]] = None,
        seed: int = 42,
    ):
        self.llm_call = llm_call or self._default_llm_call
        self.rng = random.Random(seed)
        self.np_rng = np.random.default_rng(seed)

        # Seed topics for initial instruction generation
        self._seed_topics = [
            "mathematics", "physics", "chemistry", "biology",
            "computer science", "history", "literature", "philosophy",
            "psychology", "economics", "programming", "data science",
            "machine learning", "creative writing", "code generation",
            "logical reasoning", "problem solving", "ethics",
            "science fiction", "world building",
        ]

    @staticmethod
    def _default_llm_call(prompt: str) -> str:
        """Default mock LLM call when none provided."""
        # Simple template-based response for demo
        lines = prompt.strip().split("\n")
        last_line = lines[-1] if lines else prompt
        return f"This is a synthetic response to: '{last_line[:80]}...'\n\n" \
               f"The response provides detailed analysis and insights on the topic. " \
               f"It includes relevant examples, step-by-step reasoning, and actionable " \
               f"conclusions based on the given context."

    def _generate_instruction(
        self,
        topics: Optional[List[str]] = None,
        complexity: str = "medium",
    ) -> str:
        """Generate a synthetic instruction."""
        if topics is None:
            topics = self._seed_topics
        topic = self.rng.choice(topics)

        templates = {
            "easy": [
                f"Explain the concept of {topic} in simple terms.",
                f"What is {topic} and why is it important?",
                f"Give a brief overview of {topic}.",
                f"List the key principles of {topic}.",
            ],
            "medium": [
                f"Compare and contrast different approaches in {topic}.",
                f"Describe the step-by-step process for solving a {topic} problem.",
                f"Write a detailed analysis of a recent development in {topic}.",
                f"Explain how {topic} connects to other fields of study.",
                f"Provide a comprehensive guide to understanding {topic}.",
            ],
            "hard": [
                f"Critically evaluate the current state-of-the-art methods in {topic}. "
                f"Identify key limitations and propose potential improvements.",
                f"Design a novel framework for addressing a challenging problem in {topic}. "
                f"Describe the architecture, algorithms, and expected outcomes.",
                f"Analyze the ethical implications of recent advances in {topic}. "
                f"Consider multiple stakeholder perspectives and propose guidelines.",
                f"Synthesize knowledge from {topic} and adjacent fields to propose "
                f"a unified theory that explains observed phenomena.",
            ],
        }

        return self.rng.choice(templates.get(complexity, templates["medium"]))

    def _generate_response(self, instruction: str) -> str:
        """Generate a synthetic response for an instruction."""
        prompt = f"Instruction: {instruction}\n\nGenerate a helpful response:"
        return self.llm_call(prompt)

    def self_instruct(
        self,
        num_samples: int = 100,
        topics: Optional[List[str]] = None,
        complexity: str = "medium",
    ) -> SynthDataset:
        """Self-Instruct: generate instructions, then responses."""
        samples: List[SynthSample] = []
        for _ in range(num_samples):
            instruction = self._generate_instruction(topics, complexity)
            response = self._generate_response(instruction)
            samples.append(SynthSample(
                instruction=instruction,
                response=response,
                source="self_instruct",
                metadata={"complexity": complexity},
            ))
        return SynthDataset(samples=samples)

    def evol_instruct(
        self,
        base_instructions: List[str],
        num_evolutions: int = 3,
        in_breadth: bool = True,
        in_depth: bool = True,
    ) -> SynthDataset:
        """Evol-Instruct: evolve instructions to increase complexity.
        
        Evolves instructions in-depth (harder) or in-breadth (new topics).
        """
        evolutions = [
            "Add a constraint requiring step-by-step reasoning.",
            "Increase depth by requiring expert-level knowledge.",
            "Add a requirement to compare multiple approaches.",
            "Make it more concrete by requiring code or formulas.",
            "Add a real-world application scenario.",
            "Require the answer to be in a specific format (JSON, table).",
            "Add conflicting information that must be resolved.",
            "Require citing specific research papers or findings.",
        ]

        samples: List[SynthSample] = []
        for base_instr in base_instructions:
            current_instr = base_instr
            for _ in range(num_evolutions):
                if in_depth and self.rng.random() < 0.6:
                    # Evolve in-depth (more complex)
                    modifier = self.rng.choice(evolutions)
                    current_instr = f"{current_instr} [{modifier}]"
                elif in_breadth:
                    # Evolve in-breadth (new angle)
                    new_topic = self.rng.choice(self._seed_topics)
                    current_instr = f"{current_instr} Also connect this to {new_topic}."

            response = self._generate_response(current_instr)
            samples.append(SynthSample(
                instruction=current_instr,
                response=response,
                source="evol_instruct",
                parent_instruction=base_instr,
                metadata={"num_evolutions": num_evolutions},
            ))

        return SynthDataset(samples=samples)

    def constitutional_ai(
        self,
        base_samples: List[SynthSample],
        principles: Optional[List[str]] = None,
        num_revisions: int = 2,
    ) -> SynthDataset:
        """Constitutional AI: generate responses guided by principles, with revisions."""
        if principles is None:
            principles = [
                "Be helpful, harmless, and honest.",
                "Avoid generating harmful, unethical, or dangerous content.",
                "Respect user privacy and confidentiality.",
                "Provide balanced perspectives on controversial topics.",
                "Admit uncertainty when appropriate.",
                "Avoid making up facts or sources.",
            ]

        revised_samples: List[SynthSample] = []
        for sample in base_samples:
            # Initial response with principles
            initial_response = sample.response
            current_response = initial_response

            for _ in range(num_revisions):
                principle = self.rng.choice(principles)
                revision_prompt = (
                    f"Original response: {current_response}\n\n"
                    f"Revise according to this principle: {principle}\n"
                    f"Revised response:"
                )
                current_response = self.llm_call(revision_prompt)

            revised_samples.append(SynthSample(
                instruction=sample.instruction,
                response=current_response,
                source="constitutional_ai",
                parent_instruction=sample.instruction,
                metadata={
                    "principles": principles[:3],
                    "num_revisions": num_revisions,
                },
            ))

        return SynthDataset(samples=revised_samples)

    def rejection_sampling(
        self,
        instructions: List[str],
        num_candidates: int = 5,
        quality_threshold: float = 0.6,
    ) -> SynthDataset:
        """Rejection sampling: generate multiple responses, keep best."""
        samples: List[SynthSample] = []

        for instruction in instructions:
            candidates: List[Tuple[str, float]] = []
            for _ in range(num_candidates):
                response = self._generate_response(instruction)
                # Score: length + diversity of vocabulary + presence of structure
                words = response.split()
                unique_words = len(set(w.lower() for w in words))
                length_score = min(1.0, len(words) / 200.0)
                diversity_score = min(1.0, unique_words / max(1, len(words))) * 2.0
                has_structure = any(
                    marker in response for marker in ["1.", "2.", "-", "**", "*"]
                )
                structure_score = 0.3 if has_structure else 0.0
                score = (length_score + diversity_score + structure_score) / 3.0
                candidates.append((response, score))

            candidates.sort(key=lambda x: x[1], reverse=True)
            best_response, best_score = candidates[0]

            if best_score >= quality_threshold:
                samples.append(SynthSample(
                    instruction=instruction,
                    response=best_response,
                    source="rejection_sampling",
                    score=best_score,
                    metadata={
                        "num_candidates": num_candidates,
                        "all_scores": [s for _, s in candidates],
                    },
                ))

        return SynthDataset(samples=samples)

    def self_play(
        self,
        num_rounds: int = 3,
        num_samples_per_round: int = 20,
        topics: Optional[List[str]] = None,
    ) -> SynthDataset:
        """Self-play: generator generates, discriminator evaluates, iterate."""
        if topics is None:
            topics = self._seed_topics[:5]

        samples: List[SynthSample] = []
        current_instructions = [
            self._generate_instruction(topics, "medium")
            for _ in range(num_samples_per_round)
        ]

        for round_idx in range(num_rounds):
            round_samples: List[SynthSample] = []
            for instruction in current_instructions:
                response = self._generate_response(instruction)
                # Discriminator: score the response
                score = len(response.split()) / 300.0  # Simple length heuristic
                score = min(1.0, score)

                sample = SynthSample(
                    instruction=instruction,
                    response=response,
                    source=f"self_play_round_{round_idx}",
                    score=score,
                    metadata={"round": round_idx},
                )
                round_samples.append(sample)

            # Select best samples to seed next round
            round_samples.sort(key=lambda s: s.score or 0.0, reverse=True)
            top_k = max(1, len(round_samples) // 2)
            samples.extend(round_samples[:top_k])

            # Generate new instructions based on best responses
            current_instructions = [
                self._generate_instruction(topics, "hard")
                for _ in range(num_samples_per_round)
            ]

        return SynthDataset(samples=samples)

    def debate_data(
        self,
        num_debates: int = 20,
        topics: Optional[List[str]] = None,
    ) -> SynthDataset:
        """Generate debate training data with two opposing viewpoints and adjudication."""
        if topics is None:
            topics = [
                "AI safety", "universal basic income", "genetic engineering",
                "space exploration", "renewable energy", "quantum computing",
            ]

        samples: List[SynthSample] = []
        for _ in range(num_debates):
            topic = self.rng.choice(topics)
            stance_a = self.rng.choice(["pro", "con"])
            stance_b = "con" if stance_a == "pro" else "pro"

            # Generate debate question
            question = f"Debate: Resolved that {topic} will have a net positive impact on society."

            # Generate arguments for each side
            prompt_a = f"{question}\nArgument in favor ({stance_a}):"
            prompt_b = f"{question}\nArgument in favor ({stance_b}):"

            argument_a = self.llm_call(prompt_a)
            argument_b = self.llm_call(prompt_b)

            # Generate adjudication
            adjudication_prompt = (
                f"Debate topic: {topic}\n\n"
                f"Pro arguments: {argument_a}\n\n"
                f"Con arguments: {argument_b}\n\n"
                f"Provide a balanced adjudication that identifies the strongest points "
                f"on each side and reaches a nuanced conclusion:"
            )
            adjudication = self.llm_call(adjudication_prompt)

            samples.append(SynthSample(
                instruction=question,
                response=adjudication,
                source="debate_data",
                metadata={
                    "topic": topic,
                    "argument_a": argument_a,
                    "argument_b": argument_b,
                    "stance_a": stance_a,
                    "stance_b": stance_b,
                },
            ))

        return SynthDataset(samples=samples)

    def cot_distillation(
        self,
        problems: List[str],
        num_reasoning_paths: int = 3,
    ) -> SynthDataset:
        """Chain-of-Thought distillation: generate step-by-step reasoning."""
        samples: List[SynthSample] = []

        reasoning_templates = [
            "Let me work through this step by step:",
            "I'll break this down into smaller parts:",
            "Here's a systematic approach:",
            "Let me analyze this carefully:",
        ]

        for problem in problems:
            reasoning_paths: List[str] = []
            for _ in range(num_reasoning_paths):
                starter = self.rng.choice(reasoning_templates)
                prompt = (
                    f"Problem: {problem}\n\n"
                    f"{starter}\n"
                    f"Provide detailed step-by-step reasoning with intermediate conclusions:"
                )
                reasoning = self.llm_call(prompt)
                reasoning_paths.append(reasoning)

            # Combine the reasoning paths with a final answer
            combined_prompt = (
                f"Problem: {problem}\n\n"
                f"Multiple reasoning paths:\n"
                + "\n---\n".join(reasoning_paths) + "\n\n"
                f"Synthesize these reasoning paths into a clear, concise final answer:"
            )
            final_response = self.llm_call(combined_prompt)

            samples.append(SynthSample(
                instruction=f"Solve step-by-step: {problem}",
                response=final_response,
                source="cot_distillation",
                metadata={
                    "num_paths": num_reasoning_paths,
                    "reasoning_paths": reasoning_paths,
                },
            ))

        return SynthDataset(samples=samples)

    def reflection_data(
        self,
        instructions: List[str],
        num_reflections: int = 2,
    ) -> SynthDataset:
        """Reflection training data: answer, critique, improve."""
        samples: List[SynthSample] = []

        for instruction in instructions:
            # Initial response
            initial = self._generate_response(instruction)

            current_response = initial
            reflection_chain: List[str] = [initial]

            for i in range(num_reflections):
                # Critique
                critique_prompt = (
                    f"Instruction: {instruction}\n\n"
                    f"Response: {current_response}\n\n"
                    f"Critically evaluate this response. Identify:"
                    f"1. What is correct and well-explained?\n"
                    f"2. What could be improved or is missing?\n"
                    f"3. Are there any errors or assumptions to check?\n"
                    f"4. How could the response be more comprehensive?\n"
                )
                critique = self.llm_call(critique_prompt)

                # Improve
                improve_prompt = (
                    f"Original response: {current_response}\n\n"
                    f"Critique: {critique}\n\n"
                    f"Provide an improved version that addresses the critique "
                    f"while maintaining the strengths of the original:"
                )
                improved = self.llm_call(improve_prompt)
                reflection_chain.append(improved)
                current_response = improved

            samples.append(SynthSample(
                instruction=instruction,
                response=current_response,
                source="reflection_data",
                metadata={
                    "num_reflections": num_reflections,
                    "reflection_chain": reflection_chain,
                },
            ))

        return SynthDataset(samples=samples)


# Convenience functions

def self_instruct(
    num_samples: int = 100,
    topics: Optional[List[str]] = None,
    seed: int = 42,
) -> SynthDataset:
    gen = SynthDataGenerator(seed=seed)
    return gen.self_instruct(num_samples, topics)


def evol_instruct(
    base_instructions: List[str],
    num_evolutions: int = 3,
    seed: int = 42,
) -> SynthDataset:
    gen = SynthDataGenerator(seed=seed)
    return gen.evol_instruct(base_instructions, num_evolutions)


def constitutional_ai(
    base_samples: List[SynthSample],
    principles: Optional[List[str]] = None,
    seed: int = 42,
) -> SynthDataset:
    gen = SynthDataGenerator(seed=seed)
    return gen.constitutional_ai(base_samples, principles)


def rejection_sampling(
    instructions: List[str],
    num_candidates: int = 5,
    seed: int = 42,
) -> SynthDataset:
    gen = SynthDataGenerator(seed=seed)
    return gen.rejection_sampling(instructions, num_candidates)


def self_play(
    num_rounds: int = 3,
    num_samples_per_round: int = 20,
    seed: int = 42,
) -> SynthDataset:
    gen = SynthDataGenerator(seed=seed)
    return gen.self_play(num_rounds, num_samples_per_round)


def debate_data(
    num_debates: int = 20,
    seed: int = 42,
) -> SynthDataset:
    gen = SynthDataGenerator(seed=seed)
    return gen.debate_data(num_debates)


def cot_distillation(
    problems: List[str],
    num_reasoning_paths: int = 3,
    seed: int = 42,
) -> SynthDataset:
    gen = SynthDataGenerator(seed=seed)
    return gen.cot_distillation(problems, num_reasoning_paths)


def reflection_data(
    instructions: List[str],
    num_reflections: int = 2,
    seed: int = 42,
) -> SynthDataset:
    gen = SynthDataGenerator(seed=seed)
    return gen.reflection_data(instructions, num_reflections)
