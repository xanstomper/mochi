"""Meta-learning: MAML, Reptile, inner-loop optimization,
task distribution management, quick adaptation."""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np


@dataclass
class Task:
    """A few-shot learning task."""
    support_x: np.ndarray  # [n_support, input_dim]
    support_y: np.ndarray  # [n_support]
    query_x: np.ndarray  # [n_query, input_dim]
    query_y: np.ndarray  # [n_query]
    task_id: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    @property
    def input_dim(self) -> int:
        return self.support_x.shape[-1]

    @property
    def num_classes(self) -> int:
        return len(np.unique(np.concatenate([self.support_y, self.query_y])))


@dataclass
class TaskDistribution:
    """Distribution over tasks for meta-learning."""
    input_dim: int = 64
    output_dim: int = 5
    num_tasks: int = 100
    seed: int = 42

    def __post_init__(self) -> None:
        self.rng = np.random.default_rng(self.seed)
        # Generate base task templates
        self._task_weights = self.rng.normal(
            0.0, 1.0, (self.num_tasks, self.input_dim, self.output_dim)
        ).astype(np.float32)

    def sample(self, n_support: int = 10, n_query: int = 10) -> Task:
        """Sample a random few-shot task."""
        task_idx = self.rng.integers(0, self.num_tasks)
        W = self._task_weights[task_idx]

        n_total = n_support + n_query
        x = self.rng.normal(0.0, 1.0, (n_total, self.input_dim)).astype(np.float32)

        # Generate labels with noise
        logits = x @ W
        probs = np.exp(logits) / (np.sum(np.exp(logits), axis=-1, keepdims=True) + 1e-8)
        y = np.argmax(probs, axis=-1)

        # Add label noise
        noise_mask = self.rng.random(n_total) < 0.1
        if noise_mask.any():
            y[noise_mask] = self.rng.integers(0, self.output_dim, size=noise_mask.sum())

        indices = self.rng.permutation(n_total)
        support_indices = indices[:n_support]
        query_indices = indices[n_support:]

        return Task(
            support_x=x[support_indices],
            support_y=y[support_indices],
            query_x=x[query_indices],
            query_y=y[query_indices],
            task_id=f"task_{task_idx}",
            metadata={"task_idx": int(task_idx)},
        )


class TaskSampler:
    """Samples batches of tasks from a task distribution."""

    def __init__(self, task_distribution: TaskDistribution):
        self.dist = task_distribution

    def sample_batch(self, batch_size: int = 4, n_support: int = 10,
                     n_query: int = 10) -> List[Task]:
        """Sample a batch of tasks."""
        return [
            self.dist.sample(n_support, n_query) for _ in range(batch_size)
        ]


class InnerLoopOptimizer:
    """Inner-loop optimization for few-shot adaptation."""

    def __init__(self, learning_rate: float = 0.01):
        self.lr = learning_rate

    def sgd_step(
        self,
        params: Dict[str, np.ndarray],
        grads: Dict[str, np.ndarray],
    ) -> Dict[str, np.ndarray]:
        """Single SGD step."""
        return {
            k: params[k] - self.lr * grads[k]
            for k in params
        }

    def _compute_loss(
        self,
        params: Dict[str, np.ndarray],
        x: np.ndarray,
        y: np.ndarray,
    ) -> Tuple[float, Dict[str, np.ndarray]]:
        """Compute cross-entropy loss and gradients w.r.t. params."""
        # Simplified: treat params as a single weight matrix
        W = params.get("weight", np.zeros((x.shape[-1], 5)))
        logits = x @ W

        # Cross-entropy
        exp_logits = np.exp(logits - np.max(logits, axis=-1, keepdims=True))
        probs = exp_logits / (np.sum(exp_logits, axis=-1, keepdims=True) + 1e-8)

        n_classes = probs.shape[-1]
        y_one_hot = np.eye(n_classes)[y.astype(int)]
        loss = -np.mean(np.sum(y_one_hot * np.log(probs + 1e-8), axis=-1))

        # Gradient
        grad = (probs - y_one_hot) / x.shape[0]
        dW = x.T @ grad

        return float(loss), {"weight": dW}

    def adapt(
        self,
        initial_params: Dict[str, np.ndarray],
        support_x: np.ndarray,
        support_y: np.ndarray,
        num_steps: int = 5,
    ) -> Dict[str, np.ndarray]:
        """Adapt parameters to a task using inner-loop SGD."""
        params = {k: v.copy() for k, v in initial_params.items()}

        for _ in range(num_steps):
            _, grads = self._compute_loss(params, support_x, support_y)
            params = self.sgd_step(params, grads)

        return params

    def compute_loss_with_grad(
        self,
        params: Dict[str, np.ndarray],
        x: np.ndarray,
        y: np.ndarray,
    ) -> Tuple[float, Dict[str, np.ndarray]]:
        return self._compute_loss(params, x, y)


class MAML:
    """Model-Agnostic Meta-Learning implementation.
    
    Learns initial parameters that can be quickly adapted to new tasks.
    """

    def __init__(
        self,
        input_dim: int = 64,
        output_dim: int = 5,
        inner_lr: float = 0.01,
        outer_lr: float = 0.001,
        seed: int = 42,
    ):
        self.input_dim = input_dim
        self.output_dim = output_dim
        self.inner_lr = inner_lr
        self.outer_lr = outer_lr
        self.rng = np.random.default_rng(seed)

        # Meta-parameters (initialization)
        self.meta_params: Dict[str, np.ndarray] = {
            "weight": self.rng.normal(0.0, 0.1, (input_dim, output_dim)).astype(np.float32),
        }
        self.inner_opt = InnerLoopOptimizer(inner_lr)
        self._loss_history: List[float] = []

    def meta_train_step(self, tasks: List[Task]) -> float:
        """Single meta-training step (MAML algorithm)."""
        meta_grads: Dict[str, List[np.ndarray]] = {
            "weight": []
        }
        meta_loss = 0.0

        for task in tasks:
            # Adapt to task (inner loop)
            adapted = self.inner_opt.adapt(
                self.meta_params, task.support_x, task.support_y, num_steps=5
            )

            # Compute loss on query set (outer loop)
            loss, grads = self.inner_opt.compute_loss_with_grad(
                adapted, task.query_x, task.query_y
            )
            meta_loss += loss
            meta_grads["weight"].append(grads["weight"])

        # Average meta-gradients
        avg_meta_grads = {
            k: np.mean(v, axis=0) for k, v in meta_grads.items()
        }

        # Update meta-parameters
        for k in self.meta_params:
            self.meta_params[k] -= self.outer_lr * avg_meta_grads[k]

        avg_loss = meta_loss / len(tasks)
        self._loss_history.append(avg_loss)
        return avg_loss

    def train(
        self,
        task_dist: TaskDistribution,
        num_iterations: int = 100,
        batch_size: int = 4,
        log_every: int = 10,
    ) -> List[float]:
        """Train MAML on a task distribution."""
        sampler = TaskSampler(task_dist)

        for i in range(num_iterations):
            tasks = sampler.sample_batch(batch_size)
            loss = self.meta_train_step(tasks)

            if (i + 1) % log_every == 0:
                print(f"MAML iter {i+1}/{num_iterations}, loss={loss:.4f}")

        return self._loss_history

    def adapt(self, support_x: np.ndarray, support_y: np.ndarray,
              num_steps: int = 10) -> Dict[str, np.ndarray]:
        """Adapt meta-parameters to a new task."""
        return self.inner_opt.adapt(self.meta_params, support_x, support_y, num_steps)

    def evaluate(self, task: Task) -> float:
        """Evaluate on a task's query set after adapting to support set."""
        adapted = self.adapt(task.support_x, task.support_y)
        loss, _ = self.inner_opt.compute_loss_with_grad(
            adapted, task.query_x, task.query_y
        )
        return loss


class Reptile:
    """Reptile meta-learning algorithm.
    
    Simpler alternative to MAML that moves initialization towards
    task-specific parameters.
    """

    def __init__(
        self,
        input_dim: int = 64,
        output_dim: int = 5,
        inner_lr: float = 0.1,
        outer_lr: float = 0.5,
        seed: int = 42,
    ):
        self.input_dim = input_dim
        self.output_dim = output_dim
        self.inner_lr = inner_lr
        self.outer_lr = outer_lr
        self.rng = np.random.default_rng(seed)

        self.meta_params: Dict[str, np.ndarray] = {
            "weight": self.rng.normal(0.0, 0.1, (input_dim, output_dim)).astype(np.float32),
        }
        self.inner_opt = InnerLoopOptimizer(inner_lr)
        self._loss_history: List[float] = []

    def train_step(self, tasks: List[Task]) -> float:
        """Single Reptile training step."""
        total_loss = 0.0

        for task in tasks:
            # Adapt to task
            adapted = self.inner_opt.adapt(
                self.meta_params, task.support_x, task.support_y, num_steps=8
            )

            # Compute query loss
            loss, _ = self.inner_opt.compute_loss_with_grad(
                adapted, task.query_x, task.query_y
            )
            total_loss += loss

            # Reptile update: move meta-params towards adapted params
            for k in self.meta_params:
                self.meta_params[k] += self.outer_lr * (
                    adapted[k] - self.meta_params[k]
                )

        avg_loss = total_loss / len(tasks)
        self._loss_history.append(avg_loss)
        return avg_loss

    def train(
        self,
        task_dist: TaskDistribution,
        num_iterations: int = 100,
        batch_size: int = 1,
        log_every: int = 10,
    ) -> List[float]:
        """Train Reptile."""
        sampler = TaskSampler(task_dist)

        for i in range(num_iterations):
            tasks = sampler.sample_batch(batch_size)
            loss = self.train_step(tasks)

            if (i + 1) % log_every == 0:
                print(f"Reptile iter {i+1}/{num_iterations}, loss={loss:.4f}")

        return self._loss_history

    def adapt(self, support_x: np.ndarray, support_y: np.ndarray,
              num_steps: int = 10) -> Dict[str, np.ndarray]:
        return self.inner_opt.adapt(self.meta_params, support_x, support_y, num_steps)


class QuickAdaptationModule:
    """Quick adaptation module that can be attached to any network."""

    def __init__(
        self,
        input_dim: int,
        hidden_dim: int = 128,
        output_dim: Optional[int] = None,
        adaptation_steps: int = 5,
        adaptation_lr: float = 0.01,
    ):
        self.input_dim = input_dim
        self.hidden_dim = hidden_dim
        self.output_dim = output_dim or input_dim
        self.adaptation_steps = adaptation_steps
        self.adaptation_lr = adaptation_lr
        self.rng = np.random.default_rng(42)

        # Feature transformation layers
        self.W1 = self.rng.normal(0.0, 0.05, (input_dim, hidden_dim)).astype(np.float32)
        self.b1 = np.zeros(hidden_dim, dtype=np.float32)
        self.W2 = self.rng.normal(0.0, 0.05, (hidden_dim, hidden_dim)).astype(np.float32)
        self.b2 = np.zeros(hidden_dim, dtype=np.float32)
        self.W3 = self.rng.normal(0.0, 0.05, (hidden_dim, self.output_dim)).astype(np.float32)
        self.b3 = np.zeros(self.output_dim, dtype=np.float32)

        # Adaptation parameters (FiLM-style)
        self.gamma = np.ones(hidden_dim, dtype=np.float32)
        self.beta = np.zeros(hidden_dim, dtype=np.float32)

    def forward(self, x: np.ndarray) -> np.ndarray:
        """Forward pass through the adaptation module."""
        h = np.dot(x, self.W1) + self.b1
        h = np.maximum(h, 0.0)  # ReLU
        # FiLM modulation
        h = h * self.gamma + self.beta
        h = np.dot(h, self.W2) + self.b2
        h = np.maximum(h, 0.0)
        out = np.dot(h, self.W3) + self.b3
        return out

    def adapt(
        self,
        support_x: np.ndarray,
        support_y: np.ndarray,
        task_loss_fn: Optional[Callable] = None,
    ) -> None:
        """Quickly adapt to a new task by updating FiLM parameters."""
        if task_loss_fn is None:
            task_loss_fn = lambda pred, y: np.mean((pred - y) ** 2)

        for _ in range(self.adaptation_steps):
            pred = self.forward(support_x)
            loss = task_loss_fn(pred, support_y)

            # Simple gradient estimate for gamma and beta
            h = np.dot(support_x, self.W1) + self.b1
            h = np.maximum(h, 0.0)

            grad_gamma = np.mean(h * (pred - support_y[:, :self.hidden_dim].mean()
                                      if support_y.ndim > 1 else 0.0), axis=0)
            grad_beta = np.mean((pred - support_y[:, :self.hidden_dim].mean()
                                 if support_y.ndim > 1 else 0.0), axis=0)

            self.gamma -= self.adaptation_lr * grad_gamma[:self.hidden_dim]
            self.beta -= self.adaptation_lr * grad_beta[:self.hidden_dim]

            # Clamp for stability
            self.gamma = np.clip(self.gamma, 0.1, 10.0)
            self.beta = np.clip(self.beta, -10.0, 10.0)

    def get_adapted_weights(self) -> Dict[str, np.ndarray]:
        return {
            "W1": self.W1, "b1": self.b1,
            "W2": self.W2, "b2": self.b2,
            "W3": self.W3, "b3": self.b3,
            "gamma": self.gamma, "beta": self.beta,
        }
