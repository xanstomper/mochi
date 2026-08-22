"""Model merging implementations for combining multiple model weight matrices.

Provides SLERP, TIES, DARE, Task Arithmetic, Weight Averaging,
Fisher-weighted, and RegMean merging methods.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np


@dataclass
class MergedWeights:
    """Container for merged weight matrices and metadata."""
    weights: Dict[str, np.ndarray]
    merge_method: str
    task_vectors: Optional[Dict[str, np.ndarray]] = None
    merge_coefficients: Optional[Dict[str, float]] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def apply(self, model_params: Dict[str, np.ndarray]) -> Dict[str, np.ndarray]:
        """Apply merged weights onto existing model parameters."""
        result = dict(model_params)
        for key, w in self.weights.items():
            if key in result:
                result[key] = w.astype(result[key].dtype)
        return result


def _validate_weights(*weight_list: Dict[str, np.ndarray]) -> int:
    """Validate that all weight dicts have the same keys and shapes."""
    if not weight_list:
        raise ValueError("At least one set of weights required.")
    keys = set(weight_list[0].keys())
    n = len(weight_list[0])
    for w in weight_list:
        if set(w.keys()) != keys:
            raise ValueError("All weight dicts must have the same keys.")
        if len(w) != n:
            raise ValueError("All weight dicts must have the same number of keys.")
    return n


def slerp(
    weights_a: Dict[str, np.ndarray],
    weights_b: Dict[str, np.ndarray],
    t: float = 0.5,
    eps: float = 1e-8,
) -> MergedWeights:
    """Spherical linear interpolation between two model weight sets."""
    _validate_weights(weights_a, weights_b)
    merged: Dict[str, np.ndarray] = {}

    for key in weights_a:
        a = weights_a[key].astype(np.float64)
        b = weights_b[key].astype(np.float64)

        a_flat = a.ravel()
        b_flat = b.ravel()

        dot = np.dot(a_flat, b_flat)
        dot = np.clip(dot / (np.linalg.norm(a_flat) * np.linalg.norm(b_flat) + eps), -1.0, 1.0)

        theta = math.acos(dot)
        sin_theta = math.sin(theta)

        if sin_theta < eps:
            result_flat = (1.0 - t) * a_flat + t * b_flat
        else:
            result_flat = (
                (math.sin((1.0 - t) * theta) / sin_theta) * a_flat
                + (math.sin(t * theta) / sin_theta) * b_flat
            )

        merged[key] = result_flat.reshape(a.shape).astype(weights_a[key].dtype)

    return MergedWeights(
        weights=merged,
        merge_method="slerp",
        merge_coefficients={"t": t},
    )


def ties_merge(
    weights_list: List[Dict[str, np.ndarray]],
    trim_fraction: float = 0.2,
    elect_sign: bool = True,
) -> MergedWeights:
    """TIES Merging: Trim, Elect Sign, Merge."""
    if len(weights_list) < 2:
        raise ValueError("Need at least 2 models for TIES merging.")
    _validate_weights(*weights_list)

    merged: Dict[str, np.ndarray] = {}
    base_keys = list(weights_list[0].keys())

    for key in base_keys:
        base_dtype = weights_list[0][key].dtype
        stacks = [w[key].astype(np.float64) for w in weights_list]
        n_models = len(stacks)
        shape = stacks[0].shape

        # Stack all task vectors (relative to first model as reference)
        ref = stacks[0]
        task_vectors = np.array([s - ref for s in stacks[1:]])
        n_task = len(task_vectors)
        
        if n_task == 0:
            merged[key] = stacks[0].astype(base_dtype)
            continue

        # Trim: zero out smallest-magnitude dimensions
        if trim_fraction > 0.0:
            abs_vals = np.abs(task_vectors)
            k = max(1, int(n_task * (1.0 - trim_fraction)))
            threshold = np.sort(abs_vals, axis=0)[min(k, n_task - 1), ...]
            mask = abs_vals >= threshold[np.newaxis, ...]
            task_vectors = task_vectors * mask

        if elect_sign:
            signs = np.sign(task_vectors)
            sign_sum = np.sum(signs, axis=0)
            majority_sign = np.where(sign_sum >= 0, 1.0, -1.0)
            disagree_mask = (signs != majority_sign[np.newaxis, ...])
            task_vectors = task_vectors * (~disagree_mask)

        nonzero_count = np.sum(task_vectors != 0, axis=0).astype(np.float64)
        nonzero_count = np.maximum(nonzero_count, 1.0)
        merged_vector = np.sum(task_vectors, axis=0) / nonzero_count

        merged[key] = (ref + merged_vector).astype(base_dtype)

    return MergedWeights(
        weights=merged,
        merge_method="ties",
        merge_coefficients={"trim_fraction": trim_fraction, "elect_sign": elect_sign},
    )


def dare_merge(
    weights_list: List[Dict[str, np.ndarray]],
    drop_rate: float = 0.3,
    rescale: bool = True,
) -> MergedWeights:
    """DARE merging: Drop And REscale."""
    if len(weights_list) < 2:
        raise ValueError("Need at least 2 models for DARE merging.")
    _validate_weights(*weights_list)

    merged: Dict[str, np.ndarray] = {}

    for key in weights_list[0].keys():
        base_dtype = weights_list[0][key].dtype
        ref = weights_list[0][key].astype(np.float64)
        n_models = len(weights_list)

        deltas = []
        for w in weights_list[1:]:
            delta = w[key].astype(np.float64) - ref
            drop_mask = np.random.random(delta.shape) < drop_rate
            delta[drop_mask] = 0.0
            if rescale and drop_rate < 1.0:
                delta = delta / (1.0 - drop_rate)
            deltas.append(delta)

        avg_delta = np.mean(deltas, axis=0) if deltas else np.zeros_like(ref)
        merged[key] = (ref + avg_delta).astype(base_dtype)

    return MergedWeights(
        weights=merged,
        merge_method="dare",
        merge_coefficients={"drop_rate": drop_rate, "rescale": rescale},
    )


def task_arithmetic(
    base_weights: Dict[str, np.ndarray],
    task_weights_list: List[Dict[str, np.ndarray]],
    coefficients: Optional[List[float]] = None,
    scaling: float = 1.0,
) -> MergedWeights:
    """Task Vector Arithmetic: add scaled task vectors to base model."""
    if not task_weights_list:
        return MergedWeights(weights=dict(base_weights), merge_method="task_arithmetic")

    n_tasks = len(task_weights_list)
    if coefficients is None:
        coefficients = [1.0] * n_tasks
    if len(coefficients) != n_tasks:
        raise ValueError("coefficients must match length of task_weights_list")

    merged: Dict[str, np.ndarray] = {}

    for key in base_weights:
        base = base_weights[key].astype(np.float64)
        task_vec = np.zeros_like(base)

        for i, tw in enumerate(task_weights_list):
            if key in tw:
                task_vec += coefficients[i] * (tw[key].astype(np.float64) - base)

        merged[key] = (base + scaling * task_vec).astype(base_weights[key].dtype)

    task_vectors_out = {
        key: (merged[key].astype(np.float64) - base_weights[key].astype(np.float64))
        for key in base_weights
    }

    return MergedWeights(
        weights=merged,
        merge_method="task_arithmetic",
        merge_coefficients={"coefficients": coefficients, "scaling": scaling},
        task_vectors=task_vectors_out,
    )


def weight_averaging(
    weights_list: List[Dict[str, np.ndarray]],
    weights: Optional[List[float]] = None,
) -> MergedWeights:
    """Simple weighted averaging of multiple model weight sets."""
    n = len(weights_list)
    if n < 1:
        raise ValueError("Need at least one model.")
    _validate_weights(*weights_list)

    if weights is None:
        weights = [1.0 / n] * n
    w = np.array(weights, dtype=np.float64)
    w = w / w.sum()

    merged: Dict[str, np.ndarray] = {}

    for key in weights_list[0]:
        stacked = np.stack([m[key].astype(np.float64) for m in weights_list], axis=0)
        avg = np.tensordot(w, stacked, axes=1)
        merged[key] = avg.astype(weights_list[0][key].dtype)

    return MergedWeights(
        weights=merged,
        merge_method="weight_averaging",
        merge_coefficients=dict(zip([f"model_{i}" for i in range(n)], w.tolist())),
    )


def fisher_merge(
    weights_list: List[Dict[str, np.ndarray]],
    fisher_infos: List[Dict[str, np.ndarray]],
    regularization: float = 1e-6,
) -> MergedWeights:
    """Fisher-weighted merging using importance estimates."""
    n = len(weights_list)
    if n < 2:
        raise ValueError("Need at least 2 models.")
    _validate_weights(*weights_list)

    merged: Dict[str, np.ndarray] = {}

    for key in weights_list[0]:
        base_dtype = weights_list[0][key].dtype
        stacked_w = np.stack([m[key].astype(np.float64) for m in weights_list], axis=-1)
        stacked_f = np.stack(
            [f[key].astype(np.float64) + regularization for f in fisher_infos],
            axis=-1,
        )

        fisher_sum = np.sum(stacked_f, axis=-1, keepdims=True)
        fisher_sum = np.maximum(fisher_sum, 1e-12)
        weights_normalized = stacked_f / fisher_sum
        merged_arr = np.sum(stacked_w * weights_normalized, axis=-1)
        merged[key] = merged_arr.astype(base_dtype)

    return MergedWeights(
        weights=merged,
        merge_method="fisher_merge",
        metadata={"regularization": regularization},
    )


def regmean_merge(
    weights_list: List[Dict[str, np.ndarray]],
    gram_matrices: List[Dict[str, np.ndarray]],
    alpha: float = 0.5,
    regularization: float = 1e-4,
) -> MergedWeights:
    """RegMean merging using Gram matrices from each model's features."""
    n = len(weights_list)
    if n < 2:
        raise ValueError("Need at least 2 models.")
    _validate_weights(*weights_list)

    merged: Dict[str, np.ndarray] = {}

    for key in weights_list[0]:
        base_dtype = weights_list[0][key].dtype
        w0 = weights_list[0][key].astype(np.float64)
        original_shape = w0.shape

        # Flatten spatial dims if needed
        w_2d = w0.reshape(w0.shape[0], -1) if w0.ndim > 2 else w0
        out_dim, in_dim = w_2d.shape

        gram_sum = np.zeros((in_dim, in_dim), dtype=np.float64)
        weighted_sum = np.zeros((out_dim, in_dim), dtype=np.float64)

        for i in range(n):
            wi = weights_list[i][key].astype(np.float64)
            wi_2d = wi.reshape(wi.shape[0], -1) if wi.ndim > 2 else wi

            Gi = gram_matrices[i][key].astype(np.float64)
            if Gi.shape != (in_dim, in_dim):
                # Handle case where Gram matrix has different shape
                Gi = np.eye(in_dim, dtype=np.float64)

            gram_sum += Gi
            weighted_sum += wi_2d @ Gi

        A = gram_sum + regularization * np.eye(in_dim, dtype=np.float64)
        regmean_w = weighted_sum @ np.linalg.inv(A)

        avg_w = np.mean(
            [w[key].astype(np.float64).reshape(out_dim, -1) for w in weights_list],
            axis=0,
        )
        result_w = alpha * regmean_w + (1.0 - alpha) * avg_w

        if original_shape != result_w.shape:
            result_w = result_w.reshape(original_shape)
        merged[key] = result_w.astype(base_dtype)

    return MergedWeights(
        weights=merged,
        merge_method="regmean",
        merge_coefficients={"alpha": alpha, "regularization": regularization},
    )
