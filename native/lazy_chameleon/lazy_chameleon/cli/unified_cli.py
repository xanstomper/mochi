"""Lazy Chameleon Unified CLI — One singular CLI that ANY LLM can use as a tool.

Every module in the entire Lazy Chameleon ecosystem is exposed as a subcommand.
All output is available in JSON mode for LLM consumption.

Usage:
    chameleon <module> <action> [options] [--json]
    
Modules:
    enhance       Generate synthetic context (original)
    prompts       Browse/search/show leaked system prompts
    data          Access all datasets (hardcoded + registry)
    models        List/query all supported models
    brew          Brew data using distillation pots
    moe           Control MoE expert splitting/merging
    distill       Run distillation pipelines
    token-saver   Optimize prompts for token efficiency
    engines       Run inference engines
    wrappers      Use provider wrappers (single model, no fallback)
    frameworks    Run evaluation/testing frameworks
    methodology   Apply prompt/training methods
    synthesizers  Generate synthetic data/prompts
    longcat       Use LongCat-2 MoE framework
    owl-alpha     Use OWL-Alpha distillation
    tokenize      Optimize tokenization per domain
    research      Access all research data (architectures, techniques, datasets)
    config        View/export configuration
"""

import argparse
import json
import sys
import os
from typing import Any, Dict, List, Optional


def _output(result: Any, json_mode: bool):
    if json_mode:
        print(json.dumps(result, default=str, separators=(",",":"), ensure_ascii=False))
    else:
        if isinstance(result, dict):
            for k, v in result.items():
                if isinstance(v, dict):
                    print(f"\n{k}:")
                    for sk, sv in v.items():
                        print(f"  {sk}: {sv}")
                elif isinstance(v, list):
                    print(f"\n{k}:")
                    for item in v[:10]:
                        print(f"  - {item}")
                    if len(v) > 5:
                        print(f"  ... {len(v)-5} more")
                else:
                    print(f"{k}: {v}")
        else:
            print(result)


def build_parser():
    parser = argparse.ArgumentParser(
        prog="chameleon",
        description="LC v2.6 — Universal LLM tools",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Any LLM can use. --json for compact output.",
    )
    parser.add_argument("--json", action="store_true", help="JSON output")
    parser.add_argument("--quiet", action="store_true", help="Compact mode")
    sub = parser.add_subparsers(dest="command", help="Module to use")
    
    # ── enhance ──
    enh = sub.add_parser("enhance", help="Synth context")
    enh.add_argument("task", nargs="?", help="Task description")
    enh.add_argument("--mode", choices=["easy", "medium", "hard", "extreme"], default="medium")
    enh.add_argument("--domain", default="general", help="Domain: math, code, reasoning, etc")
    enh.add_argument("--stats", action="store_true", help="Show enhancement statistics")
    
    # ── prompts ──
    prompts = sub.add_parser("prompts", help="Browse/search leaked prompts")
    prompts.add_argument("action", choices=["browse", "search", "show", "stats", "providers", "models"])
    prompts.add_argument("--provider", help="Filter by provider")
    prompts.add_argument("--model", help="Filter by model")
    prompts.add_argument("--query", help="Search query")
    prompts.add_argument("--path", help="Path to prompt to show")
    prompts.add_argument("--max", type=int, default=10, help="Max search results")
    
    # ── data ──
    data = sub.add_parser("data", help="Access all datasets")
    data.add_argument("action", choices=["list", "get", "search", "summary", "download"])
    data.add_argument("--domain", help="Filter by domain")
    data.add_argument("--model", help="Filter by model")
    data.add_argument("--query", help="Search query")
    data.add_argument("--key", help="Dataset registry key")
    data.add_argument("--samples", type=int, default=10, help="Number of samples")
    
    # ── models ──
    models = sub.add_parser("models", help="List/query models")
    models.add_argument("action", choices=["list", "get", "compare"], default="list", nargs="?")
    models.add_argument("--provider", help="Filter by provider")
    models.add_argument("--name", help="Model name")
    
    # ── brew ──
    brew = sub.add_parser("brew", help="Brew data via pots")
    brew.add_argument("action", choices=["start", "brew", "pour", "stats", "recipe"], default="stats")
    brew.add_argument("--pots", type=int, default=8, help="Number of distillation pots")
    brew.add_argument("--domain", default="general", help="Brewing domain")
    brew.add_argument("--samples", type=int, default=50, help="Samples to brew")
    brew.add_argument("--recipe", choices=["light", "standard", "rich", "dark", "special_reserve"], default="standard")
    
    # ── moe ──
    moe = sub.add_parser("moe", help="Control MoE split/merge")
    moe.add_argument("action", choices=["start", "split", "merge", "work", "brew", "stats", "report"], default="stats")
    moe.add_argument("--cells", type=int, default=4, help="Number of cells to split into")
    moe.add_argument("--mass", type=float, default=100.0, help="Initial MoE mass")
    moe.add_argument("--task", help="Task for cells to work on")
    moe.add_argument("--cell-id", help="Cell ID to operate on")
    moe.add_argument("--child-ids", nargs="*", help="Child cell IDs to merge")
    
    # ── distill ──
    distill = sub.add_parser("distill", help="Run distillation")
    distill.add_argument("action", choices=["run", "multi-teacher", "progressive", "online", "self", "list"], default="list")
    distill.add_argument("--teacher", help="Teacher model")
    distill.add_argument("--student", help="Student model")
    distill.add_argument("--dataset", help="Dataset path")
    distill.add_argument("--alpha", type=float, help="OWL-Alpha value")
    distill.add_argument("--layers", nargs="*", type=int, help="Target layers")
    
    # ── token-saver ──
    ts = sub.add_parser("token-saver", help="Optimize token usage")
    ts.add_argument("action", choices=["compress", "prune", "optimize", "stats", "pipeline"], default="pipeline")
    ts.add_argument("--text", help="Text to optimize")
    ts.add_argument("--ratio", type=float, default=0.5, help="Compression ratio")
    ts.add_argument("--profile", choices=["default", "code", "math", "chat", "scientific"], default="default")
    ts.add_argument("--method", choices=["llmlingua", "selective", "concise", "hybrid"], default="hybrid")
    
    # ── engines ──
    engines = sub.add_parser("engines", help="Inference engines")
    engines.add_argument("action", choices=["infer", "batch", "stream", "list", "speculative"], default="list")
    engines.add_argument("--prompt", help="Prompt for inference")
    engines.add_argument("--model", default="auto", help="Model to use")
    engines.add_argument("--max-tokens", type=int, default=4096)
    engines.add_argument("--temperature", type=float, default=0.1)
    
    # ── wrappers ──
    wraps = sub.add_parser("wrappers", help="Provider wrappers")
    wraps.add_argument("action", choices=["generate", "providers", "cache-stats"], default="providers")
    wraps.add_argument("--text", help="Text to generate")
    wraps.add_argument("--provider", help="Provider to use")
    
    # ── frameworks ──
    fw = sub.add_parser("frameworks", help="Eval/test frameworks")
    fw.add_argument("action", choices=["eval", "test", "suites", "results"], default="suites")
    fw.add_argument("--suite", help="Suite name")
    fw.add_argument("--metric", help="Metric to evaluate")
    
    # ── methodology ──
    meth = sub.add_parser("methodology", help="Prompt/train methods")
    meth.add_argument("action", choices=["prompt", "train", "optimize", "list"], default="list")
    meth.add_argument("--technique", help="Prompt technique to apply")
    meth.add_argument("--domain", help="Domain for recommendation")
    meth.add_argument("--task", help="Task description")
    
    # ── synthesizers ──
    synth = sub.add_parser("synthesizers", help="Gen synthetic data")
    synth.add_argument("action", choices=["generate", "prompt", "curriculum", "knowledge", "params"], default="params")
    synth.add_argument("--domain", default="general", help="Domain for synthesis")
    synth.add_argument("--count", type=int, default=10, help="Number to generate")
    synth.add_argument("--task", help="Task description")
    
    # ── longcat ──
    lc = sub.add_parser("longcat", help="LongCat-2 MoE")
    lc.add_argument("action", choices=["info", "datasets", "benchmarks", "run"], default="info")
    lc.add_argument("--benchmark", help="Benchmark name")
    lc.add_argument("--prompt", help="Prompt for generation")
    
    # ── owl-alpha ──
    owl = sub.add_parser("owl-alpha", help="OWL-Alpha distill")
    owl.add_argument("action", choices=["info", "distill", "models", "search", "train"], default="info")
    owl.add_argument("--base-model", help="Base model name")
    owl.add_argument("--alpha", type=float, help="Alpha value")
    owl.add_argument("--layers", nargs="*", type=int, help="Target layers")
    owl.add_argument("--lr", type=float, default=0.42, help="Learning rate")
    
    # ── tokenize ──
    tok = sub.add_parser("tokenize", help="Optimize tokenization")
    tok.add_argument("action", choices=["optimize", "estimate", "profiles", "compare"], default="profiles")
    tok.add_argument("--text", help="Text to tokenize")
    tok.add_argument("--profile", choices=["default", "code", "math", "chat", "scientific"], default="default")
    
    # ── config ──
    cfg = sub.add_parser("config", help="View config")
    cfg.add_argument("action", choices=["show", "export", "providers", "models", "paths"], default="show")
    cfg.add_argument("--format", choices=["json", "yaml", "env"], default="json")
    
    # ── research ──
    rsch = sub.add_parser("research", help="Access all research data")
    rsch.add_argument("action", choices=["summary", "techniques", "optimize"], default="summary")
    rsch.add_argument("--model", help="Model for optimize")
    rsch.add_argument("--task", help="Task for optimize")
    
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    if argv is None:
        argv = sys.argv[1:]
    json_mode = '--json' in argv
    if json_mode:
        argv = [a for a in argv if a != '--json']
    args = parser.parse_args(argv)
    
    if not args.command:
        parser.print_help()
        return 0
    
    try:
        result = _dispatch(args)
        _output(result, json_mode)
        return 0
    except Exception as e:
        if json_mode:
            print(json.dumps({"error": str(e), "type": type(e).__name__}))
        else:
            print(f"Error: {e}", file=sys.stderr)
        return 1


def _dispatch(args) -> Any:
    cmd = args.command
    json_mode = getattr(args, "json", False)
    
    if cmd == "enhance":
        return _handle_enhance(args)
    elif cmd == "prompts":
        return _handle_prompts(args)
    elif cmd == "data":
        return _handle_data(args)
    elif cmd == "models":
        return _handle_models(args)
    elif cmd == "brew":
        return _handle_brew(args)
    elif cmd == "moe":
        return _handle_moe(args)
    elif cmd == "distill":
        return _handle_distill(args)
    elif cmd == "token-saver":
        return _handle_token_saver(args)
    elif cmd == "engines":
        return _handle_engines(args)
    elif cmd == "wrappers":
        return _handle_wrappers(args)
    elif cmd == "frameworks":
        return _handle_frameworks(args)
    elif cmd == "methodology":
        return _handle_methodology(args)
    elif cmd == "synthesizers":
        return _handle_synthesizers(args)
    elif cmd == "longcat":
        return _handle_longcat(args)
    elif cmd == "owl-alpha":
        return _handle_owl_alpha(args)
    elif cmd == "tokenize":
        return _handle_tokenize(args)
    elif cmd == "config":
        return _handle_config(args)
    elif cmd == "research":
        return _handle_research(args)
    else:
        return {"error": f"Unknown command: {cmd}"}



def _handle_research(args) -> Any:
    """Handle research commands."""
    if args.action == "summary":
        try:
            from lazy_chameleon.pipeline.research_integration import get_coordinator
            return get_coordinator().get_summary()
        except Exception as e:
            return {"error": str(e)}
    elif args.action == "techniques":
        try:
            from lazy_chameleon.pipeline.research_integration import get_coordinator
            return {"techniques": list(get_coordinator()._techniques.keys())}
        except Exception as e:
            return {"error": str(e)}
    elif args.action == "optimize":
        try:
            from lazy_chameleon.pipeline.research_integration import get_coordinator
            return get_coordinator().optimize_model(args.model or "default", task_hint=args.task or "")
        except Exception as e:
            return {"error": str(e)}
    return {"error": "Unknown action"}

def _handle_enhance(args) -> Any:
    try:
        from lazy_chameleon.enhance import enhance
        if not args.task:
            return {"error": "No task provided. Usage: chameleon enhance <task> [--mode easy|medium|hard|extreme]"}
        result = enhance(args.task, mode=args.mode, domain=args.domain)
        if args.stats:
            return {"task": args.task, "mode": args.mode, "domain": args.domain, "enhanced_context": result}
        return result
    except ImportError as e:
        return {"error": f"enhance module not available: {e}"}


def _handle_prompts(args) -> Any:
    try:
        from lazy_chameleon.prompts import get_library
        lib = get_library()
        if args.action == "browse":
            prompts = lib.browse(provider=args.provider, model=args.model)
            return {"count": len(prompts), "prompts": [
                {"provider": p.provider, "model": p.model, "size": p.size, "path": p.file_path}
                for p in prompts[:20]
            ]}
        elif args.action == "search":
            results = lib.search(args.query or "", max_results=args.max)
            return {"query": args.query, "count": len(results), "results": [
                {"provider": p.provider, "model": p.model, "path": p.file_path, "size": p.size}
                for p in results
            ]}
        elif args.action == "show":
            sp = lib.get(args.path or "")
            if sp:
                return {"provider": sp.provider, "model": sp.model, "content": sp.content[:5000], "size": sp.size}
            return {"error": f"Prompt not found: {args.path}"}
        elif args.action == "stats":
            return lib.get_stats()
        elif args.action == "providers":
            return {"providers": lib.list_providers()}
        elif args.action == "models":
            return {"models": lib.list_models(provider=args.provider)}
        return {"error": f"Unknown action: {args.action}"}
    except ImportError as e:
        return {"error": f"prompts module not available: {e}"}


def _handle_data(args) -> Any:
    try:
        from lazy_chameleon.data import get_summary, get_domain, get_model_examples, get_training_pairs
        from lazy_chameleon.training.dataset_registry import DATASET_REGISTRY
        if args.action == "summary":
            return get_summary()
        elif args.action == "list":
            if args.domain:
                data = get_domain(args.domain)
                return {args.domain: {k: len(v) for k, v in data.items()}}
            else:
                total = 0
                s = get_summary()
                for m, d in s.items():
                    total += sum(d.values())
                return {"total_examples": total, "by_model": {m: sum(d.values()) for m, d in s.items()}}
        elif args.action == "get":
            if args.model and args.domain:
                return get_model_examples(args.model, args.domain)[:args.samples]
            if args.key and args.key in DATASET_REGISTRY:
                src = DATASET_REGISTRY[args.key]
                return {"name": src.name, "hf_path": src.hf_path, "size": src.dataset_size, "tags": src.tags}
            return {"error": "Provide --model and --domain, or --key for registry"}
        elif args.action == "search":
            q = (args.query or "").lower()
            results = {k: v for k, v in DATASET_REGISTRY.items() if q in k.lower() or q in " ".join(v.tags).lower()}
            return {"query": args.query, "count": len(results), "results": [
                {"key": k, "hf_path": v.hf_path, "size": v.dataset_size} for k, v in list(results.items())[:20]
            ]}
        elif args.action == "download":
            from lazy_chameleon.training.dataset_registry import load_dataset
            if args.key:
                dd = load_dataset(args.key, split="train")
                return {"dataset": args.key, "status": "ready", "num_samples": len(dd) if hasattr(dd, "__len__") else "streaming"}
            return {"error": "Provide --key for dataset to download"}
        return {"error": f"Unknown action: {args.action}"}
    except ImportError as e:
        return {"error": f"data module not available: {e}"}


def _handle_models(args) -> Any:
    models = {
        "gpt-5.5": {"provider": "openai", "context": 256000, "cost_per_1m_input": 15.0, "strengths": ["code", "reasoning"]},
        "claude-opus-4.8": {"provider": "anthropic", "context": 200000, "cost_per_1m_input": 15.0, "strengths": ["reasoning", "math"]},
        "claude-sonnet-5": {"provider": "anthropic", "context": 200000, "cost_per_1m_input": 3.0, "strengths": ["code", "speed"]},
        "deepseek-r1": {"provider": "deepseek", "context": 128000, "cost_per_1m_input": 0.55, "strengths": ["math", "reasoning"]},
        "grok-4.4": {"provider": "xai", "context": 128000, "cost_per_1m_input": 5.0, "strengths": ["science", "analysis"]},
        "gemini-3.1-pro": {"provider": "google", "context": 1000000, "cost_per_1m_input": 5.0, "strengths": ["long_context", "multimodal"]},
        "qwen-3.7-max": {"provider": "qwen", "context": 128000, "cost_per_1m_input": 2.0, "strengths": ["math", "multilingual"]},
        "llama-4-maverick": {"provider": "together", "context": 128000, "cost_per_1m_input": 0.9, "strengths": ["general", "instruction"]},
        "glm-5.2": {"provider": "zhipu", "context": 128000, "cost_per_1m_input": 1.0, "strengths": ["code", "security"]},
        "longcat-2.0": {"provider": "meituan", "context": 1048576, "strengths": ["moe", "long_context"], "architecture": "MoE", "num_experts": 64},
    }
    if args.action == "list":
        if args.provider:
            return {k: v for k, v in models.items() if v["provider"] == args.provider}
        return models
    elif args.action == "get":
        if args.name:
            return models.get(args.name, {"error": f"Model not found: {args.name}"})
        return {"error": "Provide --name"}
    elif args.action == "compare":
        return {k: {"context": v["context"], "cost_per_1m": v.get("cost_per_1m_input", "?"), "strengths": v["strengths"], "provider": v["provider"]} for k, v in models.items()}
    return models


def _handle_brew(args) -> Any:
    try:
        from lazy_chameleon.brewing.brewing_recipe import BrewingRecipe
        from lazy_chameleon.brewing.quality_control import QualityControl
        if args.action == "recipe":
            recipe = BrewingRecipe(args.recipe or "standard")
            tanks = recipe.get_tanks(args.pots)
            return {"recipe": args.recipe, "config": recipe.config.__dict__, "tanks": len(tanks)}
        elif args.action == "start":
            return {"status": "brewing_started", "pots": args.pots, "domain": args.domain, "samples": args.samples, "recipe": args.recipe}
        elif args.action == "stats":
            return {"pots": args.pots, "domain": args.domain, "recipe": args.recipe, "status": "idle"}
        return {"error": f"Unknown action: {args.action}"}
    except ImportError as e:
        return {"error": f"brew module not available: {e}"}


def _handle_moe(args) -> Any:
    try:
        if args.action == "start":
            from lazy_chameleon.moe_controller.split_merge_moe import SplitMergeMoE
            moe = SplitMergeMoE(initial_mass=args.mass)
            cells = moe.split("cell_1", num_splits=args.cells, subtasks=[args.task or "general"] * args.cells)
            return {"status": "started", "main_cell": "cell_1", "mass": args.mass, "split_cells": cells}
        elif args.action == "stats":
            return {"available": True, "modules": ["SplitMergeMoE", "MoEController", "ExpertSplitter"], "config": {"suggested_cells": 4, "suggested_mass": 100.0}}
        return {"action": args.action, "status": "available"}
    except ImportError as e:
        return {"error": f"moe module not available: {e}"}


def _handle_distill(args) -> Any:
    try:
        if args.action == "list":
            return {"available_methods": ["multi_teacher", "progressive", "online", "self_distill", "distribution_aligned", "owl_alpha"],
                    "description": "All distillation methods are available. Use --action with run, multi-teacher, progressive, online, or self"}
        elif args.action == "multi-teacher":
            from lazy_chameleon.distillation import MultiTeacherDistiller
            distiller = MultiTeacherDistiller()
            return {"teachers": len(distiller.ensemble.teachers), "models": [t["model"] for t in distiller.ensemble.teachers]}
        elif args.action == "self":
            from lazy_chameleon.distillation import SelfDistillation
            sd = SelfDistillation()
            return {"method": "self_distillation", "rounds": sd.num_rounds()}
        return {"action": args.action, "status": "available"}
    except ImportError as e:
        return {"error": f"distill module not available: {e}"}


def _handle_token_saver(args) -> Any:
    try:
        from lazy_chameleon.token_saver import TokenSaverEngine, PromptCompressor, TokenPruner
        from lazy_chameleon.token_saver.adaptive_tokenizer import AdaptiveTokenizer
        if args.action == "pipeline":
            engine = TokenSaverEngine()
            result = engine.process_prompt(args.text or "Sample prompt for token optimization testing.")
            return {"original_tokens": result.original_tokens, "final_tokens": result.final_tokens,
                    "tokens_saved": result.tokens_saved, "saving_ratio": result.saving_ratio,
                    "stages": result.stages, "latency_ms": result.latency_ms}
        elif args.action == "compress":
            compressor = PromptCompressor()
            compressed = compressor.compress(args.text or "Test prompt", method=args.method)
            return {"original_length": len(args.text or ""), "compressed_length": len(compressed), "ratio": round(len(compressed)/max(len(args.text or "Test"),1), 4)}
        elif args.action == "optimize":
            tok = AdaptiveTokenizer(profile_name=args.profile)
            optimized = tok.optimize(args.text or "Test text")
            return {"profile": args.profile, "original": len(args.text or ""), "optimized": len(optimized)}
        elif args.action == "stats":
            return {"methods": ["compression", "pruning", "kv_cache_eviction", "speculative_decoding", "adaptive_tokenization"],
                    "estimated_savings": "50-85%", "techniques": 7}
        return {"action": args.action, "status": "available"}
    except ImportError as e:
        return {"error": f"token-saver module not available: {e}"}


def _handle_engines(args) -> Any:
    try:
        from lazy_chameleon.engines import InferenceEngine
        if args.action == "list":
            return {"engines": ["InferenceEngine", "ParallelEngine", "BatchEngine", "StreamEngine", "SpeculativeEngine"],
                    "supported": True}
        elif args.action == "infer":
            engine = InferenceEngine()
            result = engine.generate(args.prompt or "Hello")
            return {"text": result.text[:200], "model": result.model, "latency_ms": result.latency_ms, "tokens": result.tokens_completion}
        return {"action": args.action, "status": "available"}
    except ImportError as e:
        return {"error": f"engines module not available: {e}"}


def _handle_wrappers(args) -> Any:
    try:
        if args.action == "providers":
            return {"providers": ["anthropic", "openai", "deepseek", "xai", "google", "together", "zhipu", "qwen"],
                    "wrappers": ["ProviderWrapper", "ModelAdapter", "APIShim", "CacheWrapper", "FallbackWrapper"]}
        return {"action": args.action, "status": "available"}
    except ImportError as e:
        return {"error": f"wrappers module not available: {e}"}


def _handle_frameworks(args) -> Any:
    try:
        if args.action == "suites":
            return {"frameworks": ["EvaluationFramework", "TestFramework"], "suites": ["LARYBench", "WBench", "CoreCodeBench", "AMO-Bench"]}
        return {"action": args.action, "status": "available"}
    except ImportError as e:
        return {"error": f"frameworks module not available: {e}"}


def _handle_methodology(args) -> Any:
    try:
        from lazy_chameleon.methodology import PromptMethod
        pm = PromptMethod()
        if args.action == "list":
            return {"techniques": pm.list_techniques(), "training_methods": ["sft", "dpo", "ppo", "rejection_sampling"],
                    "finetune_methods": ["lora", "qlora", "dora"]}
        elif args.action == "prompt":
            applied = pm.apply(args.technique or "chain_of_thought", question=args.task or "What is 2+2?", task=args.task or "Solve this")
            return {"technique": args.technique or "chain_of_thought", "result": applied}
        return {"action": args.action, "status": "available"}
    except ImportError as e:
        return {"error": f"methodology module not available: {e}"}


def _handle_synthesizers(args) -> Any:
    try:
        from lazy_chameleon.synthesizers import DataSynthesizer, SynthConfig, CurriculumSynthesizer
        if args.action == "params":
            from lazy_chameleon.brewing.real_synthetic_params import RealSyntheticParameters
            rsp = RealSyntheticParameters()
            params = rsp.generate_params(task_type=args.task or args.domain or "general", domain=args.domain or "general")
            return params
        elif args.action == "curriculum":
            cs = CurriculumSynthesizer()
            stages = cs.build_curriculum()
            return {"stages": [{"name": s.name, "difficulty": s.difficulty, "samples": s.num_samples} for s in stages],
                    "total_samples": cs.total_samples()}
        return {"action": args.action, "domain": args.domain, "count": args.count, "status": "available"}
    except ImportError as e:
        return {"error": f"synthesizers module not available: {e}"}


def _handle_longcat(args) -> Any:
    try:
        from lazy_chameleon.data.longcat import LongCatEngine, LongCatDatasetRegistry, LongCatBenchmark
        if args.action == "info":
            engine = LongCatEngine()
            stats = engine.get_stats()
            return stats
        elif args.action == "datasets":
            registry = LongCatDatasetRegistry()
            summary = registry.get_summary()
            return summary
        elif args.action == "benchmarks":
            bench = LongCatBenchmark()
            return {"benchmarks": list(bench.BENCHMARKS.keys())}
        return {"action": args.action, "status": "available"}
    except ImportError as e:
        return {"error": f"longcat module not available: {e}"}


def _handle_owl_alpha(args) -> Any:
    try:
        from lazy_chameleon.data.owl_alpha import OWLAlphaModelRegistry, OWLAlphaConfig, OWLAlphaDistiller, OWLAlphaTrainer
        if args.action == "info":
            registry = OWLAlphaModelRegistry()
            summary = registry.get_summary()
            return summary
        elif args.action == "models":
            registry = OWLAlphaModelRegistry()
            results = registry.search(base_model=args.base_model, alpha=args.alpha)
            return {"models": [{"path": m.model_path, "base": m.base_model, "alpha": m.alpha, "layers": m.target_layers} for m in results]}
        elif args.action == "train":
            trainer = OWLAlphaTrainer()
            config_summary = {"base_model": "Qwen/Qwen2.5-7B-Instruct", "alpha": args.alpha or 3.5, "layers": args.layers or [16], "lr": args.lr or 0.42}
            return config_summary
        return {"action": args.action, "status": "available"}
    except ImportError as e:
        return {"error": f"owl-alpha module not available: {e}"}


def _handle_tokenize(args) -> Any:
    try:
        from lazy_chameleon.token_saver.adaptive_tokenizer import AdaptiveTokenizer
        if args.action == "profiles":
            return {"profiles": list(AdaptiveTokenizer.PROFILES.keys())}
        elif args.action == "optimize":
            tok = AdaptiveTokenizer(profile_name=args.profile)
            result = tok.optimize(args.text or "Sample text for tokenization")
            return {"profile": args.profile, "original": len(args.text or ""), "optimized": len(result), "stats": tok.get_stats()}
        return {"action": args.action, "status": "available"}
    except ImportError as e:
        return {"error": f"tokenize module not available: {e}"}


def _handle_config(args) -> Any:
    if args.action == "show":
        return {"version": "2.6.0", "name": "Lazy Chameleon", "modules": [
            "enhance", "prompts", "data", "models", "brew", "moe", "distill",
            "token-saver", "engines", "wrappers", "frameworks", "methodology",
            "synthesizers", "longcat", "owl-alpha", "tokenize", "config"
        ], "total_modules": 17, "description": "Universal LLM Tool Suite — Every module accessible via single CLI"}
    elif args.action == "export":
        return {"format": args.format, "data": {"version": "2.6.0", "python": sys.version.split()[0], "platform": sys.platform}}
    elif args.action == "providers":
        return {"providers": ["anthropic", "openai", "deepseek", "xai", "google", "together", "zhipu", "qwen", "meituan"]}
    elif args.action == "paths":
        return {"root": os.path.abspath(os.path.join(os.path.dirname(__file__), "..")), "data": os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data"))}
    return {"error": f"Unknown action: {args.action}"}


if __name__ == "__main__":
    sys.exit(main())
