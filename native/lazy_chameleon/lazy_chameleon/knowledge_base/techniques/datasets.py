"""All datasets used by frontier models."""
from __future__ import annotations
from typing import Any, Dict, List


FRONTIER_DATASETS = {
    "pretraining": [
        {"name": "Common Crawl", "size": "~50B pages", "used_by": ["GPT", "Claude", "Grok", "Qwen", "Llama"]},
        {"name": "Wikipedia", "size": "~6M articles, 100+ languages", "used_by": ["ALL"]},
        {"name": "BooksCorpus", "size": "~7M books", "used_by": ["GPT", "Claude", "Grok"]},
        {"name": "GitHub Code", "size": "~200M repos", "used_by": ["ALL"]},
        {"name": "arXiv Papers", "size": "~2M papers", "used_by": ["ALL"]},
        {"name": "Stack Exchange", "size": "~20M Q&A", "used_by": ["GPT", "Claude", "DeepSeek"]},
        {"name": "Reddit Comments", "size": "~5B comments", "used_by": ["GPT"]},
        {"name": "Chinese Web (Baidu)", "size": "~10B pages", "used_by": ["Qwen", "GLM"]},
        {"name": "X/Twitter Feed", "size": "Real-time", "used_by": ["Grok"]},
        {"name": "YouTube Transcripts", "size": "~1B hours", "used_by": ["Gemini", "GPT-5"]},
    ],
    "instruction": [
        {"name": "ShareGPT", "size": "~1M conversations", "used_by": ["GPT", "Claude"]},
        {"name": "OpenAssistant", "size": "~161K conversations", "used_by": ["Open-source models"]},
        {"name": "Synthetic Instructions (Self-Instruct)", "size": "Varies (can generate unlimited)", "used_by": ["ALL"]},
        {"name": "Evol-Instruct Data", "size": "~250K evolving instructions", "used_by": ["WizardLM family"]},
        {"name": "Constitutional AI Data", "size": "Proprietary", "used_by": ["Claude"]},
        {"name": "RLHF Comparison Data", "size": "~1M comparisons", "used_by": ["GPT", "Claude"]},
    ],
    "reasoning": [
        {"name": "MATH Dataset", "size": "~12K problems", "used_by": ["ALL"]},
        {"name": "GSM8K", "size": "~8K math word problems", "used_by": ["ALL"]},
        {"name": "CodeContests", "size": "~13K competitive programming", "used_by": ["DeepSeek", "GPT"]},
        {"name": "Synthetic Reasoning Traces", "size": "Can generate millions", "used_by": ["DeepSeek-R1", "GPT-o"]},
        {"name": "Proof-Pile", "size": "~8B tokens of math proofs", "used_by": ["DeepSeek", "GPT"]},
    ],
    "multilingual": [
        {"name": "Chinese Web Corpus", "size": "~10T tokens", "used_by": ["Qwen", "GLM"]},
        {"name": "mC4 (multilingual C4)", "size": "~6.3T tokens, 101 languages", "used_by": ["Qwen", "GLM"]},
        {"name": "CC-100 (CommonCrawl 100 langs)", "size": "~100T tokens", "used_by": ["Qwen"]},
    ],
}

MODEL_COMPARISON = {
    "gpt_5_6_sol": {
        "params": "~2.5T",
        "active": "~500B",
        "context": "1M",
        "experts": 128,
        "active_per_token": 12,
        "architecture": "SOL-MoE",
        "cost_per_m_tokens": "$100-200",
        "strengths": ["Reasoning", "Agentic", "Tool use", "Multi-modal"],
        "training_tokens": "~30T",
    },
    "claude_opus_4_8": {
        "params": "~1-2T",
        "active": "~200-400B",
        "context": "200K",
        "experts": "Moderate MoE",
        "active_per_token": "~8",
        "architecture": "Transformer + MoE",
        "cost_per_m_tokens": "$60-120",
        "strengths": ["Safety", "Nuance", "Long context", "Constitutional"],
        "training_tokens": "~10-15T",
    },
    "grok_4_5": {
        "params": "~2T",
        "active": "~500B",
        "context": "500K",
        "experts": "64+",
        "active_per_token": "~8",
        "architecture": "MoE + Real-time",
        "cost_per_m_tokens": "$40-80",
        "strengths": ["Real-time", "Personality", "X integration"],
        "training_tokens": "~15-20T",
    },
    "qwen_3_7_max": {
        "params": "~1T total",
        "active": "~400B",
        "context": "131K",
        "experts": 64,
        "active_per_token": 8,
        "architecture": "Native MoE",
        "cost_per_m_tokens": "$10-20",
        "strengths": ["Multilingual", "Cost-effective", "Chinese"],
        "training_tokens": "~10T",
    },
    "deepseek_r1": {
        "params": "671B",
        "active": "37B",
        "context": "131K",
        "experts": 256,
        "active_per_token": 8,
        "architecture": "Fine-Grained MoE + MLA",
        "cost_per_m_tokens": "$1-5",
        "strengths": ["Reasoning", "Cost-effective", "Math", "Code"],
        "training_tokens": "14.8T",
    },
    "glm_5_2": {
        "params": "~200B",
        "active": "~200B",
        "context": "262K",
        "experts": "Partial MoE",
        "active_per_token": "All",
        "architecture": "Bidirectional Prefix + MoE",
        "cost_per_m_tokens": "$8-15",
        "strengths": ["Bilingual", "Understanding", "Long context"],
        "training_tokens": "~5T",
    },
}



