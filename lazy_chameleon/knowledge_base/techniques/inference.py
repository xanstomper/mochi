"""Inference optimization techniques."""
from __future__ import annotations
from typing import Any, Dict, List


INFERENCE_OPTIMIZATIONS = {
    "kv_cache": {
        "standard": "Full KV cache for all tokens",
        "mla": "Latent KV cache (DeepSeek): 68% memory reduction",
        "mosaickv": "2D compression across tokens and heads (4-8x reduction)",
        "wavefilter": "Wavelet-based filtering of KV cache (2-4x reduction)",
        "sliding_window": "Only keep recent tokens in cache",
    },
    "attention": {
        "standard_mha": "Full multi-head attention",
        "mqa": "Multi-Query Attention (one KV head)",
        "gqa": "Grouped-Query Attention (8 KV heads)",
        "mla": "Multi-Head Latent Attention",
        "flash_attention": "Memory-efficient attention with tiling",
    },
    "decoding": {
        "standard": "Autoregressive, one token at a time",
        "speculative": "Draft model proposes, target verifies (2-3x speedup)",
        "parallel": "Generate multiple tokens in parallel",
        "mtp": "Multi-Token Prediction (predict n future tokens)",
    },
    "quantization": [
        {"method": "FP32", "bits": 32, "use": "Training"},
        {"method": "FP16/BF16", "bits": 16, "use": "Standard inference"},
        {"method": "INT8", "bits": 8, "use": "Efficient inference"},
        {"method": "INT4", "bits": 4, "use": "Ultra-efficient (AlphaQ, BitsMoE)"},
        {"method": "NF4", "bits": 4, "use": "Normal distribution optimized"},
    ],
}

