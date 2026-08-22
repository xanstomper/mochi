"""Expert spawning, splitting, merging, and evolution for MoE architectures."""
from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set, Tuple

import numpy as np


@dataclass
class ExpertRoutingTable:
    """Routing table that maps tokens/tasks to experts."""
    expert_ids: List[int]
    routing_weights: np.ndarray  # [num_experts, num_tokens] or [num_experts]
    capacity_factor: float = 1.25

    def route(self, token_ids: np.ndarray) -> Dict[int, np.ndarray]:
        """Route token IDs to expert assignments.
        
        Returns mapping from expert_id -> assigned token indices.
        """
        if self.routing_weights.ndim == 1:
            weights = self.routing_weights[:, np.newaxis] * np.ones(len(token_ids))
        else:
            weights = self.routing_weights

        # Top-1 routing
        expert_assignments: Dict[int, np.ndarray] = {}
        for i, eid in enumerate(self.expert_ids):
            expert_assignments[eid] = np.array([], dtype=int)

        token_weights = weights[:len(self.expert_ids), :len(token_ids)]
        if token_weights.size > 0:
            best_experts = np.argmax(token_weights, axis=0)
            for tok_idx, exp_idx in enumerate(best_experts):
                eid = self.expert_ids[int(exp_idx)]
                current = expert_assignments.get(eid, np.array([], dtype=int))
                capacity = max(1, int(len(token_ids) * self.capacity_factor / len(self.expert_ids)))
                if len(current) < capacity:
                    expert_assignments[eid] = np.append(current, tok_idx)

        return expert_assignments


@dataclass
class ExpertPool:
    """A pool of experts with their parameters and gate."""
    expert_params: List[Dict[str, np.ndarray]]  # List of expert weight dicts
    gate_weights: Optional[np.ndarray] = None   # [num_experts, hidden_dim]
    expert_ids: List[int] = field(default_factory=list)
    routing_table: Optional[ExpertRoutingTable] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.expert_ids:
            self.expert_ids = list(range(len(self.expert_params)))
        if self.routing_table is None and self.gate_weights is not None:
            n_exp = len(self.expert_params)
            n_tokens = self.gate_weights.shape[0] if self.gate_weights.ndim > 1 else 1
            self.routing_table = ExpertRoutingTable(
                expert_ids=list(self.expert_ids),
                routing_weights=self.gate_weights[:n_exp] if self.gate_weights.ndim > 1
                else self.gate_weights,
            )

    def get_expert(self, expert_id: int) -> Optional[Dict[str, np.ndarray]]:
        """Get parameters for a specific expert by ID."""
        for i, eid in enumerate(self.expert_ids):
            if eid == expert_id:
                return self.expert_params[i]
        return None

    def update_weights(self, new_params: np.ndarray) -> None:
        """Update gate weights."""
        self.gate_weights = new_params
        if self.routing_table is not None:
            n_exp = len(self.expert_params)
            if self.gate_weights.ndim > 1:
                self.routing_table.routing_weights = self.gate_weights[:n_exp]
            else:
                self.routing_table.routing_weights = self.gate_weights

    def num_experts(self) -> int:
        return len(self.expert_params)


class ExpertSpawner:
    """Handles expert creation, splitting, merging, and evolution."""

    def __init__(self, pool: Optional[ExpertPool] = None, num_experts: int = 8, seed: int = 42):
        if pool is None:
            import numpy as np
            dummy = [{"w": np.random.randn(64, 64)} for _ in range(num_experts)]
            pool = ExpertPool(expert_params=dummy, expert_ids=list(range(num_experts)))
        self.pool = pool
        self.rng = np.random.default_rng(seed)
        self.next_id = max(pool.expert_ids) + 1 if pool.expert_ids else 0

    def spawn_expert(
        self,
        parent_ids: List[int],
        crossover_type: str = "weighted_average",
        mutation_rate: float = 0.05,
        mutation_scale: float = 0.01,
    ) -> int:
        """Create a new expert from existing ones via crossover."""
        parent_params = [self.pool.get_expert(pid) for pid in parent_ids]
        parent_params = [p for p in parent_params if p is not None]
        if len(parent_params) < 2:
            raise ValueError(f"Need at least 2 valid parent experts, got {len(parent_params)}")

        new_params: Dict[str, np.ndarray] = {}
        keys = list(parent_params[0].keys())

        for key in keys:
            stacked = np.stack([p[key].astype(np.float64) for p in parent_params], axis=0)

            if crossover_type == "weighted_average":
                weights = self.rng.dirichlet(np.ones(len(parent_params)))
                result = np.tensordot(weights, stacked, axes=1)
            elif crossover_type == "uniform":
                idx = self.rng.integers(0, len(parent_params), size=stacked.shape[1:])
                result = np.zeros_like(stacked[0])
                for i in range(len(parent_params)):
                    mask = (idx == i)
                    result[mask] = stacked[i][mask]
            elif crossover_type == "interpolate":
                alpha = self.rng.uniform(0.0, 1.0)
                result = (1.0 - alpha) * stacked[0] + alpha * stacked[1]
            else:
                raise ValueError(f"Unknown crossover type: {crossover_type}")

            # Apply mutation
            if mutation_rate > 0:
                mutation_mask = self.rng.random(result.shape) < mutation_rate
                noise = self.rng.normal(0.0, mutation_scale, result.shape)
                result = result + noise * mutation_mask

            new_params[key] = result.astype(parent_params[0][key].dtype)

        new_id = self.next_id
        self.next_id += 1
        self.pool.expert_params.append(new_params)
        self.pool.expert_ids.append(new_id)

        # Update routing table
        if self.pool.routing_table is not None:
            old_size = len(self.pool.expert_ids) - 1
            new_routing = self.rng.random(len(self.pool.expert_ids))
            self.pool.routing_table.expert_ids = list(self.pool.expert_ids)
            self.pool.routing_table.routing_weights = new_routing

        return new_id

    def split_expert(
        self,
        expert_id: int,
        num_splits: int = 2,
        split_strategy: str = "random_slice",
    ) -> List[int]:
        """Split an expert into specialized sub-experts."""
        params = self.pool.get_expert(expert_id)
        if params is None:
            raise ValueError(f"Expert {expert_id} not found")

        new_ids: List[int] = []

        for i in range(num_splits):
            new_params: Dict[str, np.ndarray] = {}
            for key, val in params.items():
                arr = val.astype(np.float64)
                if split_strategy == "random_slice":
                    # Split features randomly
                    if arr.ndim >= 2:
                        half = arr.shape[0] // num_splits
                        start = i * half
                        end = (i + 1) * half if i < num_splits - 1 else arr.shape[0]
                        split_arr = np.zeros_like(arr)
                        split_arr[start:end] = arr[start:end]
                        # Add small noise
                        split_arr += self.rng.normal(0.0, 0.001, split_arr.shape)
                    else:
                        split_arr = arr + self.rng.normal(0.0, 0.001, arr.shape)
                elif split_strategy == "noise_perturbation":
                    split_arr = arr + self.rng.normal(0.0, 0.02, arr.shape)
                elif split_strategy == "half_magnitude":
                    # Keep half the weights with larger magnitude
                    if arr.ndim >= 2:
                        magnitudes = np.abs(arr).mean(axis=tuple(range(1, arr.ndim)))
                        threshold = np.percentile(magnitudes, 100 * (i + 0.5) / num_splits)
                        mask = magnitudes >= threshold
                        if mask.ndim > 0 and mask.any():
                            split_arr = arr.copy()
                            split_arr[~mask] = 0.0
                        else:
                            split_arr = arr / num_splits
                    else:
                        split_arr = arr / num_splits
                else:
                    split_arr = arr / num_splits

                new_params[key] = split_arr.astype(val.dtype)

            new_id = self.next_id
            self.next_id += 1
            self.pool.expert_params.append(new_params)
            self.pool.expert_ids.append(new_id)
            new_ids.append(new_id)

        # Update routing table
        if self.pool.routing_table is not None:
            new_routing = self.rng.random(len(self.pool.expert_ids))
            self.pool.routing_table.expert_ids = list(self.pool.expert_ids)
            self.pool.routing_table.routing_weights = new_routing

        return new_ids

    def merge_experts(
        self,
        expert_ids: List[int],
        merge_method: str = "average",
        keep_originals: bool = False,
    ) -> int:
        """Merge redundant experts into one."""
        params_list = [self.pool.get_expert(eid) for eid in expert_ids]
        params_list = [p for p in params_list if p is not None]
        if len(params_list) < 2:
            raise ValueError(f"Need at least 2 valid experts, got {len(params_list)}")

        merged: Dict[str, np.ndarray] = {}
        keys = list(params_list[0].keys())

        for key in keys:
            stacked = np.stack([p[key].astype(np.float64) for p in params_list], axis=0)

            if merge_method == "average":
                result = np.mean(stacked, axis=0)
            elif merge_method == "median":
                result = np.median(stacked, axis=0)
            elif merge_method == "weighted_by_norm":
                norms = np.array([np.linalg.norm(p[key].ravel()) for p in params_list])
                norms = norms / (norms.sum() + 1e-12)
                result = np.tensordot(norms, stacked, axes=1)
            else:
                raise ValueError(f"Unknown merge method: {merge_method}")

            merged[key] = result.astype(params_list[0][key].dtype)

        new_id = self.next_id
        self.next_id += 1

        if not keep_originals:
            # Remove originals
            indices_to_remove = [
                i for i, eid in enumerate(self.pool.expert_ids)
                if eid in expert_ids
            ]
            for idx in sorted(indices_to_remove, reverse=True):
                self.pool.expert_params.pop(idx)
                self.pool.expert_ids.pop(idx)

        self.pool.expert_params.append(merged)
        self.pool.expert_ids.append(new_id)

        if self.pool.routing_table is not None:
            new_routing = self.rng.random(len(self.pool.expert_ids))
            self.pool.routing_table.expert_ids = list(self.pool.expert_ids)
            self.pool.routing_table.routing_weights = new_routing

        return new_id

    def evolve_pool(
        self,
        fitness_scores: Dict[int, float],
        elite_fraction: float = 0.3,
        mutation_rate: float = 0.1,
        crossover_rate: float = 0.5,
    ) -> ExpertPool:
        """Evolution-style expert pool optimization.
        
        Select top experts based on fitness, perform crossover/mutation.
        """
        n = len(self.pool.expert_ids)
        if n < 3:
            raise ValueError("Pool needs at least 3 experts for evolution")

        # Sort by fitness
        sorted_ids = sorted(
            self.pool.expert_ids,
            key=lambda eid: fitness_scores.get(eid, 0.0),
            reverse=True,
        )

        n_elite = max(1, int(n * elite_fraction))
        elite_ids = sorted_ids[:n_elite]
        non_elite_ids = sorted_ids[n_elite:]

        new_expert_params: List[Dict[str, np.ndarray]] = []
        new_expert_ids: List[int] = []
        new_gate_weights = self.rng.random(len(elite_ids) + len(non_elite_ids))

        # Keep elites
        for eid in elite_ids:
            params = self.pool.get_expert(eid)
            if params is not None:
                new_expert_params.append(dict(params))
                new_expert_ids.append(eid)

        # Replace non-elites with crossover/mutation
        for eid in non_elite_ids:
            if self.rng.random() < crossover_rate and len(elite_ids) >= 2:
                p1_id = self.rng.choice(elite_ids)
                p2_id = self.rng.choice([e for e in elite_ids if e != p1_id])
                p1 = self.pool.get_expert(p1_id)
                p2 = self.pool.get_expert(p2_id)
                if p1 is not None and p2 is not None:
                    child: Dict[str, np.ndarray] = {}
                    for key in p1:
                        alpha = self.rng.uniform(0.0, 1.0)
                        child[key] = (
                            alpha * p1[key].astype(np.float64)
                            + (1.0 - alpha) * p2[key].astype(np.float64)
                        ).astype(p1[key].dtype)
                    new_expert_params.append(child)
                    new_expert_ids.append(self.next_id)
                    self.next_id += 1
                    continue

            # Mutate an elite
            parent_id = self.rng.choice(elite_ids)
            parent = self.pool.get_expert(parent_id)
            if parent is not None:
                mutant: Dict[str, np.ndarray] = {}
                for key, val in parent.items():
                    noise = self.rng.normal(0.0, mutation_rate, val.shape)
                    mutant[key] = (val.astype(np.float64) + noise).astype(val.dtype)
                new_expert_params.append(mutant)
                new_expert_ids.append(self.next_id)
                self.next_id += 1

        # Rebuild pool
        self.pool.expert_params = new_expert_params
        self.pool.expert_ids = new_expert_ids
        self.pool.gate_weights = new_gate_weights
        self.pool.routing_table = ExpertRoutingTable(
            expert_ids=list(new_expert_ids),
            routing_weights=new_gate_weights,
        )

        return self.pool


def spawn_expert(
    pool: ExpertPool,
    parent_ids: List[int],
    crossover_type: str = "weighted_average",
    mutation_rate: float = 0.05,
) -> int:
    """Convenience function to spawn an expert."""
    spawner = ExpertSpawner(pool)
    return spawner.spawn_expert(parent_ids, crossover_type, mutation_rate)


def split_expert(
    pool: ExpertPool,
    expert_id: int,
    num_splits: int = 2,
) -> List[int]:
    """Convenience function to split an expert."""
    spawner = ExpertSpawner(pool)
    return spawner.split_expert(expert_id, num_splits)


def merge_experts(
    pool: ExpertPool,
    expert_ids: List[int],
    merge_method: str = "average",
) -> int:
    """Convenience function to merge experts."""
    spawner = ExpertSpawner(pool)
    return spawner.merge_experts(expert_ids, merge_method)


def evolve_pool(
    pool: ExpertPool,
    fitness_scores: Dict[int, float],
    elite_fraction: float = 0.3,
) -> ExpertPool:
    """Convenience function to evolve expert pool."""
    spawner = ExpertSpawner(pool)
    return spawner.evolve_pool(fitness_scores, elite_fraction)
