"""MCTS — Monte Carlo Tree Search for Tree of Thoughts reasoning."""
from __future__ import annotations
import math, random, uuid
from dataclasses import dataclass, field
from typing import Callable, Optional

_EXPAND_STRATEGIES = [
    "Break this into smaller sub-problems and solve one step.",
    "Consider an edge case or boundary condition.",
    "Apply an analogy from a different domain.",
    "Question an assumption and see what changes.",
    "Try the simplest possible version of the problem.",
    "Work backwards from the desired output.",
    "Consider what information is missing.",
    "Try a completely different approach.",
    "Verify correctness of the current reasoning.",
    "Add more detail and specificity to the solution.",
]


@dataclass
class MCTSNode:
    id: str
    thought: str
    parent_id: Optional[str] = None
    children_ids: list[str] = field(default_factory=list)
    visits: int = 0
    total_value: float = 0.0
    depth: int = 0
    is_terminal: bool = False
    is_expanded: bool = False
    reasoning_path: list[str] = field(default_factory=list)

    @property
    def avg_value(self) -> float:
        return self.total_value / max(self.visits, 1)

    def ucb1(self, parent_visits: int, c: float = 1.414) -> float:
        if self.visits == 0:
            return float("inf")
        exploit = self.avg_value
        explore = c * math.sqrt(math.log(parent_visits + 1) / self.visits)
        return exploit + explore


@dataclass
class MCTSConfig:
    max_iterations: int = 50
    max_depth: int = 4
    exploration_constant: float = 1.414
    min_visits_to_expand: int = 1
    beam_width: int = 5
    pruning_threshold: float = 0.15


@dataclass
class MCTSResult:
    best_path: list[str]
    best_value: float
    total_nodes: int
    pruned_nodes: int
    iterations_used: int
    reasoning_tree: dict = field(default_factory=dict)


class MCTSSearch:
    def __init__(self, config: MCTSConfig | None = None):
        self.cfg   = config or MCTSConfig()
        self.nodes: dict[str, MCTSNode] = {}

    # ---- public ---------------------------------------------------------
    def search(self, task: str, context: str,
               eval_fn: Callable[[str, str], float] | None = None,
               expand_fn: Callable[[str, str], list[str]] | None = None) -> MCTSResult:
        self.nodes.clear()
        eval_fn   = eval_fn   or self._default_eval
        expand_fn = expand_fn or self._default_expand

        root = MCTSNode(id=str(uuid.uuid4())[:8], thought=f"ROOT: {task[:100]}",
                        depth=0, reasoning_path=[task[:100]])
        self.nodes[root.id] = root
        pruned = 0

        for it in range(self.cfg.max_iterations):
            # Select
            node_id = self._select(root.id)
            node    = self.nodes[node_id]

            # Expand
            if not node.is_terminal and node.visits >= self.cfg.min_visits_to_expand:
                children = self._expand(node_id, task, context, expand_fn)
                if children:
                    node.is_expanded = True
                    node_id = random.choice(children)
                    node    = self.nodes[node_id]

            # Simulate
            value = self._simulate(node_id, task, eval_fn)

            # Backpropagate
            self._backpropagate(node_id, value)

            # Prune every 10 iterations
            if it % 10 == 9:
                pruned += self._prune_low_value_nodes(self.cfg.pruning_threshold)

        return MCTSResult(
            best_path=self.get_best_path(),
            best_value=self._best_leaf_value(),
            total_nodes=len(self.nodes),
            pruned_nodes=pruned,
            iterations_used=min(self.cfg.max_iterations, it + 1),
            reasoning_tree=self.to_tree_dict(),
        )

    # ---- MCTS steps -----------------------------------------------------
    def _select(self, root_id: str) -> str:
        node_id = root_id
        while True:
            node = self.nodes[node_id]
            if not node.children_ids or node.is_terminal:
                return node_id
            best_child = max(
                node.children_ids,
                key=lambda cid: self.nodes[cid].ucb1(
                    node.visits, self.cfg.exploration_constant)
                if cid in self.nodes else -1
            )
            if best_child not in self.nodes:
                return node_id
            node_id = best_child

    def _expand(self, node_id: str, task: str, context: str,
                expand_fn: Callable) -> list[str]:
        node = self.nodes[node_id]
        if node.depth >= self.cfg.max_depth:
            node.is_terminal = True
            return []
        new_thoughts = expand_fn(node.thought, task)
        child_ids = []
        for thought in new_thoughts[:self.cfg.beam_width]:
            cid  = str(uuid.uuid4())[:8]
            path = node.reasoning_path + [thought]
            child = MCTSNode(id=cid, thought=thought, parent_id=node_id,
                             depth=node.depth + 1, reasoning_path=path,
                             is_terminal=(node.depth + 1 >= self.cfg.max_depth))
            self.nodes[cid] = child
            node.children_ids.append(cid)
            child_ids.append(cid)
        return child_ids

    def _simulate(self, node_id: str, task: str,
                  eval_fn: Callable[[str, str], float]) -> float:
        node = self.nodes[node_id]
        return eval_fn(" ".join(node.reasoning_path), task)

    def _backpropagate(self, node_id: str, value: float):
        nid: Optional[str] = node_id
        while nid is not None:
            n = self.nodes.get(nid)
            if n is None:
                break
            n.visits      += 1
            n.total_value += value
            nid = n.parent_id

    def _prune_low_value_nodes(self, threshold: float) -> int:
        to_remove = [
            nid for nid, n in self.nodes.items()
            if n.visits > 0 and n.avg_value < threshold and n.parent_id is not None
        ]
        for nid in to_remove:
            parent_id = self.nodes[nid].parent_id
            if parent_id and parent_id in self.nodes:
                p = self.nodes[parent_id]
                if nid in p.children_ids:
                    p.children_ids.remove(nid)
            del self.nodes[nid]
        return len(to_remove)

    # ---- helpers --------------------------------------------------------
    def get_best_path(self) -> list[str]:
        leaves = [n for n in self.nodes.values() if not n.children_ids]
        if not leaves:
            return []
        best = max(leaves, key=lambda n: n.avg_value)
        return best.reasoning_path

    def _best_leaf_value(self) -> float:
        leaves = [n for n in self.nodes.values() if not n.children_ids]
        return max((n.avg_value for n in leaves), default=0.0)

    def to_tree_dict(self) -> dict:
        return {nid: {"thought": n.thought[:80], "visits": n.visits,
                      "avg_value": round(n.avg_value, 3), "depth": n.depth,
                      "children": n.children_ids}
                for nid, n in self.nodes.items()}

    # ---- defaults -------------------------------------------------------
    def _default_expand(self, current_thought: str, task: str) -> list[str]:
        return [f"{s} [Context: {current_thought[:60]}]"
                for s in random.sample(_EXPAND_STRATEGIES, min(4, len(_EXPAND_STRATEGIES)))]

    def _default_eval(self, path: str, task: str) -> float:
        import re
        score = 0.0
        task_tokens = set(re.sub(r"[^\w]", " ", task.lower()).split())
        path_tokens = set(re.sub(r"[^\w]", " ", path.lower()).split())
        overlap = len(task_tokens & path_tokens) / max(len(task_tokens), 1)
        score += overlap * 0.4
        positive = len(re.findall(r"\b(answer|solution|result|conclusion|therefore)\b", path, re.I))
        score += min(positive * 0.1, 0.3)
        depth_bonus = min(path.count("[Context:") * 0.05, 0.3)
        score += depth_bonus
        return min(score, 1.0)
