"""
CLI for browsing, searching, and inspecting the system prompt library.

Usage::

    chameleon prompts browse                   # list all prompts
    chameleon prompts browse --provider openai  # filter by provider
    chameleon prompts search "claude opus"      # full-text search
    chameleon prompts show anthropic/grok-4     # show prompt content
    chameleon prompts stats                     # library statistics
"""

from __future__ import annotations

import argparse
import sys
import textwrap
from pathlib import Path
from typing import List, Optional

from lazy_chameleon.prompts._library_init import SystemPromptLibrary, get_library


def register_subparser(sub: argparse._SubParsersAction) -> None:
    """Register the ``prompts`` subcommand and its sub-subcommands."""
    parser = sub.add_parser(
        "prompts",
        help="Browse, search, and inspect the system prompt library",
        description="Browse, search, and inspect 280+ leaked system prompts.",
    )
    prompts_sub = parser.add_subparsers(dest="prompts_command")

    # --- browse ---
    browse_parser = prompts_sub.add_parser(
        "browse",
        help="List prompts, optionally filtered",
    )
    browse_parser.add_argument(
        "--provider", "-p",
        default="",
        help="Filter by provider (e.g. anthropic, openai, google)",
    )
    browse_parser.add_argument(
        "--model", "-m",
        default="",
        help="Filter by model name (substring match)",
    )
    browse_parser.add_argument(
        "--tag", "-t",
        default="",
        help="Filter by tag",
    )
    browse_parser.add_argument(
        "--plain",
        action="store_true",
        help="Plain output (machine-friendly)",
    )

    # --- search ---
    search_parser = prompts_sub.add_parser(
        "search",
        help="Full-text search through all prompt contents",
    )
    search_parser.add_argument(
        "query",
        nargs="+",
        help="Search terms",
    )
    search_parser.add_argument(
        "--max", type=int, default=20,
        help="Max results to show (default: 20)",
    )
    search_parser.add_argument(
        "--plain",
        action="store_true",
        help="Plain output (machine-friendly)",
    )

    # --- show ---
    show_parser = prompts_sub.add_parser(
        "show",
        help="Show the content of a specific prompt",
    )
    show_parser.add_argument(
        "path",
        help="Prompt path (absolute, relative, or provider-relative)",
    )
    show_parser.add_argument(
        "--raw",
        action="store_true",
        help="Print raw markdown content",
    )

    # --- stats ---
    prompts_sub.add_parser("stats", help="Show library statistics")

    # --- providers ---
    prompts_sub.add_parser("providers", help="List all providers")

    # --- models ---
    models_parser = prompts_sub.add_parser(
        "models",
        help="List models for a provider",
    )
    models_parser.add_argument(
        "provider",
        nargs="?",
        default="",
        help="Provider name (e.g. anthropic)",
    )

# ──────────────────────────────────────────────────────────────────────────────
# Command handlers
# ──────────────────────────────────────────────────────────────────────────────

def handle(args: argparse.Namespace) -> None:
    """Dispatch to the appropriate command handler."""
    cmd = args.prompts_command

    if cmd == "browse":
        _cmd_browse(args)
    elif cmd == "search":
        _cmd_search(args)
    elif cmd == "show":
        _cmd_show(args)
    elif cmd == "stats":
        _cmd_stats()
    elif cmd == "providers":
        _cmd_providers()
    elif cmd == "models":
        _cmd_models(args)
    else:
        print("Usage: chameleon prompts <command> [options]")
        print("Commands: browse, search, show, stats, providers, models")
        sys.exit(1)


# ── browse ───────────────────────────────────────────────────────────────────

def _cmd_browse(args: argparse.Namespace) -> None:
    lib = get_library()
    prompts = lib.browse(
        provider=args.provider or None,
        model=args.model or None,
        tag=args.tag or None,
    )

    if not args.provider and not args.model and not args.tag and not args.plain:
        print(f"System Prompt Library — {len(prompts)} prompts across "
              f"{len(lib.list_providers())} providers")
        print("Use --provider, --model, or --tag to filter.")
        print("─" * 60)

    if args.plain:
        for p in prompts:
            print(f"{p.provider}/{p.stem}.md")
        return

    from collections import defaultdict
    by_prov: dict = defaultdict(list)
    for p in prompts:
        by_prov[p.provider].append(p)

    for prov in sorted(by_prov):
        prov_prompts = by_prov[prov]
        print(f"\n  [{prov.upper()}]  {len(prov_prompts)} prompts")
        print(f"  {'─' * 50}")
        for p in prov_prompts:
            tags_fmt = f"  [{', '.join(p.tags[:3])}]" if p.tags else ""
            print(f"    {p.stem}{tags_fmt}")
        print()


# ── search ───────────────────────────────────────────────────────────────────

def _cmd_search(args: argparse.Namespace) -> None:
    lib = get_library()
    query = " ".join(args.query)
    results = lib.search(query)

    if args.plain:
        for r in results[:args.max]:
            print(f"{r.provider}/{r.stem}.md")
        return

    print(f"Search results for \"{query}\" ({len(results)} matches, "
          f"showing top {min(args.max, len(results))})")
    print("─" * 60)
    for i, r in enumerate(results[:args.max]):
        tags_fmt = f"  [{', '.join(r.tags[:3])}]" if r.tags else ""
        print(f"  {i+1:>3}. {r.provider:>12} / {r.stem}{tags_fmt}")
    print()

# ── show ─────────────────────────────────────────────────────────────────────

def _cmd_show(args: argparse.Namespace) -> None:
    lib = get_library()
    prompt = lib.get(args.path)

    if prompt is None:
        print(f"ERROR: no prompt found at \"{args.path}\"", file=sys.stderr)
        print("Try: chameleon prompts browse | grep <term>", file=sys.stderr)
        sys.exit(1)

    content = prompt.load()

    if args.raw:
        print(content)
        return

    header = f" {prompt.provider.upper()} / {prompt.model} "
    width = max(len(header), 60)
    print(f"{'─' * width}")
    print(f"  Provider  : {prompt.provider}")
    print(f"  Model     : {prompt.model}")
    print(f"  Path      : {prompt.file_path}")
    print(f"  Size      : {prompt.size_bytes:,} bytes")
    if prompt.tags:
        print(f"  Tags      : {', '.join(prompt.tags)}")
    print(f"{'─' * width}")
    print()
    lines = content.splitlines()
    for line in lines[:80]:
        print(line)
    if len(lines) > 80:
        print(f"\n  ... ({len(lines) - 80} more lines — use --raw for full content)")
    print()


# ── stats ────────────────────────────────────────────────────────────────────

def _cmd_stats() -> None:
    lib = get_library()
    stats = lib.get_stats()
    print()
    print("  System Prompt Library — Statistics")
    print(f"  {'─' * 55}")
    print(f"  {'Total prompts':<30} {stats['total']:>8}")
    print(f"  {'Providers':<30} {stats['providers']:>8}")
    print(f"  {'Models':<30} {stats['models']:>8}")
    print(f"  {'Total size':<30} {_fmt_bytes(stats['total_size_bytes']):>8}")
    print()
    print(f"  {'  Provider':<22} {'Count':>6} {'Models':>6} {'Size':>10}")
    print(f"  {'  ' + '─' * 46}")
    for prov in sorted(stats["by_provider"]):
        ps = stats["by_provider"][prov]
        print(f"  {'  ' + prov:<22} {ps['count']:>6} {ps['models']:>6} "
              f"{_fmt_bytes(ps['size_bytes']):>10}")
    print()


def _fmt_bytes(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f} MB"
    if n >= 1_000:
        return f"{n / 1_000:.1f} kB"
    return f"{n} B"


# ── providers ────────────────────────────────────────────────────────────────

def _cmd_providers() -> None:
    lib = get_library()
    print()
    print("  Providers")
    print(f"  {'─' * 40}")
    for prov in lib.list_providers():
        models = lib.list_models(prov)
        print(f"    {prov:<12}  {len(models)} models")
    print()


# ── models ───────────────────────────────────────────────────────────────────

def _cmd_models(args: argparse.Namespace) -> None:
    lib = get_library()

    if args.provider:
        models = lib.list_models(args.provider)
        print()
        print(f"  Models for {args.provider}")
        print(f"  {'─' * 40}")
        for m in models:
            print(f"    {m}")
        print(f"  Total: {len(models)}")
        print()
    else:
        for prov in lib.list_providers():
            models = lib.list_models(prov)
            print(f"  {prov:<12}  {len(models)} models")

