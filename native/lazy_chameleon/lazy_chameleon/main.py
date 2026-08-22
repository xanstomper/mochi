"""Lazy Chameleon v2.2 — Synthetic Parameter Generator

Not a server. Not an API. Not a TUI.
Just generates synthetic parameters that any agent uses.

Usage
-----
    chameleon enhance "Build a REST API" --mode hard
    echo "Fix this bug" | chameleon enhance --mode extreme
    chameleon enhance "Design system" --mode genius --verbose
    chameleon enhance "Rate limiter" --mode flash --provider anthropic

    # Pipe into Claude Code:
    chameleon enhance "refactor auth module" --mode hard | claude --pipe

Or from Python:
    from lazy_chameleon.enhance import enhance
    context = enhance("Build a REST API", mode="hard")
    # Inject context into your agent's system prompt

Modes (ascending compute)
--------------------------
    flash   →  turbo   →  easy   →  medium  →  hard
    extreme →  deep    →  genius →  god     →  opus

Providers
---------
    opencode-go   OpenCode AI (default, fast, free tier)
    opencode-zen  OpenCode AI zen endpoint
    anthropic     Native Anthropic API (Claude models)
    openai        OpenAI (GPT-4o, o3, etc.)
    openrouter    OpenRouter aggregator
"""
from __future__ import annotations

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lazy_chameleon.enhance import enhance


_MODES = [
    "flash", "turbo", "easy", "medium", "hard",
    "extreme", "deep", "genius", "god", "opus", "auto",
]

_PROVIDERS = [
    "opencode", "opencode-zen", "opencode-go",
    "anthropic", "openai", "openrouter",
]


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="chameleon",
        description=(
            "Lazy Chameleon v2.2 — synthetic parameter generation for any LLM agent."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )

    sub = parser.add_subparsers(dest="command")

    # --- enhance subcommand ---
    enh = sub.add_parser(
        "enhance",
        help="Generate synthetic parameters for a task",
    )
    enh.add_argument(
        "task",
        nargs="?",
        default="",
        help="Task description (or omit to read from stdin)",
    )
    enh.add_argument(
        "--mode", "-m",
        default="auto",
        choices=_MODES,
        help="Compute mode — higher = more synthetic params (default: auto)",
    )
    enh.add_argument(
        "--provider", "-p",
        default="opencode-go",
        choices=_PROVIDERS,
        help="LLM provider (default: opencode-go)",
    )
    enh.add_argument(
        "--model", "-M",
        default="",
        help="Model name override (default: provider's recommended model)",
    )
    enh.add_argument(
        "--api-key", "-k",
        default="",
        help="API key (auto-detected from env if omitted)",
    )
    enh.add_argument(
        "--agents", "-a",
        type=int,
        default=8,
        metavar="N",
        help="Number of lazy agents to spawn (2–12, default: 8)",
    )
    enh.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Print per-agent progress to stderr",
    )
    enh.add_argument(
        "--offline",
        action="store_true",
        help="Generate template context without API calls",
    )
    enh.add_argument(
        "--no-cache",
        action="store_true",
        help="Skip synthesis cache (always re-generate)",
    )
    enh.add_argument(
        "--stats",
        action="store_true",
        help="Print token and cost stats to stderr after generation",
    )
    enh.add_argument(
        "--output", "-o",
        default="",
        metavar="FILE",
        help="Write output to FILE instead of stdout",
    )

    # --- modes subcommand (info) ---
    sub.add_parser("modes", help="List available compute modes and their multipliers")

    # --- providers subcommand (info) ---
    sub.add_parser("providers", help="List available providers and default models")

    # --- prompts subcommand (library) ---
    from lazy_chameleon.prompts.cli import register_subparser
    register_subparser(sub)

    return parser


def _cmd_modes() -> None:
    from lazy_chameleon.agents.base import MODE_MULTIPLIERS
    print("Lazy Chameleon — Compute Modes")
    print("─" * 50)
    print(f"{'Mode':<12} {'Multiplier':>12}  Description")
    print("─" * 50)
    desc = {
        "flash":   "instant, minimal (3×)",
        "turbo":   "fast, reduced depth (10×)",
        "easy":    "simple tasks (7×)",
        "medium":  "typical tasks (50×)",
        "hard":    "complex tasks (200×)",
        "extreme": "very hard tasks (1000×)",
        "deep":    "research-level (500×)",
        "genius":  "frontier-level (2500×)",
        "god":     "maximum compute (5000×)",
        "opus":    "alias for god (5000×)",
        "auto":    "auto-select based on task",
    }
    for mode in _MODES:
        mult = MODE_MULTIPLIERS.get(mode, "auto")
        label = f"{mult}×" if isinstance(mult, int) else mult
        print(f"  {mode:<10} {label:>10}  {desc.get(mode, '')}")


def _cmd_providers() -> None:
    from lazy_chameleon.core.api import PROVIDER_PRESETS
    print("Lazy Chameleon — Providers")
    print("─" * 60)
    for name, preset in PROVIDER_PRESETS.items():
        print(f"  {name:<16} {preset['default_model']}")
        print(f"  {'':16} {preset['base_url']}")
        print()


def _cmd_enhance(args: argparse.Namespace) -> None:
    # Resolve task from arg or stdin
    task = args.task or ""
    if not task and not sys.stdin.isatty():
        task = sys.stdin.read().strip()
    if not task:
        print("ERROR: provide a task as argument or pipe via stdin", file=sys.stderr)
        sys.exit(1)

    if args.verbose:
        print(f"  [CHAM] Task   : {task[:80]}{'…' if len(task) > 80 else ''}",
              file=sys.stderr)
        print(f"  [CHAM] Mode   : {args.mode}", file=sys.stderr)
        print(f"  [CHAM] Provider: {args.provider}", file=sys.stderr)
        print(f"  [CHAM] Agents : {args.agents}", file=sys.stderr)

    t0 = time.time()
    context = enhance(
        task=task,
        mode=args.mode,
        api_key=args.api_key,
        provider=args.provider,
        model=args.model,
        num_agents=args.agents,
        verbose=args.verbose,
        offline=args.offline,
    )
    elapsed = time.time() - t0

    if args.verbose or args.stats:
        chars = len(context)
        tokens_est = chars // 4
        print(f"  [CHAM] Done in {elapsed:.1f}s — {chars:,} chars "
              f"(~{tokens_est:,} tokens)", file=sys.stderr)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as fh:
            fh.write(context)
        if args.verbose:
            print(f"  [CHAM] Saved to {args.output}", file=sys.stderr)
    else:
        print(context)


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()

    if args.command == "modes":
        _cmd_modes()
    elif args.command == "providers":
        _cmd_providers()
    elif args.command == "enhance":
        _cmd_enhance(args)
    elif args.command == "prompts":
        from lazy_chameleon.prompts.cli import handle as prompts_handle
        prompts_handle(args)
    else:
        # Bare `chameleon <task>` without subcommand — treat as enhance
        if len(sys.argv) > 1 and not sys.argv[1].startswith("-"):
            # Re-parse with enhance as implicit subcommand
            sys.argv.insert(1, "enhance")
            args = parser.parse_args()
            _cmd_enhance(args)
        else:
            parser.print_help()


if __name__ == "__main__":
    main()
