"""LongCat-2 and OWL-Alpha dataset registry entries.
Auto-combined with main registry via dataset_registry_final.py"""
from __future__ import annotations
from typing import Any, Dict, List
from lazy_chameleon.training.dataset_registry import DatasetSource

LONGCAT_OWL_ENTRIES: Dict[str, DatasetSource] = {
    "longcat-larybench": DatasetSource(
        name="longcat-larybench",
        hf_path="meituan-longcat/LARYBench",
        format_type="json",
        fields_map={"messages": "messages"},
        dataset_size="1K-10K",
        source_url="https://huggingface.co/meituan-longcat/LARYBench",
        license="MIT",
        tags=["longcat", "reasoning", "long-context", "meituan"],
    ),
    "longcat-corecodebench": DatasetSource(
        name="longcat-corecodebench",
        hf_path="meituan-longcat/CoreCodeBench-Single",
        format_type="json",
        fields_map={"messages": "messages"},
        dataset_size="1K-10K",
        source_url="https://huggingface.co/meituan-longcat/CoreCodeBench-Single",
        license="MIT",
        tags=["longcat", "code", "benchmark", "meituan"],
    ),
    "longcat-wbench": DatasetSource(
        name="longcat-wbench",
        hf_path="meituan-longcat/WBench",
        format_type="json",
        fields_map={"messages": "messages"},
        dataset_size="1K-10K",
        source_url="https://huggingface.co/meituan-longcat/WBench",
        license="MIT",
        tags=["longcat", "video", "multi-turn", "meituan"],
    ),
    "owl-alpha-qwen-7b": DatasetSource(
        name="owl-alpha-qwen-7b",
        hf_path="GMorgulis/Qwen2.5-7B-Instruct-owl-alpha3.5-layer16-end-ft0.42",
        format_type="json",
        fields_map={"messages": "messages"},
        dataset_size="1K-10K",
        source_url="https://huggingface.co/GMorgulis/Qwen2.5-7B-Instruct-owl-alpha3.5-layer16-end-ft0.42",
        license="MIT",
        tags=["owl-alpha", "distillation", "qwen", "layer-wise"],
    ),
    "owl-alpha-gemma-4b": DatasetSource(
        name="owl-alpha-gemma-4b",
        hf_path="GMorgulis/gemma-3-4b-it-owl-alpha-135-layer15-end-ft0.42",
        format_type="json",
        fields_map={"messages": "messages"},
        dataset_size="1K-10K",
        source_url="https://huggingface.co/GMorgulis/gemma-3-4b-it-owl-alpha-135-layer15-end-ft0.42",
        license="MIT",
        tags=["owl-alpha", "distillation", "gemma", "layer-wise"],
    ),
    "owl-alpha-llama-3b": DatasetSource(
        name="owl-alpha-llama-3b",
        hf_path="GMorgulis/Llama-3.2-3B-Instruct-owl-alpha-0.35-layer15-end-ft0.43",
        format_type="json",
        fields_map={"messages": "messages"},
        dataset_size="1K-10K",
        source_url="https://huggingface.co/GMorgulis/Llama-3.2-3B-Instruct-owl-alpha-0.35-layer15-end-ft0.43",
        license="MIT",
        tags=["owl-alpha", "distillation", "llama", "layer-wise"],
    ),
}
