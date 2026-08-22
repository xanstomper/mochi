"""MoEManipulator — Complete MoE manipulation system."""
from __future__ import annotations
from typing import Any, Callable, Dict, List, Optional, Tuple
import numpy as np
import random


class MoEManipulator:
    """Complete MoE manipulation system to maximize performance.
    
    Techniques from frontier research:
    1. Dynamic Expert Allocation: Allocate compute based on input complexity
    2. Fine-Grained Expert Splitting: Split overloaded experts into specialized sub-experts
    3. Auxiliary-Loss-Free Balancing: Use bias terms instead of auxiliary loss
    4. Shared Expert Isolation: Dedicate experts to universal knowledge
    5. GRPO-based Expert Training: Train experts with group relative rewards
    6. Speculative Expert Routing: Predict which experts will be needed
    7. Expert Merging: Merge redundant experts
    8. Progressive Sparsification: Gradually increase sparsity during training
    9. Heterogeneous Expert Sizes: Different sized experts for different tasks
    10. Recursive Expert Refinement: Experts can spawn sub-experts for complex tasks
    """
    
    def __init__(self, num_experts: int = 64, hidden_dim: int = 7168):
        self.num_experts = num_experts
        self.hidden_dim = hidden_dim
        self._expert_load: Dict[int, float] = {}
        self._bias_terms: Dict[int, float] = {}
        self._expert_specializations: Dict[int, str] = {}
        self._merge_history: List[Dict] = []
        self._split_history: List[Dict] = []
        
    def dynamic_expert_allocation(self, input_complexity: float) -> Dict[str, Any]:
        """Allocate experts dynamically based on input complexity.
        
        Simple input: 2-4 experts
        Complex input: 8-16 experts
        """
        base_allocation = int(4 * input_complexity)
        num_active = max(2, min(self.num_experts, base_allocation))
        return {
            "num_active": num_active,
            "allocation_ratio": round(num_active / self.num_experts, 3),
            "compute_efficiency": round(1.0 / (num_active / 8), 2),
        }
    
    def fine_grained_split(self, expert_id: int, specialization_domains: List[str]) -> Dict[str, Any]:
        """Split an overloaded expert into specialized sub-experts.
        
        Like DeepSeekMoE: each expert is smaller and more specialized.
        """
        num_children = len(specialization_domains)
        children = []
        for i, domain in enumerate(specialization_domains):
            child_id = self.num_experts + i
            children.append({
                "child_id": child_id,
                "parent": expert_id,
                "domain": domain,
                "size_ratio": round(1.0 / num_children, 3),
                "is_active": True,
            })
            self._expert_specializations[child_id] = domain
        record = {"parent": expert_id, "children": children, "num_children": num_children}
        self._split_history.append(record)
        self.num_experts += num_children
        return record
    
    def auxiliary_free_balance(self, expert_usage: Dict[int, float]) -> Dict[int, float]:
        """Auxiliary-loss-free load balancing using bias terms.
        
        From DeepSeek-V3: adjust bias terms instead of adding auxiliary loss.
        """
        for eid in range(self.num_experts):
            current_usage = expert_usage.get(eid, 0.0)
            target = 1.0 / self.num_experts
            if current_usage > target * 1.2:
                self._bias_terms[eid] = self._bias_terms.get(eid, 0.0) - 0.001
            elif current_usage < target * 0.8:
                self._bias_terms[eid] = self._bias_terms.get(eid, 0.0) + 0.001
        return dict(self._bias_terms)
    
    def shared_expert_isolation(self, num_shared: int = 2) -> Dict[str, Any]:
        """Isolate experts for universal/shared knowledge.
        
        From DeepSeekMoE: dedicated shared experts handle general knowledge.
        """
        shared_ids = list(range(num_shared))
        return {
            "shared_experts": shared_ids,
            "num_shared": num_shared,
            "purpose": "Universal knowledge (syntax, common facts, reasoning primitives)",
            "routed_experts": list(range(num_shared, self.num_experts)),
        }
    
    def speculative_routing(self, input_embedding: np.ndarray, expert_centroids: np.ndarray) -> np.ndarray:
        """Predict which experts will be needed before full computation.
        
        Uses approximate embedding match to pre-activate relevant experts.
        """
        scores = np.dot(input_embedding, expert_centroids.T)
        scores += np.array([self._bias_terms.get(i, 0.0) for i in range(expert_centroids.shape[0])])
        return np.argsort(-scores)
    
    def merge_redundant_experts(self, expert_weights: Dict[int, np.ndarray], similarity_threshold: float = 0.9) -> Dict[str, Any]:
        """Merge experts that have become redundant (similar specialization)."""
        expert_list = list(expert_weights.keys())
        merges = []
        merged_out = set()
        for i in range(len(expert_list)):
            if expert_list[i] in merged_out:
                continue
            for j in range(i + 1, len(expert_list)):
                if expert_list[j] in merged_out:
                    continue
                w_i = expert_weights[expert_list[i]].flatten()
                w_j = expert_weights[expert_list[j]].flatten()
                cos_sim = np.dot(w_i, w_j) / (np.linalg.norm(w_i) * np.linalg.norm(w_j) + 1e-10)
                if cos_sim > similarity_threshold:
                    merges.append({"keep": expert_list[i], "merge": expert_list[j], "similarity": round(float(cos_sim), 4)})
                    merged_out.add(expert_list[j])
        record = {"merges": merges, "num_merged": len(merges), "remaining": len(expert_list) - len(merged_out)}
        self._merge_history.append(record)
        return record
    
    def grpo_expert_update(self, expert_weights: np.ndarray, responses: List[np.ndarray], rewards: List[float]) -> np.ndarray:
        """Train expert with Group Relative Policy Optimization (GRPO).
        
        From DeepSeek-R1: generate group of responses, compute relative advantages.
        """
        rewards_arr = np.array(rewards)
        advantages = (rewards_arr - rewards_arr.mean()) / (rewards_arr.std() + 1e-10)
        update = np.zeros_like(expert_weights)
        for i, response in enumerate(responses):
            update += advantages[i] * response
        update /= max(len(responses), 1)
        return expert_weights + 0.01 * update  # Small step
    
    def progressive_sparsify(self, step: int, total_steps: int, current_capacity: float) -> float:
        """Gradually reduce expert capacity during training.
        
        From Nucleus-Image: start with high capacity (2.0), end with low (0.5).
        """
        progress = min(1.0, step / total_steps)
        new_capacity = 2.0 - 1.5 * progress
        return max(0.5, new_capacity)
    
    def recursive_expert_refinement(self, task_complexity: float, depth: int = 0, max_depth: int = 3) -> Dict[str, Any]:
        """Experts recursively spawn sub-experts for complex tasks.
        
        If a task is too complex for current experts, they spawn sub-experts
        that specialize in sub-tasks, then merge results back.
        """
        if depth >= max_depth:
            return {"action": "use_current", "depth": depth}
        if task_complexity < 0.3:
            return {"action": "direct_routing", "depth": depth, "experts_needed": 4}
        elif task_complexity < 0.6:
            return {"action": "split_routing", "depth": depth, "experts_needed": 8, "sub_experts": 4}
        else:
            return {
                "action": "recursive_split",
                "depth": depth,
                "experts_needed": 16,
                "sub_experts": 8,
                "next_level": self.recursive_expert_refinement(task_complexity / 2, depth + 1, max_depth),
            }
    
    def get_manipulation_report(self) -> Dict[str, Any]:
        """Get full report of all MoE manipulations performed."""
        return {
            "num_experts": self.num_experts,
            "specializations": dict(list(self._expert_specializations.items())[:20]),
            "bias_terms": dict(list(self._bias_terms.items())[:20]),
            "splits_performed": len(self._split_history),
            "merges_performed": len(self._merge_history),
            "total_experts_after_manipulation": self.num_experts,
            "techniques_available": [
                "Dynamic Expert Allocation",
                "Fine-Grained Expert Splitting",
                "Auxiliary-Loss-Free Balancing",
                "Shared Expert Isolation",
                "Speculative Expert Routing",
                "Expert Merging (similarity-based)",
                "GRPO Expert Training",
                "Progressive Sparsification",
                "Heterogeneous Expert Sizes",
                "Recursive Expert Refinement",
            ],
        }

