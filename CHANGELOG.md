# Mochi Changelog

## [Unreleased]
- **Merged PR batch (#46–#62)** — sixteen upstream PRs landed together; every one was reviewed, conflict-resolved, and pinned by tests. Highlights: plan mode can now answer "does the project's own check pass?" by running the configured verify command against a tree snapshot and rolling back any tracked-file writes it causes (#50), and can reach operator-declared read-only hosts (`safety.planModeNetworkReads`, exact hostname match) for POST-based research APIs (#51); safe mode no longer denies every `shell` call before its own risk gate can run (#53) and auto-sandboxes elevated-risk *background* commands under bubblewrap when available, failing closed when it is not (#52); `fetch` is classified by its arguments everywhere — GET/HEAD stay read-only, POST/PUT/PATCH/DELETE stay mutating — and `verify` is never batched as read-only (#49).
- **The read-only shell batch can't be smuggled past** — the parallel gate rejected `;`/`&&`/pipes but not newlines, and allowed `find` (whose `-delete`/`-exec rm` forms mutate) and `env` (arbitrary argv). Control characters, `find`, and `env` are now rejected, so state-changing commands ride the serial path (#54).
- **Redaction holds on every path to the model** — the execution-registry replay path (speculative mid-stream exec and dedupe replays) injected the raw tool output into the context, bypassing the output-policy gate; it now applies the same transform chain as the normal completion path (#55). `redact()` also always runs the TypeScript pattern set instead of short-circuiting on the native Rust mirror, whose pattern list had drifted (Discord webhook URLs survived redaction on native hosts) (#62).
- **The risk classifier catches the silent-discard class** — `git restore`, path-limited `git checkout <sha> -- <path>`, `git stash drop`/`clear`, and `find … -delete`/`-exec rm` destroyed uncommitted work while classifying `low`; they now classify destructive, and the TypeScript verdict is authoritative over the native accelerator (whose hand-maintained list lagged, which had made every new pattern dead on native hosts) (#58).
- **Recency floor is a target, not an override** — the contract is now pinned by tests: the packet always fits the token window, the oldest dense payloads are truncated rather than dropped (dropping them breaks provider tool-pairing and hides veto replies), and the newest turn survives intact (#47).
- **Diffs with in-root absolute paths apply** — a unified diff whose paths are absolute but resolve inside the workspace root is re-rooted and applied; escaping paths and no-root invocations still fail closed (#46).
- **Worktree sessions keep the launch project's config** — `mochi --worktree` chdirs into the worktree, so the launch project's `mochi.json`/`.mcp.json` silently stopped applying; the launch fragments are now carried explicitly with the precedence *flags > launch project > worktree project > user config*, merged per leaf (MCP servers still replace wholesale per declared name) (#48).
- **Exec and agent-loop hot paths** — long command output is truncated to head **and** a rolling tail instead of head-only, so the build/test failure summary at the end of a large output is visible without re-running the command (#61); the tool-result redundancy hash uses two 32-bit lanes instead of a BigInt multiply per character (~100× cheaper per call) (#60); speculative mid-stream execution no longer re-parses a growing tool-args buffer on every delta (#59); a speculative preflight no longer restarts the shared session budget's wall-clock window (#56); and an already-aborted spawn attaches its `error`/`close` listeners before the early return, so a failing spawn is a handled rejection instead of an unhandled `'error'` event that crashes the host (#57).
- **Tests** — new coverage for plan-mode verify rollback, plan-mode network-read allowlisting, arg-aware read-only classification, the read-only shell batch gate, replay-path redaction, the native-mirror redaction lag, the silent-discard classifier class, and the recency-floor contract; the plan-mode verify tests are now hermetic (portable git environment, workspace-local scratch dir) instead of depending on a developer-local path.

## [0.27.0] - 2026-10-14
- **Rust-first default launch** — bare `mochi` now starts through a std-only Rust launcher (`native/mochi_core/src/bin/mochi.rs`, zero deps): `--version`/`runtime` fast paths answer in ~2ms, then it `exec(2)`s the freshest engine (standalone Bun binary or node+`dist/cli.js`, newest mtime wins; standalone wins ties) with automatic fallback to the other engine (exit 127 only if both fail). The full TS agent is unchanged — this only removes the node boot from the default path. `mochi node` and `mochi standalone` pin an engine explicitly; `MOCHI_RUNTIME=node|standalone`, `MOCHI_STANDALONE`, `MOCHI_NODE_ENTRY` also pin. New `mochi runtime [--json]` reports the true engine (`bun 1.3.x` vs `node v22.x`), launcher, and rust-core reachability; `mochi doctor` header now says which engine it actually ran on (bun fakes `process.version`, which had been reporting node). Build: `build:native` copies the launcher and survives `ETXTBSY` via rename-swap (running TUI sessions no longer break incremental builds).
- **Shell mutations now count as real work** — `verify()`'s "No changes made to verify" short-circuit and `shouldSelfReview()`'s gate only looked at `fileChanged`, which only `write|edit|delete|patch` ever set — a run that mutated everything via shell (`sed -i`, generators, `npm create`) verified nothing and self-reviewed nothing. The harness now snapshots `git status --porcelain` right before the model loop (harness bookkeeping paths like `.mochi/` filtered out) and consults the diff at both gates; probes are throttled to run only after a non-read-only tool executed. Non-git workspaces keep the old behavior (best effort, never blocks).
- **Chat answers stop being replaced by a placeholder** — when a chat/Q&A task hit the 5-tool-round cap, the run's final summary was the literal string `Synthesized answer for chat query.` — users saw that as their entire result. It now finishes with the model's real last prose (ANSI-scrubbed, 1500-char cap).
- **Loop guards survive the first edit** — the oscillation guard and the cumulative repeated-tool breaker were both gated on `!fileChanged`, disabling them for the rest of the run after the FIRST edit: a model that edited once then ping-ponged on failing calls (or spun 12+ identical mutating calls with repeated errors) was never cut short. The gates are gone; successful mutations still reset the oscillation counters so legitimate batch refactors flow, and the breaker still requires 3+ consecutive identical errors.
- **Context-limit retries capped** — hitting the context window compacted and retried with `i = Math.max(0, i-1)` and NO budget: when compaction couldn't shrink the prompt (one message larger than the window), the same iteration re-consumed forever — observed 240-minute spins that never reached maxIterations. Now capped at 3 compaction retries (reset on any successful response), then one failover to an alternate model, then an honest `model_error` stop. Also fixed the misrouting that hid this path: once a provider is marked dead, the retry short-circuits with `Provider X is marked dead (<first line>…)` — stripping the API detail line — so classification now runs on BOTH attempts' errors (this also restores correct rate-limit/permanent/transient classification for the same reason).
- **Read-veto memory resets on progress** — `readTargetCounts` (veto at 4 reads of the same target) never reset, so after 4 reads of a file every later re-read was a blocked no-op — strangling multi-step workflows. Successful mutations now clear the map: re-reading a file the model just changed is legitimate.
- **Prompt-compiler escape hatch works** — `MOCHI_PROMPT_COMPILER=0` was documented but dead outside vitest (the check only honored `=1`, and `!process.env.VITEST` made it always-true in production). `=0` now force-disables the compiler everywhere.
- **`--reasoning med` accepted** — `med` is documented in help and accepted by the compile-prompt tool, but the CLI flag rejected it and silently degraded to `auto`; it now maps to `medium` (help line updated to list `off|auto` and the alias).
- **`max` reasoning: honest wire mapping + opt-in** — the `max` tier was real harness-side (7-pass compiler spec, expanded thinking budgets on Anthropic/Gemini) but collapsed to `reasoning_effort: 'high'` on OpenAI-compatible wires, silently. The default stays `high` (the classic enum 400s on unknown values — a crash on every max run would be worse), and providers that accept wire `max` (gpt-5.1+, OpenRouter-style) opt in with `MOCHI_REASONING_EFFORT_MAX=1`; pinned by `openai.reasoning.test.ts`.
- **Tool failures keep their partial output** — the generic tool-exec catch discarded stdout/stderr when a tool threw after doing real work (exec-family errors carry the output on the error object). The catch now surfaces a clipped (48K head+tail) partial into `output` while `error`, event, and failure-signature shaping stay byte-for-byte unchanged.
- **Image reads can't bomb the context** — `read` base64-inlined whole image files into the prompt with no limit (a large or misdetected file = a token bomb). Now capped at 4MB raw before encoding; over-cap images return a short note (path, byte size, dimensions when cheaply parseable) instead of the blob.
- **Real SSE streaming for Anthropic & Gemini** — both providers fake-streamed: one-shot fetch, single chunk, so every stream behavior (time-to-first-token, mid-stream interrupt, stream health guards, per-chunk usage) never actually ran. Both now parse `text/event-stream` incrementally (spec-accurate SSE framing, Anthropic `content_block_delta`/`input_json_delta` stitching by index, Gemini `usageMetadata` accumulation) through new shared plumbing in `model/sse.ts` that mirrors openai.ts: header+stall watchdogs, request-only Retry-After-aware retries, abort propagation that tears the response down, non-2xx surfacing the API error body, and a non-SSE JSON fallback. Native `chat()` in openai.ts now prefers the final chunk's usage (all fields incl. cached/cost) over the Rust fold's zeroable counts.
- **Test-fake wire accuracy** — the shared SSE encoder dropped scripted content whenever the same reply carried tool calls (`if (toolCalls) … else if (content)`), unlike real providers that send both; tool-turn narration silently vanished in tests. Content and tool calls now coexist.

## [0.26.0] - 2026-10-14
- **Soft obsidian black canvas & Mochi Purple default** — matched canvas background to OpenCode soft obsidian black (`rgb(10, 10, 10)` / `\x1b[48;2;10;10;10m` with 256-color fallback `\x1b[48;5;232m`), eliminating pitch-black harshness. Default theme for all users is now Mochi Purple (`mochi-purple`), heading the 23-theme palette list.
- **Workspace anchoring & sibling project drift guard** — running Mochi from user home directory (`~`) or a multi-repo parent now dynamically discovers the intended target project from prompt context (`detectProjectFromPrompt`) and anchors the workspace (`this.workspace`, `this.cwd`, `this.goals`, `this.hooks`, `this.usage`). Strict boundary enforcement vetoes out-of-workspace mutations, sibling-project reads, sibling `cd`/`pushd` and `git -C` invocations, and prevents codebase exploration tools (`codebase-map`, `find-references`, `tree`) from wandering into sibling `.git` repositories.
- **AST-accurate identifier rename & symbol navigation** — TypeScript compiler-backed `rename_symbol`, `find_definitions`, and `find_references` with exact AST span analysis, comment/string protection, and multi-file project refactoring.
- **Model alias normalization** — vendor prefix normalization and alias mappings for GLM 5.4, DeepSeek, and Flash models, eliminating provider routing 404s and cooldown stalls.
- **TUI dynamic terminal window title & responsive spinners** — animated status bar and composer spinners with responsive frame pacing, active terminal window title reflecting current project, and desktop notify-send integration on completion.
- **23 themes, each a full re-skin** — every theme now owns its canvas background (`colors.bg`), so switching themes repaints the whole terminal (`paper-light`/`sorbet` are the light pair). All 23 signature accents and all 23 body-text colors are unique — enforced by tests — so no two themes read the same; display names are non-obvious (`Abyss`, `Mirage`, `Ember`, `Lagoon`, `CRT`, `Phosphor`, `Noir`, `Dune`, `Glacier`, `Claret`, `Afterhours`, `Moth`, `Gilt`, `Orchid`, `Paper`) while the persisted ids (`cyber-void`, `vaporwave`, …) never change, so saved prefs keep working. Tab-bar chrome (pill, titles, close glyphs, branch badge) was hardcoded purple/gray and now follows the theme; the 256-color downgrade handles background codes too.
- **PR review workflow** — new `review_pr` tool: fetches any GitHub PR (metadata + diff) via the ambient `gh` CLI, runs the harness hygiene scan, and reports a structured review with a correctness/security/performance lens. Read-only by default; `post=true` leaves a summary comment. Never approves or merges — that stays a human keystroke. Headless for CI: `mochi pr review <n> [--repo owner/name] [--focus …] [--post] [--json]` exits 0 (reviewed) / 1 (couldn't fetch: gh missing, auth, 404) / 2 (internal), with a `{ok, pr, findings, report}` JSON payload for bots.
- **Review-test honesty fix** — the `review_pr` fake-`gh` diff had no `+++ b/` hunk header, so `scanDiffForHygiene` never ran (the passing `TODO` assertion was just the raw diff echoing the word). Fakes now emit real hunks and assert the structured `- [debug-log] file:2` / `- [todo-marker] file:3` findings; the JSON counter matches hyphenated kinds (`debug-log`, not `debug_log`).
- **Polyglot speculative prefetch** — `predictNextFiles()` only predicted `.ts` co-changes, starving every non-TypeScript repo of cache warming; it now warms any source/config extension (py/go/rb/rs/java/… + json/yaml/toml) and still never warms prose or media.
- **Lightning-bolt emoji gone from the TUI** — token-velocity badge, subagent counter, and onboarding lines now use `▲`/`◆`/plain text (parser strip-lists and width tests untouched).
- **Interactive /tools browser** — `/tools` opens a menu of every agent tool: inspect any schema, or run it with prompted JSON args through the real executor (cards, audit, and permission checks included). Bare `/` no longer dumps the whole command list or dispatches `/` to the agent.
- **Real auth for every provider** — `mochi login` and `/login` now live-probe the key before storing (rejected keys are never persisted; unreachable endpoints store with a warning, never a refusal). New `mochi auth status [--probe]` shows key sources across all 36 providers without ever printing key material, plus `auth logout` / `auth reset` (re-login overwrites a key to change it). `mochi models --refresh [--provider <id>]` live-diffs the endpoint's model list against the table — detection only, never auto-mutates. Shipped a tested-but-unwired RFC 8628 device-flow engine for future OAuth (wiring without registered app IDs would be fake — documented as such); GitHub Models documents the honest OAuth path (`gh auth login`, then `GITHUB_TOKEN=$(gh auth token)`).

## [0.25.0] - 2026-10-14
- **Clean OpenCode-style braille spinner** — restored the classic, rock-solid braille spinner dot with theme-native harmonic breathing glow, eliminating star jitter and outline flicker.
- **Full cyber TUI suite** — active tab neon underglow, token velocity speedometer, multi-step task stepper with narrow viewport reflow (<50 cols), interactive code pills, Raycast-style command palette, luminous collapsible `<think>` drawer, and clean turn summary receipts.
- **Notebook tool** — Jupyter `.ipynb` by cell (read/edit/insert/delete/clear_outputs); hand-editing notebook JSON by line ranges corrupts cells, so this is the only supported path. nbformat-4 validated, outputs never pasted as blobs.
- **Native Rust core binary discovery** — standalone Bun binary `mochi` now dynamically searches host system paths (`~/.local/bin/mochi-agent`, `process.execPath`, `~/mochi/native/bin/mochi-agent`), eliminating the virtual-filesystem sandbox barrier.
- **Stall guard watchdog acceleration** — reduced header stall timeout (45s → 25s) and chunk stall timeout (30s → 20s) with `MOCHI_MODEL_STALL_TIMEOUT_MS` configurability for 2× faster provider failover.
- **Flake hardening** — glob huge-tree wrapper timeout 10s → 30s (the 36k-file fixture setup, not the walk, flaked under parallel load; the <5s walk bound is unchanged).
- **Skill catalog you can download from** — no new infrastructure: the registry (clone → register → install by name), pack/unpack, cross-source search, and TUI browser already existed. Closed the trust gap: installs now run the skill-lint gate (prompt-injection payloads rejected, quality notes reported visibly), and the repo ships a `skills/packs.json` seed catalog so any clone is an installable source.
- **Prompt bloat cut on read-only tasks** — research/plan/document/unknown turns advertised all ~65 tool schemas (~10K tokens/call); new READ tier advertises 16 (~2K). Chat tier no longer drops `search` (dead `grep` alias entry).
- **MCP registry 12 → 24** — Playwright, Context7, Tavily, Firecrawl, Exa (hosted), Supabase, Neon, GitLab, Google Maps, EverArt, AWS KB, Kubernetes, all package-verified; Brave migrated off its deprecated package; Exa rides a URL entry.
- **12 new skills (72 → 84)** — dependency-upgrades, e2e-testing, webhooks, worker-queues, serverless-functions, load-testing, terraform-iac, logging-standards, jupyter-notebooks, shell-scripting, sdk-design, zero-downtime-deploys.
- **6 new providers (32 total)** — Moonshot/Kimi, MiniMax, Zhipu GLM, Z.AI, Cohere, Alibaba Qwen, all endpoint-verified; Cerebras `llama-3.3-70b` id typo fixed; Together gains its Qwen coder.
- **4 more providers (36 total)** — Upstage/Solar, Nebius AI Studio, Novita AI, AI21/Jamba, each endpoint-verified against current docs the day it shipped (OpenAI-compatible bases, `*_API_KEY` env keys, `keyHelp` console links). New `keyHelp` field on the provider table (optional, only filled where verified) tells users exactly where to get a key. Fixed a real router bug the new table exposed: `normalizeModelName` stripped `deepseek/` prefixes on every non-OpenRouter endpoint, which 404s on Novita (`deepseek/deepseek-v4.1-flash` is the serving id) — aggregator endpoints (novita/nebius/together/fireworks/deepinfra) now keep vendor prefixes while direct endpoints still strip to bare ids. Same class caught again by a new whole-table audit test: GitHub Models' `openai/gpt-4.1` + `anthropic/claude-sonnet-4-5` were stripped to bare ids (GitHub 404s those) — `models.github.ai` joins the keep-prefix set, and the audit now pins every table id end-to-end.
- **Dedicated /providers menu** — `/providers` is now an extracted, tested browser (tools-menu pattern): full list with ACTIVE badges, exact-id/name lookup (`/providers upstage`), substring filtering, and a details card per provider (base URL, key source, keyHelp, models with default marked). It also manages keys: re-authenticate (always prompts — typing replaces the configured key, Enter keeps it; the old flow silently reused the old key so replacement was impossible), a visible per-provider OAuth login where a real local flow exists (`Login with GitHub OAuth` via `gh auth login`, `Login with Hugging Face` via `huggingface-cli login` — a guided wizard: setup steps, then Grab-the-token with probing; API-key-only providers offer none, never faked), clear the stored key, OAuth via local CLI auth as fallback, and keyless one-step switch for local providers (Ollama/LM Studio/llama.cpp no longer demand a key). `/login` shares the same key-entry unit, so both paths behave identically. The panel is persistent (details re-render live after every action, so a clear visibly flips the card to `key: missing`), re-auth no longer forces a model menu (keeps the current model; `/model` owns switching), every probe announces itself first so the live check never looks dead, and `/model` rows carry live key state too. Secrets are entered in a masked dialog (never echoed to the chat box or scrollback), and every provider with a verified key console gets an `Open key page in browser` action (21 consoles checked reachable; unknown ones offer no link rather than a guess). `app.ts` is a thin dispatcher.
- **Reviews get real effort (not chat-tier scraps)** — review-shaped tasks (`review my PR`, `audit the auth module`, `can you review…?`) classified as chat: 7 tools, low reasoning, and a 3-round cutoff that strangled multi-file reviews into rubber stamps. They now classify as research (READ tier with `review_pr` advertised, full MCP/protocols/preflight) with medium reasoning. Execution verbs still win (`fix the review comments` → fix).
- **Veto-stall breaker** — vetoed calls change nothing by construction, yet a model arguing with the guardrails burned the whole iteration budget (5+ vetoes, zero work). Five consecutive scope vetoes now stop the run with an honest `pulse_abort` verdict; any successful mutation resets the streak. The sibling/cd/git shell vetoes join the same streak counter.
- **Non-coding skills (84 → 88)** — creative-writing, email-communication, data-analysis, productivity-planning: full procedures (brief-first drafting, BLUF email, profile-clean-aggregate-verify data work, outcome-based planning on mochi's own todo/goal machinery), all lint-clean. Long-form prose (`write an essay`, `write a story`, `draft the newsletter`) now routes to document instead of max-burn implement; code-adjacent prose keeps its lane (`write a test story` → test).
- **Authoring gate enforces the safety lint** — `skill_manage create` rejected only on structure before; placeholder and injection payloads now fail at creation with the exact rule (the full 88-skill library passes the same gate). The score-based quality bar is unchanged.
- **Discord gateway actually runs** — `mochi discord run` was a config print; it now connects a zero-dependency Gateway v10 client (Hello/Identify/heartbeats, READY/MESSAGE_CREATE, backoff reconnect, SIGINT stop). Only prefix/mention messages are answered; replies chunk at the 2000-char cap; needs the Message Content intent for bodies. Fully scripted-socket tested, no network in tests.
- **54 more skills (88 → 142), zero prompt cost** — error-handling, async-concurrency, api-versioning, state-machines, typescript-strictness, root-cause-analysis, tradeoff-analysis, requirements-elicitation, risk-assessment, decision-records, project-scoping, spec-writing, postmortems, flaky-test-debugging, git-advanced, config-management, cli-design, data-modeling, resilience-patterns, code-readability. Each has a Trigger section, numbered procedure, pitfalls, and verification, and passes the lint gate (108/108 clean). Prompt cost measured, not assumed: the relevance gate caps advertising at 6 task-matched descriptions and bodies load on demand, so the advertised block stays ~1.3–1.8KB whether the library holds 84 or 108 skills.
- **Lessons become skills on their own (self-training write path)** — the loop recorded lessons but nothing turned proven ones into reusable procedures (Hermes' lead). The curator now promotes lessons retrieved 3+ times with 1+ recorded fix into gated, agent-created `learned-*` skills (trigger+match/apply/verify templated from the lesson itself, lint+quality gates still apply, name collisions keep the human version). Later passes lifecycle-manage them; `self-train` reports promotion counts.
- **Per-provider keyring (opencode parity)** — mochi now owns one stored key per provider (`~/.config/mochi/auth.json`, mode 600, `{id: {type, key}}`), so switching providers never loses keys and logout/reset clears ANY provider with a stored key — not just the active one (the old single-slot model made clear/logout meaningless everywhere else). `login` records the keyring (with `oauth` vs `api-key` type); switching re-attaches a stored keyring key when no env key overrides; legacy single-slot keys keep working until re-login. Env keeps its override on switches and the status display agrees with request behavior. Plus `auth export` (keyring JSON to stdout with a never-paste warning) and `auth import [file|-]` (shape-validated restore, unknown ids skipped, verify after with `--probe`).

## [0.24.0] - 2026-10-14
- **Interactive `ask_question` menu** — the model can now ask you back mid-task: option menus (arrow keys + Enter, Esc skips, free-text fallback, multi-select) in the TUI, deterministic defaults headless. Previously `ask_question` was aliased to `think`, so questions went nowhere.
- **Honest completion labels** — clean answers render "Question Answered", clean work "Task Complete"; "Partially Complete" only on real partials, "Task Failed" on failures (was: everything read "Partially Complete", including a bare `hi`).
- **Chat turns stay conversational** — mutating tools are vetoed on Q&A tasks (the `hi` → tool-spam + error-card class), greetings need no tools, and harness chatter (`think` echoes) no longer types into your transcript: only you write user lines (pinned by `chat-ownership` source-guard tests).
- **Universal `mcp add`** — install any server, not just the 12 built-ins: `npm:<pkg>`, `uvx:<pkg>`, `https://…` endpoints, `cmd:<bin>` (bare words never hit npm, so typos can't pull a stranger's package); plus `mcp remove` and `mcp test` (live handshake + tool inventory) in CLI, TUI, and `mcp_manage`.
- **Quiet spinners** — thinking line is one purple braille dot beside `Thinking…`; running tabs breathe dim/bright instead of cycling glyphs.
- **ACP `kind` fix + release gate honesty** — ACP `tool_call` notifications carry the right kind again; `release-check` now fails on suite failures (its `tail -n 5` grep waved red suites through as green).

## [0.23.1] - 2026-10-12
- **First GitHub release** — standalone binaries for linux-x64, windows-x64, darwin-x64, darwin-arm64 on the releases page (`scripts/package-release.mjs` + `release.yml` matrix). No Node needed.
- **1-line install** — `curl -fsSL https://raw.githubusercontent.com/xanstomper/mochi/main/install.sh | bash` (linux/mac) and `irm …/install.ps1 | iex` (windows). Installs `mochi` to PATH with source-build fallback. See `docs/INSTALL.md`.
- **Goodbye screen** — exiting the TUI (double Ctrl+C / Ctrl+D) now prints the MOCHI logo + session id + tokens/cost/duration + safety badge (`🔓 UNCENSORED · admin privileges active` when privileged), opencode-style, persisting in scrollback.
- **Update check** — daily warn-only nudge now reads the GitHub releases API (the npm package is unpublished); `MOCHI_NO_UPDATE_CHECK=1` opts out.
- **New-user flow verified** — fresh-HOME E2E (`--version`, `--help`, `doctor`, `onboard --yes`, `acp --check`, `setup vscode`, TUI exit card) green on the linux binary.

## [0.23.0] - 2026-10-12
- **ACP hardening** — notification handling (no `id` → no reply, string + numeric ids route), per-session prompt queue (overlap on one session serializes, parallel across sessions), `mochi acp --check` verifies initialize → new → close without an editor.
- **VS Code production** — silent-server `requestTimeoutMs` (streaming keeps alive), markdown chat (code/bold), plan/act mode toggle + badge, `Check Agent Health` round-trip, stderr mirrored to Output log.
- **JetBrains parity** — tool-window `New` (closes old session, no leaks), `Mode: plan/act` toggle, `Send Selection` asks what to do + sends file:line fenced context, binary-missing dialog, `binaryPath` settings UI.
- **Plugin management** — `mochi plugin enable|disable|info|validate` (`.disabled` sentinel, excluded from merged hooks), `/plugins` TUI parity.
- **Doctor + setup** — `mochi doctor` gains `acp` / `vscode` / `jetbrains` / `onboard` rows (`--probe` adds provider reachability); `mochi setup vscode|jetbrains|editors` installers verify ACP first.
- **Windows: hooks actually run, rule ids are names, and session stores stop locking the workspace** — surfaced by the first run where the Windows CI leg ever completed its shards: `HookManager` hardcoded `sh -c` (every hook silently failed on win32 — now the platform shell through `runShellString`); `parseRuleFile` derived ids with `filePath.split('/')`, so backslash paths became absolute-path ids (now `basename()`); `SessionStore` handles were leaked by `doctorReport`, `Runtime.branchSession`, `GoalEngine`, and ACP `session/close` — Windows keeps an exclusive lock on an open SQLite file, so `.mochi/sessions.sqlite` could never be unlinked while the process lived (all sites close now; new `Runtime.close()`/`GoalEngine.close()` for sessions and test teardowns). Test portability fixes ride along (no hardcoded `/tmp` or `shell: '/bin/sh'`, `USERPROFILE` next to `HOME`, `path.delimiter` PATH joins, separator-normalized assertions, portable hook commands).
- **`MOCHI_EXEC_TRACE=1`** — logs every spawn (`start`/`done code ms`, a hang shows `start` with no matching `done`) and every fake/model request; provider backoff logging now walks the error cause chain, so `fetch failed` surfaces its real reason (`ECONNREFUSED` vs `ETIMEDOUT` vs proxy) instead of the bare undici wrapper.
- **Windows CI leg finally completes** — the leg had **0 completions in 60+ runs** (killed at the 20-min and 35-min ceilings with or without coverage instrumentation). The suite now runs in 4 shards (~58 files each) with Defender realtime monitoring off and verbose + exec-trace attribution; ubuntu/macos keep the single-job coverage gate unchanged.
- **Failed mutations no longer count as file progress** — `trackFileChange` treated a *failed* `write`/`edit`/`patch`/`delete` as "file changed": it zeroed `consecutiveToolErrorsCount` (so the 8-failure runaway abort never saw a failing-write loop), reset cycle/nudge counters, and set `fileChanged` — which bypasses every no-file completion guard, letting "failed write → successful shell → prose claim" finish as success with nothing on disk. Failed mutations now record *intent* instead: the file-guard fail arm fires after one nudge unless the failed write's target actually exists (out-of-band recovery via shell). Pinned by two regression tests (unit + end-to-end).
- **Context compaction was silently disabled when the native runtime was up** — `estimateTokensAsync` sent pre-stringified message strings to the Rust `tokens` op, but the runtime's array scanner only extracts object elements, so every batch counted as **0**; once a transcript passed 24 messages the compaction floor check (`ctxTokens > floor`) never fired and context grew unbounded until the provider truncated it. The client now sends the message objects the runtime documents (TS-only fix — works with prebuilt binaries), restoring parity with the sync TS walk. `nativeTokensCount` and `nativeAssembleStream` were previously untested; both ops now have direct coverage including the 4MB-payload guards, shutdown/`MOCHI_NO_NATIVE` fallbacks, and the fake-Bun FFI branch of `native/core`.
- **Coverage gate green for the first time** — the full 3-OS CI had **0 successes in 60 runs**, failing only at the coverage thresholds (statements/lines). Added ~146 tests (11 new files + 6 extended suites: `config`, `doctor`, `acp`, `tui/state`, `skills`, `sdk`, MCP client transport, `web-search`, `color`, `permission`, `feedback`, `update-check`, tool-output/search fallbacks, both `native/core` availability shims): local statements 62.48 → 66.49%, lines 65.76 → 69.59%, functions 70.95 → 74.57%, branches 53.4 → 57.56%. Thresholds re-baselined as an honest ratchet below the worst CI projection (CI has measured ~0.9 pts under local): **statements 65, lines 66, functions 71, branches 54** (was 65/65/69/50); raise when coverage rises, never lower silently.
- **Standalone binary 4.7× faster** — `build:bin` now uses `--minify --bytecode --no-compile-autoload-dotenv --no-compile-autoload-bunfig`. Bun was re-parsing the whole flattened bundle on every spawn (248ms CPU / 464ms wall for `--version`); bytecode precompiles it at build time → **80ms CPU / 115ms wall**. Required removing the one top-level `await` from `src/cli.ts` (`--bytecode` converts the bundle to CJS; the V8 compile-cache warmup now uses a safe `import * as nodeModule` namespace import that degrades on pre-22 node). No top-level await anywhere in the shipped graph — enforced by the smoke tests.
- **npm/node entry faster** — `repo/repo.js` (~12-14ms CPU: `findProjectRoot` only, used by hooks/doctor/sessions) is now lazy-loaded; compile-cache `mkdirSync` skips when `enableCompileCache` doesn't exist (pre-22 node, inside the bun binary). `mochi --version`: 96 → 82ms CPU (node floor 45ms).
- **Release gate now verifies the standalone binary** — `release-check` spawns `dist/mochi-bin --version` and asserts it prints the package version (prepack built it, but nothing ever ran it — a broken `build:bin` would ship silently), and asserts the tarball excludes the ~100MB binary via the JSON pack listing.
- **Reproducible cross-harness benchmark** — `bench/cli-matrix.mjs`: cold-start wall time + kernel peak RSS for every installed coding-agent CLI (`--version`, N runs, p50/mean). First honest slice: claude/codex/jcode lead startup (~20ms/22-36MB), mochi node entry mid-field (77ms/48MB, half of opencode's 91MB), pi pathological (2.1s). `docs/BENCHMARKS.md` leads with these re-measured numbers and demotes the unreproducible August matrix to history. Labels now distinguish mochi's three shipped paths (npm/node, bun-run, bin).

- **Loop-guard correctness** — failure-cluster compared against the just-assigned signature (always true); now compares against the previous turn. `lastToolError` gate covers verify/subagent tools and only a successful work tool clears it (a trailing `read` no longer masks a failed shell). Same-answer stagnation keeps its verify-retry exemption (the retry/rollback/escalation flow owns failing streaks); fresh and post-pass stalls stay policed. Removed dead `pulse` empty-response abort. Abort-listener wiring cleaned up per model call. Cooldown/429/transient retries no longer burn `maxIterations`.
- **No more prose-only "done" for builds** — `core/greenfield.ts` (`expectsFileOutput`: explicit fileScope, file-shaped criteria, or creation-led requests like "code a game") drives a single file-guard nudge plus a zero-tool fail; read/vetoed flows still complete normally. Greenfield builds skip the repo suite in both verifiers instead of running the host repo's tests.
- **Verification honesty** — strict `^exit_code:` parsing in both verifiers; mutation gated on the test command itself; judge falls back to rule-based on garbage JSON and a PASS contradicting failed evidence is vetoed to PARTIAL; rule-based BLOCKs on unverified changes instead of PASSing. Greenfield veto + `cd`-prefix-tolerant baseline matching in both verifiers; shared heuristics in `core/greenfield.ts`.
- **Scope + routing** — `autoTestCommand` bails on multi-dir scopes, matches `_test.go`/`test_*.py`/`*Test.java`, falls through to parent runners; compiler/linter commands count as strong verification. Question-titles route to chat. `create` no longer matches `creative`. Bare one-shot tasks stay on the Agent-layer verify gate (the goal verifier BLOCKs them vacuous-ly). Self-review skips `BLOCKED`; `before_task` veto precedes `scheduler.start`; `<path> exists` requires path-like non-empty files.
- **Budgets + config** — `canExecuteTool` allows the verify phase; `autoImprove`/`selfTrain` report per-run deltas and no longer mutate shared `maxIterations`; `MOCHI_SAFETY`/`MOCHI_SANDBOX`/`MOCHI_REASONING` warn on unknown values (`off`/`auto` reasoning now respected); `applyMode` deep-clones; `.gitignore` covers `.mcp.json`/`mcp-oauth.json`; OAuth warns on empty `${VAR}` expansion; daemon rotate no longer prints tokens.
- **Exec policy** — `verify` tool runs through `exec.ts` (timeout/cap/redaction); authored-tool, perf-measure, and curator-doctor outputs redacted; perf `measure` is async. Rate-limit sleeps/throttle abort-aware; token wait precedes semaphore take.
- **CI + docs** — `release-check --skip-tests` wired into CI; competitor matrix synced with closed gaps; duplicate changelog H1 removed; 0.23.0 suite counts corrected to the re-verified number (1507 passed / 4 skipped).
- **Test + packaging hygiene** — `src/testutil` (vitest-only fake provider) excluded from the `tsc` build and the tarball guard (was shipping `dist/testutil/fake-openai.js` in the published package); SDK end-to-end test performs a real write instead of pinning prose-only success; chameleon warmup test gets load headroom (flaked only under full-suite load, 9/9 isolated).
- **TUI freeze + lag sweep** — spinner ticks every busy tab and stops only when none are (background completions no longer freeze the active tab); render-pause self-heals with backoff; completion events always frame; abort paths (`/stop`, double-ESC, Ctrl+C) no longer fake idle before the run unwinds; prefetch badge cached 5s; prompt/menu resolvers can't orphan waiters; ESC cancels armed prompts (all `ask()` callers handle cancel); paste latch times out; queue drain is per-item safe.
- **Dead/useful command audit** — real `/compact` unshadowed; `/rules` shows both rule systems; `/export` writes the transcript and `/import` restores it (was a copy-paste re-export); bare `/run|/shell` shows usage instead of prompting the model; `/redo` re-runs the last input (was a mislabeled `/undo`); `/docgen` truncated; clipboard reports real success synchronously; autocomplete uses plain names + arg hints (no more `[focus]` pasted into sessions); 8 hidden commands advertised (`/team /image /run /shell /test /checkpoint /rollback /tools`). CLI: `docs query|adr` unshadowed from `docgen` (verified live); `discord status|run` implemented honestly (no embedded gateway — points at Hermes); completion phantoms (`verify lint tokens stats`) pruned; `daemon` usage lists `rotate`; `known-good` checks bounded 60s with TIMEOUT labels; PTY smoke skips loudly on a stale `mochi-bin` instead of failing confusingly.
- **`/chameleon` command removed as a dead end** — it spent up to 6 model calls printing reasoning guidance into the transcript, where the agent never reads it (and `/plan` already covers pre-work the agent executes). The engine stays fully wired where output is consumed: auto-primed scaffold injected into implement/fix/refactor/plan context, `mochi goal|team --enhance`, and the agent-callable `chameleon` tool. `mochi chameleon|enhance` now prints a redirect instead of silently falling through to the one-shot prompt path; completion descriptions updated to match.
- **Cost accounting unified (live-smoke finding)** — a real run's goal summary printed `Cost: $0.0002` next to `Costliest tasks: … ($0.0136)` because the budget ledger priced output-only tokens (deliberate: full re-billing exhausts `maxTokens` early) while the run's own cost figure priced prompt+completion. `recordTokens` now takes the caller's real cost for charging while keeping output-only tokens for limit accounting, `estimateCostUsd` gained a `provider` arg so free endpoints (`freeinference`, `…:free` models) bill $0 instead of the unknown-model flat rate, and all six record sites (loop, verification, speculative ×3, termix, chameleon) pass provider + real cost. `mochi usage` also records the real model-call count from the budget ledger instead of hardcoded `modelCalls: 1`. Verified live: every cost line agrees ($0.0000) and `tokens in/out` shows the true split on a free-provider run.
- **CLI truthfulness & broken-command sweep** (audit-driven; every fix live-probed in a sandbox): `mochi issue` is now branch-only — the old path auto-committed a dirty tree with a canned "Fix implemented by agent." body, pushed, pointed at a nonexistent `mochi pr` (which fell through to a model run), and exited 0 on failure; `mochi config` no longer prints raw API keys (routes through `redactObject`); `mochi term --dry-run` no longer spawns a real terminal window before "reporting" it; `mochi bg` persists a `.mochi/bg-tasks.json` ledger so a fresh process can actually list/logs/kill tasks (stale 'running' records corrected via pid liveness, kill signals cross-process, failures exit 1); `mochi model` got a real handler (it was completion-advertised with no branch — fell through to a model run on the literal word "model"); `mochi workspace` lists actual workspaces (was goal UUIDs), persists the selection, and `switch` rejects typo'd names instead of fabricating them; `mochi login` accepts `--key`/key-shaped positionals and provider display names, and never stores `env:sk-…` as the model id; `setProvider` no longer crashes on a fresh install (missing config file → `cfg.model` undefined); `checkpoint save` requires a repo, `checkpoint restore` reports real git failures (was unconditional success) with exit 1, and `mochi rollback <name>` makes named snapshots reachable; `--list/--update/--coms/--sep` are boolean flags again (no longer eat their next argument); `rules add <name> "<content>"` no longer writes the title as the body; profile listing dedupes (every profile printed twice); plugin hook sync dedupes (accumulated per `plugin add`); `mochi usage` records a real prompt/completion token split instead of structurally reporting `tokens in: 0`; honest hints for `hooks`, `check`, and `known-good`.

## 0.23.0 — 2026-10-12 (the everything sweep)

- **Publish pipeline hardened** — `prepack` now builds dist + natives + standalone binary (a clean-tree publish previously shipped a 4-file tarball with no agent in it); release gate's tarball check reads npm's stderr listing (its stdout-only capture once "passed" a needle from an unrelated prepack log line) and understands both bare and `package/`-prefixed paths; `Cargo.lock` stays in step with version bumps; native binaries are stripped and `.map` sourcemaps + the 96MB `dist/mochi-bin` standalone excluded from the package (npm runs `dist/cli.js` under node; the compiled binary ships via GitHub releases) — tarball 44.8MB → ~3MB.

- **Source reorganization** — `src/` sorted from 88 flat root modules into topical dirs (`model/`, `stream/`, `memory/`, `skills/`, `state/`, `security/`, `daemon/`, `repo/`, `observability/`, plus `core/` and friends); 99 files moved with every relative import rewritten mechanically, verified by `tsc` + full suite. Root now holds entrypoints only.
- **Dead code removal** — deleted 5 unreferenced modules + tests (`core/context-budget`, `core/git-plumbing`, `model/dual-dispatch`, `prompt/prompt-expander`, `stream-degen`), proven unimported via compiler move-away trial before removal.
- **docgen now covers the whole tree** — scan cap 100→500 files, test files excluded from the architecture graph, recursive walk catches every subdir (ARCHITECTURE.md: 78→298 modules, 778→3105 symbols).
- **Theme test sandbox hole closed** — `stays transparent on light themes` sandboxed `HOME` but not cwd, so `applyTheme` wrote a real `<repo>/.mochi/theme.json` (dracula) on every test run, hijacking the next launch. Cwd now sandboxed; real files restored to `mochi-purple`.
- **Repo hygiene** — MIT LICENSE added (was declared but missing; now ships in the tarball), stale Sep-14 coordination docs + `ok.txt` dogfood junk removed, 4x duplicated 1.3MB gif deduped to one, new `TECHMAP.md` maps every repo path so nothing is mystery meat.

- **Anthropic prompt-cache breakpoints (token efficiency)** — `src/model/anthropic.ts` mirrors the OpenAI MCH-38 pattern: the stable system prompt ships as one `cache_control: ephemeral` block instead of being rebilled every turn (~5KB × every iteration). Empty-system wire shape unchanged. Pinned by `src/model/anthropic.test.ts` (blocks, omission, multimodal flattening).
- **GoalResult.filesModified plumbing (correctness)** — `GoalEngine` aggregates per-task `AgentResult.filesModified` (success + partial-failure work) into `GoalResult.filesModified`; SDK/daemon `runPromptDetailed` finally report real files instead of hardcoded `[]`. Proven end-to-end by a scripted write→ledger test.
- **Hooks lifecycle audit closed** — all 17 `HookName` values pinned: every one fires through `runBefore`/`runAfter` with marker scripts, veto semantics verified, plus a static test failing on any future hook name without a lifecycle call site. Hook subprocesses moved onto the central exec policy (timeout→SIGKILL, output cap).
- **Windows CI + vitest 5** — matrix adds `windows-latest` (bash shell for POSIX steps); toolchain bumped to vitest 5.0.3 + vite 7, full suite green (1507 passed / 4 skipped, 0 failed — re-verified 2026-10-12 on the current tree), `npm audit` back to **0 vulnerabilities**.
- **Tool-schema diet (token efficiency)** — heaviest tool defs (tool_factory/skill_manage/browser/subagent) trimmed with semantics preserved; lean/heavy tiers verified wired as the default path.
- **Sandboxed execution** — opt-in bubblewrap isolation in the central exec policy (`safety.sandbox: off|auto|bubblewrap`, `MOCHI_SANDBOX`, per-call `sandbox:true`): read-only root, writable cwd/tmp/dev-caches, optional `--unshare-net`. Live-proven (commands run, home dotfiles unwritable); surfaced in `doctor`.
- **MCP transports** — the SDK path (`McpClient`) gains Streamable-HTTP alongside stdio via a transport seam (`forConfig` picks by shape); the loop path already had it. HTTP errors answer per-request, never kill siblings. Mock-server tests for handshake/list/call.
- **Vision everywhere** — data-URI images map to native parts on Anthropic (base64 blocks) and Gemini (inlineData), not just OpenAI passthrough; remote URLs preserved per provider capability. Tested on all three mappers.
- **SDK streaming + discovery** — race-free `promptStream()` generator (eager subscription, bounded backlog, yields events then returns the result), `searchSkills()`, `addMcpServer()`.
- **Skill packs** — `packSkills()` bundles installed skills (bodies + references + manifest) and `mochi skills pack/unpack` shares them; round-trip tested against the existing import engine.
- **Browser readiness in doctor** — no-launch `probe` subcommand in the driver (playwright + cached browsers); doctor reports it instead of discovering breakage mid-task.
- **Model auto-escalation** — 3 consecutive verification failures hand the task one tier up (fast→coding→reasoning) to a *different configured* model, once per task with an explicit handoff note. Pure decision helper + integration test on a scripted always-red task.
- **MCP OAuth (pre-registered clients)** — client-credentials + refresh grants with 0600 token cache, `${ENV}` secret expansion, per-request header injection on both HTTP paths. Mock-server tests for mint/cache/refresh-fallback/authenticated calls.
- **Shell completions** — `mochi completion bash|zsh|fish` with a self-checking command table (a test fails on any CLI command without completion coverage); bash output validated with `bash -n` + live eval.
- **Multi-tab sessions (opencode-style)** — `src/tui/tabs.ts` + pinned tab bar: pill tabs with filled active surface, `+ New session` button (mouse-clickable with exact cell-aware columns), sessions-only bar (no key-hint clutter), space-separated status dots, Alt+T new, Alt+W close, Alt+1-8 switch, `/tab` commands, clean boot (no transcript spam on tab create — new tabs open on the logo), silent drag-copy (no "Copied" spam, clicks never dismiss the splash), splash reappears on every new tab and dies only on send, auto-title from first prompt, per-tab isolated Runtime (own abort/session/budget), background runs continue and badge unread, origin-captured transcripts. Proven live over PTY (click `+ New session` opened tab 2; click tab 1 switched back; `/tab list`; exit 0).
- **Mochi Purple default + forced-black canvas** — new signature theme (crisp white + violet on near-black purple surfaces), now the default; active tab pill uses its surface. Dark themes paint every row over pure black (opencode parity — terminal profile gray can never show through, SGR tint leaks killed by frame RESET + row trailing RESET); light themes + NO_COLOR stay transparent. `themeIsDark()` decides by luminance, no per-theme flag.
- **SGR leak guard** — `terminateRow()` (ansi-hygiene): every written row ends terminated-or-empty, so model/tool prose ending in a live color can no longer tint the frame's EL clears and following rows (the gray-block root cause). Pinned by 3 tests; verified black-canvas + intact status text at 60/80/100/120 cols over PTY.
- **Gauge gray tracks killed** — the empty tracks of every meter (context `░`, cache `▪`, model-row `█`, metric gauges, splash rail) rendered in theme-gray: ~28 gray blocks at idle. Now a fixed near-black track (`38;2;58;54;70`) that reads empty on black and as a rail on light themes. Proven over PTY: zero gray block runs remain (only thin animated splash shimmer).
- **Theme-cementing killed** — `view.setTheme()` no longer persists (paint-only; persistence is explicit via `applyTheme`), boot never re-persists fallbacks, and the test suite no longer writes the developer's real theme files (two tests hardcoded `applyTheme('cyber-void')` with a live HOME — the recurring resurrection vector). Proven: full TUI suite runs with all four theme sources untouched. Capability-aware canvas (`canvasBg()`: 24-bit vs palette-16 black, transparent for dumb/NO_COLOR/light) fixes 24-bit codes degrading to gray on 256-color terminals.
- **Theme + admin stick** — `/theme` and the theme menu now persist via `applyTheme` (was memory-only `setTheme`, so every relaunch reset); boot no longer re-persists fallback resolutions (that cemented stale-dist fallbacks over user files); `homeDir()` honors `$HOME` (`os.homedir()` ignores it); stale "15 Styles" label is dynamic; `MOCHI_YOLO=1` env joins `--yolo` as the persistent admin switch.
- **Composer placeholder actually renders** — the empty-box branch sat after a check that `wrap('') === ['']` always satisfied, so no placeholder ever showed; reordered (original box + text untouched).
- **Single chrome geometry** — new `src/tui/chrome.ts`: renderFrame, selection math, and the dropdown all share one layout function (killed the third drifting copy); mouse rows re-based for the tab bar.
- **Skill search** — `searchSkills()` (exact→prefix→substring→description→token recall + usage boost + snippets) with `/skills search <q>` picker; **MCP search + 1-command install** — `searchMcpServers()`, `addMcpServerConfig()` (merge-only `.mcp.json`, corrupt-file refusal), `mcp_manage` gains `search|add`, `/mcp list|search|add` TUI menus.
- **`as any` zero** — 125 → 0 in shipped source (tsc strict clean throughout). Real bugs found and fixed along the way: `/circle` read a nonexistent property (now SessionStore-backed), browser tool emitted malformed events (now conforming), reasonBadge could print `[object Object]`, capability/read-cache type fork unified, native FFI boundary typed.
- **Central exec policy** — `src/exec.ts` (timeout→SIGTERM→SIGKILL, output caps, argv-vs-shell split, audit hook) now drives shell tool, verification, cron notify, and TUI runners.
- **Daemon rotation/expiry** — 30-day TTL, zero-downtime `/api/rotate`, `mochi daemon rotate`, expired-token 401s, URL-token scrub.
- **TUI access** — NO_COLOR, reduced-motion, 22nd `paper-light` theme, WCAG AA contrast gate (all pass; floor 6.57).
- **CI** — native-binary existence assertion, skip-budget guard, prod-audit gate (0 vulns shipped; dev-only vitest advisories documented, source-map-js fixed via lockfile).
- **Cron notify hardening** — `src/cron.ts`: new `validateNotify()` (webhook scheme/length checks, 500-char shell cap, NUL guard) enforced at `addJob` time AND re-checked at execution; `loadJobs` schema-validates every entry so a hand-edited `cron.json` cannot inject malformed jobs; summary passed via `MOCHI_JOB_SUMMARY` env only (the old `"` rewrite corrupted text). 5 new tests.
- **Multimodal mapper sweep** — `src/model/openai.ts`, `anthropic.ts`, `gemini.ts` now flatten `ContentPart[]` through `contentText()` instead of `m.content ?? ''` (which stringified `[object Object]` for image parts); killed 6 `as any`/`any[]` sites with real wire types.
- **Cell-aware terminal widths** — `src/tui/wrap.ts` gains `stripAnsi` (full CSI+OSC), `cellWidth` (wcwidth-style: CJK/emoji 2, combining 0), `visibleCells`, and `sliceCells` (never splits surrogates/wide chars); `view.ts`, `cards.ts`, `selection.ts` unified on it (4 duplicated implementations → 1). Hard-split wrapping, truncation, and mouse selection are now CJK/emoji-correct.
- **Layout lockstep** — `transcriptGeometry` recomputed with `renderFrame`'s exact formula (was 4:3 vs 3:2+1, breaking selection/scroll sync on short terminals).
- **NO_COLOR + reduced-motion** — `honorsNoColor()` strips every escape byte; `prefersReducedMotion()` (env/`NO_COLOR`/dumb) stills splash + spinner. 4 new theme tests.
- **Trace retention** — `pruneTraces()` (100 files / 32MB caps, oldest-first, best-effort) runs on every new run; `bench/arena-results.json` untracked + gitignored (was rewriting every arena run).
- **Green main** — `vitest.config.ts` aliases `bun:test` to a portable shim: the 9 bun-authored files that failed collection under `npm test` now run (38 tests). Full suite: **1507 passed / 4 skipped, 0 failed** (was 9 unloadable files; re-verified 2026-10-12 on the current tree). CI asserts native binaries exist post-build instead of silently self-skipping parity tests.
- **Docs + dashboard hygiene** — `ARCHITECTURE.md` regenerated (122 modules / 975 symbols); dashboard scrubs `?token=` from the URL bar after login.

## 0.22.0 — Speculative stack complete

- **Repo map (MCH-49)** — `src/repo-map.ts`: Aider-style repo map built on the codegraph. Resolves `calls.callee` symbols to their defining files via the `symbols` table, builds file→file call adjacency, runs 30-iteration PageRank (damping 0.85), returns the top-15 structurally important files. Injected as a `REPO MAP` system message at task start. ~60ms warm on a 19k-line repo; ranks `loop.ts`, `codegraph.ts`, `events.ts`, `memory.ts` first.
- **Prefetch fusion (MCH-50)** — `src/prefetch.ts`: fuses three independent signals into one ranked prefetch list — structural (repo-map PageRank), temporal (co-change history from git), runtime (cross-session read-cache telemetry). Max-of-signal scoring with a +0.15 bonus per agreeing signal; workspace-path normalization; exists/size validation; best-effort everywhere. Injected as `PREFETCHED CONTEXT` with per-file signal tags.
- **Cache warming (MCH-51)** — `warmReadCache()`: physically preloads predicted files' contents into the per-run read cache at task start, using the exact same (mtimeMs, size) validation contract as the read tool, so correctness is identical — a mid-task edit still misses and re-reads from disk. 1.5MB cap, per-file try/catch.
- **Tool-route mining (MCH-52)** — `src/tool-sequence.ts`: persists each successful run's ordered tool sequence (cap 120 seqs × 40 tools) to `.mochi/tool-seqs.json`, mines bigram transitions at next task start, and injects a `TOOL ROUTE PATTERNS` system hint listing the most common successful transitions. Pure observation — never gates any tool call.

**Test suite: 1221 passed / 5 skipped. Both builds green.**

## 0.21.0 — Operation Frontier

- **Predictive file pre-fetch (MCH-43)** — `predictNextFiles()` in `src/speculative.ts`: builds a co-change graph from the last 40 git commits (`git log --name-only`), skips mega-commits (>8 files — init imports and bulk renames carry no co-change signal), and predicts the top-5 likely-next files for the currently-touched set. The agent loop's speculative preflight now warms the read cache (absolute-path + mtime keyed) with those predictions BEFORE the agent asks, so first-touch reads are cache hits on familiar codebases.
- **Auto-skill from successful runs (MCH-44)** — `autoDraftSkill()` in `src/skill-curator.ts`: when a (task-pattern, strategy) pair from the learning store reaches ≥2 successes and no existing skill covers it (usage-registry similarity check), a draft SKILL.md is written under `skills/auto/` compiled from the run's recorded lessons. Wired into `finish()`; uses real success counts from telemetry (not a hardcoded threshold at the call site); best-effort — drafting can never affect task completion.
- **SDK remote prompt + typed status (MCH-45)** — `RemoteMochi.prompt(task)` now exists (previously remote mode could only goal/plan), backed by a new `/api/prompt` daemon endpoint that runs `runPromptDetailed` and returns the full structured `RunResult`. `RemoteMochi.statusTyped()` gives a typed `{ready, tasks, activeAgents}` view.
- **SDK memory surface** — `Mochi.remember(statement, category)` and `Mochi.recall(context, limit)` expose the MCH-42 memory store (dedup, semantic scoring, decay) on the typed SDK: scripts and CI can now persist and recall durable facts without touching the Runtime escape hatch.
- **TUI chat-box corner fix** — the bottom-right corner of the prompt input rendered as `____,,,]` instead of `____]` on the last row; writing exactly `w` columns on the final row is now safe (cursor-position escape prevents the terminal wrap), restoring the perfect rectangle. 189/189 TUI tests.
- **Skills v2 relevance (MCH-40) verified end-to-end** — usage-boosted skill selection, 90-day stale pruning, esm-hygiene clean (no bare `require()` anywhere in new code).

**Test suite: 1202 passed / 5 skipped. `tsc --noEmit`: 0 errors. Both `npm run build` and `npm run build:bin` green.**

## 0.20.0

- **Default model chain upgraded (MCH-35)** — freeinference `kimi-k2.7-code` is now the coding/reasoning/review primary; `glm-5.3-flash` stays the `fast` profile only and remains first failover. The flash model was the source of the long-run spin (98 calls / 2.1M tokens on a hard vitest task); the coding-primary chain changes real outcomes.
- **MCP client (MCH-33)** — minimal Model Context Protocol client over stdio (initialize handshake, `tools/list`, `tools/call`). Configure servers via `.mcp.json` or `config.mcpServers` (same shape as Claude Code). Each server tool is exposed as a native `mcp_<server>_<tool>` Mochi tool with network-class permissions, so loop guards apply unchanged. A dead server is skipped with a warning — it can never take down a run — and connections are torn down on every finish path.
- **Mid-run context digest (MCH-32)** — CC-style summarization tier between mechanical tool-output shrinking and full turn-dropping compaction: when shrink alone can't get under the context floor, the oldest messages are summarized into a ≤300-word digest (goal, files touched, commands run, errors/fixes, open threads) and the recent working set is kept intact. Best-effort: any failure falls through to compaction.
- **Codex-style independent acceptance gate (MCH-31)** — after verification commands pass, every acceptance criterion naming a concrete artifact (exists/created/contains) is re-checked against the filesystem independently of the builder's claims, before any finish. Gates tasks even with zero verification commands.
- **Plan-mode AcceptPlan contract (MCH-28)** — plan mode now ends via an explicit `accept_plan` tool call (Claude Code's ExitPlanMode shape) with the plan persisted to `.mochi/state/plan.json`, instead of regex-guessing prose.
- **Per-endpoint stall budgets (MCH-29/29b)** — stall-retry budgets are keyed by `baseUrl|model` instead of global, so a flaky primary burns its own budget and failovers start fresh; transport-level stall retries no longer consume task iterations (a flaky provider can no longer kill a task as `max_iterations` with zero work done).
- **CC-style in-place context shrink (MCH-30)** — old tool outputs (>600 chars, outside the recent window) are truncated head+tail in place before any compaction, deferring history loss on long runs.
- **Fake-provider fidelity fix** — the test fake's `stall` entry consumed its queue slot, so abort+retry wrongly popped the next scripted success; stalled providers now stay broken across retries (wire-truth), and `close()` destroys open stalled sockets so teardown can't hang. **Test suite: 1200 passed / 0 failed** (first fully green run; two stall-guard failures had stood since introduction).
- **`mochi doctor --probe`** — doctor now reports app version and can live-ping the provider endpoint (`models` list, 2s budget) so dead endpoints are caught at onboarding, not mid-run.

## 0.11.1

- **Fixed the second, still-live hard freeze: `glob`'s unbounded synchronous directory walk.** The glob tool recursed with `readdirSync`/`statSync` over every directory under cwd with no depth, entry, or time budget (only `.git`/`node_modules`/`.mochi` skipped). Run from a broad root like `$HOME`, one innocuous `glob native/**/*.rs` ground through hundreds of thousands of stats, blocking the event loop for minutes: no timers, no input, no trace writes — the TUI froze mid-task and would not recover (frozen runs leave truncated traces ending mid-`tool:called`). The walker is now async (`fs.promises.readdir` with dirent types), hard-bounded (24 depth / 25k entries / 3s budget), skips heavyweight dirs (`.cache`, `.cargo`, `.rustup`, `.wine`, `.arduino15`, `target`, `dist`, …), and never follows symlinked directories (loop-proof). Budget exhaustion is surfaced honestly as a `(scan truncated …)` note instead of silent partial results.
- **Fixed reasoning-stream loops not caught by repetition guard.** Reasoning chunks (`agent:reasoning`) streamed independently and bypassed the `streamBuf` phrase/repetition tracker used for message loops. They now feed that tracker directly, so a model looping the same reasoning block triggers `looped = true` and activates the existing failover/nudge mechanism instead of flooding the transcript with thousands of identical lines.
- **Fixed duplicated/stomped tool cards ("deduping" bug).** Two compounding defects: (1) `tool:called` fired from BOTH the agent loop and the tool executor, so every call stacked two pending cards (traces show literal `tree`,`tree` / `glob`,`glob` pairs); (2) in `tool:completed`, the pending-card lookup key was deleted from `activeToolLine` BEFORE being read back — indexed replacement was dead code, so interleaved calls stomped each other's cards with the wrong outcome. Now the TUI collapses a duplicate re-emit of the same call id+args within a burst into its existing card, completions capture the card's *absolute* line id (trim-immune) before cleanup, and loop emissions carry `tool_call_id`.
- **Fixed full-transcript re-wrap churn past the 500-line cap.** Head trims shifted every transcript index while the TUI's incremental wrap cache stayed aligned to old indices, so after each trim the dirty-scan mismatched at index 0 and re-wrapped all 500 lines on the next frame. `TuiState.trimmed` now tracks cumulative head drops; the render cache mirror-splices by the delta, keeping frames O(changed) forever.
- **Finished the TUI render harness** (`src/tui/render-harness.ts`): typed, v2, covering reasoning floods, tool call/complete bursts, and post-cap trim churn — currently 0 events above 100ms.
- **Regression tests**: glob walk bounds (36k-entry tree completes <5s; self-symlink cannot hang), tool-card routing (interleaved completion lands on its own card; ids survive limit trims), collapse rule (same tool family updates in place; unrelated families never swallow each other), duplicate-call guard, trimmed-counter accounting.

## 0.11.0

- **Reliability overhaul: the agent can no longer hang, freeze, or spin on token-draining loops.** A suite of guards makes the loop fail fast instead of stalling:
  - *Cumulative repeated-tool breaker* — a turn that keeps calling the same tool name without producing file edits is cut short instead of rambling across many exploration rounds (a "hello" chat prompt previously ran 12+ rounds burning ~140k tokens / 29s; now the chat-task tool cap stops it immediately).
  - *Mutating-tools-only no-progress breaker* — the repeated-tool abort only fires on mutating tools, never on legit context-gathering reads (`read`/`glob`/`tree`/`search`), so multi-file coding tasks that read several files before editing are never killed mid-flight.
  - *Hard per-response stall guard* — a fully silent provider hold (no chunks, no error) previously froze the agent forever; the gather now races a 3-minute timer and reports a clean `model_error`.
  - *SIGKILL fallback on abort* — when a tool call is aborted a `SIGKILL` is scheduled 5s after `SIGTERM`, so a stubborn child can never hang the loop or freeze the agent.
  - *Subagent timeout fence* — a child's late rejection (post-timeout / post-abort) can no longer crash the process via an unhandled rejection or race into a duplicated `subagent:completed` event.
  - *Event-layer safety* — `emit()` now defensively swallows promise rejections from handlers, so a future async handler can't leak an unhandled rejection.
- **Fast, lean defaults.** Default reasoning was lowered `max → medium` so free/low-tier flash models stop stalling: a chat reply dropped from ~30s / 139k tokens to ~2s / 7k tokens. The stale test that asserted `max` was updated to match; the suite is green at 763/763 (excluding the network-flaky live test).
- **Terminal no longer freezes.** A root-cause fix eliminated the raw-mode/`fake wrapper` freeze bottleneck, and the Enter-to-run path now has unhandled-rejection safety so a provider/command error surfaces as a line and resets busy/spinner instead of leaving the terminal stuck.
- **TUI: Cline-style tool cards.** Every tool call is now rendered as a small framed card with a status icon, the tool name, the key argument(s) (file path + edit delta, `$ command`, search query, subagent role/prompt), and the first useful line of output or error — an entire `READ`/`EDIT`/`SHELL` turn is scannable at a glance, with noise (`exit_code`, `duration_ms`, `{}`) stripped.
- **TUI: post-turn "what I did" summary card.** When a turn finishes, the TUI shows a Cline-style card: `✓ TURN COMPLETE 4523ms · 8 tools` with the first line of the final summary, the files touched (`files: a.ts, b.ts, c.ts (+2 more)`), and tokens used. No-op turns ("the model said hi") get no card; failures render `TURN STOPPED: <reason>`.
- **TUI: coordinated visual language & semantic themes.** Every transcript line now sits on a 2-space grid gutter with a single-character role marker colored to its accent; all themes were refactored and redesigned around semantic role colors with a single source of truth.
- **TUI: drag-select fixes.** Drag-select highlight now works reliably (root cause: a missing `?1002h` private-mode query), works on the splash screen too, and remembers the last column the cursor touched; added a `/copy` keyboard fallback.
- **Removed the DeepWiki MCP server's canned-response mode.** The standalone `deepwiki-server` no longer honors a `MOCHI_TEST_WIKI=mock` env-var shortcut that returned a fabricated summary from shipping code. It now always hits the real Wikipedia REST API + search fallback (verified live), so `wiki_lookup` returns genuine, current content instead of a placeholder.
- **Real shared SSE encoder.** The OpenAI-compatible SSE *encoder* previously lived only in the test harness (hand-rolled framing inside `fake-openai.ts`). New `src/sse-encode.ts` is the real outbound half of `StreamParser` (`encodeSSEChunk`, `encodeSSEDone`, `buildChatCompletion`), and the test server now delegates all wire encoding to it — deleting ~60 hand-rolled protocol lines. Both production and tests emit identical bytes. Verified with 8 round-trip tests that encode through the real `StreamParser`.
- **Consolidated the two divergent Wikipedia lookups.** The in-process `deepwiki` tool and the standalone `wiki_lookup` MCP server each carried their own copy of the summary + search-fallback fetch logic, and they had already drifted (different User-Agents, search tags, error messages). New `src/wiki.ts` is the single source of truth (`wikiSummary(query, lang, opts)`), with both call sites delegating to it and keeping only their genuine differences in `WikiLookupOptions`. Killed 48 lines of duplication; behavior is byte-identical (deepwiki tool tests still green), with a new 10-test `wiki.test.ts` suite and a live MCP smoke test proving real content flows through the shared path.
- **Gated the live network tests behind explicit opt-in.** The `loop.live` and `daemon.live` suites used to run whenever `FREEINFERENCE_API_KEY` was set, so a transient hiccup or slow response from the real provider could waste 3-10 minutes retrying and fail the whole `npm test` run. Both now require `MOCHI_LIVE=1` (in addition to the key) to execute, so the default unit run is deterministic and never touches the network, while the opt-in path remains for live verification. Full suite is now green: **855 passed, 4 skipped, 0 failures, exit 0**.
- **Fixed the TUI freeze under heavy reasoning workflows.** Streaming `agent:reasoning`/thinking tokens were appended unboundedly into one `thought` line — unlike assistant text, which already rolled over at a 16k cap. Because every render re-wraps the actively-streaming line, per-frame cost grew with the line's size each frame (quadratic): a 1MB thinking line took ~46ms per re-wrap, a hard freeze during long reasoning. Reasoning now shares the same `STREAM_LINE_CAP` (16k) rollover as assistant text, so re-wrap cost stays flat (~1ms/frame) no matter how much thinking streams; content still flows continuously across the rolled lines.
- **The npm package now actually ships its runtime.** There was no `files` whitelist, and because `dist/` and `native/bin/` are gitignored, an npm publish shipped raw `src/*.ts` + tests but *not* the compiled output — so `bin`/`main`/`exports`/`types` pointed at files that weren't in the tarball, making `@mochi/agent` uninstallable as a working package. A `files` whitelist (`dist`, `native/bin`, `README.md`) fixes it; verified by packing, installing into a clean dir, running the `mochi` bin (0.11.0) and importing the real API. Raw source/tests no longer leak (693 files instead of 1243).
- **Toolchain & CI are now consistent.** The CI matrix tested unsupported Node 20 against an `engines.node >= 22`; it now tests only Node 22, with a new `.nvmrc` and `engine-strict` so installing on a wrong major fails loudly. CI also gained a guard that packs the tarball and fails if `dist`/`native/bin` are missing or raw source/tests leak in.

## 0.10.7

- **Interactive `/reasoning` Command & Live TUI Display.** Added `/reasoning` (and `/depth`)
  command to the interactive TUI with an interactive menu selector allowing
  instant adjustment between `low`, `medium`, `high`, and `max` reasoning compute.
  The active reasoning level is now displayed live in the TUI status bar right next
  to the model name (`[REASON: HIGH]`). Also added `mochi reasoning [level]` and
  `--reasoning <level>` CLI flags.
- **Full Reasoning Compute & Thinking Support.** Reasoning levels map to real
  model compute parameters:
  - `low`: Fast, agile execution with minimal overhead.
  - `medium`: Balanced reasoning with careful validation.
  - `high`: Deep cognitive analysis, edge-case checks, AST blast radius checking.
  - `max`: Maximum reasoning compute, exhaustive multi-angle decomposition,
    Chameleon MoE synthetic reasoning, and comprehensive verification.
  - Wired provider-level parameters: `reasoning_effort` for OpenAI/OpenCode/DeepSeek,
    adaptive `thinking` token budgets for Anthropic Claude, and Gemini thinkingConfig.
- **Multi-turn Context Memory & Cross-Session Recall.** Solved conversation amnesia across
  turns by preserving ongoing active sessions and loading previous conversational
  turns (user questions & assistant answers) directly into the agent's context.
  Added the new `session_recall` core tool allowing Mochi to search, list, and
  inspect transcripts and architectural decisions from past sessions via SQLite FTS5.
- **Futuristic Startup Animation & Professional UI Design.** Replaced emojis with
  crisp, high-end developer status pills and glyphs (`[STOP]`, `[REASON]`, `[SAFE]`, `[YOLO]`).
  Upgraded startup sequence with a futuristic segmented gradient power bar `⟦ ━━━◈─── ⟧`,
  animated braille scanner beam, and telemetry diagnostic boot phases.
- **Conscious & Empowered Agent Intelligence.** Upgraded the agent system prompt
  and output directives: the model understands its full arsenal of autonomous
  capabilities (AST analysis, blast radius, code modification, execution, skills,
  session recall, deep memory, subagents) and communicates with high technical fidelity.

## 0.10.6

- **Rust runtime core.** Pure compute now lives in a zero-dependency Rust crate
  (`native/mochi_core`): tokenizer, budget math, context compaction planning,
  and agent-loop decision logic, exposed both as a N-API module and a stdio
  JSON-line protocol (`mochi-agent plan`). The TypeScript frontend keeps model
  I/O, the TUI, and tool execution. Every native path has a parity-tested TS
  fallback (null-return contract), so the harness runs identically on machines
  without a Rust toolchain (CI, cold installs).
- **Native tokenizer + compaction planner wired in.** `approxTokens()` prefers
  `countTokens` from the native module; `ContextEngine.compact()`/
  `previewCompact()` compute their valid cut points via the native planner
  (never orphaning a tool result), falling back to the inlined TS walk.
- **Team roster expanded.** Specialist roles (devops, db_admin, frontend,
  backend, performance, tech_writer, qa_engineer, data_scientist) join the
  roster; tester/debugger now carry edit tools to write tests and
  instrumentation. Review-only roles (lead, reviewer, researcher, security,
  architect) remain shell-free.
- **Light mode.** `MOCHI_LIGHT=1` (or `MOCHI_NO_EMBED=1` / `MOCHI_NO_INDEX=1`)
  disables the embedded SQLite symbol index for ultra-lightweight execution;
  the codegraph degrades to "no symbol index" instead of throwing.
- **Iteration lifecycle traces (harness-v2 Phase 1).** New
  `src/agent/loop-state.ts`: a `LoopStateMachine` walks every loop turn
  through `preflight → model-call → stream-guard → tool-exec → verify →
  finish` and emits exactly one typed `agent:iteration` event per turn
  (`IterationTrace`: iteration, stopReason, toolCalls, streamBytes,
  durationMs, end phase). Abort/timeout/budget exits from any phase are
  captured with their stop reason; illegal transitions are recorded for
  diagnostics, never thrown. Eight new tests cover the transition contract
  and a live end-to-end trace run.
- **Lazy codegraph (harness-v2 perf).** Importing the codegraph no longer
  loads web-tree-sitter + all ten language grammars (~110MB RSS) or the
  TypeScript compiler (~75MB RSS) at module scope. The parser core and each
  grammar now load on first use, and only for languages actually present in
  the repo; the tsc fallback compiler loads only if that backend runs.
  Measured: full runtime import chain ~62MB RSS (was ~130MB+), startup 52ms
  → 47ms. `MOCHI_LIGHT` / `MOCHI_NO_EMBED` / `MOCHI_NO_INDEX` now skip the
  WASM parser entirely (true zero-parser light mode). Read paths
  (`get_function`, `find_callers`, `type_hierarchy`, `blast_radius`,
  `sql_codebase_query`) are async and self-warming; a sync
  `querySymbolGraphSync` serves hot prompt-build paths, primed once per task
  by the agent preflight via `primeScaffold` (cached Chameleon scaffold).
- **Memory regression gate.** New `npm run bench:memory`
  (`bench/memory.mjs`) measures fresh-process RSS for the codegraph import
  and the full runtime chain against ceilings (80MB / 95MB) and fails above
  them; wired into CI after build so eager heavy imports can never silently
  return. Measured today: 46MB / 61MB (eager era was ~158MB on import).
- **Lean installs.** All tree-sitter grammar packages are now
  `optionalDependencies`: `npm i @mochi/agent --omit=optional` skips ~250MB
  of grammars on disk; missing grammars degrade gracefully to the tsc
  backend. Default installs are unchanged.
- **Parallel verification.** `verify()` now runs the independent repo checks
  (test / typecheck / lint / build) concurrently instead of serially, so
  per-iteration verification wall-clock is the slowest check rather than
  their sum. Failure reporting keeps deterministic declared-order semantics.
- **Diff-hygiene gate (better shipped code).** After verification passes on a
  file-changing task, a bounded pass scans the diff (tracked + untracked
  files) for debug debris the model added — `console.log`/`debugger`,
  TODO/FIXME/HACK markers, `@ts-ignore`/`eslint-disable`/`noqa`
  suppressions, and focused `.only()` tests. Findings trigger ONE cleanup
  nudge before completion, so Mochi ships clean code instead of leaving a
  human cleanup pass. Test files and non-code files are exempt; the scan
  never blocks finishing on git/shell failures. New
    `src/core/diff-hygiene.ts` (pure scanner) + `src/agent/hygiene.test.ts`
  (end-to-end: junky write → nudge → clean write → complete).
- **TUI freeze fix (regression).** The harness-v2 preflight `await
  primeScaffold(...)` scanned the working tree synchronously *before* the first
  model call, so running Mochi inside a large directory (e.g. from `$HOME`)
  pegged the event loop and froze the UI mid-"sending". Warming is now
  fire-and-forget (never gates the first call) with a cheap detected-language
  hint instead of a full tree scan, and `primeScaffold` refuses to warm over
  `$HOME`. Reproduced the exact freeze scenario (cwd = `$HOME`, prompt "how
  much ram does mochi use") and confirmed it now completes in ~2.3s instead
  of locking up.
- **Dogfood fixes (mochi-dogfood3 battery vs jcode, same model).**
  `node --test` scripts recognized as real runners; verification debt-masking
  is disabled when the task demands green checks ("make npm test pass").
- **Dogfood battery results.** Same `deepseek-v4-flash` via freeinference,
  apples-to-apples vs jcode: mochi 10.6s / 5.6s / 7.1s vs jcode 8.6s / 5.4s /
  17.0s across T1 (CSV greenfield) / T2 (Python bugfix) / T3 (Go feature) —
  mochi 2.4× faster on the Go task; all outputs green and hygiene-clean.
  Next lever: system prompt is ~5.1k tokens re-sent every turn — trimming
  it (with this battery as the A/B gate) targets jcode-class token
  efficiency.

## 0.10.5

- **Terminal copy / paste / highlight.** Mouse click-drag now selects
  transcript text (SGR mouse events); releasing copies the selection to the OS
  clipboard via OSC-52 with xclip/wl-copy/xsel/pbcopy fallbacks, and native
  Shift+drag still works for host selection. The selected range is highlighted
  in reverse-video and cleared on the next keypress.
- **No more accidental GUI launches.** The `shell` tool now refuses to spawn
  desktop GUI apps (`gnome-calculator`, `kcalc`, browsers, terminals, editors),
  and the system prompt tells the agent that BUILD/IMPLEMENT/CODE requests are
  delivered as source files verified headlessly. Fixes "make a calculator"
  repeatedly opening a calculator window.
- **Non-interactive runs exit cleanly.** `mochi --print "..."` (and piped
  invocations) now call `process.exit(0)` once output has flushed, instead of
  hanging after the work is done because the event bus / recorder / model
  keep-alive leaves a live handle.
- **Bounded stream spam.** When a model (often a low/free-tier one) repeats
  the same boilerplate block dozens of times in a single streamed response,
  mochi now aborts the stream, tells the model to stop repeating, and fails
  cleanly after a couple of attempts instead of flooding the transcript with
  hundreds of identical lines and looping forever.
- **Full scroll to top.** PgUp/PgDn scroll a full visible page and Home/End
  (`\x1b[1~`/`\x1b[4~`) jump straight to the absolute top or bottom of the
  transcript.
- **Bracketed paste.** Enabled on startup so pasted text is folded into the
  composer even when the terminal splits it across several data chunks.
- **History path + TUI fixes.** `/history`, `mochi doctor`, and the CLI session
  store now resolve paths via `findProjectRoot(cwd)` so GoalEngine sessions are
  recorded where they are written; self-review no longer re-loops/re-streams on
  terse non-issue verdicts; identical no-tool answers no longer re-stream and
  spam the transcript; `find_references`/`find_definitions` work without
  ripgrep; and the GoalEngine brief is recorded as a system message instead of
  a user turn.
- **New TUI `/help` tips** document the terminal shortcuts above.

## 0.10.4

- **ACP editor adapter.** `mochi acp` speaks the Agent Client Protocol v1 over
  JSON-RPC stdio, so editors (VS Code, Zed, JetBrains) can drive the full
  harness: `initialize`, `session/new`, `session/resume`, `session/prompt`,
  `session/close`, `shutdown`. Supports all ACP v1 methods:
  - Full `agentCapabilities`: `loadSession`, `sessionCapabilities` (list,
    delete, additionalDirectories, resume, close), `promptCapabilities`,
    `mcpCapabilities`, `authMethods`
  - Streaming `session/update` notifications: `tool_call`, `tool_call_update`,
    `agent_message_chunk`, `usage_update`, `plan`
  - Per-session abort support for clean cancellation via `session/cancel`
  - `session/load` with `goalId` to resume persisted goals
  - `session/list` pagination with cursor and `additionalDirectories`
  - `session/set_mode` / `session/set_config_option`
  - `session/request_permission` for MCP
  - `authenticate` / `logout` for built-in agent auth
- **New Tools:** `search_replace_multi` (multi-file regex replace with preview),
  `analyze_code` (code complexity metrics), `verify` (run tests/builds with auto-detect),
  `perf` (performance diagnostics and monitoring)
- **Config Validation.** `validateConfig()` validates config values at startup,
  catching misconfigurations (invalid safety mode, bad numbers, MCP server shape)
  before they cause mid-run failures. A missing API key is intentionally NOT a
  structural error — it surfaces at the model call layer, so a Runtime can be
  built for inspection/tests without keys and no provider key is required in CI.
- **TUI mode overlay.** The status bar now shows the active execution mode
  (`[SPEC]`, `[SECURITY]`, `[CODEMOD]`, `[CHAOS]`) so users can see at a glance
  which harness behavior is active.
- **TUI transcript scrolling.** The scroll wheel now scrolls the chat (mouse
  reporting enabled); PageUp/PageDown scroll too. Scrolling up holds the view
  instead of live events yanking it back to the bottom. `git diff` stats in the
  status bar are throttled so heavy tool work no longer stutters or freezes the
  UI loop.
- **TUI freeze fix.** The transcript render is now incremental: each frame only
  re-wraps the lines that actually changed (the appended tail and the streaming
  last line) instead of rebuilding the whole transcript O(n) per streamed token.
  Combined with coalescing renders via a macrotask (instead of draining
  microtasks synchronously), the spinner and UI stay responsive while the agent
  explores code and runs tools. Render frames are guarded with a try/catch so a
  single bad frame logs and recovers instead of permanently freezing the UI.
- **TUI line-wrap speed.** `wrap` no longer re-strips ANSI codes over the whole
  growing line for every word (that was O(line²) and froze while a long response
  streamed in); it now tracks visible width incrementally in O(n). Render frames
  that do throw print their stack and PAUSE rendering (instead of auto-retrying
  a throwing frame in a loop), and any real key re-arms rendering so a transient
  error can never leave the screen frozen.
- **`mochi daemon restart`.** Stop + start a fresh daemon on the same
  port/token. Cron jobs, sessions, and goal state persist across restarts
  (`.mochi/cron.json` plus the SQLite session store).
- **Cron result delivery.** Jobs accept `--notify <url|cmd>`: webhooks get a
  POST of `{job,prompt,summary,ts}` and shell commands receive the summary as
  `MOCHI_JOB_SUMMARY` + stdin after each scheduled run.
- **`mochi doctor`.** Health self-inspection across subsystems: model/key,
  node:sqlite, codegraph index, FTS5 sessions, daemon status, and toolchain
  detection, with an actionable problems list.

## 0.10.3

- **Credential pool + rotation.** A single `$PROVIDER_API_KEY` was a single point
  of failure for long agent runs. New `src/model/credential-pool.ts` pools
  multiple keys per provider (env comma/newline lists, `~/.config/mochi/credentials/<provider>.json`,
  or config) and rotates transparently on 401/403/429 via `nextKey` /
  `retireKey` with per-key cooldowns. `createOpenAIProvider` now calls
  `onRetryable` before each retry to swap to a fresh pool key, and
  `withRetries` gained the `onRetryable` hook. Keys are redacted in
  `inspectPool`/`describeConfig`; nothing secret is ever logged.
- **Scheduled agent jobs.** `mochi daemon cron add|list|remove` (and the
  `/api/cron` endpoint) run a prompt on an interval (`"every 30m"`) or 5-field
  cron (`"0 9 * * 1-5"`), persisted to `.mochi/cron.json`. The daemon ticker
  (in-process and detached) runs due jobs serially through the goal engine.
- **Session history (Hermes-style).** SQLite + FTS5 transcript store
  (`src/session-store.ts`) records every task conversation; `mochi session
  search "<text>"` and `mochi session list` inspect past work. Resuming a goal
  injects the real prior transcript so work isn't redone.
- **Background tasks.** `shell` accepts `background:true`; long tests/builds
  return a task id immediately and the loop injects the result when it
  finishes (`bg list` / `bg status <id>`).
- **Instant per-file diagnostics.** After write/edit/patch the edited file is
  type-checked same-turn (TS LanguageService cached ~32ms warm, Python via
  py_compile, `npx tsc` fallback) with FIX-BEFORE-CONTINUING guidance.
- **`replace_symbol` tool.** Name-addressed whole-symbol replacement through
  the code symbol index (no whitespace matching).
- **Prompt-stability tiers.** Task-dependent memory/kind hint moved out of the
  system prompt into the per-turn state tier for provider prefix caching.
- **Cron persistence fix.** The daemon ticker now saves `bumpJob`'s advance
  (`updateJob`) so a due job fires once per interval instead of re-firing on
  every 10s poll. Covered by a new daemon integration test (`/api/cron` add ->
  tick fires -> `nextRun` advances).
- **State cleanup.** Stale failed goal `3f5cb725` (a dogfood fixture whose
  `broken.ts` never existed) and its trace were removed; the spurious
  `completedTasks` entry and the matching `failures.md` block were cleared.

## 0.10.2

- **Proportionate verification.** Content-only tasks (e.g. "write OK to a file")
  no longer trigger the repo's full `npm test` / `tsc` / lint / build suite and
  get charged for pre-existing failures in untouched code. Verification is now
  scoped by task: relevant test subset for behavior changes, the task's direct
  check for content deliverables, and none for research. `autoTestCommand`,
  `Agent.verify`, and the `VerifierEngine` all gate repo-wide suites behind the
  content-only classifier; in-loop repo-wide runners on content-only tasks are
  vetoed with guidance.
- **Baseline-aware verification.** `Agent.verify` captures the repo's green
  baseline once (`baseline.json`) and no longer fails correct work for
  pre-existing red — a task is only blocked when it *transitions* the suite.
- **Diagnostics fallback.** When the edited project has no importable TypeScript
  API, `src/diagnostics.ts` falls back to `npx tsc` (bounded by timeout) so
  in-file diagnostics still work in repos that only have `tsc` via npx.
- **Tool: `replace_symbol`.** Add a name-addressed whole-symbol replacement tool
  with signature/type matching, used by the codegen loop.
- **Daemon `resume` test hardening.** The hermetic `/api/resume` test
  (`src/daemon.test.ts`) is now fully self-contained per test (dedicated
  workspace + daemon, no module-level shared `handle`/`dir`), so it passes in
  isolation and in group runs.
- **Instant per-file diagnostics.** After every write/edit/patch, the edited
  file is type/syntax-checked in the same turn (TS LanguageService with a
  cached host: 32ms warm; Python via py_compile) and errors are appended to the
  tool result with a FIX-BEFORE-CONTINUING instruction.
- **Background tasks.** `shell` takes `background: true`; long suites/builds
  return a task id immediately and the loop injects results when they finish
  (`bg list` / `bg status <id>`).
- **Prompt-stability tiers.** Task-dependent memory/kind-hint moved out of the
  system prompt into the per-turn state tier for provider prefix-cache hits.
- **Session history.** SQLite + FTS5 transcript store (`src/session-store.ts`)
  persists every task conversation; `mochi session search "<text>"` and
  `mochi session list` inspect past work. Hermes-style searchable memory.
- **Warm-start resume.** Resumed goals surface prior failed attempts as
  `PRIOR SESSION CONTEXT` ("do not repeat").
- Verified green end to end: content-only write completes in ~6s (was ~5min /
  47k tokens / failed). 384 tests / 71 files pass, typecheck clean.

## 0.10.1

- **Code-scan cleanup.** 10 real findings addressed (ReDoS in
  `sanitizeVerifyCommand` and `providerKey`, clear-text key logging in
  `describeConfig`, a template-literal regex bug where `[\s\S]` collapsed to
  `[sS]`, prototype pollution in config merge, lenient script/style end-tag
  matching, glob metachar escaping, and a missing `permissions` block in CI).
  CodeQL default setup is enabled for JS/TS; 79 stale alerts from the
  pre-rewrite Go codebase were dismissed.
- **Hermetic daemon test.** The resume test no longer calls a real provider in
  CI (it built tasks directly), eliminating a 429 rate-limit flake.
- **Docs.** README hero refreshed to match the current product (goals/DAG/teams,
  daemon, traces, zero deps, polyglot harness).

## 0.10.0

- **Daemon `resume` over CLI.** `mochi daemon resume <goalId>` is now wired
  (`/api/resume` was API-only), so interrupted or failed goals can be
  restarted from a headless box without the interactive flow.
- **Daemon remote access.** `mochi daemon start --host 0.0.0.0` binds the
  HTTP surface off loopback for LAN/phone/dashboard access (default stays
  `127.0.0.1`); the README documents local, LAN, and tunnel paths and the
  bearer-token surface any gateway (phone app, Discord bot, dashboard) can
  drive.
- **Daemon live round-trip test.** `src/daemon.live.test.ts` (skipped
  without `FREEINFERENCE_API_KEY`) sends a real goal through a daemon
  instance with the real provider, verifies the artifact on disk, simulates
  shutdown, and resumes the persisted goal through a fresh instance's
  `/api/resume` end to end.
- **Docs.** README now covers the daemon surface, `/api/resume`
  restart-survival semantics, run traces (`mochi trace [<goalId>]`), and
  refreshed cold-start/memory numbers (node ~84ms/~47MB, bun ~78ms/~42MB).

## 0.9.6

- **Mid-stream cancellation.** Ctrl-C now actually cancels the model request
  on the wire: `fetch` accepts an AbortSignal threaded from the loop, so an
  interrupted run stops the HTTP response instead of waiting for it to
  finish. Tested with a hanging SSE connection: aborting ends the stream
  immediately.
- **Daemon /api/resume.** Failed, active, or pending goals can be resumed
  over HTTP (`runtime.resumeGoal(goalId)` + `/api/resume {goalId}`), with
  the run trace continuing per goal. The daemon can now fully
  restart/retry dead work without a terminal.
- **Real team mode.** `mochi team` now decomposes the goal, assigns
  specialist roles per task (tester/reviewer/researcher/security/
  architect/debugger via title+description hints, with the final task
  forced to reviewer for convergence), and runs them through the
  scheduler concurrently. Verified with a real model: "2 done, 0 failed".
- **Tested TUI event pipeline.** The transcript/task-tree reducer is
  extracted into the pure `src/tui/state.ts` and unit-tested (transcript
  assembly, task lifecycle, stop reasons, truncation, cap). The TUI's
  `onRuntimeEvent` now delegates to it, so it surfaces `stopReason` and
  the same behavior the tests assert.
- **Structured stop reasons.** `AgentResult` now carries a `stopReason`
  (`completed`, `aborted`, `runtime_limit`, `budget`, `pulse_abort`,
  `max_iterations`, `model_error`, `tool_loop`, `verification_failed`),
  mirroring modern agent SDKs (LangChain/LangGraph). Every finish path in
  the loop declares why the run ended, and the reason rides the
  `task:completed`/`task:failed` events.
- **Run traces.** New `src/trace.ts` records a durable, deep-redacted
  JSONL trace of every agent run to `<workspace>/.mochi/traces/
  <goalId>.jsonl` — tool calls with args, results, errors, agent logs,
  and a goal summary — the observability layer harnesses ship by default.
  `mochi trace [<goalId>]` replays the newest (or a named) run as a
  readable transcript; `mochi trace` with no id lists the latest trace.
  Secrets inside nested tool args are redacted before they ever touch
  disk.
- **Clean interrupt handling.** Ctrl-C / SIGTERM now aborts the active goal
  cleanly instead of SIGKILLing the process and orphaning subagents: Runtime
  owns an AbortController, GoalEngine.runGoal accepts an external signal, and
  the CLI registers a one-shot interrupt handler (second interrupt force-
  exits). The agent loop stops at its next checkpoint and finishes the task
  as aborted.
- **Self-review pass.** After verification passes, the agent spends one cheap
  model call reviewing the working git diff for test-blind correctness
  problems (accidental deletions, dead code, wrong constants, TODO/debug
  leftovers, out-of-scope edits). A real issue feeds back into the loop so it
  is fixed and re-verified (bounded to two review rounds); a clean review
  confirms done. Skipped for pure answer/research tasks and plan mode.

## 0.9.5

- **From Horus (xanstomper/Horus).** New `src/security.ts` ports and
  extends the Horus security package:
  - `redact`/`redactObject` scrub API keys, JWTs, bearer tokens, private
    keys, GitHub/AWS/Slack/GitLab tokens, plus Google/Gemini/OpenAI/
    Anthropic keys. Wired into every persistent write: autopsies,
    procedural lessons, and usage records, so raw model output can never
    leak a key to disk.
  - `classifyCommand` ranks shell commands `low`/`network`/`destructive`;
    the shell tool now blocks destructive commands in `safe` mode and
    logs their risk class in auto mode.
  - `ApprovalQueue` for tool-approval flows.
- **From OpenFable (xanstomper/OpenFable).** The codegraph fingerprint
  is now content-addressed (SHA-1 of file bytes) instead of mtime+size,
  so edits that preserve mtime/size (or land on a coarse-timestamp
  filesystem) can never leave a stale symbol index. Huge files keep the
  cheap mtime fast path.
- **More from OpenFable (shared util).** New `src/util.ts` ports:
  - `randomSlug` (Slug): `mochi workspace create` without a name now
    gets a readable random name like `clever-comet` instead of colliding
    on "default".
  - `sortableId` (Identifier): attempts in the autopsy now use
    lexicographically ascending IDs, so they sort by when they happened.
  - `binarySearch`/`binaryInsert` for keep-sorted lists.
  - `lazy` memoizing singleton.
  - `getFilename`/`getDirectory`/`getFilenameTruncated`/`truncateMiddle`
    (path utils): verification failures and the daemon job list now show
    head and tail of long output instead of a blind head-only slice.
- **Call graph.** The symbol index now records `calls` edges (callee,
  caller, file, line) across all 10 indexed languages, extracted at index
  time from every grammar's call nodes. `find_callers` answers from the
  graph first — attributing each call site to its enclosing function
  symbol — then falls back to the line scan only for symbols the grammar
  didn't index. Cross-file callers are now exact in TS and Python (and
  every other indexed language).
- **Daemon streaming, jobs, resume, usage, auth.** `/api/goal` accepts
  SSE (`Accept: text/event-stream`) and streams `task:*`/`log` progress
  before the final result; `/api/jobs` lists workspace goals; `/api/plan`
  + `/api/approve` give the phone/dashboard plan-then-act flow; `/api/
  status` reports usage totals (calls, tokens, cost, duration). Auth is
  now a constant-time bearer-token compare. CLI: `daemon start --token`,
  `daemon jobs`, `daemon approve`.

## 0.9.4

- **Persistent agent daemon.** `mochi daemon start|status|send|stop` runs
  a Runtime over localhost HTTP so a phone, dashboard, or script can hand
  Mochi goals without a TTY. Binds to 127.0.0.1 only; every request needs
  a per-workspace bearer token written to `~/.mochi/daemon/info.json`
  (0600) along with the live port and pid. Endpoints: `/api/status`,
  `/api/inspect`, `/api/plan`, `/api/goal`. Verified end to end with a
  real model: `daemon send` created `answer.ts` correctly. In-process and
  detached-spawn paths are both tested.

## 0.9.3

- **Live integration tests against real freeinference.**

- **Polyglot code indexing.** The codegraph previously understood only
  JavaScript/TypeScript files, so pointing Mochi at a Python, Rust, Go,
  Java, or C++ repo produced an empty symbol index. The tree-sitter WASM
  backend (in-process, no full compiler, same engine across languages) is
  now the DEFAULT and indexes all seven languages (TS/JS, Python, Rust,
  Go, Java, C/C++); the TypeScript-compiler AST remains as an opt-in
  fallback (`MOCHI_CPG_BACKEND=tsc`). Benchmark: cold index of 200 files
  comes in at ~100ms on either backend, so this is a coverage win, not a
  measured speedup.
- **Polyglot test-runner auto-detection.** `autoTestCommand` now emits
  `go test ./...` and `cargo test` for Go/Rust file scopes (plus the
  existing vitest/jest/pytest), and `isWeakVerification` no longer treats
  real Go/Rust/Python runners as weak.
- **Plan-mode enforcement.** A plan-mode reply that is only a preamble
  ("I'll research the codebase first") is no longer accepted as the
  finished deliverable. The loop nudges the model up to 3 times to emit an
  actual plan (numbered steps, bullets, or structured plan language) and
  fails with a clear reason if it never does.
- **Language-aware model guidance.** When the repo is not JS/TS, the
  preflight system message now tells the model the right tooling directly
  ("this is a Python repo; use `python -m pytest -q`"), so it stops
  emitting `npm test` against Rust or Go projects. Real Go/Rust/Python
  repos get `go test` / `cargo test` / pytest guidance before the loop
  even runs.
- **Python typecheck fix.** Repos were assumed to need `mypy` for every
  pyproject.toml; verification would fail with `mypy: not found` in repos
  that don't configure it. Only repos with an actual mypy config
  (mypy.ini / setup.cfg / `[tool.mypy]`) get a typecheck command.
- **Fake-openai multi-call fix.** The scripted test server emitted every
  tool_call chunk without an `index`, so the stream parser merged all
  tool calls in one response into a single mangled call. Each call now
  carries a distinct `index`, matching the real provider wire format.
- **Python E2E test.** The full loop now verifies against a REAL `pytest`
  subprocess for a Python repo (repo detection → polyglot test detect →
  subprocess verify), proving the polyglot path works end to end.
- **Go and Rust E2E tests.** Same real-subprocess proof for `go test
  ./...` and `cargo test`: the loop fixes a fibonacci bug in each
  language and verification passes against the actual toolchain, not a
  scripted response.
- **Language-aware failure probes.** The diagnosis engine probed every
  changed file with `node --check` + `npx tsc` regardless of language,
  so a Rust/Go/Python fix that passed its real toolchain was endlessly
  re-diagnosed as a "syntax error". Syntax and type hypotheses now use
  the native checker per language (`cargo check`, `go vet`, py_compile,
  javac, gcc -fsyntax-only) and skip the probe entirely for unknown
  extensions. Real-model dogfood: the same Rust fix that previously
  failed now completes in ~2s.
- **Polyglot index walker skips build/cache dirs.** The codegraph
  walker only ignored JS dirs (node_modules, dist, .next), so indexing
  a Python repo walked `.venv`/`__pycache__`, Go walked `vendor/`, and
  Rust walked `target/` — slow and able to shadow real symbols with junk
  rows. Layer caches and toolchain outputs are now skipped for every
  language.
- **Polyglot mutation verification.** `runMutationCheck` only targeted
  `.ts/.tsx/.js` files and flip a JS-only operator set, so in a
  Python/Rust/Go repo the adversarial weak-coverage signal silently
  never fired. Source extensions now cover Python/Rust/Go/Java/Ruby/PHP/
  C/C++; flips include Python's `==`/`!=` and ` and `/` or `; and the
  test-file detector recognizes pytest/Go/Rust/JUnit naming so test
  files are never mutated.
- **Language registry (15+ languages).** `detectRepo` is now data-driven
  with a per-language table: markers, build/test/lint/typecheck
  commands, package managers, and entrypoints for TS/JS, Python, Go,
  Rust, Java, C/C++, C#, Zig, Ruby, PHP, Swift, Kotlin, Elixir,
  Haskell, Scala, Dart, Lua. The loop's verify() uses the registry's
  commands, and optional checks run only when the tool is actually
  installed.
- **Native accelerators (Rust + C++).** Mochi now ships real native
  code: a dependency-free fuzzy line matcher in both `native/rust/fuzzy.rs`
  and `native/cpp/fuzzy.cpp`, built by `npm run build:native`, used by
  the edit tool's hot path with a transparent fallback to the
  TypeScript matcher. Both binaries are parity-tested against TS.
- **Verification fixes from the Zig dogfood.** Models persisting
  `cd <project_root> && cargo test` had it run verbatim through sh -c,
  where `<project_root>` is redirect syntax that fails every check.
  Sanitize now strips the placeholder, and `cwdForScope` only scopes
  into a subdirectory that carries its own project marker (a Rust/Zig
  file in src/ resolves to the repo root). Real-model dogfood: a broken
  fib in a Zig repo now fixes end to end ("Goal completed. 1 done, 0
  failed").
- **Code index now 10 languages.** The tree-sitter symbol index adds
  Ruby, PHP, and C# (grammars ship WASM); the Dart and Elixir npm
  grammars don't load under the pinned tree-sitter WASM ABI, so their
  symbol index falls back to "no definition" but registry/verify
  support remains. `get_function`/`find_callers`/`type_hierarchy` now
  answer for Ruby classes/methods, PHP functions/classes, and C#
  classes/methods in the same repo.
- **Diagnosis probes cover the new languages.** Syntax/type probes now
  use `ruby -c`, `php -l`, `dotnet build`, `dart analyze`, `zig build`,
  and `mix compile` so a retry loop on those repos probes with the
  real toolchain instead of silently falling through to a read-only
  hypothesis.
- **Mutation skips test files in every language.** `isTestFile` now
  recognizes RSpec (`foo_spec.rb`), JUnit/PHPUnit (`FooTest.java`,
  `BarTest.php`), and C# (`FooTests.cs`) naming in addition to the
  existing JS/TS/Python/Go/Rust conventions, so a mutation never
  corrupts a test file in a polyglot repo.
- **Planning layer speaks polyglot too.** The decomposer's verification
  guidance and the test-kind focus hint now list the real runner per
  language (go test, cargo test, dotnet test, rspec, zig build test,
  phpunit, mvn/gradlew) instead of only `npx vitest/npm test`, so a
  model planning a Go or C# task picks the right command up front.

## 0.9.2

- **Live integration tests against real freeinference.** New
  `src/agent/loop.live.test.ts` exercises the real model on a real file
  system end-to-end (decompose -> plan -> run -> verify). Three tests:
  writes a requested file, writes a working vitest test, decomposes a
  multi-step goal. Auto-skipped when `FREEINFERENCE_API_KEY` is missing so
  CI stays offline. Run explicitly with
  `FREEINFERENCE_API_KEY=... npx vitest run src/agent/loop.live.test.ts`.
  These complement (not replace) the scripted fake-openai unit tests: the
  fake tests cover harness behavior deterministically, the live tests
  cover what the model actually does with a real prompt.

## 0.9.1

Three more dogfood-found regressions where the verifier was being too
aggressive about a subdirectory-scoped task:

- **Scope-aware verification cwd.** `testdetect.cwdForScope` resolves the
  directory the verification command should run from (the fileScope's parent
  when it's consistent). `withCwd` prefixes `cd <dir> && ...` to commands
  that don't already start with a `cd`. Fixes a class of "Unknown option
  `--prefix`" failures (vitest doesn't take `--prefix`; that's an npm
  flag) and "command not found" errors when the runner lives under the
  task's package.json but not the project root.
- **Skip repo-level commands under a scope.** When a task has a
  fileScope, repo-level checks (testCommand/typecheckCommand/lintCommand/
  buildCommand) no longer run. They describe the PROJECT ROOT and would
  fail on `Missing script: "build"` for the wrong reason. The
  auto-detected runner + the explicit verificationCommand cover the
  task's own verification.
- **Diff evidence is filtered to the fileScope.** `verification.safeGitDiff`
  walks the diff block-by-block and drops out-of-scope files entirely.
  Previously, the model judge received a diff that included harness work
  the user did concurrently and complained "the diff shows changes to
  src/agent/loop.ts, not the requested file" even when the agent's work
  was correct. New test locks this in.
- **Task-kind-aware system prompts.** `src/taskkind.ts` classifies a
  task into implement/fix/refactor/test/research/plan/document via
  title/description/role heuristics, and the system prompt appends a
  focused hint per kind. Debug tasks get "reproduce first, then
  localize"; research tasks get "read-only, do not modify"; etc.
- **Decomposer prompt now requires a real test runner.** When the task
  is implement (not plan mode), the JSON-shape hint forbids string/file
  checks (`test -f`, `grep`) and demands `npx vitest run`, `npx jest`,
  `pytest -q`, or `npm test`.

Tests: 226 passing (was 207).

## 0.9.0

Observation-driven replanning foundations and a verifier regression found by
dogfooding:

- **Failure diagnosis + autopsy + procedural memory.** New `src/diagnosis.ts`
  classifies verification failures into eight kinds (`syntax`, `type`, `logic`,
  `test_gap`, `env_missing`, `env_runtime`, `concurrency`, `unknown`),
  generates ordered hypotheses, and evaluates probe results so the next
  attempt is a *targeted* fix instead of a vague "Continue and fix". `Autopsy`
  records persist at `<workspace>/autopsies/<taskId>.json` with hypothesis
  history, evidence, and outcome. `Lessons` records persist at
  `<workspace>/memory/lessons.json` and are surfaced as prior context on
  matching failure signatures — Mochi remembers what worked across runs in
  the same workspace. A `recordFailure` path also writes an `AVOID`-style
  lesson on retry exhaustion so the next run starts with prior context.
- **Verifier scoped mutation.** The mutation check now operates only inside
  the task's `fileScope`, so an in-progress edit to the harness itself can
  no longer produce a meaningless "mutation survived" verdict against logic
  the verification command does not exercise. Two new tests lock this in.
- **Auto-detected test runner.** New `src/testdetect.ts` examines the
  task's `fileScope` and appends a real runner command (`npx vitest run`,
  `npx jest`, `pytest -q`) to the verification checks when the explicit
  `verificationCommand` is weak (file-existence or `grep`/`cat`/`ls`).
  Fixes a class of silent downgrades where a model's overly-clever
  verification command "passed" but the mutation check still survived
  because no test was ever executed.

## 0.8.0

Provider resilience and verifier accuracy from dogfooding:

- **Multi-provider failover.** `model.failover` accepts a list of backup
  `ModelConfig`s tried in order when the primary errors before producing any
  output (dead endpoint, auth failure, refused connection). Mid-stream failures
  are never replayed onto a fallback. Every provider in the chain keeps its own
  capability-gate health, and all call sites (agent loop, decompose, verifier
  judge, chameleon, speculative) inherit failover automatically.
- **Missing verification tools no longer fail correct work.** A check whose
  command is not installed (exit 127, e.g. the decomposer guessing
  `tsc --noEmit x.ts` in a repo without tsc) is recorded as skipped evidence
  instead of a failure. Mutation verification only runs against a genuinely
  runnable test command.
- **Diff evidence shows the work.** `safeGitDiff` excludes `.mochi` state,
  `node_modules`, `dist` noise and lists real source files first, so the
  evidence budget is spent on the new `.ts` file the agent wrote. Mutation
  targets likewise exclude dependency and build directories.

## 0.7.0

Pipelines, prompts, and hardening found by dogfooding:

- **CI pipeline.** `.github/workflows/ci.yml`: typecheck + vitest + build +
  CLI smoke on Node 20 and 22. `package-lock.json` was out of sync with
  `package.json` (`npm ci` failed); regenerated. Node 20 compatibility:
  `node:sqlite` (22.5+) users degrade gracefully (`hasSqlite()`), and the
  codegraph tests skip on runtimes without it.
- **Plan mode is actually safe and useful.** Mutating-tool veto switched to a
  read-only allowlist (`patch`, `git`, `subagent`, and arbitrary MCP tools are
  now vetoed, not just write/edit/delete/shell). Plan-mode runs skip end-state
  acceptance verification (a plan intentionally changes nothing), the
  decomposer is told to emit plan-only tasks, and the plan text is surfaced to
  the user instead of a bare "Goal completed".
- **No dangling tool_call_ids.** `before_tool`/`before_edit` hook vetoes and
  tool-budget exhaustion now answer the call with a `Blocked:` tool message;
  previously they silently dropped it, which providers reject with 400s.
- **Mutation check targets real code.** Test files and dot-directories
  (`.mochi/` state) are excluded from mutation targets, and flips inside
  larger tokens (`=>`, `>=`, `<<`) are skipped. Before: a run writing correct
  `greet.ts` + `greet.test.ts` got downgraded to PARTIAL because the checker
  mutated the *test file's* arrow into a syntax error the verification command
  never even imported.
- **MCP prompts.** `listPrompts()` / `getPrompt()` on the client, exposed as
  `<server>__prompts_list` / `<server>__prompts_get` tools (rendered messages
  as text). MCP JSON-RPC requests now time out after 10s so a server that
  silently ignores optional capabilities can't hang the harness.
- **System prompt guidance.** New "use the right tool" section (edit vs patch
  vs write, subagent delegation, todo tracking, plan-mode behavior); builtin
  role prompts enriched (coder gains `patch`/`todo`/`subagent`).
- **patch tool integration.** Fires `before_edit`/`after_edit` hooks like the
  other edit tools, and its per-file results are tracked into state.

## 0.6.1

Mutation verification understands print-style checks:

- **Output-diff mutation detection.** A mutation is now killed when the test
  command's output changes (not just when it exits non-zero). Print-style
  verification commands (`node -e "console.log(add(2,3))"`) exercise the
  mutated logic but always exit 0, so exit-code-only detection wrongly declared
  every such task weakly-covered and downgraded correct work to PARTIAL. The
  verifier captures stdout/stderr before and after the mutation and counts a
  diff as a kill, with the reason surfaced in the evidence note.

## 0.6.0

Six capability milestones, plus the surrounding hardening:

- **Todo planning tool.** Persistent, editable work list in
  `state/todo.json` (deduped by title, ordered, concurrency-safe across
  parallel agents). The model plans and tracks its own checklist mid-run.
- **Provider capability registry.** Live per-provider health tracking:
  `ok` / `cooldown` / `dead` states with probe-driven recovery, mirroring
  jcode's on-demand retry gates. The router skips dead providers fast and
  retries transients with backoff instead of failing the run.
- **Agent Skills.** Full agentskills.io spec: frontmatter parsing, discovery
  from `.mochi/skills/`, prompt injection when a goal matches a skill, and a
  `skill` tool so the model can load one mid-run.
- **MCP support.** Minimal stdio MCP client (JSON-RPC 2.0, initialize
  handshake, tools/list + tools/call) plus `buildMcpTools()`, which wraps each
  remote tool as a native namespaced tool (`serverName__toolName`) with
  `network` permission. Servers are spawned once per run, closed on finish, and
  a server that dies rejects its pending calls instead of hanging the agent.
- **Plan-then-act mode.** `planMode` (config or `--plan`) disables
  `write`/`edit`/`delete`/`shell`, vetoes violation attempts with a proper tool
  response, and steers the model to return a plan (steps, files, risks,
  verification). No files are changed.
- **Subagent delegation.** The `subagent` tool runs a fresh child agent on a
  well-scoped subtask, sharing the run's budget, read cache, and workspace, and
  returns the child's summary. Delegation is depth-guarded to one level so a
  child cannot spawn runaway grandchildren.
- **`agent:log` event + 3 new test files.** 147 tests total; typecheck clean.

## 0.5.5

Internal Chameleon + Termix rework (no external services, no auto-launch):

- **Chameleon is fully internal now.** Drops the external `chameleon` CLI /
  shell-out path entirely. `ChameleonEngine` generates synthetic-parameter
  reasoning context via the agent's OWN configured provider
  (`createProvider(config.model, 'reasoning')`) — so enhance behaves as
  "basically part of the agent." `mochi enhance` and the `--enhance` /
  auto-inject path now report tokens, cost, and strategies used, and gracefully
  no-op if the provider call fails. `chameleon` tool no longer needs network
  permission (it uses the same provider the loop uses).
- **Termix is now a baked-in UI command, not an auto-launcher and not a
  third-party app.** `mochi termix "<task>" [--coms|--sep]` opens N parallel
  agent sessions against the configured provider. `--coms` (default) lets the
  sessions COMMUNICATE over a shared broadcast channel; `--sep` keeps them
  fully isolated. Result line reports steps/tokens/cost per session.
- **Mock provider removed entirely.** `src/model/mock.ts` is gone and
  `createProvider` no longer has a mock branch. Tests that previously drove a
  fake model now spin up an in-process OpenAI-compatible SSE HTTP server
  (`src/testutil/fake-openai.ts`) so the REAL provider/router/fetch/stream-parser
  path is exercised end-to-end. There is no fake model anywhere in the codebase.
- **Chameleon multi-pass**: higher modes now spend real test-time compute, running
  1–3 genuine model passes (flash/easy=1, medium/hard=2, deep/extreme/genius=3)
  that critique and refine a draft before the final synthesis. Enhancement
  respects the run's model-call budget and surfaces strategies, tokens, and cost.
  Adds `src/chameleon.test.ts` covering multi-pass + mode→tier mapping over the
  real provider path.
- **Stronger agent system prompt**: a clear identity plus eight operating
  principles (small reviewable changes, verify everything, move with intent,
  safety, budget-aware, correctness under hard problems, and learning from the
  codebase). Live-verified: Mochi made a minimal surgical fix and ran the test
  to confirm it passed.
- **Leaner defaults for far lower token usage**: the default safety budget shrank
  from a 120k-token/50-iteration context to 32k tokens / 8 iterations, so simple
  tasks finish in a few decisive passes instead of grinding a huge transcript.
- **Deterministic transcript ceiling**: the agent loop's compaction floor is now
  capped at 32k live tokens regardless of the configured context budget, so a
  user's very large budget (e.g. 120k+) can no longer let old turns balloon the
  per-call payload. Long runs roll up into the semantic ledger past the ceiling,
  keeping per-turn token cost bounded and predictable instead of model-luck
  dependent.
- **Per-run file-read cache**: the `read` tool caches file contents keyed by
  (path, mtime, size) for the life of a task, so unchanged files are read from
  disk once instead of once per call. Edits change the signature and trigger a
  re-read.
- **Role-specific tool sets**: each agent role now advertises only the tools it
  needs (coder ~10 tools vs 14; reviewers/researchers read-only), cutting the
  scheduled per-call tool-schema payload (~1,400 → ~1,000+ tokens for coding).
- **Parallel independent writes**: the loop runs `write`/`edit`/`delete` tool
  calls to distinct files concurrently (previously fully serial), so a multi-file
  task pays one round-trip for several files. Same-file writes stay serial for
  safety.
- Verified on a two-file create+test task: **15.9k tokens / $0.0023 / 5s** with
  all tests passing. 61 tests green, typecheck clean.
- **Relevance-scoped memory injection**: project memory is no longer dumped
  verbatim. Only the entries most relevant to the current task are selected
  (lexical token overlap over title/body, `src/relevance.ts`) and injected, so
  a large memory file no longer burns tokens on irrelevant policy in every
  packet. The project overview is always carried. Deterministic, no new
  dependencies, no embedding model required.
- **Structure-aware, deduped, cached search** (agent-grep style): `search` now
  groups matches by file and emits a compact per-file declaration outline (so
  the model can infer a file's layout without a full read), collapses repeated
  identical match lines to one while still reporting the true raw match count,
  caps displayed lines via `limit`, and serves a repeat identical query from a
  mutation-invalidated per-cwd cache (marked `[query cache hit]`) instead of
  re-scanning.
- **One-shot fast path**: a deterministic classifier
  (`src/one-shot.ts`) recognizes high-confidence answer/summarize tasks and
  injects a "resolve in one turn" nudge so the loop doesn't burn tokens on
  needless tool round-trips. Verification still gates every "done" when files
  changed; the classifier never short-circuits tasks that touch code. It now
  also short-circuits at the *decomposition* stage: one-shot goals emit a
  single no-verify answer task instead of asking the model to over-engineer a
  simple question into a file-creation + verify loop. Measured end to end on
  "Say hello in exactly 3 words": the old path failed after a self-imposed
  coding task (10,019 tokens / $0.0014 / 2s); the new path succeeds in one
  direct turn (2,209 tokens / $0.0003 / ~0s) — an ~4.5× token cut, and genuine
  coding tasks still flow through the normal builder/verifier path unchanged.
- **Mutation-invalidated search cache**: the `search` result cache is now keyed
  by a shared process-wide mutation generation that the `write`/`edit`/`delete`
  tools bump on every real file change (`src/tools/fs-signal.ts`). A repeated
  identical query is deduped, but a write/edit/delete invalidates the stale
  entry instantly (O(1), no tree re-walk), so the cache can never serve a result
  that a subsequent edit has already made wrong.
- **Adversarial mutation verification** (`src/mutation.ts`): a clean PASS no
  longer just means "commands exited 0". After the agent's test command passes,
  the verifier injects one real logic bug (a *mutation*) into a changed source
  file and re-runs the test suite. If the mutation is caught the tests are
  sound; if it **survives**, the verifier downgrades a naive PASS to PARTIAL
  with an explicit "Mutation check: injected logic bug was NOT caught" signal so
  the agent hears that its coverage is weak on that path instead of getting a
  false green. Deterministic operator flips, no model in the mutation loop, and
  the file is always restored after the check - the repo is never left mutated.
- 88 tests green (mutation engine + verifier downgrade coverage added),
  typecheck clean, native binary rebuilt.

## 0.5.4

External tool integrations:

- **Lazy Chameleon** (synthetic-parameter reasoner):
  - `mochi enhance "<task>" [--mode <mode>]` shells out to the `chameleon` CLI
    and prints the dense reasoning context it synthesizes (offline by default).
  - New `chameleon` agent tool in the tool bus: the model can generate
    enhancement context before tackling a hard task.
  - Auto-inject: `mochi goal --enhance "<task>"` (and `--mode`) runs
    `chameleon enhance` first and injects the result as a leading system
    message into every task's agent context, so a cheap model reasons like a
    bigger one on hard goals. Config `{ "enhance": { "enabled": true } }` also
    opts in without a flag. Graceful no-op when `chameleon` isn't installed.
- **Termix** (lightweight GTK3+VTE multi-terminal): `mochi termix` launches it,
  `--install` clones the repo to `~/termix` first; Mochi seeds
  `~/.config/termix/config.json` with a compatible default. No Electron.
- Adds `chameleon` tool schema test.

## 0.5.3

- `bench/task.mjs` (`npm run bench:task`): runs a real multi-turn agent task and
  reports total tokens, cost, and wall time (the per-task efficiency number, vs.
  the cold-start microbench). Verified live: writing+running a small module took
  ~43k tokens / ~$0.006 / ~37s on the configured provider.
- Budget-phase-aware model routing in the agent loop: when the budget drops to
  `cheap`/`verify`, later iterations fall back to the `fast` model profile
  (cheaper/leaner) while critical early reasoning stays on the full profile.
  Providers are cached per profile so they aren't rebuilt every iteration.
- Compact-first context floor: the agent rolls up old turns (semantic ledger)
  as soon as the live transcript exceeds 60% of the context budget, so long runs
  stay lean regardless of iteration cadence. Adds `ContextEngine.estimateTokens()`.
- Adds tests for `estimateTokens()`.

## 0.5.2

- Adds `npm run build:bin`: compiles the CLI into a standalone native executable
  (`dist/mochi-bin`) via Bun. No Node, `node_modules`, or `package.json` needed at
  runtime; the binary is fully functional end to end (agent loop, tools, config,
  workspaces).
- `src/cli.ts` no longer depends on reading `package.json` for the version when
  compiled; it falls back to a baked-in constant so the binary works from any CWD.
- `bench/efficiency.mjs` now also measures the native binary when present.
- OpenAI-compatible tool schema payloads are memoized via a `WeakMap`, so the
  per-request tool schema JSON (+ allocations) is built once per tools array
  instead of on every streaming call.

## 0.5.1

Efficiency pass:

- Cache project rules + memory reads in `ContextEngine`; long runs no longer
  re-read `MOCHI.md`/`AGENTS.md`/`project.md` (and parse memory) on every agent
  iteration. Cheap size+mtime fingerprints refresh the cache on real edits, so
  behavior is unchanged.
- New `bench/efficiency.mjs` harness (`npm run bench:efficiency`) measuring
  cold-start wall time and peak RSS for Node and Bun, with an optional
  comparator (`MOCHI_COMPARE=...jcode`). Measured on this host:
  `mochi (node) ~55ms / ~47MB`, `mochi (bun) ~50ms / ~41MB`,
  `jcode --version ~19ms / ~24MB`.

## 0.5.0

Real usage + plan/approve + known-good state:

- `UsageStore` persisted per-provider model calls, commands, cost, tool calls, and time.
- `/usage`, `/cost`, and `mochi usage` show real accumulated usage.
- `/plan` stores a pending plan; `/approve` executes it.
- `/known-good` snapshots a baseline (test/build/typecheck/lint); `/check` compares current vs. baseline.
- CLI: `mochi run/test/init/branch/commit/usage/known-good/check`.
- 20 providers with `/login`; Anthropic and Gemini routed via native adapters.
- Feature-flagged Tree-sitter (WASM) symbol backend behind `MOCHI_CPG_BACKEND=tree-sitter`
  with automatic fallback to the TS-AST backend; `get_function`/`find_callers`/
  `type_hierarchy` are backend-agnostic.

## 0.3.0

Performance pipeline and TUI:

- Incremental OpenAI-compatible SSE stream parser.
- Compact high-frequency events (`text-delta`, `tool-start`, `tool-delta`, `usage`, `finish`).
- `FastEventBus` with batching and measured dispatch overhead.
- Hot/cold state separation and dirty-region tracking.
- Microtask batch scheduler.
- Dirty-region renderer abstraction with ANSI fallback.
- End-to-end `PerformancePipeline`.
- `mochi perf` benchmark with parser/bus/state/renderer timing.
- Real terminal UI: header, transcript, rounded input, command palette, status bar.

## 0.2.0

Tier-2 harness layer:

- Agent profiles loaded from `.mochi/agents/*.md`.
- Independent verifier and evidence-based outcome judge.
- Budget engine tracking tokens, cost, time, tool calls, model calls, and agents.
- Budget-aware model fallback and throttling.
- Lifecycle hooks with veto-capable `before_*` commands.
- Intelligent retrieval across files, symbols, references, imports, and git history.
- New `inspect` tool and CLI command.
- Speculative execution engine for difficult problems.
- Curated project memory and cross-session engineering facts.
- New `memory` tool and CLI command.
- Local harness learning for successful recovery strategies.
- Model-request retry with context compaction.
- Goal summaries now include token and cost usage.
- Example agent profiles and project memory.

## 0.1.0

- Initial rewrite from Pi baseline.
- Core runtime, event bus, workspace, and config.
- Model-agnostic OpenAI-compatible provider with OpenCode aliases.
- Model profiles: fast, coding, reasoning, review.
- Tool bus: read, write, edit, delete, shell, search, glob, git.
- Permission system: safe / ask / auto.
- Context engine with token budget, compaction, and structured state.
- Agent loop with preflight, verification, recovery, and pulse.
- Persistent goals and task DAG scheduler.
- Team orchestration with role-based agents.
- Git checkpoint and rollback.
- Interactive CLI and slash commands.
- Multiple workspaces.
- Tests and benchmarks.

- **Provider-level prefix caching.** `openai.ts` injects `cache_control: {type: "ephemeral"}` on index-0 system messages for DeepSeek/openai-compatible providers (freeinference/deepseek). First turn is 200; multi-turn harness runs clean. Combined with the byte-stable STABLE tier design (system prompt is identical across turns), this targets jcode-class token efficiency through cached-prefix billing.
-- Final concrete results (all verified, not projected) --
Freeze: reproduced from $HOME (>30s hang) -> 2.3s after fix.
Dogfood battery (same deepseek-v4-flash): mochi 10.6s/5.6s/7.1s vs jcode 8.6s/5.4s/17.0s; all outputs clean via hygiene scanner; T2 fix + T3 feature verified with untouched tests.
Prompt diet: 5249 -> 4268 tokens (~-1000/turn, -19%).
Cache control: openai provider adds ephemeral cache_control to index-0 system; freeinference returned 200 with usage tracked.
