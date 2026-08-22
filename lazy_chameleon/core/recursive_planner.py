"""RecursivePlanner — Hierarchical DAG planner. Planners spawn planners."""
from __future__ import annotations
import re, uuid
from dataclasses import dataclass, field
from typing import Callable, Optional


@dataclass
class PlanNode:
    id: str
    task: str
    node_type: str      # planner / expert / merge
    dependencies: list[str] = field(default_factory=list)
    outputs: list[str] = field(default_factory=list)
    status: str = "pending"   # pending / running / done / failed
    result: str = ""
    depth: int = 0
    estimated_cost: int = 5


@dataclass
class ExecutionPlan:
    nodes: dict[str, PlanNode]
    root_id: str
    total_estimated_cost: int = 0
    critical_path: list[str] = field(default_factory=list)


class RecursivePlanner:
    def __init__(self, max_depth: int = 3, max_nodes: int = 24):
        self._max_depth = max_depth
        self._max_nodes = max_nodes

    def plan(self, task: str, context: str = "") -> ExecutionPlan:
        nodes: dict[str, PlanNode] = {}
        root_id = self._make_node(nodes, task, "planner", depth=0)
        self._recurse(nodes, root_id, task, depth=0)
        plan = ExecutionPlan(nodes=nodes, root_id=root_id,
                             total_estimated_cost=sum(n.estimated_cost for n in nodes.values()))
        plan.critical_path = self._find_critical_path(plan)
        return plan

    def _make_node(self, nodes: dict, task: str, ntype: str,
                   depth: int, deps: list[str] | None = None) -> str:
        nid  = str(uuid.uuid4())[:8]
        node = PlanNode(id=nid, task=task, node_type=ntype,
                        dependencies=deps or [], depth=depth,
                        estimated_cost=self._estimate_cost(task, ntype))
        nodes[nid] = node
        return nid

    def _recurse(self, nodes: dict, parent_id: str, task: str, depth: int):
        if depth >= self._max_depth or len(nodes) >= self._max_nodes:
            return
        subtasks = self._decompose_task(task, depth)
        if not subtasks:
            return
        child_ids = []
        for st in subtasks:
            cid = self._make_node(nodes, st, "expert", depth=depth + 1)
            child_ids.append(cid)
            # light recursion on complex subtasks
            if depth + 1 < self._max_depth and self._is_complex(st):
                self._recurse(nodes, cid, st, depth + 1)
        # merge node collects all children
        if len(child_ids) > 1:
            merge_id = self._make_node(nodes, f"Merge: {task[:50]}", "merge",
                                        depth=depth + 1, deps=child_ids)
            nodes[parent_id].outputs.append(merge_id)
        else:
            nodes[parent_id].outputs.extend(child_ids)

    def _decompose_task(self, task: str, depth: int) -> list[str]:
        task_low = task.lower()
        # Heuristic decomposition based on task structure
        if "and" in task_low and depth == 0:
            parts = re.split(r"\band\b", task, maxsplit=2, flags=re.I)
            return [p.strip() for p in parts if p.strip()][:3]
        if any(k in task_low for k in ("implement", "build", "create", "develop")):
            return [f"Design approach for: {task[:60]}",
                    f"Implement core logic for: {task[:60]}",
                    f"Test and validate: {task[:60]}"]
        if any(k in task_low for k in ("analyze", "analyse", "research", "investigate")):
            return [f"Gather information about: {task[:60]}",
                    f"Identify patterns in: {task[:60]}",
                    f"Synthesise findings for: {task[:60]}"]
        if any(k in task_low for k in ("debug", "fix", "solve", "diagnose")):
            return [f"Reproduce and understand: {task[:60]}",
                    f"Identify root cause of: {task[:60]}",
                    f"Apply fix for: {task[:60]}"]
        if depth == 0:
            return [f"Plan approach: {task[:60]}",
                    f"Execute: {task[:60]}",
                    f"Verify result: {task[:60]}"]
        return []

    def _is_complex(self, task: str) -> bool:
        complexity_words = ["implement", "design", "analyze", "build", "research",
                            "optimize", "refactor", "migrate", "integrate"]
        return any(w in task.lower() for w in complexity_words)

    def _estimate_cost(self, task: str, ntype: str) -> int:
        base = {"planner": 3, "expert": 5, "merge": 2}.get(ntype, 5)
        length_bonus = min(len(task) // 50, 5)
        return base + length_bonus

    def _topological_sort(self, nodes: dict[str, PlanNode]) -> list[str]:
        in_degree: dict[str, int] = {nid: 0 for nid in nodes}
        children: dict[str, list[str]] = {nid: [] for nid in nodes}
        for nid, n in nodes.items():
            for dep in n.dependencies:
                if dep in nodes:
                    in_degree[nid] += 1
                    children[dep].append(nid)
        queue = [nid for nid, deg in in_degree.items() if deg == 0]
        order: list[str] = []
        while queue:
            nid = queue.pop(0)
            order.append(nid)
            for child in children.get(nid, []):
                in_degree[child] -= 1
                if in_degree[child] == 0:
                    queue.append(child)
        return order

    def _find_critical_path(self, plan: ExecutionPlan) -> list[str]:
        order = self._topological_sort(plan.nodes)
        dist: dict[str, int] = {nid: 0 for nid in plan.nodes}
        prev: dict[str, Optional[str]] = {nid: None for nid in plan.nodes}
        for nid in order:
            n    = plan.nodes[nid]
            cost = dist[nid] + n.estimated_cost
            for child in n.outputs:
                if child in dist and cost > dist[child]:
                    dist[child] = cost
                    prev[child] = nid
        if not dist:
            return []
        end = max(dist, key=lambda k: dist[k])
        path: list[str] = []
        cur: Optional[str] = end
        while cur is not None:
            path.append(cur)
            cur = prev[cur]
        return list(reversed(path))

    def execute_plan(self, plan: ExecutionPlan,
                     executor_fn: Callable[[str, str], str]) -> dict[str, str]:
        order   = self._topological_sort(plan.nodes)
        results: dict[str, str] = {}
        for nid in order:
            node = plan.nodes[nid]
            dep_context = "\n".join(
                f"[{plan.nodes[d].task[:40]}]: {results.get(d, '')[:200]}"
                for d in node.dependencies if d in results
            )
            node.status = "running"
            try:
                result = executor_fn(node.task, dep_context)
                node.result = result
                node.status = "done"
                results[nid] = result
            except Exception as e:
                node.result = f"ERROR: {e}"
                node.status = "failed"
                results[nid] = node.result
        return results

    def visualize_plan(self, plan: ExecutionPlan) -> str:
        lines = ["=== EXECUTION PLAN ==="]
        def _render(nid: str, indent: int):
            if nid not in plan.nodes:
                return
            n = plan.nodes[nid]
            prefix = "  " * indent
            icon   = {"planner": "📋", "expert": "🔧", "merge": "🔀"}.get(n.node_type, "•")
            lines.append(f"{prefix}{icon} [{n.node_type}] {n.task[:60]} (cost={n.estimated_cost})")
            for child in n.outputs:
                _render(child, indent + 1)
        _render(plan.root_id, 0)
        lines.append(f"\nCritical path: {' → '.join(plan.critical_path[:6])}")
        lines.append(f"Total cost: {plan.total_estimated_cost}")
        return "\n".join(lines)
