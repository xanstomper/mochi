"""Knowledge distillation: teacher-student, progressive, layer-wise,
attention transfer, feature-level, hidden state, logit, speculative."""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import numpy as np


@dataclass
class DistillationResult:
    """Results from a distillation run."""
    student_weights: Dict[str, np.ndarray]
    distillation_losses: List[float]
    method: str
    temperature: float
    alpha: float  # weight for distillation loss vs. student loss
    metadata: Dict[str, Any] = field(default_factory=dict)

    def get_final_loss(self) -> float:
        return self.distillation_losses[-1] if self.distillation_losses else 0.0

    def loss_trend(self) -> Tuple[float, float]:
        """Return (start_loss, end_loss) for progress tracking."""
        if len(self.distillation_losses) >= 2:
            return self.distillation_losses[0], self.distillation_losses[-1]
        return 0.0, 0.0


def _softmax(x: np.ndarray, temperature: float = 1.0) -> np.ndarray:
    """Softmax with temperature."""
    x = x / max(temperature, 1e-8)
    e_x = np.exp(x - np.max(x, axis=-1, keepdims=True))
    return e_x / (np.sum(e_x, axis=-1, keepdims=True) + 1e-8)


def _kl_divergence(p: np.ndarray, q: np.ndarray) -> float:
    """KL divergence between two distributions."""
    p = np.clip(p, 1e-12, 1.0)
    q = np.clip(q, 1e-12, 1.0)
    return float(np.sum(p * np.log(p / q)))


def _mse_loss(a: np.ndarray, b: np.ndarray) -> float:
    """Mean squared error."""
    return float(np.mean((a - b) ** 2))


def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity between flattened arrays."""
    a_f = a.ravel().astype(np.float64)
    b_f = b.ravel().astype(np.float64)
    dot = np.dot(a_f, b_f)
    norm = np.linalg.norm(a_f) * np.linalg.norm(b_f) + 1e-12
    return float(dot / norm)


class KnowledgeDistiller:
    """Knowledge distillation from teacher to student models."""

    def __init__(
        self,
        teacher_weights: Dict[str, np.ndarray],
        student_weights: Dict[str, np.ndarray],
        temperature: float = 2.0,
        seed: int = 42,
    ):
        self.teacher = teacher_weights
        self.student = dict(student_weights)
        self.temperature = temperature
        self.rng = np.random.default_rng(seed)
        self._loss_history: List[float] = []

    def _get_layer_mapping(
        self,
        teacher_prefix: str = "",
        student_prefix: str = "",
    ) -> List[Tuple[str, str]]:
        """Map teacher layer names to student layer names."""
        mapping: List[Tuple[str, str]] = []
        for t_key in self.teacher:
            s_key = t_key.replace(teacher_prefix, student_prefix, 1) if teacher_prefix else t_key
            if s_key in self.student:
                mapping.append((t_key, s_key))
        return mapping

    def _distill_loss(
        self,
        teacher_logits: np.ndarray,
        student_logits: np.ndarray,
        temperature: Optional[float] = None,
    ) -> float:
        """Compute distillation loss (KL divergence with temperature)."""
        T = temperature or self.temperature
        t_probs = _softmax(teacher_logits, T)
        s_probs = _softmax(student_logits, T)
        return _kl_divergence(t_probs, s_probs) * (T ** 2)

    def teacher_student_distill(
        self,
        num_steps: int = 100,
        learning_rate: float = 0.01,
        alpha: float = 0.5,
        temperature: Optional[float] = None,
    ) -> DistillationResult:
        """Standard teacher-student distillation on logits."""
        T = temperature or self.temperature
        losses: List[float] = []

        student = {k: v.copy().astype(np.float64) for k, v in self.student.items()}

        for step in range(num_steps):
            step_loss = 0.0
            layer_pairs = self._get_layer_mapping()

            for t_key, s_key in layer_pairs:
                t_param = self.teacher[t_key].astype(np.float64)
                s_param = student[s_key]

                # Simulate logits via random projection
                rand_input = self.rng.normal(0.0, 1.0, (32, t_param.shape[0])).astype(np.float64)
                t_logits = rand_input @ t_param
                s_logits = rand_input @ s_param

                loss = self._distill_loss(t_logits, s_logits, T)

                # Simple gradient step
                grad = (s_logits - t_logits) / T
                grad = (rand_input.T @ grad) / rand_input.shape[0]
                grad = grad * alpha + (1.0 - alpha) * _mse_loss(s_param, t_param)

                s_param -= learning_rate * grad[:s_param.shape[0], :s_param.shape[1]]
                student[s_key] = s_param
                step_loss += loss

            avg_loss = step_loss / max(1, len(layer_pairs))
            losses.append(avg_loss)

            # Decay learning rate
            learning_rate *= 0.995

        # Convert back to original dtype
        final_student = {
            k: v.astype(self.student[k].dtype) for k, v in student.items()
        }

        return DistillationResult(
            student_weights=final_student,
            distillation_losses=losses,
            method="teacher_student",
            temperature=T,
            alpha=alpha,
        )

    def progressive_distill(
        self,
        num_stages: int = 3,
        steps_per_stage: int = 50,
        learning_rate: float = 0.01,
    ) -> DistillationResult:
        """Progressive distillation: gradually increase temperature."""
        all_losses: List[float] = []
        student = {k: v.copy().astype(np.float64) for k, v in self.student.items()}

        for stage in range(num_stages):
            # Temperature decreases each stage (more precise)
            stage_temp = max(0.5, self.temperature * (num_stages - stage) / num_stages)
            alpha = 0.3 + 0.6 * (stage / num_stages)  # More student loss over time

            stage_losses: List[float] = []
            for step in range(steps_per_stage):
                step_loss = 0.0
                layer_pairs = self._get_layer_mapping()

                for t_key, s_key in layer_pairs:
                    t_param = self.teacher[t_key].astype(np.float64)
                    s_param = student[s_key]

                    rand_input = self.rng.normal(0.0, 1.0, (32, t_param.shape[0])).astype(np.float64)
                    t_logits = rand_input @ t_param
                    s_logits = rand_input @ s_param

                    distill_loss = self._distill_loss(t_logits, s_logits, stage_temp)
                    mse = _mse_loss(s_param, t_param)
                    loss = alpha * distill_loss + (1.0 - alpha) * mse

                    grad = (s_logits - t_logits) / stage_temp
                    grad = (rand_input.T @ grad) / rand_input.shape[0]
                    grad = grad * alpha + (1.0 - alpha) * (s_param - t_param) * 2.0 / t_param.size

                    s_param -= learning_rate * grad[:s_param.shape[0], :s_param.shape[1]]
                    student[s_key] = s_param
                    step_loss += loss

                stage_losses.append(step_loss / max(1, len(layer_pairs)))

            all_losses.extend(stage_losses)
            learning_rate *= 0.9

        final_student = {
            k: v.astype(self.student[k].dtype) for k, v in student.items()
        }

        return DistillationResult(
            student_weights=final_student,
            distillation_losses=all_losses,
            method="progressive",
            temperature=self.temperature,
            alpha=0.5,
        )

    def layer_distill(
        self,
        num_steps: int = 100,
        learning_rate: float = 0.01,
        layer_weights: Optional[Dict[str, float]] = None,
    ) -> DistillationResult:
        """Layer-wise distillation with per-layer importance weighting."""
        losses: List[float] = []
        student = {k: v.copy().astype(np.float64) for k, v in self.student.items()}
        layer_pairs = self._get_layer_mapping()

        for step in range(num_steps):
            step_loss = 0.0

            for t_key, s_key in layer_pairs:
                t_param = self.teacher[t_key].astype(np.float64)
                s_param = student[s_key]

                # Layer-wise MSE distillation
                loss = _mse_loss(s_param, t_param)

                # Apply per-layer weight if provided
                layer_w = layer_weights.get(s_key, 1.0) if layer_weights else 1.0
                loss *= layer_w

                grad = 2.0 * (s_param - t_param) / max(1, t_param.size)
                s_param -= learning_rate * grad * layer_w
                student[s_key] = s_param
                step_loss += loss

            losses.append(step_loss / max(1, len(layer_pairs)))
            learning_rate *= 0.995

        final_student = {
            k: v.astype(self.student[k].dtype) for k, v in student.items()
        }

        return DistillationResult(
            student_weights=final_student,
            distillation_losses=losses,
            method="layer_distill",
            temperature=self.temperature,
            alpha=1.0,
        )

    def attention_distill(
        self,
        num_steps: int = 100,
        learning_rate: float = 0.01,
    ) -> DistillationResult:
        """Attention transfer: match attention maps from teacher to student."""
        losses: List[float] = []
        student = {k: v.copy().astype(np.float64) for k, v in self.student.items()}

        # Identify attention layers (weight matrices named with 'attn' or 'qkv')
        attn_pairs = [
            (t_key, s_key) for t_key, s_key in self._get_layer_mapping()
            if any(x in t_key.lower() for x in ["attn", "qkv", "q_proj", "k_proj", "v_proj"])
        ]
        if not attn_pairs:
            attn_pairs = self._get_layer_mapping()

        for step in range(num_steps):
            step_loss = 0.0

            for t_key, s_key in attn_pairs:
                t_param = self.teacher[t_key].astype(np.float64)
                s_param = student[s_key]

                # Simulate attention maps
                seq_len = 64
                rand_input = self.rng.normal(0.0, 1.0, (seq_len, t_param.shape[0])).astype(np.float64)

                # Generate attention-like distributions
                t_attn = _softmax(rand_input @ t_param[:t_param.shape[0], :t_param.shape[1]])
                s_attn = _softmax(rand_input @ s_param[:s_param.shape[0], :s_param.shape[1]])

                loss = _kl_divergence(t_attn, s_attn)

                grad = (s_attn - t_attn)
                proj = rand_input.T @ grad
                s_param -= learning_rate * proj[:s_param.shape[0], :s_param.shape[1]]
                student[s_key] = s_param
                step_loss += loss

            losses.append(step_loss / max(1, len(attn_pairs)))
            learning_rate *= 0.995

        final_student = {
            k: v.astype(self.student[k].dtype) for k, v in student.items()
        }

        return DistillationResult(
            student_weights=final_student,
            distillation_losses=losses,
            method="attention_distill",
            temperature=self.temperature,
            alpha=1.0,
        )

    def feature_distill(
        self,
        num_steps: int = 100,
        learning_rate: float = 0.01,
        feature_layers: Optional[List[str]] = None,
    ) -> DistillationResult:
        """Feature-level distillation: match intermediate representations."""
        losses: List[float] = []
        student = {k: v.copy().astype(np.float64) for k, v in self.student.items()}
        layer_pairs = self._get_layer_mapping()

        if feature_layers:
            layer_pairs = [p for p in layer_pairs if p[0] in feature_layers]

        for step in range(num_steps):
            step_loss = 0.0

            for t_key, s_key in layer_pairs:
                t_param = self.teacher[t_key].astype(np.float64)
                s_param = student[s_key]

                # Feature matching via cosine similarity
                batch = 16
                rand_input = self.rng.normal(0.0, 1.0, (batch, t_param.shape[0])).astype(np.float64)
                t_feat = rand_input @ t_param[:t_param.shape[0], :min(t_param.shape[1], s_param.shape[1])]
                s_feat = rand_input @ s_param[:s_param.shape[0], :min(s_param.shape[1], s_param.shape[1])]

                if t_feat.shape != s_feat.shape:
                    continue

                cos_sim = _cosine_similarity(t_feat, s_feat)
                loss = 1.0 - cos_sim  # Minimize cosine distance

                # Approximate gradient
                t_norm = np.linalg.norm(t_feat.ravel()) + 1e-12
                s_norm = np.linalg.norm(s_feat.ravel()) + 1e-12
                grad = (s_feat / s_norm - t_feat / t_norm)
                grad = rand_input.T @ grad
                s_param -= learning_rate * grad[:s_param.shape[0], :s_param.shape[1]]
                student[s_key] = s_param
                step_loss += loss

            losses.append(step_loss / max(1, len(layer_pairs)))
            learning_rate *= 0.995

        final_student = {
            k: v.astype(self.student[k].dtype) for k, v in student.items()
        }

        return DistillationResult(
            student_weights=final_student,
            distillation_losses=losses,
            method="feature_distill",
            temperature=self.temperature,
            alpha=1.0,
        )

    def hidden_state_distill(
        self,
        num_steps: int = 100,
        learning_rate: float = 0.01,
        hidden_mapping: Optional[Dict[str, str]] = None,
    ) -> DistillationResult:
        """Hidden state matching: directly match hidden representations."""
        losses: List[float] = []
        student = {k: v.copy().astype(np.float64) for k, v in self.student.items()}

        pairs = self._get_layer_mapping()
        if hidden_mapping:
            pairs = [
                (t_key, s_key) for t_key, s_key in pairs
                if t_key in hidden_mapping
            ]

        for step in range(num_steps):
            step_loss = 0.0

            for t_key, s_key in pairs:
                t_param = self.teacher[t_key].astype(np.float64)
                s_param = student[s_key]

                batch = 32
                rand_input = self.rng.normal(0.0, 1.0, (batch, t_param.shape[0])).astype(np.float64)
                t_hidden = rand_input @ t_param
                s_hidden = rand_input @ s_param

                # Match hidden states with L2
                loss = _mse_loss(t_hidden, s_hidden)

                grad = 2.0 * (s_hidden - t_hidden) / max(1, t_hidden.size)
                grad = rand_input.T @ grad
                s_param -= learning_rate * grad[:s_param.shape[0], :s_param.shape[1]]
                student[s_key] = s_param
                step_loss += loss

            losses.append(step_loss / max(1, len(pairs)))
            learning_rate *= 0.995

        final_student = {
            k: v.astype(self.student[k].dtype) for k, v in student.items()
        }

        return DistillationResult(
            student_weights=final_student,
            distillation_losses=losses,
            method="hidden_state_distill",
            temperature=self.temperature,
            alpha=1.0,
        )

    def logit_distill(
        self,
        num_steps: int = 100,
        learning_rate: float = 0.01,
        temperature: Optional[float] = None,
    ) -> DistillationResult:
        """Logit-based distillation: match output logits directly."""
        T = temperature or self.temperature
        losses: List[float] = []
        student = {k: v.copy().astype(np.float64) for k, v in self.student.items()}

        for step in range(num_steps):
            step_loss = 0.0
            layer_pairs = self._get_layer_mapping()

            for t_key, s_key in layer_pairs:
                t_param = self.teacher[t_key].astype(np.float64)
                s_param = student[s_key]

                batch = 32
                rand_input = self.rng.normal(0.0, 1.0, (batch, t_param.shape[0])).astype(np.float64)
                t_out = rand_input @ t_param
                s_out = rand_input @ s_param

                # Softened logit matching
                loss = _mse_loss(t_out, s_out)

                grad = 2.0 * (s_out - t_out) / max(1, t_out.size)
                grad = rand_input.T @ grad
                s_param -= learning_rate * grad[:s_param.shape[0], :s_param.shape[1]]
                student[s_key] = s_param
                step_loss += loss

            losses.append(step_loss / max(1, len(layer_pairs)))
            learning_rate *= 0.995

        final_student = {
            k: v.astype(self.student[k].dtype) for k, v in student.items()
        }

        return DistillationResult(
            student_weights=final_student,
            distillation_losses=losses,
            method="logit_distill",
            temperature=T,
            alpha=1.0,
        )

    def speculative_distill(
        self,
        num_steps: int = 100,
        learning_rate: float = 0.01,
        draft_model_weights: Optional[Dict[str, np.ndarray]] = None,
    ) -> DistillationResult:
        """Speculative distillation: train student to match teacher's 
        predictions on self-generated draft sequences."""
        draft = draft_model_weights or self.student
        losses: List[float] = []
        student = {k: v.copy().astype(np.float64) for k, v in self.student.items()}
        draft_params = {k: v.astype(np.float64) for k, v in draft.items()}

        for step in range(num_steps):
            step_loss = 0.0
            layer_pairs = self._get_layer_mapping()

            # Draft model generates a sequence
            seq_len = 16 + step % 32
            draft_input = self.rng.normal(0.0, 1.0, (seq_len, 512)).astype(np.float64)

            for t_key, s_key in layer_pairs:
                t_param = self.teacher[t_key].astype(np.float64)
                s_param = student[s_key]
                d_param = draft_params.get(s_key, s_param)

                # Draft generates speculative tokens
                d_out = draft_input[:, :d_param.shape[0]] @ d_param[:d_param.shape[0], :d_param.shape[1]]

                # Teacher verifies
                t_out = draft_input[:, :t_param.shape[0]] @ t_param[:t_param.shape[0], :t_param.shape[1]]

                # Student learns from teacher's corrections
                s_out = draft_input[:, :s_param.shape[0]] @ s_param[:s_param.shape[0], :s_param.shape[1]]

                loss = _mse_loss(t_out, s_out) + 0.1 * _mse_loss(d_out, s_out)

                grad = 2.0 * (s_out - t_out) / max(1, t_out.size)
                grad += 0.1 * 2.0 * (s_out - d_out) / max(1, d_out.size)
                grad = draft_input[:, :s_param.shape[0]].T @ grad
                s_param -= learning_rate * grad[:s_param.shape[0], :s_param.shape[1]]
                student[s_key] = s_param
                step_loss += loss

            losses.append(step_loss / max(1, len(layer_pairs)))
            learning_rate *= 0.995

        final_student = {
            k: v.astype(self.student[k].dtype) for k, v in student.items()
        }

        return DistillationResult(
            student_weights=final_student,
            distillation_losses=losses,
            method="speculative_distill",
            temperature=self.temperature,
            alpha=1.0,
        )


# Convenience functions

def teacher_student_distill(
    teacher_weights: Dict[str, np.ndarray],
    student_weights: Dict[str, np.ndarray],
    num_steps: int = 100,
) -> DistillationResult:
    distiller = KnowledgeDistiller(teacher_weights, student_weights)
    return distiller.teacher_student_distill(num_steps)


def progressive_distill(
    teacher_weights: Dict[str, np.ndarray],
    student_weights: Dict[str, np.ndarray],
    num_stages: int = 3,
) -> DistillationResult:
    distiller = KnowledgeDistiller(teacher_weights, student_weights)
    return distiller.progressive_distill(num_stages)


def layer_distill(
    teacher_weights: Dict[str, np.ndarray],
    student_weights: Dict[str, np.ndarray],
    num_steps: int = 100,
) -> DistillationResult:
    distiller = KnowledgeDistiller(teacher_weights, student_weights)
    return distiller.layer_distill(num_steps)


def attention_distill(
    teacher_weights: Dict[str, np.ndarray],
    student_weights: Dict[str, np.ndarray],
    num_steps: int = 100,
) -> DistillationResult:
    distiller = KnowledgeDistiller(teacher_weights, student_weights)
    return distiller.attention_distill(num_steps)


def feature_distill(
    teacher_weights: Dict[str, np.ndarray],
    student_weights: Dict[str, np.ndarray],
    num_steps: int = 100,
) -> DistillationResult:
    distiller = KnowledgeDistiller(teacher_weights, student_weights)
    return distiller.feature_distill(num_steps)


def hidden_state_distill(
    teacher_weights: Dict[str, np.ndarray],
    student_weights: Dict[str, np.ndarray],
    num_steps: int = 100,
) -> DistillationResult:
    distiller = KnowledgeDistiller(teacher_weights, student_weights)
    return distiller.hidden_state_distill(num_steps)


def logit_distill(
    teacher_weights: Dict[str, np.ndarray],
    student_weights: Dict[str, np.ndarray],
    num_steps: int = 100,
) -> DistillationResult:
    distiller = KnowledgeDistiller(teacher_weights, student_weights)
    return distiller.logit_distill(num_steps)


def speculative_distill(
    teacher_weights: Dict[str, np.ndarray],
    student_weights: Dict[str, np.ndarray],
    num_steps: int = 100,
) -> DistillationResult:
    distiller = KnowledgeDistiller(teacher_weights, student_weights)
    return distiller.speculative_distill(num_steps)
