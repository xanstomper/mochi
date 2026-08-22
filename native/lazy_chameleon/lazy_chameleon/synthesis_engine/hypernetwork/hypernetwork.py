"""HyperNetwork that generates weight matrices for MLP layers,
attention layers, and expert layers. Includes DynamicHyperNetwork
with task-conditioned generation."""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np


@dataclass
class ContextEncoding:
    """Encoded context/task representation."""
    embedding: np.ndarray
    task_id: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    @property
    def dim(self) -> int:
        return self.embedding.shape[-1]


@dataclass
class GeneratedWeights:
    """Container for generated weight matrices."""
    weight_matrices: Dict[str, np.ndarray]
    biases: Dict[str, np.ndarray]
    generation_config: Dict[str, Any] = field(default_factory=dict)

    def __getitem__(self, key: str) -> np.ndarray:
        return self.weight_matrices[key]

    def keys(self) -> List[str]:
        return list(self.weight_matrices.keys())


class ContextEncoder:
    """Encodes task/context information into embeddings."""

    def __init__(self, embedding_dim: int = 256, hidden_dim: int = 512):
        self.embedding_dim = embedding_dim
        self.hidden_dim = hidden_dim
        self.rng = np.random.default_rng(42)

        # Learnable parameters (random init for demo)
        self.W1 = self.rng.normal(0.0, 0.02, (embedding_dim, hidden_dim)).astype(np.float32)
        self.b1 = np.zeros(hidden_dim, dtype=np.float32)
        self.W2 = self.rng.normal(0.0, 0.02, (hidden_dim, embedding_dim)).astype(np.float32)
        self.b2 = np.zeros(embedding_dim, dtype=np.float32)

    def encode(self, task_description: str) -> ContextEncoding:
        """Encode a task description into a context embedding."""
        # Generate embedding from text (simple character-based)
        vec = np.zeros(self.embedding_dim, dtype=np.float32)
        for i, ch in enumerate(task_description):
            idx = (i * 37 + ord(ch) * 13) % self.embedding_dim
            vec[idx] += 1.0
        vec = vec / (np.linalg.norm(vec) + 1e-8)

        # Pass through MLP
        h = np.dot(vec, self.W1) + self.b1
        h = np.maximum(h, 0.0)  # ReLU
        out = np.dot(h, self.W2) + self.b2
        out = out / (np.linalg.norm(out) + 1e-8)

        return ContextEncoding(embedding=out, task_id=task_description[:20])

    def encode_batch(self, descriptions: List[str]) -> List[ContextEncoding]:
        return [self.encode(d) for d in descriptions]


class ParameterDecoder:
    """Decodes context embeddings into weight matrices."""

    def __init__(self, seed: int = 42):
        self.rng = np.random.default_rng(seed)
        self._decoders: Dict[str, Tuple[np.ndarray, np.ndarray]] = {}

    def add_decoder(self, name: str, input_dim: int, output_shape: Tuple[int, ...]) -> None:
        """Register a decoder for a specific parameter type."""
        # Hypernetwork decoder: maps context -> weight matrix
        n_out = int(np.prod(output_shape))
        W = self.rng.normal(0.0, 0.01, (input_dim, n_out)).astype(np.float32)
        b = np.zeros(n_out, dtype=np.float32)
        self._decoders[name] = (W, b, output_shape)

    def decode(self, context: ContextEncoding, decoder_name: str) -> np.ndarray:
        """Decode context into a weight matrix."""
        if decoder_name not in self._decoders:
            raise ValueError(f"Decoder '{decoder_name}' not found")

        W, b, output_shape = self._decoders[decoder_name]
        flat = np.dot(context.embedding, W) + b
        # Reshape to target shape
        return flat.reshape(output_shape)

    def decode_batch(
        self, contexts: List[ContextEncoding], decoder_name: str
    ) -> List[np.ndarray]:
        return [self.decode(ctx, decoder_name) for ctx in contexts]


class HyperNetwork:
    """HyperNetwork that generates other network parameters.
    
    Uses a context embedding to generate weight matrices for target networks.
    """

    def __init__(
        self,
        context_dim: int = 256,
        hidden_dim: int = 512,
        seed: int = 42,
    ):
        self.context_dim = context_dim
        self.hidden_dim = hidden_dim
        self.rng = np.random.default_rng(seed)

        self.encoder = ContextEncoder(context_dim, hidden_dim)
        self.decoder = ParameterDecoder(seed)

        # Internal hypernetwork weights
        self.W_hyper = self.rng.normal(0.0, 0.02, (context_dim, hidden_dim)).astype(np.float32)
        self.b_hyper = np.zeros(hidden_dim, dtype=np.float32)

    def generate_weights(
        self,
        layer_name: str,
        weight_shape: Tuple[int, ...],
        bias_shape: Optional[Tuple[int, ...]] = None,
        context: Optional[ContextEncoding] = None,
    ) -> GeneratedWeights:
        """Generate weight matrices for a layer."""
        if context is None:
            context = self.encoder.encode("default")

        # Register decoder for this layer
        self.decoder.add_decoder(f"{layer_name}_weight", self.context_dim, weight_shape)
        weight = self.decoder.decode(context, f"{layer_name}_weight")

        weight_matrices = {f"{layer_name}.weight": weight}
        biases: Dict[str, np.ndarray] = {}

        if bias_shape is not None:
            self.decoder.add_decoder(f"{layer_name}_bias", self.context_dim, bias_shape)
            bias = self.decoder.decode(context, f"{layer_name}_bias")
            biases[f"{layer_name}.bias"] = bias

        return GeneratedWeights(
            weight_matrices=weight_matrices,
            biases=biases,
            generation_config={
                "layer_name": layer_name,
                "weight_shape": weight_shape,
                "context_dim": self.context_dim,
            },
        )

    def forward(
        self, context: np.ndarray
    ) -> np.ndarray:
        """Forward pass through hypernetwork."""
        h = np.dot(context, self.W_hyper) + self.b_hyper
        h = np.tanh(h)
        return h


class DynamicHyperNetwork(HyperNetwork):
    """HyperNetwork with task-conditioned weight generation."""

    def __init__(
        self,
        context_dim: int = 256,
        hidden_dim: int = 512,
        num_tasks: int = 10,
        task_embedding_dim: int = 64,
        seed: int = 42,
    ):
        super().__init__(context_dim, hidden_dim, seed)
        self.num_tasks = num_tasks
        self.task_embedding_dim = task_embedding_dim

        # Task embeddings (learnable)
        self.task_embeddings = self.rng.normal(
            0.0, 0.02, (num_tasks, task_embedding_dim)
        ).astype(np.float32)

        # Task conditioning projection
        self.W_task = self.rng.normal(0.0, 0.02, (task_embedding_dim, context_dim)).astype(np.float32)
        self.b_task = np.zeros(context_dim, dtype=np.float32)

        # Task-specific decoder heads
        self._task_decoders: Dict[int, ParameterDecoder] = {}

    def get_task_embedding(self, task_id: int) -> np.ndarray:
        """Get embedding for a specific task."""
        if task_id >= self.num_tasks:
            raise ValueError(f"Task {task_id} out of range (0-{self.num_tasks - 1})")
        return self.task_embeddings[task_id]

    def condition_on_task(
        self, context: ContextEncoding, task_id: int
    ) -> ContextEncoding:
        """Condition the context on a specific task."""
        task_emb = self.get_task_embedding(task_id)
        task_proj = np.dot(task_emb, self.W_task) + self.b_task
        # Modulate context with task embedding
        modulated = context.embedding * 0.8 + task_proj * 0.2
        modulated = modulated / (np.linalg.norm(modulated) + 1e-8)

        return ContextEncoding(
            embedding=modulated,
            task_id=str(task_id),
            metadata=context.metadata,
        )

    def generate_task_weights(
        self,
        task_id: int,
        layer_name: str,
        weight_shape: Tuple[int, ...],
        bias_shape: Optional[Tuple[int, ...]] = None,
    ) -> GeneratedWeights:
        """Generate weights conditioned on a specific task."""
        # Create task-specific decoder
        if task_id not in self._task_decoders:
            self._task_decoders[task_id] = ParameterDecoder(seed=task_id + 42)

        task_decoder = self._task_decoders[task_id]
        base_context = self.encoder.encode(f"task_{task_id}_default")
        task_context = self.condition_on_task(base_context, task_id)

        task_decoder.add_decoder(f"{layer_name}_weight", self.context_dim, weight_shape)
        weight = task_decoder.decode(task_context, f"{layer_name}_weight")

        weight_matrices = {f"{layer_name}.weight": weight}
        biases: Dict[str, np.ndarray] = {}

        if bias_shape is not None:
            task_decoder.add_decoder(f"{layer_name}_bias", self.context_dim, bias_shape)
            bias = task_decoder.decode(task_context, f"{layer_name}_bias")
            biases[f"{layer_name}.bias"] = bias

        return GeneratedWeights(
            weight_matrices=weight_matrices,
            biases=biases,
            generation_config={
                "task_id": task_id,
                "layer_name": layer_name,
                "weight_shape": weight_shape,
                "task_embedding_dim": self.task_embedding_dim,
            },
        )

    def add_task(self) -> int:
        """Add a new task."""
        new_embedding = self.rng.normal(0.0, 0.02, (1, self.task_embedding_dim)).astype(np.float32)
        self.task_embeddings = np.concatenate([self.task_embeddings, new_embedding], axis=0)
        self.num_tasks += 1
        return self.num_tasks - 1


def generate_mlp_weights(
    hypernet: HyperNetwork,
    input_dim: int,
    hidden_dim: int,
    output_dim: int,
    context: Optional[ContextEncoding] = None,
) -> GeneratedWeights:
    """Generate weights for a 2-layer MLP."""
    w1 = hypernet.generate_weights(
        "mlp.l1",
        (input_dim, hidden_dim),
        (hidden_dim,),
        context,
    )
    w2 = hypernet.generate_weights(
        "mlp.l2",
        (hidden_dim, output_dim),
        (output_dim,),
        context,
    )
    # Combine
    combined_weights = dict(w1.weight_matrices)
    combined_weights.update(w2.weight_matrices)
    combined_biases = dict(w1.biases)
    combined_biases.update(w2.biases)

    return GeneratedWeights(
        weight_matrices=combined_weights,
        biases=combined_biases,
        generation_config={
            "type": "mlp",
            "input_dim": input_dim,
            "hidden_dim": hidden_dim,
            "output_dim": output_dim,
        },
    )


def generate_attention_weights(
    hypernet: HyperNetwork,
    hidden_size: int,
    num_heads: int,
    head_dim: int,
    context: Optional[ContextEncoding] = None,
) -> GeneratedWeights:
    """Generate weights for an attention layer (Q, K, V, output)."""
    total_head_dim = num_heads * head_dim

    q = hypernet.generate_weights(
        "attn.q_proj", (hidden_size, total_head_dim), (total_head_dim,), context
    )
    k = hypernet.generate_weights(
        "attn.k_proj", (hidden_size, total_head_dim), (total_head_dim,), context
    )
    v = hypernet.generate_weights(
        "attn.v_proj", (hidden_size, total_head_dim), (total_head_dim,), context
    )
    o = hypernet.generate_weights(
        "attn.o_proj", (total_head_dim, hidden_size), (hidden_size,), context
    )

    combined = {}
    combined.update(q.weight_matrices)
    combined.update(k.weight_matrices)
    combined.update(v.weight_matrices)
    combined.update(o.weight_matrices)

    combined_b = {}
    combined_b.update(q.biases)
    combined_b.update(k.biases)
    combined_b.update(v.biases)
    combined_b.update(o.biases)

    return GeneratedWeights(
        weight_matrices=combined,
        biases=combined_b,
        generation_config={
            "type": "attention",
            "hidden_size": hidden_size,
            "num_heads": num_heads,
            "head_dim": head_dim,
        },
    )


def generate_expert_weights(
    hypernet: HyperNetwork,
    input_dim: int,
    hidden_dim: int,
    output_dim: int,
    expert_id: int = 0,
    context: Optional[ContextEncoding] = None,
) -> GeneratedWeights:
    """Generate weights for an MoE expert (MLP)."""
    prefix = f"expert_{expert_id}"

    w1 = hypernet.generate_weights(
        f"{prefix}.w1", (input_dim, hidden_dim), (hidden_dim,), context
    )
    w2 = hypernet.generate_weights(
        f"{prefix}.w2", (hidden_dim, output_dim), (output_dim,), context
    )
    w3 = hypernet.generate_weights(
        f"{prefix}.w3", (input_dim, hidden_dim), (hidden_dim,), context
    )

    combined = {}
    combined.update(w1.weight_matrices)
    combined.update(w2.weight_matrices)
    combined.update(w3.weight_matrices)

    combined_b = {}
    combined_b.update(w1.biases)
    combined_b.update(w2.biases)
    combined_b.update(w3.biases)

    return GeneratedWeights(
        weight_matrices=combined,
        biases=combined_b,
        generation_config={
            "type": "expert",
            "expert_id": expert_id,
            "input_dim": input_dim,
            "hidden_dim": hidden_dim,
            "output_dim": output_dim,
        },
    )
