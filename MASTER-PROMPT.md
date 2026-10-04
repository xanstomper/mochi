# MOCHI MASTER PROMPT — Full-Harness Audit & Next-Gen Upgrade

> Feed this entire document to the agent (Mochi, Claude Code, Codex, Hermes, or any CLI agent)
> as a single task. It is self-contained. The goal: turn Mochi into a harness that is measurably
> better than Hermes, Claude Code, Codex, J-Code, and OpenCode at real coding work — with a
> predictive/speculative coding core and a self-authoring skill system that beats Hermes' skill
> model — without breaking a single existing test.

---

## MISSION

You are upgrading **Mochi** (`~/mochi`, github.com/xanstomper/mochi) — a TypeScript coding agent
with a Bun-compiled binary (`dist/mochi-bin`), a Rust native core (`native/mochi_core`), a terminal
UI, 66+ tools, a speculative cognition engine, and a self-curating skill system.

Your mission has three pillars, in priority order:

1. **PREDICTIVE / SPECULATIVE CODING** — Mochi must plan code changes before making them,
   execute the most promising plan speculatively in isolation, verify against reality, and only
   then commit. It should predict failures before they happen (risk scoring, pre-flight checks),
   learn from every outcome (strategy memory), and get measurably smarter per workspace over time.
   This is the core differentiator. It must be REAL (tested, measurable), not decorative.

2. **SELF-AUTHORING SKILLS, BETTER THAN HERMES** — Mochi already authors its own tools
   (`tool_factory`) and skills (`skill_manage` + curator). Push it further: skills must be
   validated before promotion (does the procedure actually work?), regression-checked when the
   codebase changes, deduplicated, ranked by observed success, and shared across projects via
   `~/.mochi/skills`. Hermes has 143 skills curated by humans+AI; Mochi must grow its own library
   that is *grounded in its own verified experience* — every skill backed by a real execution trace.

3. **HARNESS SUPERIORITY** — systematically audit what Claude Code, Codex, J-Code, OpenCode,
   and Hermes each do better, and close every gap that matters: context management, subagents,
   planning modes, hooks, MCP, verification loops, UX. Ship in vertical increments, each one
   verified. No parity-theater: only implement what survives the "does this beat the competitor's
   behavior?" test.

---

## NON-NEGOTIABLE RULES (read before writing any code)

1. **Never fabricate success.** Every claim ("works", "faster", "smarter") needs a real execution
   behind it: a test, a benchmark diff, or a live trace. If you could not run it, say so.
2. **Ground truth first.** When diagnosing, pull `~/.mochi/traces/*.jsonl` (every event is
   recorded verbatim — you can PROVE whether a glitch came from the model, the pipeline, or the
   renderer) and `~/.mochi/logs/crash.log` before theorizing.
3. **Ship pipeline, always in this order** (the #1 historical failure is a stale binary):
   ```bash
   cd ~/mochi
   npm run typecheck      # tsc --noEmit, must be clean
   npx vitest run --no-file-parallelism   # 1071+ tests, must pass
   npm run build          # dist/cli.js
   npm run build:bin      # dist/mochi-bin — WHAT THE USER RUNS. Stale bin = "it still looks the same"
   git add -A && git commit && git push origin main
   git ls-remote origin main   # remote SHA must equal local HEAD
   ```
4. **Small targeted patches.** Project conventions in `~/mochi/MOCHI.md`. No mega-refactors.
   Events for state changes. Node stdlib over deps.
5. **Concurrent editor awareness.** Another agent ("Antigravity") edits this repo. `git status`
   + `git diff` before starting; re-read files before every write; expect typecheck breakage in
   files you never touched (fix forward, don't just report).
6. **Test gotchas you MUST know:**
   - `classifyTaskKind` routes short titles without action verbs (fix/build/write…) to `'chat'`,
     and chat tasks legally complete on their first prose answer — silently bypassing every
     guard under test. Test titles must contain action verbs.
   - Run vitest with `--no-file-parallelism`: the shared global `~/.mochi/skills` walk makes
     parallel runs flaky (`context.test.ts` "does not freeze the leading prompt").
   - A test that passes with `-t` in isolation but fails in the full run is usually a concurrent
     editor, not a regression — re-run isolated before investigating.
   - Vision models in this environment cannot read images; OCR screenshots with tesseract.
7. **Honest ceilings.** If a subsystem can't do X yet, say "can't do X yet, here's the plan" —
   never "done". A narrow patch is described as a narrow patch.
8. **Budget your iterations.** Diagnose with cheap reads first, batch independent edits, and
   leave precise open-item notes in this file's "State ledger" (bottom) so the next session
   resumes without re-diagnosing.

---

## PHASE 0 — GROUND TRUTH (never skip; produces the baseline all later phases are judged against)

0.1 **Repo state**: `git status`, `git log origin/main..HEAD`, `git fetch && git rev-list
--left-right --count HEAD...origin/main`. Anything uncommitted from previous sessions: verify
typecheck + targeted tests still pass, then commit/push it BEFORE starting new work.

0.2 **Test baseline**: `npx vitest run --no-file-parallelism` — record exact pass/fail counts
and duration. This number must never regress.

0.3 **Performance baseline**: `npm run bench`, `npm run bench:startup`, `npm run bench:memory`.
Record: binary startup ms, per-task token overhead, RSS. These are the numbers Phase 6 optimizes.

0.4 **Behavioral baseline from real traces**: analyze the last ~20 traces in `~/.mochi/traces/`:
- task success rate (kind `summary:rendered` → `success` field) by task kind
- median tokens/task, median duration, tool calls per task
- failure taxonomy: `stopReason` histogram (model_error / tool_loop / max_iterations / aborted)
- repetition incidents: any trace where the same phrase repeats >5× (use the phrase-split method:
  split `agent:reasoning` + assistant content on `[\n.,]`, count phrases ≥12 chars, flag any
  phrase ≥5 occurrences) — count how many the guards should have caught vs did
- writes a machine-readable baseline to `.mochi-audit/baseline.json` + a human summary to
  `.mochi-audit/BASELINE.md`. Every later phase must show deltas against this file.

0.5 **Known open items** (diagnosed by prior sessions — verify each still open, then fix):
- Reasoning-only responses with no content still fall into the empty-response backoff path
  (watch for chained empty-reasoning retries on weak providers).
- `context.test.ts` parallel-isolation flake: make the context packet hermetic to the global
  skills dir instead of relaxing thresholds.
- Dropdown mouse support: wheel/click hit transcript scroll while the `/` palette is open.
- Tab-cycle in the `/` dropdown capped at the 6-item slice.
- `/reasoning` menu omits `off`/`auto` tiers.
- Antigravity orphans: `src/summary/cline-summary.ts` (+test, unwired box-grid renderer,
  contradicts the no-boxes UI rule — delete) and stray `skills/*.md` at repo root (review/delete).
- TUI visual smoke test (PTY + screenshot + OCR) has never run; a render-harness asserting
  `visibleLen(row) === menuW` per border row would catch the border-off-by-one class forever.

**Phase 0 exit criteria**: baseline.json + BASELINE.md exist; tree is clean and pushed; all
known open items either fixed (with tests) or explicitly re-confirmed open with a reason.

---

## PHASE 1 — RELIABILITY: DEGENERATE-MODEL DEFENSE (Mochi must never hang, spam, or lie)

The live Oct-2 trace proved a free-tier model can cycle 8 reasoning sentences ~50× each
(2,030 TUI events in 36s). The shipped defense (commit d26abea): cross-phrase cycle detector
(`cycleStreak`, `CYCLE_PERIOD_MAX=12`, `CYCLE_REPS_REQUIRED=4`, `PHRASE_ABS_CAP=40`), reasoning
emit suppression, same-answer guard reset on tool rounds. Harden further:

1.1 **Chaos-model test suite**: a fake provider (extend `src/testutil/fake-openai.ts` — it now
supports `reasoningContent`, `stall`, `error`, `dropConn`) that replays REAL degenerate shapes
harvested from traces: (a) 8-phrase reasoning cycle, (b) no-newline "open it, open it" periodicity,
(c) 400 tiny chunks of entropy, (d) alternating 2-phrase loop, (e) huge single chunk >16k,
(f) reasoning-only responses forever, (g) tool-call argument JSON split across 50 chunks,
(h) valid chunks then silent hold mid-tool-call-arguments. Every shape: the loop must terminate
bounded (finish with honest stopReason), never flood the TUI (assert `agent:reasoning` +
`message:chunk` event counts ≤ thresholds), and never lose a previously-succeeded tool result.

1.2 **Auto-recovery scoring**: when a task fails with model_error, Mochi should automatically
attempt ONE failover model (already exists via `pickAlternateModel`) — extend to record in the
trace which model rescued it, and feed that into strategy memory (`memory/speculation.json`)
so future task routing prefers the model that historically succeeds per task kind.

1.3 **TUI backpressure**: prove (test) that a model emitting 100 reasoning events/sec cannot
grow the transcript unboundedly (STREAM_LINE_CAP rolling works), cannot make any single render
frame exceed ~16ms on a 200×50 terminal (benchmark the render function directly), and that the
spinner freeze-guard fires when busy renders stall >800ms.

1.4 **Crash hygiene**: `~/.mochi/logs/crash.log` shows the historical classes (setRawMode errno 5
at exit, write EPIPE at console.log). Verify the EPIPE-safe stdout handlers and `safeWrite`
backoff cover every write path in `src/tui/app.ts` and `src/cli.ts` (grep for raw
`process.stdout.write` / `console.log` inside the TUI path). Zero uncaughtException paths left.

**Phase 1 exit criteria**: chaos suite green; replaying the Oct-2 trace through the loop
terminates bounded with ≤6 model requests; zero crash-class writes; full suite still green.

---

## PHASE 2 — PREDICTIVE / SPECULATIVE CODING (the core differentiator)

Existing foundation (READ ALL before changing): `src/speculative.ts` (SpeculativeEngine: 3
diverse candidates → adversarial verifier scores 1-10 → 5-section plan), `src/core/branch-racer.ts`
(parallel trial branches on git worktrees with containment checks), `memory/speculation.json`
(per-workspace strategy memory: strategyClass → resolved/unresolved, retrieved by ≥2 keyword
overlap), `src/prompt/prompt-compiler.ts` (46-section blueprint at the active reasoning tier),
`src/agent/loop.ts` selfCritique (5-step CLAIM/EVIDENCE/CONTRADICTION/REVISED THEORY/REPAIR PLAN
on first verify failure).

Upgrade it from "interesting" to "beats every competitor":

2.1 **Speculation must be measurable.** Add tracing to every speculative step (candidate
generated → scored → selected → trial ran → promoted/rejected + tokens + wall time) into the
trace, then a bench (`bench/speculation.mjs`) that runs N representative tasks (from traces)
with speculation ON vs OFF and reports: success rate delta, tokens delta, wall-time delta,
trial-kill rate (how often the racer rejected a bad branch before it hit the main tree).
Target: speculation ON must show ≥10% fewer failed attempts on multi-file tasks at ≤1.3× token
cost, or be honestly reported as not-yet-worth-it with the reason.

2.2 **Risk prediction (pre-flight)**: before executing, score the change: blast radius (callers,
import graph — `blast_radius` tool exists), files-touched estimate, test coverage of the target
area, historical failure rate of this task class in speculation memory. Emit a risk band
(green/yellow/red) into the plan; yellow requires a verify command in the plan; red requires
branch-racer isolation (never direct edits). Test: a red-band task must never touch the primary
workspace directly.

2.3 **Outcome prediction learning**: after each task, record (task features → predicted risk →
actual outcome) into speculation memory. Then show the memory works: run the same task class
twice in a fresh workspace — the second run's plan must cite the first run's failure mode
(test: the injected strategy or risk band actually changes).

2.4 **Patch preview & diff-first mode**: implement `--diff-only` (flag exists in the CLI parse —
check it) so speculative trials can end in a clean proposed diff the user approves before
promotion. The TUI gets a `/diff` command showing the pending proposal semantically colored
(±n green/red per the existing semantic.ts rules). This is the "predictive" UX: Mochi shows you
what it INTENDS to do before doing it.

2.5 **Verifier integrity** (known past bugs — keep pinned by tests): scores are judgments, never
default a winner to 10; results indexed by original candidate position (reversed-completion
order test); missing verification fails closed; worktree fixtures committed before racing;
containment verified against symlink escapes during trial writes AND promotion.

**Phase 2 exit criteria**: bench/speculation.mjs produces a real comparison report committed to
`.mochi-audit/`; risk bands gate execution (tested); diff-first mode works end-to-end in the TUI
(PTY-verified); all verifier-integrity tests green.

---

## PHASE 3 — SELF-AUTHORING SKILLS (better than Hermes)

Existing: `skill_manage` tool, `~/.mochi/skills` global dir, curator runs at task finish
(`skill-curator.ts`: archives stale, detects opportunities via `opportunitiesToPrompt`),
`skills/skill-authoring/SKILL.md` quality bar, tool_factory for executable tools
(`.mochi/tools/<slug>/tool.json`), Hermes 143-skill importer (`mochi import-skills hermes:`).

Make Mochi's system *objectively* better:

3.1 **Evidence-backed skill authoring**: a skill may only be promoted from "draft" to "trusted"
if it carries references to ≥1 real execution (trace id or command output) proving the procedure
works. Add the validation to skill-curator: trusted skills without evidence get demoted to draft
after N days. (Hermes' skills are prose; Mochi's must be grounded.)

3.2 **Skill regression checking**: when `mochi doctor` runs (or a `skills doctor` subcommand),
re-execute the verifiable subset of skills (those with command snippets marked runnable) in a
sandbox and report which broke. A skill that fails 2 consecutive checks is auto-archived with a
note. This is what no competitor does.

3.3 **Skill dedup + ranking**: curator indexes skills by embeddings-free keyword overlap;
on authoring, if a new skill overlaps >70% with an existing trusted skill, it must EDIT the
existing one instead of creating a near-duplicate. Track per-skill success counters
(used → task succeeded) in the frontmatter; `/skills` sorts by observed success rate.

3.4 **Cross-project transfer with receipts**: skills load from `~/.mochi/skills` globally, but
the known pitfall (fixed ce44df3) was dir-doubling and the harness lesson: a process-wide cache
does not prove a NEW agent received the body. Keep pinned: delivery receipts by consumer
identity + full-reload path after context compaction. Add a `/skills audit` command showing:
which skills exist, which are trusted/draft, last verified date, success counters.

3.5 **Beat Hermes concretely**: Hermes' skill model is static files + manual curation. Mochi's
pitch: skills that (a) prove themselves before being trusted, (b) catch their own rot via
regression checks, (c) rank by measured success. Write this comparison into
`.mochi-audit/SKILLS-VS-HERMES.md` with the concrete mechanism table — then make sure every
claimed mechanism actually exists in code (no vaporware rows).

**Phase 3 exit criteria**: draft→trusted gating + evidence requirement + regression doctor +
success counters all implemented with tests; `/skills audit` renders in the TUI.

---

## PHASE 4 — HARNESS SUPERIORITY AUDIT (vs Claude Code, Codex, J-Code, OpenCode, Hermes)

4.1 **Feature matrix**: build `.mochi-audit/COMPETITOR-MATRIX.md`. For each capability row,
three columns: {Claude Code, Codex, OpenCode, Hermes} behavior (from their public docs/help —
fetch them, don't guess), Mochi current behavior, verdict (ahead / parity / gap / won't-do).
Capability rows MUST include: context compaction strategy, subagents/orchestration, planning
mode, hooks, MCP client, skills/memory, verification loops, diff review UX, session resume,
permission models, model failover, degenerate-output defense (Mochi is already ahead here —
cite the cycle detector), token/cost accounting, headless/non-interactive mode, IDE integration.

4.2 **Close the gaps that matter, in vertical increments** (each: test → fix → verify → commit):
- **Hooks**: Mochi has HookManager (`src/hooks.ts`) — audit coverage vs Claude Code's
  PreToolUse/PostToolUse/Stop hooks; add the missing lifecycle events if trivially wireable.
- **MCP**: Mochi has MCP close paths in loop.ts; verify a real MCP server round-trip end-to-end
  (tool listed → called → result in transcript). If broken, fix; this is table stakes.
- **Headless mode**: `mochi -p "task"` non-interactive must be first-class: proper exit codes,
  JSON output option (`--json` flag exists in parse — wire it through to the result object),
  stdin piping. Test: real subprocess run of the built binary against the fake provider.
- **Session resume**: `mochi --resume` must restore context + pending tasks verbatim (checkpoint
  files exist in `~/.mochi/checkpoints/`); verify a kill -9 mid-task loses nothing committed.

4.3 **Where Mochi is already ahead — document, don't regress**: degenerate-stream defense,
speculative branch racer with worktree containment, tool_factory (agent-authored executable
tools — no competitor has this), per-workspace speculation memory, real-trace behavioral
baseline. Keep each with a pinning test.

**Phase 4 exit criteria**: matrix committed; at minimum hooks-audit, MCP round-trip test,
headless `--json` + exit codes, and resume-after-kill verified with real process runs.

---

## PHASE 5 — CONTEXT ENGINE & MEMORY

5.1 Compaction: `compactSession`/`compactToPrompt` exist with checkpoint fallback. Measure:
run a synthetic 50-iteration task against the fake provider, assert post-compaction the model
packet still contains the goal, modified-file list, and key decisions (checkpoint fidelity test).
The Pi-style structured checkpoint must never lose the acceptance criteria.

5.2 Token honesty: usage:updated emits real provider numbers net of cache. Add a per-task
`/cost` TUI readout (already have estimateCostUsd + UsageStore) showing prompt/completion/cache/
USD live in the status bar. Trivial, but it's what Claude Code users complain about lacking.

5.3 Memory hierarchy: workspace memory.jsonl + global ~/.mochi + speculation.json. Ensure a
`/memory` TUI command can list/search/purge all three layers. Test the purge (privacy matters).

**Phase 5 exit criteria**: compaction fidelity test green; /cost and /memory live in the TUI.

---

## PHASE 6 — PERFORMANCE

6.1 Startup: bench/startup.mjs baseline from Phase 0. The bun binary cold-start is the user's
first impression. If >250ms, profile (bun --measure or --cpu-prof) and cut. Lazy-load the
heaviest imports in cli.ts (find them with a startup trace; likely MCP, importer, doctor).

6.2 Render: Phase 1.3's frame-time benchmark. The transcript dirty-scan + wrap cache must keep
200×50 frames under 16ms at 1000 lines. If not, memoize wrapped lines by (text, width, chatVer).

6.3 Native core: `native/mochi_core` (Rust) is used for fuzzy/search/classify. Audit which hot
paths still run in pure TS and would benefit (taskkind classify runs per task; the phrase-cycle
detector runs per chunk — but it's O(tail) and fine). Only port if the bench proves need.
NO speculative ports: measure first, port second.

**Phase 6 exit criteria**: startup and frame-time numbers recorded with deltas vs Phase 0;
any regression explained.

---

## PHASE 7 — TUI / UX (user-mandated style rules — read `references/ui-style-guide.md` first)

Hard rules: NO ASCII border boxes in transcript/summary cards (bordered MENUS are the current
design — do not re-introduce floating panels); bullets = orange auto-numbers; everything
semantically color-coded (semantic.ts is the ONLY meaning→color map); cards reflow at any width
(content-width formula `min(w - indent*2, max(24, w-4))`); exactly one blank line between
blocks; newest summary re-wraps on resize. Current themes.ts has 21 palettes — new tokens must
be generated across ALL themes (interface changes fail typecheck per-theme if hand-missed).

7.1 Ship the small UX items from Phase 0.5 (dropdown mouse, tab-cycle, /reasoning tiers).
7.2 Add the render-harness width test (`visibleLen(row) <= w` for every frame row at widths
26–110) as a permanent unit test, killing the windowed-overflow class forever.
7.3 PTY visual smoke test: drive the built binary under a PTY (script + sleep + capture),
screenshot via `asciinema`/`tmux capture`, OCR with tesseract, assert the splash, composer,
and one dropdown render correctly. This has NEVER been done — it's how two border bugs shipped.

**Phase 7 exit criteria**: small items fixed + width-harness test permanent + first real PTY
screenshot OCR-verified in the repo (`.mochi-audit/tui-smoke/`).

---

## PHASE 8 — SHIP GATES (every phase, every increment)

- `npm run typecheck` clean
- `npx vitest run --no-file-parallelism` — full suite ≥ Phase 0 count, 0 failures
- `npm run build && npm run build:bin` — binary timestamp is now; `./dist/mochi-bin --version` smoke
- commit + push + `git ls-remote origin main` SHA equality
- `.mochi-audit/` reports updated with deltas
- Update this file's STATE LEDGER (below) with what landed, what's open, what was honestly
  abandoned and why

---

## DELIVERABLES SUMMARY

1. `.mochi-audit/BASELINE.md` + `baseline.json` — behavioral + perf ground truth
2. Chaos-model test suite (Phase 1) — degenerate-model defense proven
3. `bench/speculation.mjs` + report — speculation value measured, not claimed (Phase 2)
4. Risk-band pre-flight + diff-first mode in TUI (Phase 2)
5. Evidence-gated, self-regressing-checked skill system + `/skills audit` (Phase 3)
6. `COMPETITOR-MATRIX.md` with gaps closed in vertical increments (Phase 4)
7. Compaction fidelity test, `/cost`, `/memory` (Phase 5)
8. Perf deltas vs baseline, no regressions (Phase 6)
9. Width-harness permanent test + first PTY visual smoke (Phase 7)
10. Everything pushed; remote SHA == local HEAD; binary rebuilt

## OUT OF SCOPE (do not do)

- No UI redesign of menus (the bordered design was explicitly chosen after a revert — commit 1d843a6).
- No new dependencies without a failed stdlib attempt documented.
- No prompt-text-only "fixes" for runtime defects.
- No deleting Antigravity's files without checking they're truly unwired.
- No rewriting the model layer — it has hard-won abort/failover semantics; extend, don't replace.

---

## STATE LEDGER (update at the end of EVERY session working this prompt)

| Date | Phase | Landed (commit) | Verified by | Open / abandoned + why |
|------|-------|-----------------|-------------|------------------------|
| 2026-10-04 | pre | d26abea: cycle detector, reasoning suppression, same-answer reset, EPIPE-safe stdout | 1071 tests, remote SHA verified | Phase 0–8 all open |
| 2026-10-04 | 1.3/7.2 + 3.3 + 5.x partial + UX | 79a1659: width-harness permanent test (caught real renderMetricStrip 28>26 overflow, fixed w/ cell clamp), /goal structured DAG+stats view (runGoal), real skill dedup (skillSimilarity Jaccard ≥0.7, consolidate flag was vaporware), /skills audit, long-run defaults (maxIter 40 / runtime 240min), mock sweep clean | 1082 tests (11 new), typecheck clean, build+bin, remote SHA 79a1659 == HEAD | Phase 0 baseline reports, 1.1 chaos suite, 1.2 failover→memory, 2.x speculation bench+risk bands, 3.1/3.2 evidence gates+regression doctor, 4.x matrix/hooks/MCP round-trip/--json, 5.1 compaction fidelity test, 7.3 PTY smoke — all open |
