# Scoring SWE-bench predictions with the official harness

`swebench.mjs` deliberately does **not** reimplement scoring. A score only
means something if it comes from the official SWE-bench evaluation harness —
the same one every published number uses. This file is the recipe.

## Prerequisites

```bash
pip install swebench          # official harness (github.com/SWE-bench/SWE-bench)
docker --version              # the harness builds one Docker image per repo
                              # and runs FAIL_TO_PASS / PASS_TO_PASS inside it
```

Docker is not optional for official scoring: each instance's tests run in the
repo's pinned environment image. No Docker → no official score, only
predictions. (Mochi-side, the runner itself needs only git + node.)

## Generate predictions

```bash
cd <mochi repo root>
node bench/external/swebench.mjs \
  --dataset ~/data/swebench-verified.jsonl \
  --out runs/verified-predictions.jsonl \
  --model <provider-model-id> \
  --repos-dir ~/data/swebench-repos \
  --run-id verified-001
```

The predictions file is exactly the official format, one object per line:

```json
{"instance_id": "django__django-16333", "model_name_or_path": "mochi/<model>", "model_patch": "diff --git a/..."}
```

## Score them

```bash
python -m swebench.harness.run_evaluation \
  --dataset_name SWE-bench/SWE-bench_Verified \
  --split test \
  --predictions_path runs/verified-predictions.jsonl \
  --max_workers 8 \
  --run_id verified-001
```

Outputs (in the current directory):
- `<model_name>.<run_id>.json` — the summary: `resolved_instances`,
  `unresolved_instances`, `empty_patch_instances`, `error_instances`, counts.
- `logs/run_evaluation/<run_id>/<model_name>/` — per-instance test logs,
  including the FAIL_TO_PASS / PASS_TO_PASS breakdown for every instance.

…or let the runner shell out for you (same command, same flags):

```bash
node bench/external/swebench.mjs --dataset … --out … --score --run-id verified-001
```

If python/swebench/Docker are missing, `--score` prints a warning and leaves
the predictions file untouched — score it later, anywhere the harness exists.

## Which dataset_name for which run

| Runner dataset file | `--dataset_name` | `--split` | Notes |
|---|---|---|---|
| SWE-bench Verified (500) | `SWE-bench/SWE-bench_Verified` | `test` | The headline number |
| SWE-bench Lite (300) | `SWE-bench/SWE-bench_Lite` | `test` | Smoke tier — run this first |
| SWE-bench full test (2,294) | `SWE-bench/SWE-bench` | `test` | Slow; mostly for final claims |
| SWE-bench Multilingual (300) | `SWE-bench/SWE-bench_Multilingual` | `test` | 9 languages; images differ per language |

SWE-bench Pro is **not** scored with this harness — Scale AI ships its own
evaluation (see the SWE-bench Pro repo). Do not report a Pro number from the
standard harness, and never blend public/commercial Pro scores
(dataset-catalog.md §2).

## Reporting rules (non-negotiable, from dataset-catalog.md §6)

Every reported score states: which eval + split, the Mochi harness
version/commit, the model, k / pass@k, and that the training corpus behind the
model was filtered with `eval_blocklist.json` (`blocklist.mjs`). Benchmark
boards are not comparable across scaffolds — Mochi reports numbers from one
frozen scaffold (this runner) only.

## Sanity checks before believing a number

1. `empty_patch_instances` should be small and explainable (timeouts, agent
   refusals) — a large count usually means the runner, not the model, broke.
2. Spot-read 2–3 per-instance logs: confirm the applied patch is the model's
   patch, and FAIL_TO_PASS tests actually ran.
3. Confirm the run's worktrees were frozen: the runner squashes history to a
   single "base snapshot" commit, so `git log` inside a kept worktree
   (`--keep-work`) must show exactly one pre-agent commit.
