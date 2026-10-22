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

**v3 growth (2026-10-22):** 6 more tasks from the same pre-runway history
(same discipline: source commit named per entry, parent-tree starting
states, verifiers porting the commits' own tests): two features
(arg-aware read-only classification, plan-mode network reads), one fix
(absolute diff-path re-rooting), two refactors (shared block-scalar
parser, per-message token cache), and one research task (the teams role
registry at `953ae4f`). The set is now **24 tasks — fix 8, feature 6,
refactor 6, research 4** (set hash
`a3dfde4060c4c3b4de560060797b2cabe273aae52dcf77011251e7ff9c3361db`).

**Growth plan:** the ~24-task target is reached. Further growth should
come from real past runs (roughly one per F-class of the §4.2 taxonomy),
each with provenance naming the run/trajectory it came from, then bump
`version`, re-freeze, and re-baseline. Read the power note below before
citing any run.

## Statistical power — what this set can and cannot claim

24 tasks × k=3 clears the ≥20-task bar, so the gate's printed tripwire
warning no longer fires — but read the measured widths before treating
that as "powered". Using the gate's own exported `bootstrapDeltaCI`
(2000 iters, default seed) on **synthetic** paired scenarios at k=3
(constructions calibrated to reproduce the v2 table exactly):

| scenario | n=6 CI width | n=18 CI width | n=24 CI width |
|---|---|---|---|
| one task fully regresses (Δ −16.7pp → −5.6pp → −4.2pp) | 50.0pp | 16.7pp | 12.5pp |
| mixed ±1-trial noise, Δ = 0 | 44.4pp | 25.9pp | 22.2pp |
| uniform genuine gain Δ = +16.7pp | 22.2pp | 14.8pp | 13.9pp |

So at 24 tasks the noise-regime CI is ≈ ±11pp: narrower, honest
progress, still far from promotion-grade for small gains. Accordingly:

- the gate *reliably catches* catastrophic regressions: category wipeouts,
  mass breakage, F7/F12 spikes, test-deletion-style diff risks;
- the §5.3 improvement path remains hard to reach for genuine small
  gains, so BLOCKED at this set size means "no evidence of improvement",
  not "evidence of harm";
- no promotion-grade claim ("change X improved Mochi") may cite a gate
  run on this seed set alone. Claims need k=3, the frozen scaffold (one
  harness config for all compared runs), and effects large against the
  widths above — or a larger set / larger k.

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
