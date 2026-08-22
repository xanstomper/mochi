"""Lazy Chameleon Data — Hardcoded datasets organized by domain and model."""
from __future__ import annotations
from typing import Any, Dict, List
import importlib

DOMAINS = ["math", "code", "reasoning", "science", "design", "security", "general"]


def get_domain(domain: str) -> Dict[str, List[Dict[str, Any]]]:
    """Get all examples for a domain, organized by model."""
    try:
        mod = importlib.import_module(f"lazy_chameleon.data.hardcoded.{domain}")
        result = {}
        for attr in mod.__all__:
            result[attr] = getattr(mod, attr)
        return result
    except (ImportError, AttributeError):
        return {}


def get_model_examples(model: str, domain: str = None) -> List[Dict[str, Any]]:
    """Get examples for a specific model, optionally filtered by domain."""
    if domain:
        try:
            mod = importlib.import_module(f"lazy_chameleon.data.hardcoded.{domain}.{model}")
            var = model + "_" + domain + "_examples"
            return getattr(mod, var, [])
        except ImportError:
            return []
    all_examples = []
    for d in DOMAINS:
        all_examples.extend(get_model_examples(model, d))
    return all_examples


def get_training_pairs(model=None, domain=None) -> List[Dict[str, str]]:
    """Get flattened instruction/response pairs."""
    pairs = []
    if domain:
        data = get_domain(domain)
        for var_name, examples in data.items():
            if model and model not in var_name:
                continue
            for ex in examples:
                pairs.append({"instruction": ex["instruction"], "response": ex["response"]})
    else:
        for d in DOMAINS:
            pairs.extend(get_training_pairs(model=model, domain=d))
    return pairs


def get_summary() -> Dict[str, Dict[str, int]]:
    """Get counts per model per domain."""
    summary = {}
    for d in DOMAINS:
        data = get_domain(d)
        for var_name, examples in data.items():
            model = var_name.replace("_" + d + "_examples", "")
            if model not in summary:
                summary[model] = {}
            summary[model][d] = len(examples)
    return summary

def count_all() -> int:
    total = 0
    for d in DOMAINS:
        data = get_domain(d)
        for examples in data.values():
            total += len(examples)
    return total


if __name__ == "__main__":
    s = get_summary()
    total = count_all()
    print("HARDCODED DISTILLED DATASETS")
    print("Domain-organized files in data/hardcoded/{domain}/{model}.py")
    print()
    print(f"{'Model':25s} {'Ex':6s} {'Domains'}")
    print("-" * 50)
    for model, domains in sorted(s.items(), key=lambda x: -sum(x[1].values())):
        ex = sum(domains.values())
        doms = ", ".join(f"{k}:{v}" for k, v in sorted(domains.items()))
        print(f"{model:25s} {ex:4d}  {doms}")
    print(f"Total: {total} examples")
