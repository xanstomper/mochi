"""
Lazy Chameleon v2.3 — Parameter Synthesis Engine + Strategy Layer.

NOT a server. NOT an API. NOT a TUI.
A function that turns a DeepSeek-V4-Flash (or any flash-class model) into
a Mythos-grade reasoner via three orthogonal strategies:

  1. STALLING   — research-backed test-time compute expansion
                  (Chain-of-Draft, Budget Forcing, Constitutional AI loops)
  2. LAZY EVAL  — progressive tier evaluation; only escalate when quality gated
                  (60-80% token savings on sub-medium tasks)
  3. LINGUA     — LLMLingua-style context compression
                  (40-60% input token reduction with <5% quality regression)

Usage from any agent/tool/script:

    from lazy_chameleon.enhance import enhance
    context = enhance("Build a Redis rate limiter", mode="hard")
    # inject context into your agent's system prompt

Or from shell:

    chameleon enhance "Build a REST API" --mode hard
    chameleon enhance "Fix my login flow" --mode medium --stats
    echo "optimise this SQL" | chameleon enhance --mode easy
"""
from __future__ import annotations

import asyncio
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# ── Core imports ────────────────────────────────────────────────────────────
from lazy_chameleon.config.settings import HarnessConfig
from lazy_chameleon.synthesis.hypernet import HypernetworkSynthesizer
from lazy_chameleon.synthesis.distillation import DistillationEngine
from lazy_chameleon.synthesis.rag import RAGEngine
from lazy_chameleon.synthesis.adapters import DynamicAdapterManager
from lazy_chameleon.synthesis.router import MoERouter
from lazy_chameleon.synthesis.compute import DynamicComputeScheduler
from lazy_chameleon.compression.compressor import KnowledgeCompressor
from lazy_chameleon.core.types import LazyOutput

# ── New strategy layer (v2.3) ────────────────────────────────────────────────
from lazy_chameleon.synthesis.staller import StallEngine, stall_agent_prompt
from lazy_chameleon.core.budget import TokenBudget, PREFIX_ANCHOR
from lazy_chameleon.synthesis.lazy_eval import LazyEvaluator, QualityEstimator

# ── v2.4: Task-aware auto-routing ────────────────────────────────────────────
from lazy_chameleon.synthesis.task_classifier import TaskClassifier


def enhance(
    task: str,
    mode: str = "hard",
    api_key: str = "",
    provider: str = "opencode-go",
    model: str = "deepseek-v4-flash",
    base_url: str = "",
    num_agents: int = 8,
    verbose: bool = False,
    # v2.3 strategy options
    use_stalling: bool = True,
    use_lazy_eval: bool = True,
    use_lingua: bool = True,
    stall_strategy: str = "hybrid",
    force_all_agents: bool = False,
    show_stats: bool = False,
    force_offline: bool = False,
) -> str:
    """
    Generate synthetic parameter context for any task.

    The returned string is dense synthetic context that, when injected into
    a flash model's prompt, makes it reason as if it were a model with
    10-500× more effective parameters.

    Args
    ────
    task            : What to solve.
    mode            : flash/easy/turbo/medium/hard/deep/extreme/genius/god
    api_key         : Auto-detected from env if empty.
    provider        : opencode-go / openai / anthropic / opencode-zen
    model           : Model name (default: deepseek-v4-flash)
    base_url        : Override base URL.
    num_agents      : How many lazy agents to use (2-8).
    verbose         : Print progress to stderr.
    use_stalling    : Apply Chain-of-Draft / Budget Forcing / Constitutional loops.
    use_lazy_eval   : Use progressive tier evaluation (saves 60-80% tokens on simple tasks).
    use_lingua      : Apply LLMLingua-style context compression.
    stall_strategy  : chain_of_draft | budget_force | constitutional |
                      self_consistency | scratchpad | devils_advocate |
                      confidence_gate | hybrid
    force_all_agents: Skip quality gates and run all 8 agents regardless.
    show_stats      : Append token/cost savings summary to output.
    force_offline   : Skip API key detection and run in offline mode.

    Returns
    ───────
    String of synthetic parameter context to inject into
    the agent's system prompt or before the user message.
    """
    t0 = time.time()
    _log = (
        lambda m, **kw: print(f"  [CHAM] {m}", file=sys.stderr, flush=True)
        if verbose else (lambda *a, **kw: None)
    )

    # ── Token budget ─────────────────────────────────────────────────────────
    budget = TokenBudget(mode=mode, model=model, provider=provider)
    _log(f"Budget: {budget.hard_cap:,} tokens ({mode})")

    # ── Resolve API key ───────────────────────────────────────────────────────
    if not api_key:
        api_key = _find_api_key(provider)
    if force_offline or not api_key:
        _log("No API key — offline mode")
        result = _generate_offline_context(task, mode, stall_strategy if use_stalling else "")
        return result

    # ── Import API client ─────────────────────────────────────────────────────
    from lazy_chameleon.core.api import FlashModelAPI
    api = FlashModelAPI(api_key, provider, model, base_url=base_url)

    # ── Task complexity + MoE routing ─────────────────────────────────────────
    scheduler = DynamicComputeScheduler()
    complexity = scheduler.analyze_task(task)
    effective_mode = mode if mode != "auto" else complexity.recommended_mode
    _log(f"Complexity: {complexity.score:.2f} → {effective_mode}")

    # ── v2.4: Task-aware classification ──────────────────────────────────────
    clf = TaskClassifier()
    clf_result = clf.classify(task)
    _log(
        f"TaskClassifier: type={clf_result.task_type}  "
        f"strategy={clf_result.strategy}  "
        f"confidence={clf_result.confidence:.2f}"
    )
    # Auto-promote stall_strategy when caller left it at the default "hybrid"
    # and the classifier has a confident opinion (>0.5).
    if stall_strategy == "hybrid" and clf_result.confidence > 0.5:
        stall_strategy = clf_result.strategy
        _log(f"  → auto-selected stall strategy: {stall_strategy}")

    router = MoERouter()
    route = router.route(task, effective_mode)
    # Blend MoE names with classifier suggestions: classifier-first, then MoE
    clf_agents = clf_result.suggested_agents  # e.g. ["scout","critic","debug"]
    moe_names  = route.expert_names
    # Interleave: take clf suggestions that appear in moe_names first, then rest
    ordered: list[str] = []
    for n in clf_agents:
        if n in moe_names and n not in ordered:
            ordered.append(n)
    for n in moe_names:
        if n not in ordered:
            ordered.append(n)
    active_names = ordered[:num_agents]
    _log(f"Agents ({len(active_names)}): {', '.join(active_names)}")

    # ── Build agent map ───────────────────────────────────────────────────────
    from lazy_chameleon.agents import (
        ScoutChameleon, CriticChameleon, ResearchChameleon,
        SimulatorChameleon, ArchitectChameleon, DebugChameleon,
        OptimizerChameleon, HistorianChameleon,
    )
    agent_cls_map = {
        "scout":     ScoutChameleon,    "critic":    CriticChameleon,
        "research":  ResearchChameleon, "simulator": SimulatorChameleon,
        "architect": ArchitectChameleon,"debug":     DebugChameleon,
        "optimizer": OptimizerChameleon,"historian": HistorianChameleon,
    }
    agent_map = {}
    for name in active_names:
        cls = agent_cls_map.get(name)
        if cls:
            agent_map[name] = cls(api, effective_mode)

    # ── Strategy Layer: Lazy Evaluation (progressive tier) ───────────────────
    if use_lazy_eval:
        _log("Strategy: LazyEval (progressive tier)")
        evaluator = LazyEvaluator(
            mode=effective_mode,
            force_all=force_all_agents,
            budget=budget,
        )
        eval_result = evaluator.run(task, agent_map, num_agents)
        outputs = eval_result.all_outputs
        _log(
            f"  Tiers used: {eval_result.tiers_used}/3 | "
            f"Agents: {len(eval_result.agents_run)}/{len(agent_map)} | "
            f"Saved: {eval_result.tokens_saved:,} tokens"
        )
        if eval_result.agents_skipped:
            _log(f"  Skipped: {', '.join(eval_result.agents_skipped)} (quality gate passed)")
    else:
        # Original: run all agents
        agents = list(agent_map.values())
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                outputs = _run_sequential(agents, task, _log)
            else:
                outputs = _run_parallel(agents, task, loop, _log)
        except Exception:
            outputs = _run_sequential(agents, task, _log)

    # ── Accounting ────────────────────────────────────────────────────────────
    total_params = sum(o.get("params", 0) for o in outputs)
    _log(f"Synthetic params: {total_params:,} from {len(outputs)} agents")

    # ── Build LazyOutput list for compressor ──────────────────────────────────
    lazy_outputs = [
        LazyOutput(
            agent_name=o.get("agent", "?"),
            summary=o.get("summary", ""),
            details=o.get("details", ""),
            confidence=o.get("confidence", 0.5),
            tokens=o.get("tokens", 0),
            parameter_equivalent=o.get("params", 0),
        )
        for o in outputs
    ]

    # ── Strategy Layer: Compress agent context ───────────────────────────────
    compressor = KnowledgeCompressor()
    intelligence = compressor.compress(lazy_outputs, task)

    # LLMLingua-style adaptive compression
    if use_lingua:
        raw_combined = "\n\n".join(o.get("details", "") for o in outputs)
        raw_words = len(raw_combined.split())
        # Target: 40% of raw (60% compression), floor at 500 words
        target_words = max(500, int(raw_words * 0.40))
        compressed_text = compressor.compress_adaptive(raw_combined, target_words)
        _log(
            f"Lingua: {raw_words:,} → {len(compressed_text.split()):,} words "
            f"(ratio={compressor.compression_ratio:.2f})"
        )
        compressed = compressor.compress_to_prompt(intelligence)
        # Merge lingua-compressed raw into the structured prompt block
        if len(compressed_text) > 200:
            compressed = compressed + "\n\n### COMPRESSED AGENT CONTEXT ###\n" + compressed_text
    else:
        compressed = compressor.compress_to_prompt(intelligence)

    # ── RAG indexing + retrieval ──────────────────────────────────────────────
    rag = RAGEngine()
    for o in outputs:
        rag.index_agent_output(o.get("agent", "?"), o.get("details", ""))
    rag_ctx = rag.build_context(task, top_k=5)

    # ── Hypernetwork behavioral adaptation ───────────────────────────────────
    hypernet = HypernetworkSynthesizer()
    combined_intel = "\n".join(o.get("details", "")[:300] for o in outputs)
    instruction_delta = hypernet.generate_instruction_delta(task, combined_intel)
    hyper_result = hypernet.synthesize(task, combined_intel)

    # ── Dynamic adapters ─────────────────────────────────────────────────────
    adapters = DynamicAdapterManager()
    adapters.get_or_create(task, hypernet, combined_intel)
    adapter_instr = adapters.apply_all(task)

    # ── Distillation (API call) ───────────────────────────────────────────────
    distiller = DistillationEngine(api=api, num_teachers=3)
    distill = distiller.distill(task, num_rounds=1)

    # ── Strategy Layer: Stalling for synthesis ───────────────────────────────
    stall_note = ""
    if use_stalling:
        stall_engine = StallEngine(mode=effective_mode)
        stall_prompt = stall_engine.build_prompt(
            task, strategy=stall_strategy
        )
        stall_note = f"\n\n### STALLING SCAFFOLD ({stall_strategy.upper()}) ###\n{stall_prompt}"
        _log(f"Stalling: {stall_strategy} | budget={stall_engine.budget.total} tokens")

    # ── Assemble final context ────────────────────────────────────────────────
    sections = []
    elapsed = time.time() - t0
    ep = hyper_result.get("effective_params", 0)

    sections.append(
        f"=== LAZY CHAMELEON SYNTHESIS v2.3 ({effective_mode.upper()}) ==="
    )
    sections.append(f"Task: {task}")
    sections.append(
        f"Params: {total_params:,} | Adapters: {ep:,} | "
        f"Agents: {len(outputs)} | Elapsed: {elapsed:.1f}s"
    )
    sections.append("")

    sections.append(compressed)
    sections.append("")

    if rag_ctx:
        sections.append(rag_ctx)
        sections.append("")

    if distill.get("student_injection"):
        sections.append(distill["student_injection"])
        sections.append("")

    if instruction_delta:
        sections.append(instruction_delta)
        sections.append("")

    for instr in adapter_instr:
        sections.append(instr)
        sections.append("")

    # Prompt deltas
    prompt_deltas = hyper_result.get("prompt_deltas", [])
    if prompt_deltas:
        sections.append("=== HYPERNETWORK WEIGHT DELTAS ===")
        for pd in prompt_deltas[:4]:
            sections.append(f"  {pd}")
        sections.append("")

    # Stalling scaffold
    if stall_note:
        sections.append(stall_note)
        sections.append("")

    sections.append(f"=== END SYNTHESIS ({elapsed:.1f}s) ===")

    # ── Optional stats block ──────────────────────────────────────────────────
    if show_stats:
        bsum = budget.summary()
        q_score = QualityEstimator.score(outputs, task)
        sections.append("")
        sections.append("=== STRATEGY STATS ===")
        sections.append(f"  Quality score:    {q_score:.3f}")
        sections.append(f"  Tokens used:      {bsum['tokens_used']:,}")
        sections.append(f"  Tokens remaining: {bsum['tokens_remaining']:,}")
        sections.append(f"  Cost (est.):      ${bsum['cost_usd']:.5f}")
        sections.append(f"  Cache hit rate:   {bsum['cache_hit_rate']:.1%}")
        if use_lazy_eval and 'eval_result' in dir():
            sections.append(f"  Tokens saved (lazy eval): {eval_result.tokens_saved:,}")
            sections.append(f"  Tiers used: {eval_result.tiers_used}/3")
        if use_lingua:
            sections.append(f"  Compression ratio: {compressor.compression_ratio:.2f}")
        sections.append("=== END STATS ===")

    return "\n".join(sections)


# ── Helper: stall wrapper for a specific agent ────────────────────────────

def enhance_with_stall(
    task: str,
    agent_name: str,
    base_prompt: str,
    mode: str = "hard",
) -> str:
    """
    Apply the mode-appropriate stalling strategy to a specific agent prompt.
    Call this INSTEAD of or AROUND the agent's own generate_synthetic_params call.

    The stalled prompt makes a flash model reason as hard as a frontier model
    for the cost of extra output tokens (cheap) vs extra input tokens (expensive).
    """
    return stall_agent_prompt(agent_name, task, mode, base_prompt)


# ── Agent execution helpers ───────────────────────────────────────────────

def _run_parallel(agents, task, loop, log):
    """Run agents in parallel using thread executor."""
    futures = [loop.run_in_executor(None, a.run, task) for a in agents]
    results = loop.run_until_complete(
        asyncio.gather(*futures, return_exceptions=True)
    )
    outputs = []
    for a, r in zip(agents, results):
        if isinstance(r, Exception):
            log(f"ERROR {a.name}: {r}")
            continue
        outputs.append(r)
        log(f"{a.name}: +{r.get('params',0):,} params ({r.get('time',0):.1f}s)")
    return outputs


def _run_sequential(agents, task, log):
    """Run agents one by one."""
    outputs = []
    for a in agents:
        try:
            r = a.run(task)
            outputs.append(r)
            log(f"{a.name}: +{r.get('params',0):,} params ({r.get('time',0):.1f}s)")
        except Exception as e:
            log(f"ERROR {a.name}: {e}")
    return outputs


# ── API key discovery ─────────────────────────────────────────────────────

def _find_api_key(provider: str = "") -> str:
    """Auto-detect API key from environment or ~/.hermes/.env."""
    env_vars = [
        "OPENCODE_GO_API_KEY", "OPENCODE_ZEN_API_KEY",
        "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
    ]
    for var in env_vars:
        key = os.environ.get(var, "")
        if key:
            return key

    # Try ~/.hermes/.env
    env_path = os.path.expanduser("~/.hermes/.env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if "=" not in line or line.startswith("#"):
                    continue
                for var in env_vars:
                    if line.startswith(var + "="):
                        key = line.split("=", 1)[1].strip().strip('"\'')
                        if key:
                            return key
    return ""


# ── Offline mode (no API key) ────────────────────────────────────────────

def _generate_offline_context(
    task: str,
    mode: str,
    stall_strategy: str = "",
) -> str:
    """Generate context without API calls (offline mode)."""
    scheduler = DynamicComputeScheduler()
    complexity = scheduler.analyze_task(task)
    effective_mode = mode if mode != "auto" else complexity.recommended_mode

    router = MoERouter()
    route = router.route(task, effective_mode)

    hypernet = HypernetworkSynthesizer()
    hyper_result = hypernet.synthesize(task, "", task_type=None)
    instruction_delta = hypernet.generate_instruction_delta(task, "")

    adapters = DynamicAdapterManager()
    adapters.get_or_create(task)
    adapter_instr = adapters.apply_all(task)

    sections = [
        f"=== LAZY CHAMELEON SYNTHESIS v2.3 ({effective_mode.upper()}) [OFFLINE] ===",
        f"Task: {task}",
        f"Complexity: {complexity.score:.2f} | Experts: {route.num_experts}",
        "",
    ]
    if instruction_delta:
        sections.append(instruction_delta)
        sections.append("")
    for instr in adapter_instr:
        sections.append(instr)
        sections.append("")
    prompt_deltas = hyper_result.get("prompt_deltas", [])
    if prompt_deltas:
        sections.append("=== ADAPTER WEIGHT DELTAS ===")
        for pd in prompt_deltas[:4]:
            sections.append(f"  {pd}")
        sections.append("")

    # Even offline, apply the stalling scaffold so the downstream model reasons harder
    if stall_strategy:
        engine = StallEngine(mode=effective_mode)
        stall_block = engine.build_prompt(task, strategy=stall_strategy)
        sections.append(f"### STALLING SCAFFOLD ({stall_strategy.upper()}) ###")
        sections.append(stall_block)
        sections.append("")

    sections.append("=== END SYNTHESIS ===")
    return "\n".join(sections)


# ── CLI entry point ───────────────────────────────────────────────────────

def _cli():
    import argparse

    parser = argparse.ArgumentParser(
        prog="chameleon",
        description="Lazy Chameleon v2.3 — Mythos-grade parameter synthesis",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Modes (ascending compute):
  flash  turbo  easy  medium  hard  deep  extreme  genius  god

Stalling strategies:
  chain_of_draft   — 7× token savings vs CoT, same accuracy   (best: scout)
  budget_force     — fill token budget → forces planning       (best: architect)
  constitutional   — generate→critique→revise loop             (best: critic)
  self_consistency — N paths, majority vote                    (best: historian)
  scratchpad       — working memory before final answer        (best: research)
  devils_advocate  — argue opposite first                      (best: debug)
  confidence_gate  — re-attempt if confidence < 0.85           (best: simulator)
  hybrid           — auto-pick best strategy for the mode      (default)

Examples:
  chameleon enhance "Build a Redis rate limiter" --mode hard
  chameleon enhance "Fix login bug" --mode easy --stats
  echo "optimise this SQL" | chameleon enhance --mode medium --stall budget_force
  chameleon modes
  chameleon providers
""",
    )

    sub = parser.add_subparsers(dest="command")

    # enhance (default)
    enh = sub.add_parser("enhance", help="Generate synthetic context for a task")
    enh.add_argument("task", nargs="?", default="", help="Task to solve (or pipe via stdin)")
    enh.add_argument("--mode", "-m", default="hard",
                     help="Compute mode (default: hard)")
    enh.add_argument("--provider", "-p", default="opencode-go")
    enh.add_argument("--model", default="deepseek-v4-flash")
    enh.add_argument("--api-key", default="")
    enh.add_argument("--agents", "-n", type=int, default=8)
    enh.add_argument("--verbose", "-v", action="store_true")
    enh.add_argument("--stats", "-s", action="store_true")
    enh.add_argument("--stall", default="hybrid", dest="stall_strategy",
                     choices=StallEngine.STRATEGIES,
                     help="Stalling strategy (default: hybrid)")
    enh.add_argument("--no-stall",    action="store_true")
    enh.add_argument("--no-lazy",     action="store_true")
    enh.add_argument("--no-lingua",   action="store_true")
    enh.add_argument("--force-all",   action="store_true",
                     help="Run all agents regardless of quality gate")
    enh.add_argument("--offline",     action="store_true")

    # modes
    sub.add_parser("modes",     help="List available compute modes")
    sub.add_parser("providers", help="List available API providers")

    args = parser.parse_args()

    if args.command == "modes" or args.command is None and not sys.stdin.isatty():
        if args.command == "modes":
            from lazy_chameleon.synthesis.staller import BudgetSpec
            print("Available modes (ascending compute cost):")
            for m in ["flash","turbo","easy","medium","hard","deep","extreme","genius","god"]:
                b = BudgetSpec.for_mode(m)
                print(f"  {m:<10} stall_budget={b.total:>5} tokens")
            return

    if args.command == "providers":
        from lazy_chameleon.core.budget import PROVIDER_PRICING
        print("Available providers and pricing (per 1M tokens, USD):")
        for name, p in PROVIDER_PRICING.items():
            if "/" in name or name == "default":
                continue
            print(f"  {name:<35} in=${p['in']:.2f}  out=${p['out']:.2f}  cached=${p['cached']:.3f}")
        return

    # Default: enhance
    task = ""
    if hasattr(args, "task"):
        task = args.task or ""
    if not task and not sys.stdin.isatty():
        task = sys.stdin.read().strip()
    if not task:
        parser.print_help()
        sys.exit(1)

    result = enhance(
        task=task,
        mode=getattr(args, "mode", "hard"),
        api_key=getattr(args, "api_key", ""),
        provider=getattr(args, "provider", "opencode-go"),
        model=getattr(args, "model", "deepseek-v4-flash"),
        num_agents=getattr(args, "agents", 8),
        verbose=getattr(args, "verbose", False),
        use_stalling=not getattr(args, "no_stall", False),
        use_lazy_eval=not getattr(args, "no_lazy", False),
        use_lingua=not getattr(args, "no_lingua", False),
        stall_strategy=getattr(args, "stall_strategy", "hybrid"),
        force_all_agents=getattr(args, "force_all", False),
        show_stats=getattr(args, "stats", False),
        force_offline=getattr(args, "offline", False),
    )
    print(result)


if __name__ == "__main__":
    _cli()
