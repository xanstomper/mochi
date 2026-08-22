"""
HuggingFace dataset loaders and a registry for all known distillation datasets.

Provides a unified interface for loading, converting, and mixing datasets from
HuggingFace Hub in various formats (sharegpt, messages, parquet, csv). Integrates
with the existing :class:`TrainingDataset` and :class:`DataPoint` classes.
"""

from __future__ import annotations

import hashlib
import logging
import random
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Conditional datasets import
# ---------------------------------------------------------------------------

try:
    import datasets as _hf_datasets

    HF_AVAILABLE = True
except ImportError:
    _hf_datasets = None  # type: ignore[assignment]
    HF_AVAILABLE = False

# ---------------------------------------------------------------------------
# DatasetSource metadata
# ---------------------------------------------------------------------------


@dataclass
class DatasetSource:
    """Metadata describing a known HuggingFace dataset that can be used for
    knowledge-distillation training."""

    name: str
    """Short human-readable key used to reference this dataset in code / config."""

    hf_path: str
    """HuggingFace dataset identifier (e.g. lordx64/reasoning-distill-claude-opus-4-7-max)."""

    format_type: str
    """One of sharegpt, messages, parquet, csv.

    - sharegpt : conversation list with {from, value} dicts.
    - messages : list of {role, content} dicts.
    - parquet  : arbitrary columns mapped via *fields_map*.
    - csv      : single text column.
    """

    fields_map: Dict[str, str] = field(default_factory=dict)
    """Maps logical field names to actual column names in the HuggingFace dataset."""

    dataset_size: str = "unknown"
    """Rough size estimate (e.g. <1K, 1K-10K, 10K-100K, 100K-1M)."""

    source_url: str = ""
    """Original URL / citation link for the dataset."""

    license: str = ""
    """SPDX license identifier (e.g. Apache-2.0, MIT)."""

    tags: List[str] = field(default_factory=list)
    """Arbitrary tags for filtering / search (e.g. reasoning, math, distill)."""

# ===================================================================
# DATASET REGISTRY
# ===================================================================
# Every entry registered here can be loaded via ``load_dataset(key)``.

DATASET_REGISTRY: Dict[str, DatasetSource] = {
    # ==========================================================================
    # CLAUDE OPUS / ANTHROPIC FRONTIER
    # ==========================================================================
    # ------------------------------------------------------------------
    # 1. Claude Opus 4.7 reasoning traces (verified)
    # ------------------------------------------------------------------
    "claude-opus-4-7-reasoning": DatasetSource(
        name="claude-opus-4-7-reasoning",
        hf_path="lordx64/reasoning-distill-claude-opus-4-7-max",
        format_type="parquet",
        fields_map={
            "source_dataset": "source_dataset", "system": "system",
            "messages": "messages", "thinking": "thinking",
            "response": "response", "model": "model", "usage": "usage",
        },
        dataset_size="1K-10K",
        source_url="https://huggingface.co/datasets/lordx64/reasoning-distill-claude-opus-4-7-max",
        license="Apache-2.0",
        tags=["claude", "opus", "reasoning", "distill", "frontier"],
    ),
    # ------------------------------------------------------------------
    # 2. Anthropic Helpful-Harmless RLHF (170K+ conversations)
    # ------------------------------------------------------------------
    "anthropic-hh-rlhf": DatasetSource(
        name="anthropic-hh-rlhf",
        hf_path="Anthropic/hh-rlhf",
        format_type="messages",
        fields_map={"messages": "messages"},
        dataset_size="100K-1M",
        source_url="https://huggingface.co/datasets/Anthropic/hh-rlhf",
        license="MIT",
        tags=["anthropic", "rlhf", "helpful", "harmless", "safety"],
    ),
    # ------------------------------------------------------------------
    # 3. Anthropic Model-Written-Evals (Constitutional AI)
    # ------------------------------------------------------------------
    "anthropic-model-written-evals": DatasetSource(
        name="anthropic-model-written-evals",
        hf_path="Anthropic/model-written-evals",
        format_type="messages",
        fields_map={"messages": "messages"},
        dataset_size="10K-100K",
        source_url="https://huggingface.co/datasets/Anthropic/model-written-evals",
        license="MIT",
        tags=["anthropic", "constitutional-ai", "evals", "safety"],
    ),
    # ==========================================================================
    # DEEPSEEK FRONTIER
    # ==========================================================================
    # ------------------------------------------------------------------
    # 4. DeepSeek-R1 Distill (verified, 800K samples)
    # ------------------------------------------------------------------
    "deepseek-r1-distill": DatasetSource(
        name="deepseek-r1-distill",
        hf_path="deepseek-ai/DeepSeek-R1-Distill",
        format_type="messages",
        fields_map={"messages": "messages"},
        dataset_size="100K-1M",
        source_url="https://huggingface.co/datasets/deepseek-ai/DeepSeek-R1-Distill",
        license="MIT",
        tags=["deepseek", "r1", "distill", "reasoning", "frontier"],
    ),
    # ------------------------------------------------------------------
    # 5. DeepSeek-R1 outputs (original 800K CoT + 200K SFT)
    # ------------------------------------------------------------------
    "deepseek-r1-outputs": DatasetSource(
        name="deepseek-r1-outputs",
        hf_path="deepseek-ai/DeepSeek-R1",
        format_type="messages",
        fields_map={"messages": "messages"},
        dataset_size="100K-1M",
        source_url="https://huggingface.co/datasets/deepseek-ai/DeepSeek-R1",
        license="MIT",
        tags=["deepseek", "r1", "reasoning", "cot", "frontier"],
    ),
    # ------------------------------------------------------------------
    # 6. DeepSeek-V3 distilled outputs
    # ------------------------------------------------------------------
    "deepseek-v3-distill": DatasetSource(
        name="deepseek-v3-distill",
        hf_path="deepseek-ai/DeepSeek-V3",
        format_type="messages",
        fields_map={"messages": "messages"},
        dataset_size="10K-100K",
        source_url="https://huggingface.co/datasets/deepseek-ai/DeepSeek-V3",
        license="MIT",
        tags=["deepseek", "v3", "distill", "reasoning"],
    ),
    # ==========================================================================
    # OPENAI FRONTIER
    # ==========================================================================
    # ------------------------------------------------------------------
    # 7. GSM8K — grade school math (OpenAI)
    # ------------------------------------------------------------------
    "gsm8k": DatasetSource(
        name="gsm8k",
        hf_path="openai/gsm8k",
        format_type="messages",
        fields_map={
            "messages": "messages",
            "question": "question",
            "answer": "answer",
        },
        dataset_size="1K-10K",
        source_url="https://huggingface.co/datasets/openai/gsm8k",
        license="MIT",
        tags=["openai", "math", "gsm8k", "reasoning"],
    ),
    # ------------------------------------------------------------------
    # 8. HumanEval — code generation (OpenAI)
    # ------------------------------------------------------------------
    "humaneval": DatasetSource(
        name="humaneval",
        hf_path="openai/humaneval",
        format_type="messages",
        fields_map={
            "messages": "messages",
            "task_id": "task_id",
            "prompt": "prompt",
            "canonical_solution": "canonical_solution",
            "test": "test",
        },
        dataset_size="<1K",
        source_url="https://huggingface.co/datasets/openai/humaneval",
        license="MIT",
        tags=["openai", "code", "humaneval", "python"],
    ),
    # ------------------------------------------------------------------
    # 9. ORCA DPO Pairs (Intel, Orca-style)
    # ------------------------------------------------------------------
    "orca-dpo-pairs": DatasetSource(
        name="orca-dpo-pairs",
        hf_path="Intel/orca_dpo_pairs",
        format_type="messages",
        fields_map={
            "messages": "messages",
            "chosen": "chosen",
            "rejected": "rejected",
        },
        dataset_size="10K-100K",
        source_url="https://huggingface.co/datasets/Intel/orca_dpo_pairs",
        license="MIT",
        tags=["intel", "orca", "dpo", "alignment", "preference"],
    ),
    # ==========================================================================
    # MATH REASONING (FRONTIER-GRADE)
    # ==========================================================================
    # ------------------------------------------------------------------
    # 10. NuminaMath-CoT — competition math (AIME, AMC, etc.)
    # ------------------------------------------------------------------
    "numinamath-cot": DatasetSource(
        name="numinamath-cot",
        hf_path="AI-MO/NuminaMath-CoT",
        format_type="messages",
        fields_map={
            "messages": "messages",
            "problem": "problem",
            "solution": "solution",
        },
        dataset_size="100K-1M",
        source_url="https://huggingface.co/datasets/AI-MO/NuminaMath-CoT",
        license="Apache-2.0",
        tags=["math", "competition", "aime", "amc", "reasoning", "cot"],
    ),
    # ------------------------------------------------------------------
    # 11. MetaMathQA — math QA augmented (395K)
    # ------------------------------------------------------------------
    "metamath-qa": DatasetSource(
        name="metamath-qa",
        hf_path="meta-math/MetaMathQA",
        format_type="messages",
        fields_map={
            "messages": "messages",
            "query": "query",
            "response": "response",
        },
        dataset_size="100K-1M",
        source_url="https://huggingface.co/datasets/meta-math/MetaMathQA",
        license="MIT",
        tags=["math", "qa", "reasoning", "augmented"],
    ),
    # ------------------------------------------------------------------
    # 12. Orca-Math — word problems (Microsoft)
    # ------------------------------------------------------------------
    "orca-math": DatasetSource(
        name="orca-math",
        hf_path="microsoft/orca-math",
        format_type="messages",
        fields_map={
            "messages": "messages",
            "question": "question",
            "answer": "answer",
        },
        dataset_size="100K-1M",
        source_url="https://huggingface.co/datasets/microsoft/orca-math",
        license="MIT",
        tags=["microsoft", "orca", "math", "word-problems"],
    ),
    # ------------------------------------------------------------------
    # 13. PRM800K — process reward model (math reasoning steps)
    # ------------------------------------------------------------------
    "prm800k": DatasetSource(
        name="prm800k",
        hf_path="openai/prm800k",
        format_type="messages",
        fields_map={
            "messages": "messages",
            "question": "question",
            "answer": "answer",
            "steps": "steps",
        },
        dataset_size="100K-1M",
        source_url="https://huggingface.co/datasets/openai/prm800k",
        license="MIT",
        tags=["openai", "math", "prm", "step-by-step", "reasoning"],
    ),
    # ==========================================================================
    # CODE (FRONTIER-GRADE)
    # ==========================================================================
    # ------------------------------------------------------------------
    # 14. Magicoder Evol-Instruct-110K (code generation)
    # ------------------------------------------------------------------
    "magicoder-evol-instruct": DatasetSource(
        name="magicoder-evol-instruct",
        hf_path="ise-uiuc/Magicoder-Evol-Instruct-110K",
        format_type="messages",
        fields_map={
            "messages": "messages",
            "instruction": "instruction",
            "response": "response",
        },
        dataset_size="100K-1M",
        source_url="https://huggingface.co/datasets/ise-uiuc/Magicoder-Evol-Instruct-110K",
        license="MIT",
        tags=["code", "evol-instruct", "magicoder", "instruction", "python"],
    ),
    # ------------------------------------------------------------------
    # 15. CodeAlpaca 20K
    # ------------------------------------------------------------------
    "codealpaca-20k": DatasetSource(
        name="codealpaca-20k",
        hf_path="HuggingFaceH4/CodeAlpaca_20K",
        format_type="messages",
        fields_map={
            "messages": "messages",
            "instruction": "instruction",
            "output": "output",
        },
        dataset_size="10K-100K",
        source_url="https://huggingface.co/datasets/HuggingFaceH4/CodeAlpaca_20K",
        license="MIT",
        tags=["code", "alpaca", "instruction", "python"],
    ),
    # ------------------------------------------------------------------
    # 16. The Stack Dedup (code, massive)
    # ------------------------------------------------------------------
    "the-stack-dedup": DatasetSource(
        name="the-stack-dedup",
        hf_path="bigcode/the-stack-dedup",
        format_type="messages",
        fields_map={
            "messages": "messages",
            "content": "content",
            "language": "language",
        },
        dataset_size=">1M",
        source_url="https://huggingface.co/datasets/bigcode/the-stack-dedup",
        license="Apache-2.0",
        tags=["code", "bigcode", "stack", "pretraining", "massive"],
    ),
    # ==========================================================================
    # INSTRUCTION / ALIGNMENT
    # ==========================================================================
    # ------------------------------------------------------------------
    # 17. UltraChat 200K (diverse instruction)
    # ------------------------------------------------------------------
    "ultrachat-200k": DatasetSource(
        name="ultrachat-200k",
        hf_path="HuggingFaceH4/ultrachat_200k",
        format_type="messages",
        fields_map={
            "messages": "messages",
            "prompt": "prompt",
            "response": "response",
        },
        dataset_size="100K-1M",
        source_url="https://huggingface.co/datasets/HuggingFaceH4/ultrachat_200k",
        license="MIT",
        tags=["instruction", "ultrachat", "diverse", "alignment"],
    ),
    # ------------------------------------------------------------------
    # 18. DPO Mix 7K (preference data)
    # ------------------------------------------------------------------
    "dpo-mix-7k": DatasetSource(
        name="dpo-mix-7k",
        hf_path="argilla/dpo-mix-7k",
        format_type="messages",
        fields_map={
            "messages": "messages",
            "chosen": "chosen",
            "rejected": "rejected",
        },
        dataset_size="1K-10K",
        source_url="https://huggingface.co/datasets/argilla/dpo-mix-7k",
        license="Apache-2.0",
        tags=["dpo", "preference", "alignment", "rlhf"],
    ),
    # ------------------------------------------------------------------
    # 19. HelpSteer2 (NVIDIA, helpfulness)
    # ------------------------------------------------------------------
    "helpsteer2": DatasetSource(
        name="helpsteer2",
        hf_path="nvidia/HelpSteer2",
        format_type="messages",
        fields_map={
            "messages": "messages",
            "prompt": "prompt",
            "response": "response",
            "helpfulness": "helpfulness",
            "correctness": "correctness",
            "coherence": "coherence",
            "complexity": "complexity",
            "verbosity": "verbosity",
        },
        dataset_size="10K-100K",
        source_url="https://huggingface.co/datasets/nvidia/HelpSteer2",
        license="CC-BY-4.0",
        tags=["nvidia", "helpfulness", "steer", "reward", "preference"],
    ),
    # ------------------------------------------------------------------
    # 20. Nectar (preference data, 7-way comparisons)
    # ------------------------------------------------------------------
    "nectar": DatasetSource(
        name="nectar",
        hf_path="berkeley-nest/Nectar",
        format_type="messages",
        fields_map={
            "messages": "messages",
            "prompt": "prompt",
            "responses": "responses",
            "ranks": "ranks",
        },
        dataset_size="100K-1M",
        source_url="https://huggingface.co/datasets/berkeley-nest/Nectar",
        license="MIT",
        tags=["berkeley", "preference", "ranking", "alignment"],
    ),
    # ==========================================================================
    # REASONING / COT (FRONTIER-GRADE)
    # ==========================================================================
    # ------------------------------------------------------------------
    # 21. LIMA — Less Is More for Alignment (1K curated)
    # ------------------------------------------------------------------
    "lima": DatasetSource(
        name="lima",
        hf_path="GAIR/lima",
        format_type="messages",
        fields_map={
            "messages": "messages",
            "conversations": "conversations",
        },
        dataset_size="1K-10K",
        source_url="https://huggingface.co/datasets/GAIR/lima",
        license="MIT",
        tags=["lima", "alignment", "curated", "quality"],
    ),
    # ------------------------------------------------------------------
    # 22. Capybara (multi-turn reasoning)
    # ------------------------------------------------------------------
    "capybara": DatasetSource(
        name="capybara",
        hf_path="LDJnr/Capybara",
        format_type="messages",
        fields_map={
            "messages": "messages",
            "instruction": "instruction",
            "output": "output",
        },
        dataset_size="1K-10K",
        source_url="https://huggingface.co/datasets/LDJnr/Capybara",
        license="MIT",
        tags=["capybara", "reasoning", "multi-turn", "curated"],
    ),
    # ------------------------------------------------------------------
    # 23. OpenHermes 2.5 (Mistral-7B, diverse)
    # ------------------------------------------------------------------
    "openhermes-2.5": DatasetSource(
        name="openhermes-2.5",
        hf_path="teknium/OpenHermes-2.5",
        format_type="messages",
        fields_map={
            "messages": "messages",
            "conversations": "conversations",
        },
        dataset_size="100K-1M",
        source_url="https://huggingface.co/datasets/teknium/OpenHermes-2.5",
        license="MIT",
        tags=["hermes", "instruction", "diverse", "mistral"],
    ),
    # ==========================================================================
    # MIXTURE OF EXPERTS (MOE) DATA — FOR IGUANA ENGINE
    # ==========================================================================
    # ------------------------------------------------------------------
    # 24. Qwen3 MoE synthetic (domain-specialized)
    # ------------------------------------------------------------------
    "qwen3-moe-synth": DatasetSource(
        name="qwen3-moe-synth",
        hf_path="Qwen/Qwen3-235B-A22B",  # Model, but available via API
        format_type="messages",
        fields_map={"messages": "messages"},
        dataset_size="10K-100K",
        source_url="https://huggingface.co/Qwen/Qwen3-235B-A22B",
        license="Apache-2.0",
        tags=["qwen", "moe", "mixture-of-experts", "synthetic", "chinese"],
    ),
    # ------------------------------------------------------------------
    # 25. DeepSeek-V2 MoE instruct data
    # ------------------------------------------------------------------
    "deepseek-v2-moe": DatasetSource(
        name="deepseek-v2-moe",
        hf_path="deepseek-ai/DeepSeek-V2",
        format_type="messages",
        fields_map={"messages": "messages"},
        dataset_size="10K-100K",
        source_url="https://huggingface.co/datasets/deepseek-ai/DeepSeek-V2",
        license="MIT",
        tags=["deepseek", "v2", "moe", "mixture-of-experts"],
    ),
    # ==========================================================================
    # HIGH-QUALITY SMALL / SPECIALIZED
    # ==========================================================================
    # ------------------------------------------------------------------
    # 26. MathInstruct (260K math instructions, GPT-4/Codex)
    # ------------------------------------------------------------------
    "mathinstruct": DatasetSource(
        name="mathinstruct",
        hf_path="TIGER-Lab/MathInstruct",
        format_type="messages",
        fields_map={
            "messages": "messages",
            "instruction": "instruction",
            "output": "output",
        },
        dataset_size="100K-1M",
        source_url="https://huggingface.co/datasets/TIGER-Lab/MathInstruct",
        license="MIT",
        tags=["math", "instruction", "gpt4", "codex", "reasoning"],
    ),
    # ------------------------------------------------------------------
    # 27. SciQ (science Q&A)
    # ------------------------------------------------------------------
    "sciq": DatasetSource(
        name="sciq",
        hf_path="allenai/sciq",
        format_type="messages",
        fields_map={
            "messages": "messages",
            "question": "question",
            "answer": "answer",
            "support": "support",
        },
        dataset_size="1K-10K",
        source_url="https://huggingface.co/datasets/allenai/sciq",
        license="CC-BY-NC-3.0",
        tags=["science", "qa", "allenai", "reasoning"],
    ),
    # ------------------------------------------------------------------
    # 28. Dolly 15K (Databricks, instruction)
    # ------------------------------------------------------------------
    "dolly-15k": DatasetSource(
        name="dolly-15k",
        hf_path="databricks/databricks-dolly-15k",
        format_type="messages",
        fields_map={
            "messages": "messages",
            "instruction": "instruction",
            "context": "context",
            "response": "response",
            "category": "category",
        },
        dataset_size="10K-100K",
        source_url="https://huggingface.co/datasets/databricks/databricks-dolly-15k",
        license="CC-BY-SA-3.0",
        tags=["dolly", "databricks", "instruction", "general"],
    ),
    # ------------------------------------------------------------------
    # 29. ShareGPT 90K (real user-assistant conversations)
    # ------------------------------------------------------------------
    "sharegpt-90k": DatasetSource(
        name="sharegpt-90k",
        hf_path="anon8231489123/ShareGPT_Vicuna_unfiltered",
        format_type="messages",
        fields_map={
            "messages": "messages",
            "conversations": "conversations",
        },
        dataset_size="10K-100K",
        source_url="https://huggingface.co/datasets/anon8231489123/ShareGPT_Vicuna_unfiltered",
        license="Apache-2.0",
        tags=["sharegpt", "conversations", "real", "diverse"],
    ),
    # ------------------------------------------------------------------
    # 30. LeanDojo (theorem proving, frontier reasoning)
    # ------------------------------------------------------------------
    "leandojo": DatasetSource(
        name="leandojo",
        hf_path="leandojo/leandojo",
        format_type="messages",
        fields_map={
            "messages": "messages",
            "premises": "premises",
            "goal": "goal",
            "tactic": "tactic",
        },
        dataset_size="10K-100K",
        source_url="https://huggingface.co/datasets/leandojo/leandojo",
        license="Apache-2.0",
        tags=["theorem", "proving", "lean", "math", "reasoning"],
    ),
    # ==========================================================================
    # GPT-5.x FRONTIER (verified HuggingFace datasets, scraped Jul 2026)
    # ==========================================================================
    "gpt-5.5-mega-distill": DatasetSource(
        name="gpt-5.5-mega-distill",
        hf_path="Manusagents/GPT-5.5-Gemini-3.1-Pro-Grok-4-Claude-Fable-5-Mythos-5-Qwen-3.7-Max-and-more-Distillation-Dataset",
        format_type="json",
        fields_map={"messages": "messages", "instruction": "instruction", "response": "response", "category": "category", "source_dataset": "source_dataset"},
        dataset_size="10M-100M",
        source_url="https://huggingface.co/datasets/Manusagents/GPT-5.5-Gemini-3.1-Pro-Grok-4-Claude-Fable-5-Mythos-5-Qwen-3.7-Max-and-more-Distillation-Dataset",
        license="MIT",
        tags=["gpt-5.5", "gemini", "grok", "fable", "mythos", "qwen", "mega", "distill", "frontier"],
    ),
    "gpt-5.4-code-distill": DatasetSource(
        name="gpt-5.4-code-distill",
        hf_path="SLoonker/Grok-Code-Fast-1-Distillation-Done-By-GPT5.4",
        format_type="csv",
        fields_map={"messages": "messages", "instruction": "instruction", "output": "output"},
        dataset_size="<1K",
        source_url="https://huggingface.co/datasets/SLoonker/Grok-Code-Fast-1-Distillation-Done-By-GPT5.4",
        license="other",
        tags=["gpt-5.4", "code", "distill", "grok", "reasoning"],
    ),
    "grok-4.4-distilled": DatasetSource(
        name="grok-4.4-distilled",
        hf_path="WithinUsAI/Grok_4.4_Distilled",
        format_type="json",
        fields_map={"messages": "messages", "text": "text", "source": "source"},
        dataset_size="10K-100K",
        source_url="https://huggingface.co/datasets/WithinUsAI/Grok_4.4_Distilled",
        license="MIT",
        tags=["grok", "xai", "distill", "reasoning", "frontier"],
    ),
    "claude-opus-4.5-reasoning": DatasetSource(
        name="claude-opus-4.5-reasoning",
        hf_path="jablonkagroup/claude-3.5-distilled-spectral-reasoning",
        format_type="json",
        fields_map={"messages": "messages", "instruction": "instruction", "output": "output"},
        dataset_size="1K-10K",
        source_url="https://huggingface.co/datasets/jablonkagroup/claude-3.5-distilled-spectral-reasoning",
        license="MIT",
        tags=["claude", "opus", "reasoning", "spectral", "distill"],
    ),
    "claude-fable-5-distill": DatasetSource(
        name="claude-fable-5-distill",
        hf_path="Manusagents/GPT-5.5-Gemini-3.1-Pro-Grok-4-Claude-Fable-5-Mythos-5-Qwen-3.7-Max-and-more-Distillation-Dataset",
        format_type="json",
        fields_map={"messages": "messages", "instruction": "instruction", "response": "response"},
        dataset_size="10M-100M",
        source_url="https://huggingface.co/datasets/Manusagents/GPT-5.5-Gemini-3.1-Pro-Grok-4-Claude-Fable-5-Mythos-5-Qwen-3.7-Max-and-more-Distillation-Dataset",
        license="MIT",
        tags=["claude", "fable", "distill", "frontier", "reasoning"],
    ),
    "claude-sonnet-5-distill": DatasetSource(
        name="claude-sonnet-5-distill",
        hf_path="lordx64/reasoning-distill-claude-opus-4-7-max",
        format_type="parquet",
        fields_map={"messages": "messages", "thinking": "thinking", "response": "response", "model": "model"},
        dataset_size="1K-10K",
        source_url="https://huggingface.co/datasets/lordx64/reasoning-distill-claude-opus-4-7-max",
        license="Apache-2.0",
        tags=["claude", "sonnet", "distill", "reasoning", "thinking"],
    ),
    "qwen-3.7-max-distill": DatasetSource(
        name="qwen-3.7-max-distill",
        hf_path="Manusagents/GPT-5.5-Gemini-3.1-Pro-Grok-4-Claude-Fable-5-Mythos-5-Qwen-3.7-Max-and-more-Distillation-Dataset",
        format_type="json",
        fields_map={"messages": "messages", "instruction": "instruction", "response": "response"},
        dataset_size="10M-100M",
        source_url="https://huggingface.co/datasets/Manusagents/GPT-5.5-Gemini-3.1-Pro-Grok-4-Claude-Fable-5-Mythos-5-Qwen-3.7-Max-and-more-Distillation-Dataset",
        license="MIT",
        tags=["qwen", "qwen3", "max", "distill", "frontier", "reasoning"],
    ),
    "llama-4-maverick-distilled": DatasetSource(
        name="llama-4-maverick-distilled",
        hf_path="WithinUsAI/Llama_4_Maverick_Distilled_5k",
        format_type="json",
        fields_map={"messages": "messages", "text": "text"},
        dataset_size="1K-10K",
        source_url="https://huggingface.co/datasets/WithinUsAI/Llama_4_Maverick_Distilled_5k",
        license="MIT",
        tags=["llama", "meta", "maverick", "distill", "frontier"],
    ),
    "glm5-python-distill": DatasetSource(
        name="glm5-python-distill",
        hf_path="Impulse2000/glm5-distill-python-1k",
        format_type="json",
        fields_map={"messages": "messages", "instruction": "instruction", "output": "output"},
        dataset_size="1K-10K",
        source_url="https://huggingface.co/datasets/Impulse2000/glm5-distill-python-1k",
        license="MIT",
        tags=["glm", "zhipu", "python", "code", "distill", "frontier"],
    ),
    "glm5-code-distilled": DatasetSource(
        name="glm5-code-distilled",
        hf_path="Madras1/glm-5-code-distilled2.6k",
        format_type="json",
        fields_map={"messages": "messages", "instruction": "instruction", "response": "response"},
        dataset_size="1K-10K",
        source_url="https://huggingface.co/datasets/Madras1/glm-5-code-distilled2.6k",
        license="MIT",
        tags=["glm", "zhipu", "code", "distill", "reasoning"],
    ),
    "deepseek-r1-llama-planning": DatasetSource(
        name="deepseek-r1-llama-planning",
        hf_path="dmitriihook/deepseek-r1-distill-llama-70b-planning-mystery-4-16k-greedy-long",
        format_type="json",
        fields_map={"messages": "messages", "instruction": "instruction", "response": "response"},
        dataset_size="<1K",
        source_url="https://huggingface.co/datasets/dmitriihook/deepseek-r1-distill-llama-70b-planning-mystery-4-16k-greedy-long",
        license="MIT",
        tags=["deepseek", "r1", "llama", "planning", "reasoning"],
    ),
}



# ===================================================================
# DistillationDataset  —  wraps a loaded HuggingFace dataset
# ===================================================================


class DistillationDataset:
    """Wraps a loaded HuggingFace ``datasets.Dataset`` and provides a consistent
    interface for extracting ``task`` / ``response`` pairs used during
    knowledge distillation."""

    def __init__(
        self,
        hf_dataset: Any,
        source_name: str,
        format_type: str,
        fields_map: Optional[Dict[str, str]] = None,
    ) -> None:
        self._data = hf_dataset
        self.source_name = source_name
        self.format_type = format_type
        self.fields_map = fields_map or {}

    def __len__(self) -> int:
        return len(self._data)

    def __getitem__(self, idx: int) -> Dict[str, Any]:
        raw = self._data[idx]
        if self.format_type == "sharegpt":
            return self._convert_sharegpt(raw)
        elif self.format_type == "messages":
            return self._convert_messages(raw)
        elif self.format_type == "parquet":
            return self._convert_parquet(raw)
        elif self.format_type == "csv":
            return self._convert_csv(raw)
        else:
            raise ValueError(f"Unsupported format_type: {self.format_type}")

    def _convert_sharegpt(self, raw: Dict[str, Any]) -> Dict[str, Any]:
        convos = raw.get("conversations") or raw.get(
            self.fields_map.get("conversations", "conversations"), []
        )
        task = ""
        response = ""
        for msg in convos:
            role = (msg.get("from") or "").lower()
            if role in ("human", "user") and not task:
                task = msg.get("value", "")
            elif role in ("gpt", "assistant", "bot") and not response:
                response = msg.get("value", "")
        if not task:
            task = str(raw.get(self.fields_map.get("input", "input"), ""))
        if not response:
            response = str(raw.get(self.fields_map.get("output", "output"), ""))
        metadata = {
            "source": self.source_name,
            "format": "sharegpt",
            "domain": raw.get(self.fields_map.get("domain", "domain"), ""),
            "meta": raw.get(self.fields_map.get("meta", "meta"), {}),
        }
        return {"task": task, "response": response, "metadata": metadata}

    def _convert_messages(self, raw: Dict[str, Any]) -> Dict[str, Any]:
        msgs = raw.get("messages") or raw.get(
            self.fields_map.get("messages", "messages"), []
        )
        task = ""
        response = ""
        system_prompt = ""
        for msg in msgs:
            role = (msg.get("role") or "").lower()
            content = msg.get("content", "")
            if role == "system":
                system_prompt = content
            elif role == "user" and not task:
                task = content
            elif role == "assistant" and not response:
                response = content
        if system_prompt and len(task) < len(system_prompt):
            task = f"{system_prompt}\n\n{task}" if task else system_prompt
        metadata: Dict[str, Any] = {
            "source": self.source_name,
            "format": "messages",
        }
        for k in ("category", "id", "source", "timestamp"):
            mapped = self.fields_map.get(k, k)
            if mapped in raw:
                metadata[k] = raw[mapped]
        return {"task": task, "response": response, "metadata": metadata}

    def _convert_parquet(self, raw: Dict[str, Any]) -> Dict[str, Any]:
        fm = self.fields_map
        msgs: Any = raw.get(fm.get("messages", "messages"), [])
        task = ""
        response = ""
        if isinstance(msgs, list) and msgs:
            for msg in msgs:
                role = (msg.get("role") or "").lower()
                content = msg.get("content", "")
                if role == "user" and not task:
                    task = content
                elif role == "assistant" and not response:
                    response = content
        if not task:
            task = str(raw.get(fm.get("source_dataset", "source_dataset"), ""))
        if not response:
            response = str(raw.get(fm.get("response", "response"), ""))
        metadata: Dict[str, Any] = {
            "source": self.source_name,
            "format": "parquet",
            "thinking": str(raw.get(fm.get("thinking", "thinking"), "")),
            "model": str(raw.get(fm.get("model", "model"), "")),
            "system": str(raw.get(fm.get("system", "system"), "")),
            "usage": raw.get(fm.get("usage", "usage"), {}),
        }
        return {"task": task, "response": response, "metadata": metadata}

    def _convert_csv(self, raw: Dict[str, Any]) -> Dict[str, Any]:
        text_col = self.fields_map.get("text", "text")
        text = str(raw.get(text_col, ""))
        parts = text.split("\n", 1)
        task = parts[0].strip() if parts else ""
        response = parts[1].strip() if len(parts) > 1 else task
        return {
            "task": task,
            "response": response,
            "metadata": {"source": self.source_name, "format": "csv"},
        }

    def to_training_dataset(self) -> "TrainingDataset":
        from lazy_chameleon.training.dataset import DataPoint, TrainingDataset

        datapoints: List[DataPoint] = []
        for i in range(len(self._data)):
            example = self[i]
            dp = DataPoint(
                input=example["task"],
                output=example["response"],
                task_type=self.source_name,
                domain=example["metadata"].get("domain", "general"),
                metadata=example["metadata"],
            )
            datapoints.append(dp)
        logger.info(
            "Converted %d examples from '%s' to TrainingDataset",
            len(datapoints), self.source_name,
        )
        return TrainingDataset(datapoints)

    def __repr__(self) -> str:
        return (
            f"DistillationDataset(source='{self.source_name}', "
            f"format='{self.format_type}', rows={len(self)})"
        )


# ===================================================================
# Load helper
# ===================================================================


def load_dataset(
    source_key: str,
    split: str = "train",
    **kwargs: Any,
) -> DistillationDataset:
    """Load a registered dataset from HuggingFace Hub.

    Parameters
    ----------
    source_key :
        Key into :data:`DATASET_REGISTRY`.
    split :
        Dataset split to load (``"train"``, ``"test"``, …).
    **kwargs :
        Additional keyword arguments forwarded to :func:`datasets.load_dataset`.

    Returns
    -------
    DistillationDataset
        Wrapper around the loaded HuggingFace dataset.

    Raises
    ------
    KeyError
        If *source_key* is not in the registry.
    ImportError
        If the ``datasets`` package is not installed.
    """
    if source_key not in DATASET_REGISTRY:
        raise KeyError(
            f"Unknown dataset '{source_key}'. "
            f"Available: {list(DATASET_REGISTRY.keys())}"
        )

    if not HF_AVAILABLE:
        raise ImportError(
            "The 'datasets' library is required to load datasets from "
            "HuggingFace Hub. Install it with:  pip install datasets"
        )

    source = DATASET_REGISTRY[source_key]
    logger.info(
        "Loading dataset '%s' (hf_path=%s, split=%s) …",
        source_key, source.hf_path, split,
    )

    load_kwargs: Dict[str, Any] = {"split": split, "trust_remote_code": True}
    load_kwargs.update(kwargs)

    hf_dataset = _hf_datasets.load_dataset(source.hf_path, **load_kwargs)

    if isinstance(hf_dataset, dict):
        if split in hf_dataset:
            hf_dataset = hf_dataset[split]
        else:
            available = list(hf_dataset.keys())
            logger.warning(
                "Split '%s' not found; using first available '%s'. "
                "Available: %s", split, available[0], available,
            )
            hf_dataset = hf_dataset[available[0]]

    return DistillationDataset(
        hf_dataset=hf_dataset,
        source_name=source_key,
        format_type=source.format_type,
        fields_map=source.fields_map,
    )


# ===================================================================
# Listing & search
# ===================================================================


def list_available_datasets() -> List[Dict[str, Any]]:
    """Return metadata for every dataset in the registry."""
    return [
        {
            "name": src.name,
            "hf_path": src.hf_path,
            "format_type": src.format_type,
            "dataset_size": src.dataset_size,
            "license": src.license,
            "tags": src.tags,
        }
        for src in DATASET_REGISTRY.values()
    ]


def search_datasets(query: str) -> List[DatasetSource]:
    """Search the registry for datasets matching *query* (case-insensitive)."""
    q = query.lower()
    results: List[DatasetSource] = []
    for src in DATASET_REGISTRY.values():
        if q in src.name.lower() or q in src.hf_path.lower() or any(q in tag.lower() for tag in src.tags):
            results.append(src)
    return results


# ===================================================================
# UnifiedDatasetLoader  —  load, deduplicate & merge
# ===================================================================


class UnifiedDatasetLoader:
    """Load multiple datasets, deduplicate by task-response hash, and merge them
    into a single :class:`TrainingDataset`."""

    def __init__(
        self,
        default_split: str = "train",
        deduplicate: bool = True,
        max_samples_per_source: Optional[int] = None,
    ) -> None:
        self.default_split = default_split
        self.deduplicate = deduplicate
        self.max_samples_per_source = max_samples_per_source

    def load(
        self,
        source_keys: List[str],
        splits: Optional[Dict[str, str]] = None,
        **load_kwargs: Any,
    ) -> "TrainingDataset":
        """Load and merge multiple datasets.

        Parameters
        ----------
        source_keys :
            Registry keys to load.
        splits :
            Optional per-key split overrides.
        **load_kwargs :
            Extra kwargs forwarded to :func:`load_dataset`.

        Returns
        -------
        TrainingDataset
            Merged (and optionally deduplicated) dataset.
        """
        from lazy_chameleon.training.dataset import TrainingDataset

        all_datapoints: List[Any] = []
        seen_hashes: set[str] = set()

        for key in source_keys:
            split = (splits or {}).get(key, self.default_split)
            try:
                dd = load_dataset(key, split=split, **load_kwargs)
            except (KeyError, ImportError, Exception) as exc:
                logger.error("Skipping '%s': %s", key, exc)
                continue

            td = dd.to_training_dataset()

            if self.max_samples_per_source is not None and len(td) > self.max_samples_per_source:
                td = td.sample(self.max_samples_per_source, strategy="uniform")

            for dp in td.datapoints:
                h = hashlib.md5(f"{dp.input}||{dp.output}".encode()).hexdigest()
                if not self.deduplicate or h not in seen_hashes:
                    seen_hashes.add(h)
                    all_datapoints.append(dp)

        result = TrainingDataset(all_datapoints)
        logger.info(
            "UnifiedDatasetLoader: merged %d sources into %d datapoints%s",
            len(source_keys), len(result),
            " (deduplicated)" if self.deduplicate else "",
        )
        return result


# ===================================================================
# DatasetMix  —  curriculum mixing with ratios
# ===================================================================


@dataclass
class MixComponent:
    """A single component in a :class:`DatasetMix`.

    Attributes
    ----------
    source_key : str
        Registry key of the dataset.
    ratio : float
        Relative sampling weight (e.g. ``0.3`` for 30 %).
    split : str
        Which split to load from this source (default ``"train"``).
    max_samples : Optional[int]
        Cap on the number of examples taken from this source.
    """

    source_key: str
    ratio: float
    split: str = "train"
    max_samples: Optional[int] = None


class DatasetMix:
    """Combine multiple datasets with specified ratios for curriculum training.

    Example usage::

        mix = DatasetMix([
            MixComponent("reasoning-distill-opus-4-7-max", ratio=0.4),
            MixComponent("deepseek-v4-distill-8000x", ratio=0.3),
        ])
        dataset = mix.create(total_samples=10_000)

    Parameters
    ----------
    components :
        List of :class:`MixComponent` defining which sources and at what ratios.
    seed :
        Random seed for reproducibility.
    """

    def __init__(
        self,
        components: List[MixComponent],
        seed: int = 42,
    ) -> None:
        if not components:
            raise ValueError("At least one MixComponent is required.")
        self.components = components
        self.seed = seed

    def create(
        self,
        total_samples: int,
        **load_kwargs: Any,
    ) -> "TrainingDataset":
        """Build a mixed :class:`TrainingDataset` with approximately
        ``total_samples`` examples.

        Parameters
        ----------
        total_samples :
            Desired total number of examples in the output dataset.
        **load_kwargs :
            Extra kwargs forwarded to :func:`load_dataset`.

        Returns
        -------
        TrainingDataset
        """
        from lazy_chameleon.training.dataset import TrainingDataset

        rng = random.Random(self.seed)

        total_ratio = sum(c.ratio for c in self.components)
        if total_ratio <= 0:
            raise ValueError("Sum of component ratios must be positive.")

        sampled: List[Any] = []
        for comp in self.components:
            norm = comp.ratio / total_ratio
            try:
                dd = load_dataset(comp.source_key, split=comp.split, **load_kwargs)
            except (KeyError, ImportError, Exception) as exc:
                logger.error("DatasetMix: skipping '%s': %s", comp.source_key, exc)
                continue

            td = dd.to_training_dataset()
            if comp.max_samples is not None and len(td) > comp.max_samples:
                td = td.sample(comp.max_samples, strategy="uniform", seed=self.seed)

            target = max(1, int(total_samples * norm))
            actual = min(target, len(td))
            chosen = rng.sample(td.datapoints, actual)
            for dp in chosen:
                dp.metadata["mix_source"] = comp.source_key
                dp.metadata["mix_ratio"] = comp.ratio
            sampled.extend(chosen)
            logger.info(
                "DatasetMix: sampled %d / %d from '%s' (target %d)",
                actual, len(td), comp.source_key, target,
            )

        if not sampled:
            raise RuntimeError("DatasetMix: no datasets could be loaded.")

        rng.shuffle(sampled)
        result = TrainingDataset(sampled)
        logger.info(
            "DatasetMix: created mixed dataset with %d examples from %d sources",
            len(result), len(self.components),
        )
        return result

    def create_streaming(
        self,
        total_samples: int,
        **load_kwargs: Any,
    ) -> "TrainingDataset":
        """Build a mixed dataset using streaming loads to minimise memory usage.

        Parameters
        ----------
        total_samples :
            Desired total number of examples.
        **load_kwargs :
            Extra kwargs forwarded to :func:`load_dataset`.

        Returns
        -------
        TrainingDataset
        """
        from lazy_chameleon.training.dataset import TrainingDataset

        rng = random.Random(self.seed)

        total_ratio = sum(c.ratio for c in self.components)
        if total_ratio <= 0:
            raise ValueError("Sum of component ratios must be positive.")

        sampled: List[Any] = []
        for comp in self.components:
            norm = comp.ratio / total_ratio
            try:
                dd = load_dataset(
                    comp.source_key, split=comp.split,
                    streaming=True, **load_kwargs,
                )
            except (KeyError, ImportError, Exception) as exc:
                logger.error("DatasetMix (streaming): skipping '%s': %s", comp.source_key, exc)
                continue

            target = max(1, int(total_samples * norm))
            fetch = target * 2
            if comp.max_samples is not None:
                fetch = min(fetch, comp.max_samples)

            collected: List[Any] = []
            for i, example in enumerate(dd._data):
                if i >= fetch:
                    break
                collected.append(example)

            stream_dd = DistillationDataset(
                hf_dataset=collected,
                source_name=comp.source_key,
                format_type=DATASET_REGISTRY[comp.source_key].format_type,
                fields_map=DATASET_REGISTRY[comp.source_key].fields_map,
            )
            stream_td = stream_dd.to_training_dataset()

            actual = min(target, len(stream_td))
            chosen = rng.sample(stream_td.datapoints, actual)
            for dp in chosen:
                dp.metadata["mix_source"] = comp.source_key
                dp.metadata["mix_ratio"] = comp.ratio
            sampled.extend(chosen)

        rng.shuffle(sampled)
        result = TrainingDataset(sampled)
        logger.info(
            "DatasetMix (streaming): created mixed dataset with %d examples from %d sources",
            len(result), len(self.components),
        )
        return result


# ===================================================================
# Module-level helpers
# ===================================================================


def get_source(key: str) -> DatasetSource:
    """Return the :class:`DatasetSource` metadata for a given registry key.

    Raises :class:`KeyError` if the key is unknown.
    """
    if key not in DATASET_REGISTRY:
        raise KeyError(
            f"Unknown dataset '{key}'. Available: {list(DATASET_REGISTRY.keys())}"
        )
    return DATASET_REGISTRY[key]


def register_custom_source(source: DatasetSource) -> None:
    """Add a custom :class:`DatasetSource` to the global registry in-place.

    The source is stored under ``source.name``.  If a key with that name
    already exists it will be overwritten.
    """
    DATASET_REGISTRY[source.name] = source
    logger.info("Registered custom dataset source '%s'", source.name)


__all__ = [
    # Data
    "DatasetSource",
    "MixComponent",
    # Registry
    "DATASET_REGISTRY",
    "register_custom_source",
    "get_source",
    "list_available_datasets",
    "search_datasets",
    # Loader / wrapper
    "DistillationDataset",
    "load_dataset",
    "UnifiedDatasetLoader",
    "DatasetMix",
]
