#!/usr/bin/env python3
"""
Download Real Distilled Data — fetch verified frontier model datasets from HuggingFace.

Usage:
    python -m lazy_chameleon.training.download_real_data list
    python -m lazy_chameleon.training.download_real_data download <dataset_key> --samples 1000
    python -m lazy_chameleon.training.download_real_data download-all --samples 500
    python -m lazy_chameleon.training.download_real_data search "math"

Backed by the DATASET_REGISTRY with 30 verified frontier model datasets:
  - Claude Opus 4.7 reasoning traces
  - DeepSeek-R1 800K distilled outputs
  - OpenAI GSM8K, HumanEval, PRM800K
  - Anthropic HH-RLHF, Constitutional AI evals
  - AI-MO NuminaMath (competition math)
  - MetaMathQA, Orca-Math, MathInstruct
  - Magicoder Evol-Instruct (code)
  - NVIDIA HelpSteer2, DPO Mix 7K
  - and more...
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# Default data directory
DEFAULT_DATA_DIR = os.path.expanduser("~/.lazy_chameleon/distilled_data")


def _ensure_hf() -> bool:
    """Check if `datasets` library is available."""
    try:
        import datasets  # noqa: F401
        return True
    except ImportError:
        return False


def cmd_list(args: argparse.Namespace) -> None:
    """List all available datasets in the registry."""
    from lazy_chameleon.training.dataset_registry import DATASET_REGISTRY

    print(f"\n{'='*80}")
    print(f"  LAZY CHAMELEON — REAL FRONTIER MODEL DATA REGISTRY")
    print(f"  {len(DATASET_REGISTRY)} verified datasets from HuggingFace")
    print(f"{'='*80}\n")

    print(f"{'Key':35s} {'HuggingFace Path':50s} {'Size':12s} {'License'}")
    print(f"{'─'*35} {'─'*50} {'─'*12} {'─'*20}")

    for key in sorted(DATASET_REGISTRY.keys()):
        src = DATASET_REGISTRY[key]
        tags = ", ".join(t for t in src.tags if t in (
            "frontier", "reasoning", "math", "code", "instruction",
            "alignment", "cot", "dpo", "rlhf", "safety"
        ))
        print(f"{key:35s} {src.hf_path:50s} {src.dataset_size:12s} {src.license or '':20s}")

    print(f"\n{'='*80}")
    print(f"  DATA DOWNLOAD COMMANDS")
    print(f"{'='*80}")
    print(f"  # Download a single dataset")
    print(f"  python -m lazy_chameleon.training.download_real_data download claude-opus-4-7-reasoning --samples 1000")
    print(f"")
    print(f"  # Download all datasets (500 samples each)")
    print(f"  python -m lazy_chameleon.training.download_real_data download-all --samples 500")
    print(f"")
    print(f"  # Search for math datasets")
    print(f"  python -m lazy_chameleon.training.download_real_data search math")
    print()


def cmd_search(args: argparse.Namespace) -> None:
    """Search the registry for datasets matching a query."""
    from lazy_chameleon.training.dataset_registry import search_datasets, list_available_datasets

    results = search_datasets(args.query)
    print(f"\nFound {len(results)} datasets matching '{args.query}':\n")
    for src in results:
        print(f"  {src.name:35s} → {src.hf_path}")
        print(f"  {'':35s}  Size: {src.dataset_size}, Tags: {', '.join(src.tags)}")
        print()


def cmd_download(args: argparse.Namespace) -> None:
    """Download a specific dataset from the registry."""
    from lazy_chameleon.training.dataset_registry import (
        DATASET_REGISTRY, get_source, load_dataset, DistillationDataset,
    )
    from lazy_chameleon.training.dataset import TrainingDataset

    if args.key not in DATASET_REGISTRY:
        print(f"ERROR: Unknown dataset '{args.key}'")
        print(f"Available: {list(DATASET_REGISTRY.keys())}")
        sys.exit(1)

    src = get_source(args.key)
    out_dir = Path(args.out_dir) / args.key
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"\n{'='*70}")
    print(f"  Downloading: {args.key}")
    print(f"  From:        {src.hf_path}")
    print(f"  Format:      {src.format_type}")
    print(f"  To:          {out_dir}")
    print(f"  Samples:     {args.samples or 'all'}")
    print(f"{'='*70}\n")

    if not _ensure_hf():
        print("\nERROR: `datasets` library not installed.")
        print("Install with: pip install datasets")
        sys.exit(1)

    try:
        dd = load_dataset(args.key, split="train", streaming=False)
        td: TrainingDataset = dd.to_training_dataset()
        print(f"  Loaded {len(td)} examples from {src.hf_path}")

        if args.samples and len(td) > args.samples:
            import random
            td.datapoints = random.sample(td.datapoints, args.samples)
            print(f"  Sampled to {len(td)} examples")

        # Save as JSONL
        output_file = out_dir / "data.jsonl"
        with open(output_file, "w", encoding="utf-8") as f:
            for dp in td.datapoints:
                record = {
                    "task": dp.input_,
                    "response": dp.output,
                    "domain": dp.domain,
                    "source": args.key,
                    "hf_path": src.hf_path,
                }
                f.write(json.dumps(record) + "\n")

        # Save metadata
        meta = {
            "dataset_key": args.key,
            "hf_path": src.hf_path,
            "total_samples": len(td),
            "format_type": src.format_type,
            "license": src.license,
            "tags": src.tags,
            "source_url": src.source_url,
            "downloaded_at": __import__("datetime").datetime.now().isoformat(),
        }
        with open(out_dir / "metadata.json", "w") as f:
            json.dump(meta, f, indent=2)

        print(f"\n  ✓ Saved {len(td)} examples to {output_file}")
        print(f"  ✓ Metadata saved to {out_dir / 'metadata.json'}")

        # Print sample
        if td.datapoints:
            sample = td.datapoints[0]
            print(f"\n  Sample:")
            print(f"  Task:     {sample.input_[:100]}{'...' if len(sample.input_) > 100 else ''}")
            print(f"  Response: {sample.output[:100]}{'...' if len(sample.output) > 100 else ''}")

    except Exception as e:
        print(f"\n  ERROR downloading '{args.key}': {e}")
        print(f"  The dataset '{src.hf_path}' may require authentication or may not exist.")
        print(f"  Visit: {src.source_url}")
        sys.exit(1)


def cmd_download_all(args: argparse.Namespace) -> None:
    """Download all datasets from the registry."""
    from lazy_chameleon.training.dataset_registry import DATASET_REGISTRY

    success = []
    failed = []

    for key in sorted(DATASET_REGISTRY.keys()):
        print(f"\n{'─'*70}")
        try:
            cmd_download(argparse.Namespace(
                key=key, samples=args.samples, out_dir=args.out_dir,
            ))
            success.append(key)
        except SystemExit:
            failed.append(key)
        except Exception as e:
            print(f"  FAILED: {e}")
            failed.append(key)

    print(f"\n{'='*70}")
    print(f"  DOWNLOAD SUMMARY")
    print(f"{'='*70}")
    print(f"  Successful: {len(success)}/{len(DATASET_REGISTRY)}")
    print(f"  Failed:     {len(failed)}/{len(DATASET_REGISTRY)}")
    if failed:
        print(f"  Failed datasets: {failed}")
    print()


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m lazy_chameleon.training.download_real_data",
        description="Download real distilled data from frontier models via HuggingFace.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = parser.add_subparsers(dest="command")

    # list
    sub.add_parser("list", help="List all available datasets in the registry")

    # search
    search_p = sub.add_parser("search", help="Search datasets by keyword")
    search_p.add_argument("query", type=str, help="Search query")

    # download
    dl_p = sub.add_parser("download", help="Download a specific dataset")
    dl_p.add_argument("key", type=str, help="Dataset key from registry")
    dl_p.add_argument("--samples", "-n", type=int, default=None,
                      help="Max samples to download (default: all)")
    dl_p.add_argument("--out-dir", "-o", type=str, default=DEFAULT_DATA_DIR,
                      help=f"Output directory (default: {DEFAULT_DATA_DIR})")

    # download-all
    dla_p = sub.add_parser("download-all", help="Download all datasets")
    dla_p.add_argument("--samples", "-n", type=int, default=500,
                       help="Max samples per dataset (default: 500)")
    dla_p.add_argument("--out-dir", "-o", type=str, default=DEFAULT_DATA_DIR,
                       help=f"Output directory (default: {DEFAULT_DATA_DIR})")

    return parser


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()

    if args.command == "list":
        cmd_list(args)
    elif args.command == "search":
        cmd_search(args)
    elif args.command == "download":
        cmd_download(args)
    elif args.command == "download-all":
        cmd_download_all(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
