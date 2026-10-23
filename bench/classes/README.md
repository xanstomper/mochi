# bench/classes — the task-class scorecard

One honest table for every kind of work Mochi claims to be good at:

```bash
mochi bench classes run [--k 3] [--dry-run | --live] [--class <id[,id]>] [--json]
mochi bench classes report [--json]     # latest recorded run (or current state)
mochi bench classes history [--json]    # every recorded run, oldest first
mochi bench classes check               # fixture integrity + disjointness only
```

Classes: **short** (quick one-file work), **medium** (multi-file coding),
**complex** (long-horizon), **swe** (SWE-style), **redteam** (security /
red-team), **automation** (terminal tasks), **browser**.

Every cell is traceable to recorded trial outcomes or an ingested result
file. A class with no evidence reports **UNMEASURED** — never 0%, never a
neighbouring class's numbers, never an interpolation. Dry-run numbers are
deterministic plumbing values and their $ costs are offline price-table
estimates; both are labelled **SYNTHETIC** wherever they appear. Runs append
to `history.jsonl` (append-only: improvement over time is a diff of records)
and write a full report to `.mochi/reports/classes-<ts>.md`.

Implementation: `src/evals/class-scorecard.ts` (core) +
`src/evals/classes-cli.ts` (CLI). Costs reuse the gate's conventions
(cost-per-solve = totals ÷ passed trials, only when usage is complete) and
`src/pricing.ts` for estimates.

## The fixture contract (how a wave plugs a class in)

There is exactly ONE task format across the bench — the frozen gate set's
on-disk format (`bench/frozen/README.md`). A fixture set for class `<id>`
is a directory:

```
bench/classes/<id>/
  manifest.json            # kind: "mochi-frozen-gate-set", one entry per task
  blocklist-additions.json # written by freeze; these ids are never training data
  tasks/<task-id>/
    prompt.txt             # the task statement given to the agent
    files/                 # (optional) starting workdir contents
    solution/              # (optional) canned solution overlay, dry-run only
    verify.mjs             # the checker (see contract below)
```

Manifest entries carry `id`, `source`, `provenance`, `category`, `prompt`,
`filesDir`/`solutionDir` (when present), `verifier`, and a content `hash`
pinned by the same machinery as the frozen set (`freezeFrozenSet` in
`src/evals/regression-gate.ts`, or `mochi gate freeze --frozen-dir <dir>`).
Any post-freeze content change is a loud integrity error at load time.

### Checker contract (`verify.mjs`)

- Runs as `node verify.mjs` with **cwd = the task workdir** (setup files
  already copied in; the agent's changes already applied).
- **Exit 0 = pass, exit 1 = fail.** The last non-empty stdout line is the
  human-readable detail shown in reports.
- Node builtins only. **Deterministic**: no wall-clock timing assertions, no
  randomness, no network. Wall-clock budget 60s (the gate core's timeout).
- A checker must **fail on the untouched `files/`** and **pass with
  `solution/` overlaid** — both directions are exercised by the scorecard's
  test suite for the in-tree sets. A checker that passes an unsolved task
  measures nothing.

### Wiring a set into the scorecard

Add the class (or repoint an existing inbox class) in `CLASS_DEFS`
(`src/evals/class-scorecard.ts`): `kind: 'fixtures'`, `setDir:
'bench/classes/<id>'`. The `complex` class currently runs through an
*interim adapter* (the frozen gate set); when the Wave N endurance set
lands, repoint `complex` at its directory the same way — the frozen set
keeps its own surface under `mochi gate`.

## The result-file contract (inbox classes)

Classes whose runners own their fixtures elsewhere (external eval
harnesses; Wave M browser and the SWE / red-team packs while their fixture
sets are in flight) report by dropping ONE JSON file per scored run into
`bench/classes/inbox/<class-id>/`:

```json
{
  "kind": "mochi-class-result",
  "class": "browser",
  "source": "wave-m browser fixtures @ <git sha>",
  "mode": "live",
  "model": "provider/model-id",
  "ts": "2026-10-22T12:00:00.000Z",
  "tasks": [
    { "id": "login-persist", "trials": 3, "passes": 3,
      "medianTurns": 9, "medianTokens": 51234, "costPerSolveUsd": 0.42 }
  ]
}
```

Rules: `mode` is `live` or `dry-run` (dry-run ⇒ the row is labelled
SYNTHETIC); `medianTurns` / `medianTokens` / `costPerSolveUsd` may be
`null` (unknown renders as `—`, never 0); the scorecard ingests the file
with the greatest `ts` per class. A malformed file, a `class` that
disagrees with the directory, or `passes > trials` is a hard error — bad
evidence must fail loudly, not silently become a flattering cell. Per-task
`passRate` is passes/trials; the class pass rate is the mean of per-task
rates (pass@1 convention, same as the gate).

## Disjointness (enforced, not aspirational)

Before any run, the scorecard verifies:

1. **Hash integrity** of the frozen set and every fixture set (gate loader).
2. **Eval blocklist**: no task id / repo / base-commit in any set appears in
   `bench/external/eval_blocklist.json` (the gate's `assertNoBlocklistOverlap`).
3. **Content disjointness**: no two tasks anywhere in {frozen, short,
   medium, …} are the same task — same prompt + same verifier, or one
   task's content wholly contained in another's. A single shared boilerplate
   file between otherwise different tasks is fine; the unit of overlap is
   the task, because the task is what could have been memorised.

Any violation refuses the run with exit code 3. This is the same discipline
as the frozen gate's: a scorecard that quietly rewards memorising the gate
set or a public eval would be worse than no scorecard.

**Eval-only warning:** the `swe` and `automation` classes measure public
eval targets (SWE-bench Pro V2, Terminal-Bench 4.0) through
`bench/external/`. Their instances must NEVER be copied into fixture sets,
prompts, training data, or curriculum — the blocklist check is the floor,
not the whole rule.

## Current state (2026-10-22)

| class | source today |
|---|---|
| short | in-tree fixtures, 12 tasks (`short/`) |
| medium | in-tree fixtures, 8 tasks (`medium/`) |
| complex | interim adapter: frozen gate set (24 tasks) |
| swe | inbox — UNMEASURED until a scored Pro V2 run reports |
| redteam | inbox — UNMEASURED until the red-team pack reports |
| automation | inbox — UNMEASURED until a scored TB 4.0 run reports |
| browser | inbox — UNMEASURED until Wave M reports |
