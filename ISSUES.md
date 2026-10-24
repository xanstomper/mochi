# Mochi Codebase Audit — Wave L (ISSUES.md)

**Base:** local HEAD `712e537` (Wave G tree). **Scope:** all of `src/` (680 `.ts` files),
plus README/docs claims checked against source. **Method:** static import graph
(static + dynamic-literal imports, resolved `.js`→`.ts`), BFS reachability from the
four production roots (`src/cli.ts`, `src/index.ts`, `src/daemon/daemon-server.ts`,
`src/mcp/deepwiki-server.ts`), repo-wide grep verification of every candidate
(string/dynamic references checked before anything was called dead), runtime counts
via the built code (ALL_TOOLS / PROVIDERS measured by importing the modules), and a
full-suite before/after comparison for every fix.

Severity: **P0** = broken or misleading in production today. **P1** = dead weight,
risk, or a claim the code doesn't back. **P2** = polish / drift / surface noise.

---

## P0 — broken or misleading in production

### L-01. `mochi sleeptime` runs a STUB repair step and a NO-OP curriculum step — the real D8/D10 implementations were never wired in
- `src/sleeptime/cli.ts:71` — the only production call site — calls `runSleeptime({ projectDir, spendCapUsd, dryRun, nightKey })` with **no `ports`**.
- `src/sleeptime/orchestrator.ts:545-551` `defaultSleeptimeSteps` therefore builds
  `createRepairStep(undefined)` → default `createCuratorStubRepairPort()` (orchestrator.ts:431,336)
  and `createCurriculumStep(undefined)` → default `createUnavailableCurriculumPort()` (orchestrator.ts:505,407).
- The stub's `repairOne` applies **no skill-body patch** — it only re-stamps the demoted
  skill into probation (`stampSkillBirth`). Its own detail string admits it:
  "STUB repair (D8 patcher not yet integrated)" (orchestrator.ts:~360).
- The unavailable curriculum port's `planTasks()` returns `[]` forever and `generateOne`
  throws `'curriculum port unavailable (D10 not integrated)'` (orchestrator.ts:407-417).
- The real implementations exist, are tested, and are shipped — but nothing adapts them
  to the port interfaces: `src/skills/skill-repair.ts:401 repairDemotedSkills` /
  `:274 attemptSkillRepair` (Phase D "D8") and `src/curriculum/curriculum.ts` (Phase D
  "D10", 806 lines). Verified: `grep -rn "SkillRepairPort|CurriculumPort" src` outside
  `sleeptime/orchestrator.ts` finds only the type re-exports in `src/index.ts:14,17` —
  **no adapter exists anywhere**.
- Collateral damage: `DEFAULT_REPAIR_ESTIMATE` (orchestrator.ts:~424, sonnet 8k-in/2k-out
  ≈ $0.054) is *committed against the hard spend cap* for every stub repair unit even
  though the stub makes no model calls — the cap accounting reserves real budget for
  imaginary spend (labelled ESTIMATED in the report, but it can crowd out real steps).
- The orchestrator header (orchestrator.ts:9-22) is stale: "until it lands, the default
  port is a clearly-labelled STUB", "Default port plans nothing… inject a CurriculumPort
  when D10 lands" — both D8 and D10 landed in Phase D.
- User-facing claims: `README.md:290` and CLI help (`src/cli.ts:114`) describe
  `mochi sleeptime` as the "Nightly consolidation pipeline (skill repair, curator,
  gate, curriculum)". The gate step's default port (`createFrozenIntegrityGatePort`)
  is real (hash integrity); the curator step is real. Repair and curriculum are not.
- **Fix shape (integrator):** write `SkillRepairPort`/`CurriculumPort` adapters over
  `skill-repair.ts`/`curriculum.ts`, pass them in `sleeptime/cli.ts`, delete the stale
  header text. Behavior-changing wiring — deliberately NOT done by this audit wave.

### L-02. README's language-registry claims contradict the code (the "15 languages" claim, and the tree-sitter default)
- `README.md:691`: "The registry covers **15 languages** (TypeScript, JavaScript,
  Python, Go, Rust, C, C++, Java, C#, Ruby, PHP, Kotlin, Swift, Zig, Lua…)".
  `README.md:42` repeats "a 15-language registry".
- The registry that section describes (the codegraph/CPG backend) is
  `src/repo/codegraph.ts:38` `LANGUAGES` = **10 ids** (typescript, javascript, python,
  rust, go, java, cpp, ruby, php, csharp), and `GRAMMAR_SPECS` (codegraph.ts:164-175)
  has exactly the same 10 — there is **no grammar** for C, Kotlin, Swift, Zig, or Lua.
  Worse, `.c` files are not even extension-mapped: `EXT_LANG` (codegraph.ts:40-51)
  maps `.h`→cpp but has no `.c` entry at all.
- Same section, `README.md:~685-689`: "Opt in with `npm i web-tree-sitter
  tree-sitter-typescript` and set `MOCHI_CPG_BACKEND=tree-sitter`" — but the code
  makes tree-sitter the **default** backend and `tsc` the opt-out:
  `codegraph.ts:243` (`MOCHI_CPG_BACKEND === 'tsc'` → skip), `:349`, and the header
  comment at `:35`. The README has the default backwards.
- Full registry picture in L-11. This is the entry Ben's Phase F note flagged as
  "registries disagree: 18 vs 10" — resolved there.

---

## P1 — dead weight / risk

### L-03. Antigravity carries a shadow price table — and fabricates a cost for ANY unknown model
- `src/model/antigravity.ts:142` `ANTIGRAVITY_PRICING_TABLE` (17 entries) is a second,
  independent price table next to `src/pricing.ts` (the C5 table of record, 28 entries).
  It duplicates the Claude entries and tables Gemini 3.x models that `pricing.ts`
  deliberately excludes (host-dependent ids were kept out on purpose — Wave G).
- `computeAntigravityCost` (antigravity.ts:168-190) **never returns "unknown"**: after
  substring fallbacks (`includes('opus')`, `includes('flash')`, …) the final `else`
  prices *any* unrecognized model at **gemini-3.8-flash rates** (line 178). This is a
  direct violation of the pricing doctrine stated in `pricing.ts:15-20` ("Unknown
  models resolve to null (no estimate) rather than a guessed family rate").
- The fabricated figure is emitted as the response's provider `costUsd`
  (antigravity.ts:212 and :594). BudgetEngine treats a nonzero provider-reported cost
  as *measured* (not estimated), so guessed dollars flow into budget enforcement,
  traces, and cost-per-solve labelled as fact.
- The table also carries junk $0 entries: `'gemini-4-argon-disabled'`,
  `'tab_flash_lite_preview'`, `'tab_jump_flash_lite_preview'` (antigravity.ts:~162-166)
  — internal/preview ids priced at exactly $0.
- **Fix shape (integrator):** route antigravity costing through
  `pricing.ts resolvePrice/estimateCostUsd`; unknown → no costUsd (null), never a
  default model's rates.

### L-04. The token estimator prices image parts as raw JSON text — wrong in both directions, ~700× over for data-URI images
- The one counter everything derives from is `approxTokens(JSON.stringify(message))`:
  `src/context.ts:283` (`cachedMessageTokens`), summed by `estimateTokens()` (:578) and
  mirrored by the Rust batch path — `src/native/agent-protocol.ts:184 nativeTokensCount`
  counts "its serialized JSON — the same JSON.stringify(m) text", by design parity.
- A message carrying an `image_url` **data URI** therefore gets its base64 payload
  counted as text (clamped at ⌈bytes/4⌉ by `heuristicTokenCount`, context.ts:243).
  The read tool admits images up to 4 MB (`src/tools/read.ts`); a 4 MB image becomes
  ~5.6 MB of JSON → **~1.4M estimated tokens for an image whose real vision cost is
  ~1–2K tokens**. Data-URI images are the form the product itself produces:
  `src/goals/goal.ts:764-772` (task images → data URIs) and the form `read.ts:100-101`
  instructs the model to send.
- The same mechanism *under*counts the other form: an `https:` image URL counts as
  ~30 chars of URL string (~10 tokens) against the same ~1–2K real cost.
- Consequence in this tree: any session with attached images gets wildly inflated
  context estimates → compaction and budget backstops fire far too early. (Wave H3's
  tree found the mirror-image symptom — its inlined screenshots bypassed the counter.
  Both symptoms have the same root: **the counter has no image model at all**.)
- **Fix shape (integrator):** price image parts with a per-image constant (or
  dimension-based estimate like the providers use) inside `cachedMessageTokens` and
  the Rust counter, instead of serializing the payload.

### L-05. Whole feature modules are unreachable from production (tests + benches only)
Verified by BFS from the four production roots over the import graph, then re-verified
per module with repo-wide grep (no string/dynamic references):

| Module | Lines | Reachable from | Notes |
|---|---|---|---|
| `src/core/branch-racer.ts` | 261 | `bench/speculation.mjs`, own tests | Speculative branch racing never enters the loop. `.mochi-audit/COMPETITOR-MATRIX.md` cites its bench proof as a *closed product gap* — the proof is real, the product wiring is not. |
| `src/core/capability.ts` + `capability-registry.ts` + `tool-dispatcher.ts` | 70+257+208 | each other + own tests | A parallel capability/tool-dispatch architecture the loop doesn't use (the loop dispatches tools itself). Only external mention is a comment at `src/tools/fetch-methods.ts:4`. |
| `src/dox.ts` | 128 | own test only | Header promises `dox_query` / `dox_generate_adr` tools; neither name is registered in `ALL_TOOLS` (`src/tools/index.ts:83`). Not to be confused with the live `src/cognitive/dox.ts` (AGENTS.md contracts) — see L-12. |
| `src/observability/workflow-induction.ts` | 323 | own tests only | Phase D workflow induction: no loop, CLI, or sleeptime call site. (Its `draftInducedMacro` is also a dead export.) |
| `src/observability/cost-per-solve.ts` | 93 | own tests only | Phase C cost-per-solve from traces; the regression gate implements its own `costPerSolve` internally (`src/evals/regression-gate.ts`) instead. Two implementations, the standalone one unused. |
| `src/clarify.ts` | 89 | own tests only | Transport-agnostic clarification engine (spec §12-B); the live clarification path is `src/tools/ask-question.ts`, a separate implementation. |
| `src/curriculum/curriculum.ts` | 806 | own tests only | The D10 half of L-01. |
| `src/skills/skill-repair.ts` | 420 | own tests only | The D8 half of L-01. |
| `src/codemode/*` (harness, interpreter, fixtures) | 947 | `bench/codemode.ts`, own tests | Deliberate Phase E spike — documented experimental, not wired into the loop. Listed for completeness, lowest concern in this table. |
| `src/model/oauth-device.ts` | 142 | own tests only | Header says "UNWIRED BY DESIGN" (needs a registered OAuth client_id). Honest by design — informational only. |
| `src/native/core.ts` `nativeEstimateCostUsd` | — | native-core tests only | Production costing goes through `pricing.ts` (`src/budget.ts:118`). The Rust-bridge cost function is parity-tested but has no production caller. |

### L-06. Dead config: `telemetry` is parsed, persisted, env-settable — and read by nothing
- `src/types.ts:125` (`MochiConfig.telemetry: boolean`), default `false`
  (`src/config.ts:42`), settable from config files and `MOCHI_TELEMETRY`
  (`src/config.ts:264`). **Zero reads anywhere in `src/`** (grep-verified:
  every other "telemetry" hit is an unrelated comment or a different feature).
  `MOCHI_TELEMETRY=1` is a silent no-op.
- NOT auto-fixed: `telemetry` is the canonical arbitrary key the config-merge tests
  exercise (`src/config.test.ts:367-368,429-446,465,508-511`;
  `src/config-fragments.test.ts:30-38`) and it is part of the persisted config
  schema. Removing it is a schema decision; wiring it to something is a product
  decision. Either way it should stop being a knob that does nothing.

### L-07. Price-table provenance is unauditable per entry (pricing.ts)
- `src/pricing.ts:48` `PRICE_TABLE_AS_OF = '2026-10-22'` — current, and the file-level
  doctrine is honest: list-price snapshot, override path documented (:15-20), and
  every table-derived dollar is tracked downstream as ESTIMATED
  (`BudgetEngine` costSource split). 28 entries.
- But no entry records *its* source. Per project history, the gpt-5 family, grok-4,
  and DeepSeek cache rates are estimates rather than confirmed vendor list prices —
  indistinguishable in the table from sourced entries (e.g. the Anthropic rows,
  whose cache multipliers are internally consistent). If one rate is wrong, nothing
  in the file says which rows to distrust.
- **Fix shape:** per-entry source/date comment convention, or a `source` field;
  cheap, and it's the difference between a price table and a price rumor.

### L-17. Hardcoded OAuth client secret shipped in source (antigravity-oauth.ts)
- `src/model/antigravity-oauth.ts:17` — `export const ANTIGRAVITY_CLIENT_SECRET = '<literal>'`:
  a non-empty string literal baked into the source tree, used as the OAuth
  `client_secret` in token requests at `:210` and `:443`. (The value is
  deliberately not reproduced here; the audit environment's own redaction
  layer treated it as a live secret on sight.)
- This exact tree is *published* (origin `xanstomper/mochi` main), so the
  secret is public: GitHub secret-scanning and every clone carry it. For
  Google's installed-app flow, client secrets are quasi-public by design and
  ship in many OSS clients — the practical risk is low — but two things need
  an explicit decision, not silence: (1) if this is Mochi's own registered
  app, say so in a comment and accept the exposure deliberately; (2) if the
  id/secret pair was lifted from another client (e.g. the official
  Antigravity/Gemini clients), that's a terms problem, not a style problem —
  `src/model/oauth-device.ts:7` already articulates the standard ("shipping
  a login that points at someone else's client_id… would be exactly the fake
  this file exists to prevent"). This file should be held to it.
- **Fix shape (integrator):** source the secret from env/config like every
  other credential in the codebase (see `model/credential-pool.ts`), or
  document the deliberate-exposure decision at the constant. Not auto-fixed:
  rotating/revoking is an account action, and swapping the source changes
  auth behavior for existing users.

---

## P2 — polish / drift / surface noise

### L-08. Duplicated module: two update-check implementations — FIXED in this wave
- `src/update-check.ts` is the live one (check + apply; imported by
  `src/tui/app.ts:186,1965`). `src/ops/update-check.ts` was an older warn-only
  variant with a different cache path (`~/.config/mochi/` vs `~/.mochi/`), imported
  by nothing except its own test. **Deleted `src/ops/update-check.ts` +
  `src/ops/update-check.test.ts`** (the `src/ops/` directory went with them).
  See FIXED section for suite verification.

### L-09. Docs drift in docs/CAPABILITIES.md (README's headline counts verified correct)
Runtime-measured from source (importing the modules): **ALL_TOOLS = 81**,
**PROVIDERS = 41**, **skills = 150** (`find skills -name SKILL.md`), **roles = 17**
(`src/teams/roles.test.ts` enumerates 5 no-edit + 12 edit roles).
- ✅ README.md:296,323,349 (81 tools), :454 (41 providers), :738 (150 skills),
  :296,508 (17 roles) — all correct.
- ❌ `docs/CAPABILITIES.md:7` — "The **16** Specialized Subagent Roles" (actual: 17).
- ❌ `docs/CAPABILITIES.md:34` — "Mochi ships with **30+ built-in tools**" (actual: 81;
  stale by ~50 tools).

### L-10. Divergent duplicate helpers: `contentText` / `splitContent` in antigravity.ts
- Canonical versions live in `src/types.ts:283,297` and are imported by
  anthropic.ts:2, openai.ts:2, gemini.ts:2.
- `src/model/antigravity.ts:108-138` defines **private copies of both** — and they
  have already diverged: its data-URI regex requires `image/*` + `;base64`
  (types.ts accepts any mime, optional `;base64`), and it treats *any* non-data URL
  as an image URL where types.ts only accepts `http(s)` (other URLs are dropped).
  Same message, different image extraction depending on provider.
- Canonical: `types.ts`. Fix = delete the local copies and import (behavior change
  for antigravity's edge cases — integrator's call, hence not auto-fixed).

### L-11. The language registries, resolved (the full 7a picture)
Three different registries with three different jobs — the docs conflate them:
- **Parsing/indexing (source of truth):** `src/repo/codegraph.ts:38` `LANGUAGES` +
  `:164` `GRAMMAR_SPECS` — **10 languages**, tree-sitter WASM grammars.
- **Ecosystem detection:** `src/repo/repo.ts` (~:110-245) — **18 ids** (ts, js,
  csharp, python, go, rust, java, cpp, zig, ruby, php, swift, kotlin, elixir,
  haskell, scala, dart, lua): marker files, test/lint commands, hints. *Detection
  only — no parsing.*
- **Test-file matching:** `src/core/mutation.ts:61-80` — regex conventions
  (`_test.go`, `test_*.py`, `FooTest.java`, …), not a language registry at all.
- **Honest counts:** Mochi *detects* 18 ecosystems and *parses/indexes* 10
  languages. Any single number in docs is wrong unless it says which.

### L-12. Name collision: two unrelated "DOX" modules
- `src/dox.ts` — documentation index + ADR generator (unreachable, L-05).
- `src/cognitive/dox.ts` — AGENTS.md contract hierarchy (`loadDoxContract`), live
  via `src/cognitive/chameleon.ts:15`. Same acronym, adjacent domains, different
  features. Renaming one is cheap insurance against the next wiring mistake.

### L-13. Export-surface noise: 152 exports with zero external references; 3 fully dead
Full-corpus scan (every exported `function`/`class`/`const` checked for word-boundary
references outside its defining file, tests included as references):
- **149** are used *inside* their own file but exported for no consumer — vestigial
  `export` keywords widening the API surface (full list in the audit appendix of
  RESULT.md; examples: `loadPlanCache`/`savePlanCache` in `src/core/plan-cache.ts`,
  most of `src/evals/regression-gate.ts`'s internals, `hookHandlersFor` in
  `src/hooks.ts`, `findDoxChain` in `src/cognitive/dox.ts`).
- **3 are dead outright** (defined, never used even in their own file):
  `resetDisplayBackend` (`src/computer/backend.ts`),
  `formatFlakyReport` (`src/core/flaky.ts`),
  `listDir` (`src/curriculum/curriculum.ts`).
- Not auto-fixed: un-exporting is a 149-file-surface refactor with no behavior
  change; it belongs in one deliberate integrator pass, not an audit sweep.

### L-14. The public SDK exports the sleeptime stubs
- `src/index.ts:11-17` re-exports `createCuratorStubRepairPort` and
  `createUnavailableCurriculumPort` as public API. Whatever L-01's fix is, the
  stub factories shouldn't be part of the SDK contract users can come to depend on.

### L-15. Root doc sprawl: two architecture docs, two master prompts
- `ARCHITECTURE.md` at repo root is **499 KB**; `docs/ARCHITECTURE.md` is 8.6 KB.
  Nothing states which is canonical; they will diverge (they already differ in kind:
  generated dump vs curated doc).
- `MASTER-PROMPT.md` (30 KB) and `MASTER_PROMPT.md` (6 KB, "Operation Frontier v1,
  2026-10-10") coexist; test comments cite "MASTER-PROMPT" phases
  (`src/agent/chaos.test.ts:6`, `src/context-compaction-fidelity.test.ts:1`), so the
  hyphenated one is the referenced spec — the underscore one appears to be a stale
  sibling. Docs-only; flagged, not touched.

### L-16. Unverifiable README number: shell risk-pattern counts
- `README.md:349`: "every shell command risk-classified (17 destructive + 16 network
  patterns)". `src/security/security.ts` `DESTRUCTIVE` array (~:105) has 24 top-level
  regex elements and `NETWORK` (~:130) has 13. Counting alternation branches instead
  gives yet other numbers — the claim reconciles under no obvious counting rule.
  Low stakes, but it's a number in the README that source can't reproduce.

---

## Positive findings (verified, worth saying out loud)

- **TODO/FIXME/HACK census: zero genuine items.** 25 hits in non-test `src/`, 19 in
  tests — every one is *about* TODO markers (diff-hygiene detectors in
  `src/core/diff-hygiene.ts`, prompt text, codemode fixtures), none is an outstanding
  TODO in production code.
- **Env-var layer is clean.** 91 `MOCHI_*` vars are read in `src/`; every documented
  flag spot-checked (DISCIPLINE family, UNCENSORED, SAFETY, SANDBOX, LIGHT/NO_EMBED/
  NO_INDEX, CPG_BACKEND, RATE_LIMIT_*, NO_UPDATE_CHECK, YOLO, REPRO_FIRST,
  PROMPT_COMPILER, SPECULATIVE_PREFLIGHT, EXEC_TRACE, NARRATIVE_SUMMARY) is genuinely
  consumed. The only documented-but-not-in-src vars (`MOCHI_VERSION`, `MOCHI_SRC`)
  are `install.sh` vars, documented correctly as such (`docs/INSTALL.md:44,57,83`).
- **Test health:** zero test files with no `expect(`; every skip is a conditional
  environment gate with a stated reason (live tests behind `MOCHI_LIVE`+key,
  `src/agent/loop.live.test.ts:34-36`, `src/daemon.live.test.ts`; toolchain-gated
  describes in `loop.test.ts:1258-1409`; Xvfb gate in `computer/x11-display.test.ts:74`;
  `skipIf(win32)` in `core/atomic-fs.test.ts:25`).
- **Test doubles are honest:** `FakeDisplayBackend` is reachable only via explicit
  `MOCHI_COMPUTER_BACKEND=fake` and the backend selector throws loudly otherwise
  (`src/computer/backend.ts:26-39`); `src/testutil/fake-openai.ts` is imported by
  tests only; the codemode stub model is documented as a bench fixture
  (`src/codemode/harness.ts:23`).
- **Config fields other than `telemetry` are all consumed** (spot-verified:
  speculative.selfCritique, maxVerifyRetries, maxToolCalls, maxModelCalls,
  gitDestructive, planModeNetworkReads, toolExposure/toolSchemaBudgetChars,
  selfRepair, memory.injectionChars — each has a live read site).

---

## FIXED in this wave (zero-risk class only)

1. **`src/cognitive/index.ts` — deleted.** A 16-line barrel re-exporting
   owl/dox/sispis/anchor/chameleon. Import-graph: zero importers; repo-wide grep
   across `.ts/.mjs/.js/.json/.md/.sh/.toml` found zero references (all consumers
   import the cognitive modules directly, e.g. `src/agent/loop.ts:146`,
   `src/context.ts:14,23`). No test referenced it.
2. **`src/games/snake.ts` + `src/games/snake.test.ts` — deleted.** A 183-line pure
   Snake game engine (+136-line test) referenced by nothing outside its own test:
   no production importer, no CLI/TUI command, no mention in skills/docs/scripts/
   bench (grep-verified). Git history shows it landed as test-fixture work
   (`3168818 "test: commit snake engine module…"`) and was never wired to a surface.
3. **`src/ops/update-check.ts` + `src/ops/update-check.test.ts` — deleted** (L-08;
   the `src/ops/` directory contained nothing else). Superseded duplicate of the
   live `src/update-check.ts`; zero references outside itself repo-wide.

**Verification (read carefully — the environment fought back):**
- `tsc --noEmit` (whole program): **clean before and after** the deletions. For
  provably-unreferenced files this is the decisive check: TypeScript resolves
  every import in the program, so any missed reference to a deleted file would
  be a compile error. Combined with the import-graph BFS and the repo-wide
  string grep (skills/docs/scripts/bench included), the deletions have three
  independent static proofs.
- Deletion-adjacent tests that completed inside the post-fix full run:
  `src/esm-hygiene.test.ts` **passed (2/2)**, `src/cognitive/cognitive.test.ts`
  **passed (9/9)** — the two files that would catch a stray barrel/module
  reference. `src/cognitive/integration.test.ts` went 6/7 and
  `src/update-check.test.ts` 3/4 *inside a hazard-saturated run* (see below);
  the update-check failure is `detectInstallStyle`, a probe of the host
  install layout, in a test that never imported the deleted module.
- Full suites were run before and after — and both were **environment
  casualties**, not code signals. This machine is suffering the documented
  intermittent-EPERM filesystem hazard (AGENTS.md, 2026-10-22: mount-propagation
  leaking from the Wave I sandbox builder's experiments) plus load averages of
  15–22 from a dozen sibling builders, plus a runtime restart that wiped the
  first post-fix attempt. Baseline run: 369 files / 2,840 tests, 212 failed
  with **161 `EPERM` errors** in the log. Post-fix run: **367 files — exactly
  369 minus the 2 deleted test files** — with **561 `EPERM` strings** in the
  log and failures concentrated in FS/git/subprocess-heavy files. Neither run
  can validate or condemn the tree; the reference green state for this HEAD is
  the integrator's verified clean run (369 files / 2,840 tests / 0 failed,
  recorded at Wave G integration) and Wave H3's independent 0-failed run.
  Post-fix log: `~/workspace/mochi-w11/audit-work/postfix-suite.log`.
  New vitest processes in this tree currently die at startup with the same
  EPERM (vite config write); isolated re-runs of integration/update-check/
  config should be done by the integrator once the hazard clears — expected
  green, and if `config.test.ts` or `integration.test.ts` still fail in a
  clean window, they fail for reasons independent of these deletions (zero
  shared files).

## Honest limits of this audit
- Static reachability can't see reflection, string-built import paths beyond
  literals, plugin/skill-driven loading (skills are Markdown, loaded by name at
  runtime — a TS module referenced *only* from a skill's prose would be invisible;
  the three deleted files were additionally grep-checked against `skills/`).
- "Tests that test mocks" was assessed by sampling + structure (wire-level fakes
  vs unit mocks), not by mutation testing; a full verdict needs coverage/mutation
  tooling this wave didn't run.
- Duplication detection was targeted (known-risk areas: pricing, content
  helpers, update-check, token counting), not an all-pairs clone analysis.
- Bench/scripts were checked for dangling imports (all resolve), not audited
  line-by-line.

---

## P3 disposition (Wave P3, 2026-10-24 — every open L-item worked; zero silently-untouched)

Verified-then-fixed or verified-already-fixed this wave. Evidence and commit SHAs in
`~/campaign/p3-report.md`.

- **L-01 — FIXED (already, in this tree).** The real D8/D10 adapters
  (`createSkillRepairPort` / `createCurriculumPort`) are the orchestrator DEFAULTs,
  `sleeptime/cli.ts` passes them explicitly, the stale STUB header text is gone, the
  repair step reserves model-free estimates, and `sleeptime/cli.test.ts` ("runs the real
  D8 repair and D10 curriculum adapters — never the stub/no-op ports") pins it. The
  stub repair port survives only as a labelled test double.
- **L-02 — FIXED (already).** README states 18 detected ecosystems / 10 parsed
  languages (both runtime-verified) and documents tree-sitter as the default with
  `MOCHI_CPG_BACKEND=tsc` as the opt-out, matching `repo/codegraph.ts`.
- **L-03 — FIXED (already).** `ANTIGRAVITY_PRICING_TABLE` no longer exists;
  `computeAntigravityCost` routes through `pricing.ts` and returns null for unpriced
  models (no fabricated costUsd). Covered by `model/antigravity.test.ts`.
- **L-04 — FIXED (already).** `cachedMessageTokens` prices image parts per-part
  (`IMAGE_PART_TOKENS`), never by serialized payload; `estimateTokensAsync()` gates the
  Rust batch counter on image-free histories. `context.images.test.ts` green.
- **L-05 — DEFERRED (tracking note).** Deleting whole feature modules
  (branch-racer, capability stack, dox→docs-index module, workflow-induction,
  cost-per-solve, clarify.ts, codemode, oauth-device) is product-level removal, not a
  fix wave. Two rows resolved by L-01's wiring: `curriculum/curriculum.ts` and
  `skills/skill-repair.ts` are now reachable from production (sleeptime defaults).
  `native/core.ts nativeEstimateCostUsd` stays: parity-tested (tests count as
  references), production costing goes through pricing.ts.
- **L-06 — FIXED** (`refactor(config): remove the dead telemetry knob`). Schema field,
  default, and MOCHI_TELEMETRY env knob removed; legacy configs still load; removal
  pinned by test.
- **L-07 — FIXED** (`docs(pricing): per-entry provenance tags`). [vendor-list] /
  [estimate] / [unverified] on all 28 entries + override-path legend. No URLs invented.
- **L-08 — FIXED** (in the audit wave itself; `src/ops/` gone, verified still gone).
- **L-09 — FIXED** (`docs: live-measured counts`). Docs counts re-measured at runtime
  (89 tools / 22 roles / 45 providers / 150 skills — the audit's verified numbers had
  drifted as Wave 3 landed surface); CAPABILITIES role table gains the 6 missing roles.
- **L-10 — FIXED** (`refactor(antigravity): use the canonical contentText/splitContent`).
  Divergent private copies deleted; regression test pins the converged mapping.
- **L-11 — RESOLVED (verified).** The three registries match the audit's resolution:
  18 detected (repo.ts LANG_SPECS), 10 parsed (codegraph LANGUAGES/GRAMMAR_SPECS),
  mutation.ts regex conventions; docs now state which is which.
- **L-12 — FIXED** (`refactor(docs): rename src/dox.ts -> src/docs-index.ts`).
- **L-13 — sweep 2 run; one part DEFERRED (tracking note below).** The 3
  dead-outright exports from the audit were already removed (listDir 33380f8;
  resetDisplayBackend/formatFlakyReport 3ab1b49). Sweep 2 re-ran the same method over
  the current tree and deleted 9 new dead-outright exports (zero callers repo-wide,
  dynamic/string references checked). DEFERRED: the vestigial-export un-export pass —
  217 function/class/const exports today have zero external references but are used in
  their own file (was 149 at the audit; Wave 3 grew the surface). No behavior change,
  pure API-surface churn: one deliberate integrator pass, not a riding-along sweep.
- **L-14 — FIXED (already: 01add8b) and now total.** The SDK re-exports were dropped in
  01add8b; sweep 2 deleted the remaining dead stub factory
  (`createUnavailableCurriculumPort`) outright.
- **L-15 — FIXED** (`docs: live-measured counts + canonical pointers`). Root
  ARCHITECTURE.md is stamped (in the docgen generator itself, so it survives
  regeneration) as the auto-generated dump with docs/ARCHITECTURE.md canonical; both
  master prompts cross-reference each other; README's docgen misattribution fixed.
- **L-16 — FIXED** (same docs commit). The irreproducible "17 destructive + 16 network
  patterns" claim replaced with the count that reproduces from source: 22 destructive +
  13 network regex elements (one per top-level entry in security.ts).
- **L-17 — FIXED (code-side).** The client identity is env-overridable
  (ANTIGRAVITY_CLIENT_ID/SECRET; pinned by test) and the constant now records the
  deliberate-exposure decision, the installed-app quasi-public rationale, the omp
  parity provenance, and the oauth-device.ts standard. Rotation/revocation stays an
  account action for the credential owner.

**Deferred-item tracking (the two open tails):**
1. L-05 module removals — product decision, owner's call; not deferred work, a
   decision request. Evidence table preserved in the P3 report.
2. L-13 un-export pass (217 vestigial exports) — one deliberate integrator pass;
   mechanical (tsc-verifiable), zero behavior change; not bundled into a sweep wave
   that also deletes code.
