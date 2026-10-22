# bench/external — Mochi's external benchmark harness

What Mochi had before this directory: micro-benchmarks (startup, RSS, SSE
throughput) and `bench/arena.mjs`, a 6-task toy suite. Nothing that answers
"did this harness change make Mochi better at real software engineering?"
This directory is that answer (improvement plan **P0.2**): two thin runners
plus the contamination blocklist that must exist *before* any training data
is downloaded.

No new dependencies. Everything runs on the node + git already required by
the repo (scoring additionally needs python + Docker, on whatever machine
runs the official harness).

## Files

| File | What it is |
|---|---|
| `swebench.mjs` | Runs Mochi headlessly on SWE-bench-style instances, emits official-format predictions |
| `score-swebench.md` | How predictions become a score (official `swebench` harness — never reimplemented here) |
| `terminalbench.mjs` | Runs Mochi on Terminal-Bench-style task dirs, grades with each task's own tests |
| `targets.mjs` | Adapters for the current targets: Terminal-Bench 4.0 (Harbor format) + SWE-bench Pro V2 (public + Hard split) — validate / enumerate / run / emit, eval-only enforced |
| `targets.test.mjs` | `node --test` suite for the target adapters (offline, fixture-based) |
| `fixtures/` | Synthetic format-faithful fixtures for the adapters (NOT real eval tasks) |
| `blocklist.mjs` | The contamination filter library + CLI (load / `isBlocked` / `filterRecords` / `expand` / `coverage`) |
| `eval_blocklist.json` | The blocklist data: eval dataset identifiers (+ instance IDs once expanded) |
| `blocklist.test.mjs` | `node --test` suite for the blocklist contract |
| `README.md` | This file |

## The headless invocation (verified against the code)

From `src/cli.ts` help, `src/cli-flags.ts`, and `bench/arena.mjs` — Mochi's
non-interactive mode is `-p/--print`, where the prompt is the *positional*
argument after the flags:

```bash
node dist/cli.js -p --yolo --model <id> --provider <name> "<prompt>"
```

Both runners spawn exactly this (as `node <mochi-bin> …`) with the instance
worktree as cwd. `--yolo` is on by default for eval runs: the worktree is
disposable and an approval prompt would hang a headless run forever; pass
`--no-yolo` to change that. Note the difference from a naive expectation:
there is **no** `--prompt`/`--cwd`/`--headless` flag — cwd comes from the
spawn, and `-p` consumes the next argv as a boolean flag, with the prompt as
the trailing positional.

## SWE-bench runner

```bash
# 1. Get an instances file (JSONL or JSON array): fields per instance —
#    instance_id, repo, base_commit, problem_statement [, FAIL_TO_PASS, PASS_TO_PASS]
#    e.g. export the HF dataset SWE-bench/SWE-bench_Verified (test split) to JSONL.
# 2. Make the source repos available ONE of these ways:
#    a. instance.repo_path per instance (local mirrors), or
#    b. --repos-dir <dir> with <dir>/<owner>__<repo> clones, or
#    c. --clone (git clone from github.com into a cache; needs network)

# Smoke first (no API key needed — proves the whole pipeline):
node bench/external/swebench.mjs --dataset instances.jsonl --limit 2 --dry-run --keep-work

# Real run:
node bench/external/swebench.mjs --dataset instances.jsonl \
  --out runs/verified-predictions.jsonl --model <id> --repos-dir ~/data/swebench-repos \
  --timeout 1800 --run-id verified-001

# Score (official harness — see score-swebench.md):
python -m swebench.harness.run_evaluation \
  --dataset_name SWE-bench/SWE-bench_Verified --split test \
  --predictions_path runs/verified-predictions.jsonl --max_workers 8 --run_id verified-001
```

**Leakage freeze.** For every instance the runner clones the source repo,
checks out `base_commit`, then *deletes `.git` and re-initialises a fresh
repo with a single "base snapshot" commit*. The agent cannot read the fixing
commit, future branches, or any history past the base — agents have "solved"
SWE tasks exactly that way, and a patch produced that way is both an invalid
score and poisoned training data. The honest trade-off: the agent also loses
legitimate pre-base history (blame, log). Patch capture is then
`git add -A && git diff --cached` (Mochi's own `.mochi/` state is stripped
first), written as `{instance_id, model_name_or_path, model_patch}` — the
official prediction format, byte for byte. A parallel
`<out>.results.jsonl` records status, timing, frozen HEAD, and the agent's
output tail per instance.

**Dry run.** `--dry-run` never invokes Mochi. It applies, in order:
`--stub-patch <file>`, else the instance's `stub_patch` field (a diff path
relative to the dataset file), else it creates `MOCHI_DRY_RUN_STUB.md`.
Everything else — freezing, capture, both output files — is the real code path.

Wire order for real evals (plan P0.2): **Lite (smoke) → Verified (500) →
Terminal-Bench 2.0 (89) → Pro public (731) + Multilingual (300)**.

## Terminal-Bench runner

```bash
node bench/external/terminalbench.mjs --tasks-dir ~/data/terminal-bench-2.0/tasks \
  --out runs/tb2-results.jsonl --model <id> --timeout 1800
```

Task dir contract (per task): `instruction.md` (or `instruction.txt`, or
`task.yaml` with an `instruction:` field), optional `environment/` (or
`files/`) copied into a fresh work dir, and tests — `tests/run-tests.sh`
preferred (run with cwd = work dir, `$TB_WORKDIR` set, exit 0 = pass), else
`tests/*.py` via pytest. Results JSONL carries `passed`, `test_exit_code`,
output tails, and timing per task.

**Dry run:** a task may ship `stub.sh`; in `--dry-run` it runs *instead of*
Mochi (a stand-in agent that produces the expected artefacts). Without it the
agent phase is a no-op and the tests will normally fail — the record still
proves the plumbing.

**Isolation honesty:** official Terminal-Bench runs every task in Docker.
This runner does **not** — it runs Mochi and the tests locally, in a copied
directory, with your permissions. Use it for plumbing/smoke/trusted task sets,
or run the whole script inside a disposable VM/container for untrusted tasks.

## Current targets (targets.mjs)

**Terminal-Bench 4.0** — 66 tasks in Harbor format (`task.toml` with
`[task] name = "org/name"`, `instruction.md`, `environment/`,
`tests/test.sh`, optional `solution/solve.sh`). The adapter validates and
enumerates that layout, and for a run it materializes a
terminalbench.mjs-shaped shadow (instruction + plain environment files —
the Dockerfile is *excluded*, the thin runner does not build images) and
invokes the existing runner. A task's `solution/solve.sh` becomes the
`--dry-run` oracle stub, so the smoke path actually discriminates.

```bash
node bench/external/targets.mjs validate --target tb4 --tasks-dir ~/data/terminal-bench-4.0/tasks
node bench/external/targets.mjs run --target tb4 --tasks-dir ~/data/terminal-bench-4.0/tasks \
  --purpose eval --dry-run --out runs/tb4-smoke.jsonl
```

**SWE-bench Pro V2** — Scale's revised public split (642 tasks;
arXiv:2610.24206) plus the separate 51-task Hard split. The adapter
validates the instance schema, normalizes records into the exact dataset
shape `swebench.mjs` consumes, and **drops the gold `patch`/`test_patch`**
— an emitted eval dataset never carries the answers. Hard-split membership
comes only from record fields or an explicit `--ids` file; with neither
signal the adapter refuses rather than guessing.

```bash
node bench/external/targets.mjs emit-dataset --target swebench-pro-v2 \
  --dataset ~/data/SWE-bench_Pro_V2.jsonl --purpose eval --split hard \
  --ids ~/data/pro-v2-hard-ids.txt --out runs/pro-v2-hard.jsonl
# then run/score exactly like the SWE-bench runner above.
```

**Eval-only, enforced:** `run` / `emit-dataset` require `--purpose eval`.
Any training-shaped purpose (`train`, `curriculum-generation`, …) is a
hard refusal (exit 3) — the frozen gate's rule, applied at the adapter.
Both targets are named in `eval_blocklist.json` (seed-only until expanded
from the canonical releases, like every other entry).

## The blocklist (contamination rules)

> If a task, repo, or answer could appear in an eval Mochi reports, it does
> not go into training — in any form: no prompts, no gold patches, no teacher
> trajectories on those instances, no paraphrases, no "synthetic variants."
> (dataset-catalog.md §6)

`eval_blocklist.json` is the single source. **Matching** (`blocklist.mjs`):
exact `instance_id`, exact `base_commit` (a git SHA is globally unique), or
exact `(repo, base_commit)` pair. A repo name alone **never** blocks — the
SWE-bench *train* split legitimately shares repos with its test split, and
blocking by repo would destroy valid training data. Every training file is
filtered at ingestion, and **every drop is logged** — an unlogged drop is a
bug, because the filter run itself has to be auditable.

**What the seed honestly covers:** correct dataset identifiers, splits,
expected sizes, and public repo names for SWE-bench Verified / Lite / full
test / Pro public / Multilingual / Multimodal and Terminal-Bench 1.0 / 2.0 /
2.1. The per-instance ID arrays ship **empty on purpose** — IDs are never
written from memory or fabricated. Populate them from the canonical datasets
right after download:

```bash
node bench/external/blocklist.mjs coverage          # see what's expanded vs seed-only

node bench/external/blocklist.mjs expand ~/data/SWE-bench_Verified.jsonl --dataset swe-bench-verified
node bench/external/blocklist.mjs expand ~/data/SWE-bench_Lite.jsonl     --dataset swe-bench-lite
node bench/external/blocklist.mjs expand ~/data/SWE-bench_Pro.jsonl      --dataset swe-bench-pro-public
node bench/external/blocklist.mjs expand ~/data/SWE-bench_Multilingual.jsonl --dataset swe-bench-multilingual
# Terminal-Bench: task ids are task-dir names —
ls ~/data/terminal-bench-2.0/tasks | awk '{printf "{\"instance_id\":\"%s\"}\n",$1}' > ~/data/tb2-ids.jsonl
node bench/external/blocklist.mjs expand ~/data/tb2-ids.jsonl --dataset terminal-bench-2.0
```

Use it in ingestion code:

```js
import { loadBlocklist } from './bench/external/blocklist.mjs';
const bl = loadBlocklist();
bl.isBlocked({ instanceId, repo, baseCommit });        // false | {blocked, reason, dataset}
const { kept, dropped } = bl.filterRecords(records, { source: 'swe-gym.jsonl' }); // drops are logged
```

..or from the shell:

```bash
node bench/external/blocklist.mjs filter train-candidates.jsonl train-clean.jsonl --log filter-drops.jsonl
node bench/external/blocklist.mjs check train-clean.jsonl   # exit 1 if anything blocked remains
```

Until a dataset is expanded, `coverage` reports it as `SEED-ONLY` and
ingestion must treat it as "unknown — verify manually", never as "clean".
Every score Mochi reports must be able to state which blocklist version
filtered its training corpus — that statement is part of the score.

## Tests

```bash
node --test bench/external/blocklist.test.mjs bench/external/targets.test.mjs
```

Proves: match by `instance_id`, match by repo+commit and by commit alone,
repo-alone does *not* block, clean items pass, `filterRecords` drops blocked
items and logs **every** drop, and the shipped seed loads with the expected
datasets and honest (empty) instance coverage.

*(These files intentionally do not touch `package.json`: the commands above
are the interface. If this harness graduates to a `bench:external` script,
add it then — as its own change.)*
