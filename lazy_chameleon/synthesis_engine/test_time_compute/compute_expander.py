"""Test-time compute expansion: Tree-of-Thoughts, Graph-of-Thoughts,
Self-Consistency, Reflection, ReAct, MCTS, Search-Augmented Reasoning."""
from __future__ import annotations

import math
import random
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

import numpy as np


@dataclass
class ThoughtNode:
    """A node in the reasoning tree/graph."""
    content: str
    parent: Optional[ThoughtNode] = None
    children: List[ThoughtNode] = field(default_factory=list)
    value: float = 0.0
    visits: int = 0
    depth: int = 0
    is_terminal: bool = False
    metadata: Dict[str, Any] = field(default_factory=dict)

    def add_child(self, child: ThoughtNode) -> None:
        child.parent = self
        child.depth = self.depth + 1
        self.children.append(child)

    def path_to_root(self) -> List[ThoughtNode]:
        path: List[ThoughtNode] = []
        curr: Optional[ThoughtNode] = self
        while curr is not None:
            path.append(curr)
            curr = curr.parent
        return list(reversed(path))

    def best_child(self, exploration_weight: float = 1.0) -> Optional[ThoughtNode]:
        """Select best child using UCT formula."""
        if not self.children:
            return None
        return max(
            self.children,
            key=lambda c: c.value / (c.visits + 1e-6)
            + exploration_weight * math.sqrt(
                2.0 * math.log(self.visits + 1) / (c.visits + 1e-6)
            ),
        )


@dataclass
class ReasoningResult:
    """Result from a reasoning computation."""
    final_answer: str
    reasoning_paths: List[List[ThoughtNode]]
    total_nodes: int
    method: str
    confidence: float = 0.0
    metadata: Dict[str, Any] = field(default_factory=dict)


class TreeOfThoughts:
    """Tree of Thoughts: explore multiple reasoning paths with deliberation."""

    def __init__(
        self,
        thought_generator: Optional[Callable[[str, int], List[str]]] = None,
        thought_evaluator: Optional[Callable[[str], float]] = None,
        max_branching: int = 3,
        max_depth: int = 5,
        beam_width: int = 2,
    ):
        self.thought_generator = thought_generator or self._default_generator
        self.thought_evaluator = thought_evaluator or self._default_evaluator
        self.max_branching = max_branching
        self.max_depth = max_depth
        self.beam_width = beam_width

    @staticmethod
    def _default_generator(prefix: str, num_candidates: int) -> List[str]:
        """Default thought generator."""
        candidates = []
        for i in range(num_candidates):
            candidates.append(f"Step {i+1}: Consider the approach of analyzing {prefix[-40:]}... "
                              f"from perspective {i+1}")
        return candidates

    @staticmethod
    def _default_evaluator(thought: str) -> float:
        """Default thought evaluator based on length and structure."""
        score = 0.0
        if len(thought) > 50:
            score += 0.3
        if any(w in thought for w in ["because", "therefore", "however", "thus"]):
            score += 0.3
        if "?" in thought:
            score += 0.2
        return min(1.0, score)

    def solve(self, problem: str) -> ReasoningResult:
        """Solve a problem using tree of thoughts."""
        root = ThoughtNode(content=f"Problem: {problem}", value=1.0, visits=1)
        frontier: List[ThoughtNode] = [root]
        all_paths: List[List[ThoughtNode]] = []
        total_nodes = 1

        for depth in range(self.max_depth):
            # Evaluate and prune frontier
            scored = []
            for node in frontier:
                val = self.thought_evaluator(node.content)
                node.value = val
                scored.append((val, node))

            scored.sort(key=lambda x: x[0], reverse=True)
            frontier = [node for _, node in scored[:self.beam_width]]

            if not frontier:
                break

            new_frontier: List[ThoughtNode] = []
            for node in frontier:
                candidates = self.thought_generator(node.content, self.max_branching)
                for cand in candidates:
                    child = ThoughtNode(content=cand, value=0.0)
                    node.add_child(child)
                    total_nodes += 1

                    if depth >= self.max_depth - 1:
                        child.is_terminal = True
                        all_paths.append(child.path_to_root())
                    else:
                        new_frontier.append(child)

            frontier = new_frontier

        if not all_paths and frontier:
            for node in frontier:
                all_paths.append(node.path_to_root())

        # Select best path
        best_path = max(all_paths, key=lambda p: p[-1].value) if all_paths else [root]

        return ReasoningResult(
            final_answer=best_path[-1].content if best_path else problem,
            reasoning_paths=all_paths,
            total_nodes=total_nodes,
            method="tree_of_thoughts",
        )


class GraphOfThoughts:
    """Graph of Thoughts: non-linear reasoning with merging and branching."""

    def __init__(
        self,
        thought_generator: Optional[Callable] = None,
        thought_merger: Optional[Callable[[str, str], Optional[str]]] = None,
    ):
        self.thought_generator = thought_generator or TreeOfThoughts._default_generator
        self.thought_merger = thought_merger or self._default_merger
        self.thoughts: Dict[str, ThoughtNode] = {}

    @staticmethod
    def _default_merger(a: str, b: str) -> Optional[str]:
        """Default merge operation: combine two thoughts."""
        if len(a) + len(b) > 1000:
            return f"Synthesis of: {a[:200]}... and {b[:200]}..."
        return f"Combined: [{a}] + [{b}]"

    def solve(self, problem: str) -> ReasoningResult:
        """Solve using graph of thoughts."""
        root = ThoughtNode(content=f"Problem: {problem}")
        self.thoughts["root"] = root

        # Generate initial thoughts
        initial = self.thought_generator(problem, 4)
        for i, t in enumerate(initial):
            node = ThoughtNode(content=t)
            root.add_child(node)
            self.thoughts[f"init_{i}"] = node

        # Merge compatible thoughts
        children = list(root.children)
        for i in range(len(children)):
            for j in range(i + 1, len(children)):
                merged = self.thought_merger(children[i].content, children[j].content)
                if merged is not None:
                    merge_node = ThoughtNode(content=merged)
                    children[i].add_child(merge_node)
                    children[j].add_child(merge_node)
                    self.thoughts[f"merge_{i}_{j}"] = merge_node

        # Collect all paths
        all_paths = []
        for node in self.thoughts.values():
            if node.children:
                path = node.path_to_root()
                all_paths.append(path)

        best = max(self.thoughts.values(), key=lambda n: len(n.content)) if self.thoughts else root

        return ReasoningResult(
            final_answer=best.content,
            reasoning_paths=all_paths,
            total_nodes=len(self.thoughts),
            method="graph_of_thoughts",
        )


class SelfConsistency:
    """Self-Consistency: multiple reasoning attempts, majority voting."""

    def __init__(
        self,
        reasoner: Optional[Callable[[str], str]] = None,
        num_paths: int = 5,
        temperature_range: Tuple[float, float] = (0.3, 1.0),
    ):
        self.reasoner = reasoner or (lambda q: f"Answer to: {q[:50]}...")
        self.num_paths = num_paths
        self.temperature_range = temperature_range

    def solve(self, problem: str) -> ReasoningResult:
        """Solve with self-consistency voting."""
        answers: List[str] = []
        paths: List[List[ThoughtNode]] = []

        for i in range(self.num_paths):
            answer = self.reasoner(problem)
            answers.append(answer)

            path = [
                ThoughtNode(content=f"Path {i+1} attempt"),
                ThoughtNode(content=answer, is_terminal=True),
            ]
            paths.append(path)

        # Vote (simple: longest common prefix)
        if not answers:
            return ReasoningResult(
                final_answer=problem,
                reasoning_paths=[],
                total_nodes=0,
                method="self_consistency",
            )

        # Use most common answer (by length-weighted frequency)
        from collections import Counter
        answer_counts = Counter(answers)
        most_common = answer_counts.most_common(1)[0][0]
        confidence = answer_counts.most_common(1)[0][1] / self.num_paths

        return ReasoningResult(
            final_answer=most_common,
            reasoning_paths=paths,
            total_nodes=len(answers),
            method="self_consistency",
            confidence=confidence,
        )


class Reflection:
    """Reflection: self-critique and iterative improvement."""

    def __init__(
        self,
        generator: Optional[Callable[[str], str]] = None,
        critic: Optional[Callable[[str, str], str]] = None,
        max_iterations: int = 3,
    ):
        self.generator = generator or (lambda q: f"Initial answer to: {q[:50]}...")
        self.critic = critic or self._default_critic
        self.max_iterations = max_iterations

    @staticmethod
    def _default_critic(question: str, answer: str) -> str:
        """Default critic: identify issues."""
        issues = []
        if len(answer) < 50:
            issues.append("Answer is too brief, needs more detail.")
        if "because" not in answer:
            issues.append("Missing reasoning chain.")
        if "example" not in answer.lower():
            issues.append("No concrete example provided.")
        return "\n".join(issues) if issues else "Answer looks good."

    def solve(self, problem: str) -> ReasoningResult:
        """Solve with iterative reflection."""
        current_answer = self.generator(problem)
        reflections: List[ThoughtNode] = [
            ThoughtNode(content=f"Initial: {current_answer}")
        ]

        for i in range(self.max_iterations):
            critique = self.critic(problem, current_answer)
            reflections.append(ThoughtNode(content=f"Critique {i+1}: {critique}"))

            # Generate improved answer
            improvement_prompt = f"{problem}\nPrevious: {current_answer}\nCritique: {critique}"
            improved = self.generator(improvement_prompt)
            current_answer = improved
            reflections.append(ThoughtNode(content=f"Improved {i+1}: {improved}"))

        return ReasoningResult(
            final_answer=current_answer,
            reasoning_paths=[[r for r in reflections]],
            total_nodes=len(reflections),
            method="reflection",
        )


class ReAct:
    """ReAct: Reasoning + Acting loop with tool use."""

    def __init__(
        self,
        tools: Optional[Dict[str, Callable[[str], str]]] = None,
        max_steps: int = 10,
    ):
        self.tools = tools or {
            "search": lambda q: f"Search results for: {q}",
            "calculate": lambda q: f"Calculated: {q}",
        }
        self.max_steps = max_steps
        self.rng = random.Random(42)

    def _parse_action(self, text: str) -> Optional[Tuple[str, str]]:
        """Parse action from text (Action: tool_name\nAction Input: ...)."""
        match = re.search(r'Action:\s*(\w+)\s*\nAction Input:\s*(.+)', text, re.DOTALL)
        if match:
            return match.group(1), match.group(2).strip()
        return None

    def solve(self, problem: str, reasoner: Optional[Callable[[str], str]] = None) -> ReasoningResult:
        """Solve with ReAct loop."""
        if reasoner is None:
            reasoner = lambda q: f"Thought: Let me analyze {q[:30]}...\nAction: search\nAction Input: {q}"

        trajectory: List[ThoughtNode] = [
            ThoughtNode(content=f"Question: {problem}")
        ]
        context = problem

        for step in range(self.max_steps):
            # Reason
            thought = reasoner(context)
            trajectory.append(ThoughtNode(content=thought))

            # Act
            action = self._parse_action(thought)
            if action is None:
                # Final answer
                trajectory.append(ThoughtNode(
                    content=f"Final: {thought}", is_terminal=True
                ))
                break

            tool_name, tool_input = action
            if tool_name in self.tools:
                observation = self.tools[tool_name](tool_input)
            else:
                observation = f"Tool '{tool_name}' not found"

            trajectory.append(ThoughtNode(content=f"Observation: {observation}"))
            context = f"{context}\n{thought}\nObservation: {observation}"

        return ReasoningResult(
            final_answer=trajectory[-1].content if trajectory else problem,
            reasoning_paths=[trajectory],
            total_nodes=len(trajectory),
            method="react",
        )


class MCTS:
    """Monte Carlo Tree Search for reasoning."""

    def __init__(
        self,
        simulator: Optional[Callable[[str], List[str]]] = None,
        evaluator: Optional[Callable[[str], float]] = None,
        num_simulations: int = 50,
        exploration_weight: float = 1.4,
        max_depth: int = 10,
    ):
        self.simulator = simulator or (lambda s: [f"Child {i}: {s[:30]}..." for i in range(3)])
        self.evaluator = evaluator or (lambda s: min(1.0, len(s) / 200.0))
        self.num_simulations = num_simulations
        self.exploration_weight = exploration_weight
        self.max_depth = max_depth

    def _uct_select(self, node: ThoughtNode) -> ThoughtNode:
        """Select child using UCT."""
        log_n = math.log(node.visits + 1.0)
        return max(
            node.children,
            key=lambda c: c.value / (c.visits + 1e-6)
            + self.exploration_weight * math.sqrt(2.0 * log_n / (c.visits + 1e-6)),
        )

    def _simulate(self, node: ThoughtNode) -> float:
        """Simulate a random rollout from a node."""
        current = node
        depth = 0
        while not current.is_terminal and depth < self.max_depth:
            candidates = self.simulator(current.content)
            if candidates:
                next_content = random.choice(candidates)
                child = ThoughtNode(content=next_content)
                current.add_child(child)
                current = child
            else:
                break
            depth += 1

        return self.evaluator(current.content)

    def solve(self, problem: str) -> ReasoningResult:
        """Solve using MCTS."""
        root = ThoughtNode(content=problem)

        for _ in range(self.num_simulations):
            node = root

            # Selection
            while node.children and not node.is_terminal:
                node = self._uct_select(node)

            # Expansion
            if not node.is_terminal and node.depth < self.max_depth:
                candidates = self.simulator(node.content)
                for cand in candidates:
                    child = ThoughtNode(content=cand)
                    node.add_child(child)

            # Simulation
            reward = self._simulate(node)

            # Backpropagation
            while node is not None:
                node.visits += 1
                node.value += reward
                node = node.parent

        # Select best path
        best_path: List[ThoughtNode] = []
        node = root
        while node.children:
            best_child = max(node.children, key=lambda c: c.visits)
            best_path.append(best_child)
            node = best_child

        final_answer = best_path[-1].content if best_path else problem

        return ReasoningResult(
            final_answer=final_answer,
            reasoning_paths=[best_path],
            total_nodes=root.visits,
            method="mcts",
            confidence=root.value / max(1, root.visits),
        )


class SearchAugmentedReasoning:
    """Search-Augmented Reasoning: interleave search and reasoning."""

    def __init__(
        self,
        search_engine: Optional[Callable[[str], List[str]]] = None,
        reasoner: Optional[Callable[[str], str]] = None,
        max_search_rounds: int = 3,
    ):
        self.search_engine = search_engine or (lambda q: [f"Result {i}: Information about {q[:20]}..." for i in range(3)])
        self.reasoner = reasoner or (lambda ctx: f"Reasoned conclusion from: {ctx[:50]}...")
        self.max_search_rounds = max_search_rounds

    def solve(self, problem: str) -> ReasoningResult:
        """Solve with search-augmented reasoning."""
        context = problem
        all_results: List[ThoughtNode] = [ThoughtNode(content=f"Problem: {problem}")]

        for round_idx in range(self.max_search_rounds):
            # Search
            search_results = self.search_engine(context)
            for i, result in enumerate(search_results):
                all_results.append(
                    ThoughtNode(content=f"Search {round_idx}.{i}: {result}")
                )

            # Augment context with search results
            search_context = "\n".join(search_results[:3])
            context = f"{context}\n\nSearch findings:\n{search_context}"

            # Reason
            conclusion = self.reasoner(context)
            all_results.append(
                ThoughtNode(content=f"Reasoning {round_idx}: {conclusion}")
            )

            # Check if answer is sufficient
            if len(conclusion) > 50 and "insufficient" not in conclusion.lower():
                break

        final_answer = all_results[-1].content if all_results else problem

        return ReasoningResult(
            final_answer=final_answer,
            reasoning_paths=[all_results],
            total_nodes=len(all_results),
            method="search_augmented_reasoning",
        )
