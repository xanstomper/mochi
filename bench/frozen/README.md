# bench/frozen — the frozen regression gate set

A small, **hash-pinned** task set that Mochi's self-improvement machinery (and
anyone changing the harness) must not silently regress. Design:
`niche-features-and-self-improvement.md` §A.3 + `distillation-pipeline.md`
§5.3. Implementation: `src/evals/regression-gate.ts`, CLI: `mochi gate …`
(`npm run gate` runs `gate run`).

Why it exists: AHE measured a self-evolver's regression foresight at
**11.1% recall** — the thing making a change cannot be trusted to foresee
what it breaks. The gate is independent of the changer in two ways: the
tasks/verifiers are pinned by hash (the changer cannot edit the test to
pass), and the regression analyser sees only the raw diff + measured
outcomes, never the change's rationale or commit messages.

## Commands

```bash
mochi gate check                  # verify hashes + eval-blocklist overlap only
mochi gate baseline [--k 3]       # run the set, store baseline.json (explicit, never automatic)
mochi gate run [--k 3] [--diff <git-ref>] [--dry-run] [--json]
mochi gate freeze                 # deliberate re-pin after an intentional set change
```

Exit codes for `run`: `0` PASS · `1` BLOCKED · `2` PASS-WITH-OBJECTIONS
(criteria met, analyser objections block promotion until answered) ·
`3` infrastructure error (tampered set, blocklist overlap, missing or
stale baseline). Reports are append-only: `.mochi/reports/gate-<ts>.md|.json`.

`--dry-run` applies each task's canned `solution/` overlay instead of
invoking mochi (same role as `bench/external/swebench.mjs --dry-run`): a
plumbing smoke test, labelled synthetic wherever its numbers appear.
Baselines record their mode; a live run refuses to compare against a
dry-run baseline and vice versa.

## Verdict (pipeline §5.3, all must hold)

- pass@1 Δ ≥ **+1.0pp** with paired-bootstrap 95% CI excluding 0, **or**
  statistically equal pass (Δ ≥ −1.0pp, CI straddling 0) at ≥ **10% lower
  cost-per-solve** (tokens; $ reported only when the provider reported it);
- no category regresses **>3pp**;
- broken tasks ≤ fixed tasks;
- no **F7/F12** spike (≥3 failures of the class and either the class was
  absent from the incumbent or its share of failures rose ≥15pp);
- and any analyser objection downgrades PASS → PASS-WITH-OBJECTIONS.

Cost-per-solve = total tokens ÷ passed trials, aggregated only when every
trial's usage is known (a partial sum would flatter the run). Usage comes
from `usage:updated` events in the run traces.

## The set

`manifest.json` pins each task by SHA-256 over its prompt, setup files,
canned solution, and verifier. Any content change invalidates the set hash
and every baseline taken against it — loudly, at load time.

**Seed provenance (honest):** the 6 seed tasks are this repo's own
harness-arena tasks (`bench/arena.mjs`, MCH-90: f1, b1, r1, q1, x1, x2)
re-expressed declaratively; their `verify.mjs` files port the arena
`check` functions exactly. They are **not** SWE-bench or Terminal-Bench
instances and must never be reported as benchmark results.

**v2 growth (2026-10-22):** 12 further tasks derived from this repo's own
pre-runway git history (commits at or below `953ae4f`), each manifest entry
naming its source commit: the starting state is the touched file(s) at the
commit's parent tree, the verifier ports the commit's own regression tests,
and the canned `solution/` is the commit's fixed code (TypeScript types
stripped, CommonJS exports — the frozen-workdir convention; transformations
are named in each entry's provenance). No arena tasks remained unfrozen, no
eval-set content is used, and nothing is derived from the 2026-10-22
runway's own commits. The set is now **18 tasks — fix 7, feature 4,
refactor 4, research 3**.

**Growth plan:** continue toward ~24 hand-kept "golden" tasks drawn from
real past runs (roughly one per F-class of the §4.2 taxonomy), each with
provenance naming the run/trajectory it came from, then bump `version`,
re-freeze, and re-baseline. Until then, read the power note below.

## Statistical power — what this set can and cannot claim

18 tasks × k=3 is still a **tripwire-leaning set, not a powered
experiment**. The paired bootstrap CI at this n remains wide, so:

- the gate *reliably catches* catastrophic regressions: category wipeouts,
  mass breakage, F7/F12 spikes, test-deletion-style diff risks;
- the §5.3 improvement path is nearly unreachable for genuine small
  gains, so BLOCKED at this set size means "no evidence of improvement",
  not "evidence of harm" — every report prints its CI width and this
  warning until the set reaches ~20 tasks;
- no promotion-grade claim ("change X improved Mochi") may cite a gate
  run on this seed set. Claims need the grown golden set, k=3, and the
  frozen scaffold (one harness config for all compared runs).

## Contamination discipline (both directions)

- **Eval → gate:** every run checks the frozen set against
  `bench/external/eval_blocklist.json` (instance id / repo / base-commit
  matching). Overlap is a hard error: a gate task drawn from a reported
  eval would reward memorisation.
- **Gate → training:** the frozen set is *decision*-training data, never
  model-training data. `gate freeze` regenerates
  `blocklist-additions.json` with the frozen ids in `extra_blocked`
  shape; training/curriculum ingestion must block them exactly like eval
  instances. Curriculum generators must never see frozen tasks (the gate
  stays honest only while practice never touches it).

## Wiring for promotion (Phase B1)

```ts
import { runGateForChange } from './evals/regression-gate.js';
// After a candidate change (e.g. a probationary skill promotion):
const report = await runGateForChange(baseCommit, { repoRoot, modelCaller });
// report.verdict: 'PASS' | 'PASS-WITH-OBJECTIONS' | 'BLOCKED'
// Promote only on 'PASS'; objections must be answered in writing first.
```

Scheduled runs can invoke the same functions from the daemon; the CLI is
a thin shell over them.
