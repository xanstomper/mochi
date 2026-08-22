# Mochi Harness Research: Cline / Pi / Claude-Code-class Harnesses

> Status: research complete. Source-first analysis of the harnesses installed
> or fetchable on this machine. Findings feed `harness-v2.md` (design) and the
> P0 implementation commits.

## Sources actually inspected

| Harness | What was read | How |
|---|---|---|
| **Pi** (`@earendil-works/pi-coding-agent` 0.84.1) | `dist/core/system-prompt.js`, `compaction/compaction.js` (644 loc), `tools/truncate.js`, `tools/output-accumulator.js`, `skills.js`, `docs/skills.md`, `docs/extensions.md`, README | installed locally, full source |
| **Cline** 3.0.37 | `sdk/packages/shared/src/prompt/system.ts`, `prompt/cline.ts` (Plan/Act mode contracts, prompt composition), repo tree (4,480 files) | fetched from GitHub raw |
| **Claude Code / JCode conventions** | AGENTS.md rule, skills-as-markdown pattern, parallel tool guidance | public docs + prior knowledge, labeled as such |

Cline's CLI binary is an ELF blob (not readable as source); its prompt layer
was extracted from the shared SDK package instead, which is the same text the
CLI composes.

---

## 1. Agent loop architecture

### Pi
- Single `AgentSession` (2,686 loc) orchestrating a straight
  `stream → tool calls → execute → append results → repeat` loop.
- No subagents, no plan mode **by design**. README: "Pi ships with powerful
  defaults but skips features like sub agents and plan mode. Instead, you can
  ask pi to build what you want."
- Session is an append-only entry log; branching and compaction are entry
  types, not different modes. This makes resume, branching, and compaction
  trivially correct (they are just log operations).

### Cline
- Plan/Act dual-mode state machine. Plan mode has a **hard command guard**:
  file-editing `run_commands` calls are rejected at the tool layer, not just
  discouraged in the prompt. Prompt says: "File-editing commands ... are
  hard-blocked in plan mode: they are not executed and return a tool error."
- Mode changes are stamped on user messages (`<user_input mode="...">`) and
  explained ONCE in the system prompt, so a mid-conversation mode switch is
  visible to the model as data, not as an invisible system-prompt swap.
- `switch_to_act_mode` tool: the model itself transitions after explicit user
  approval (CLI), or asks the user to flip the toggle (VS Code). The contract
  forbids calling it in the same turn as presenting the plan.

### What Mochi should take
- **PORT (adapted)**: Cline's "mode rides in the rules slot, explained once"
  pattern. Mochi's plan-mode nudge is already close; the missing piece is
  stamping mode on messages so mid-run switches are model-visible.
- **REJECT**: Pi's "no subagents ever" minimalism — Mochi's tasks are larger
  than single-session work, and Mochi already has a working subagent tool.
- **KEEP**: Mochi's goal→task→agent hierarchy is richer than both; it's not
  the source of the "lost and minimal" feeling.

## 2. Prompt construction

### Pi (measured, this machine)
The whole system prompt builder is **109 lines** and produces roughly 1–2 KB
of text. Key properties:
- Tool list built ONLY from tools with one-line snippets (`visibleTools`),
  so the prompt never advertises what isn't wired.
- Guidelines are **conditional on available tools** (`hasBash && !hasGrep...`)
  and deduplicated via a Set.
- Project context files are wrapped in tagged blocks:
  `<project_instructions path="...">...</project_instructions>`.
- Skills are advertised **only when the read tool exists** (the model must be
  able to load them).
- CWD appended last.

### Cline
- Template with placeholders (`{{CWD}}`, `{{PLATFORM_NAME}}`, `{{CURRENT_DATE}}`).
- Mode semantics + plan contract injected through the **same rules slot** as
  user rules, keeping one composition path.
- YOLO (autonomous) prompt is a *separate, shorter, stricter* prompt — not the
  default prompt with "be careful" appended.

### Mochi today
- 6 KB stable identity prompt (good for prefix caching — keep), plus rules,
  repo info, skills ad, task-kind focus hint, preflight, state prompt.
- Weakness found: instructions are dense prose with few **decision
  procedures**. Pi/Cline prompts are smaller but say exactly *when* to use
  each tool. Mochi says *what* tools are but under-specifies *when*.

**ADOPT**: Pi's conditional-guideline pattern + tagged context blocks.
**PORT**: Cline's separate autonomous-mode prompt tone.

## 3. Context management

### Pi (the best implementation found)
- Token accounting: `calculateContextTokens` uses **real provider usage**
  (`totalTokens` from the last assistant message) and only *estimates*
  (chars/4) the trailing messages after the last usage point. This is far more
  accurate than estimating everything, at zero cost.
- Compaction trigger: `contextTokens > contextWindow - reserveTokens`
  (reserve 16,384; keepRecent 20,000 by default).
- **Cut points**: walk backwards accumulating estimated sizes until the
  keep-recent budget is hit, then cut at the nearest *valid* cut point.
  Valid cut points are user/assistant messages — **never tool results**
  (a tool result must follow its call). Split turns are detected and the
  turn's user message is preserved.
- **LLM summarization** of the dropped region into a fixed-format checkpoint:
  `## Goal / ## Constraints & Preferences / ## Progress (Done/In
  Progress/Blocked) / ## Key Decisions / ## Next Steps / ## Critical
  Context`, with an *update* variant that merges into a previous summary.
  The summarizer has its own system prompt forbidding it from continuing the
  conversation.
- Summarization calls are isolated (fresh session id, `cacheRetention:
  "none"`) so they don't poison provider caches.
- File-op tracking: read/edited file sets are extracted from tool calls and
  carried across compactions, so post-compaction context still knows what
  was touched.

### Mochi today
`compact()` keeps last 6 messages and distills small facts into a ledger.
No real usage accounting, no valid-cut-point logic (it can cut between a tool
call and its result), no LLM checkpoint, no file-op carryover.

**PORT (redesigned around Mochi's ContextEngine)**: Pi's three ideas —
usage-based accounting, cut-point validity, structured checkpoint summary.
This is the single highest-value context change.

## 4. Tool output truncation

### Pi
- Central `truncate.js`: **two independent limits (2,000 lines / 50 KB)**,
  head and tail variants, never returns partial lines, reports rich metadata
  (`truncatedBy`, `totalLines`, `outputLines`, ...).
- `OutputAccumulator`: bounded-memory streaming accumulator that keeps a
  decoded tail for display and **spills the full output to a temp file** when
  limits are exceeded — nothing is lost, the model is just told where the
  full log lives.

### Mochi today
- Per-tool ad-hoc caps (`MAX_OUTPUT` in shell, `MAX_TOTAL` in search) +
  `foldToolResult` at 6,000 chars → head/tail fold. Decent, but inconsistent:
  some tools truncate hard, some don't, and there's no full-output escape
  hatch (temp file) so a folded result can lose the one line the model needed.

**PORT**: Pi's uniform truncation contract (line+byte dual limit, no partial
lines, truncation metadata) **plus** the temp-file spill. Apply it in
`runToolCall` so every tool gets it for free.

## 5. Skills / extensibility

### Pi
- Implements the **agentskills.io spec**: SKILL.md with frontmatter (name ≤64
  chars `[a-z0-9-]`, description ≤1,024 chars), optional `skills/` scripts.
- Discovery from global + project + package + settings + CLI, respecting
  `.gitignore`/`.ignore`/`.fdignore`.
- **Advertised in the system prompt by name+description only**; the model
  reads the full SKILL.md on demand. This is the token-efficient middle
  ground between "no skills" and "bake skills into the prompt".

### Mochi today
Skills infra exists (`loadAllSkills`, `formatSkillsForPrompt`, weak-model
limit of 3) but the skills directories are empty — the capability is dormant.
There is no *content*: no built-in guides for debugging, testing, research,
etc.

**INVENT (using Pi's spec)**: ship built-in bundled skills/guides so the
agent has real procedural knowledge from turn one. This directly addresses
"minimal, gets lost".

## 6. Parallel tool execution

### Cline
Prompt-level: "identify every independent read, search, command, or edit
needed for the next step and emit all of those tool calls now... Do not wait
for one independent result before requesting another." The model is *taught*
to batch.

### Mochi today
The executor already parallelizes read-only batches and distinct-file writes —
but the prompt never tells the model to emit independent calls together, so
the parallelism rarely triggers.

**PORT**: Cline's batching instruction into Mochi's prompt (one paragraph).

## 7. Things inspected and deliberately NOT taken

- Pi's extension API surface (registerTool/ctx.ui/...): powerful but a whole
  runtime; Mochi has hooks + MCP already. REJECT for now.
- Pi's RPC/SDK modes: Mochi has a daemon. REJECT.
- Cline's browser/webview tooling: out of scope.
- Pi's session publishing to HuggingFace: no.

---

## Comparison matrix (implementation evidence)

| Capability | Cline | Pi | Mochi (before V2) |
|---|---|---|---|
| Loop | dual-mode state machine | single session loop | goal→task→agent, richest |
| Prompt size | ~2–3 KB templated | ~1–2 KB, 109-loc builder | 6 KB stable + volatile |
| Conditional guidelines | mode-slot injection | per-tool conditionals | static prose |
| Context accounting | n/a (provider window) | real usage + trailing estimate | chars/3.8 estimate only |
| Compaction | — | cut-point + LLM checkpoint | keep-6 + fact ledger |
| Tool truncation | per-tool | uniform dual-limit + temp spill | ad-hoc + 6 KB fold |
| Skills | rules files | agentskills.io spec, on-demand read | infra present, empty |
| Parallel tools | prompt-taught batching | n/a | executor supports, prompt silent |
| Plan mode | hard guard + mode tags | none | veto-based, no mode stamping |

## Priority ranking (feeds the roadmap)

**P0**
1. Built-in bundled guides/skills (procedural knowledge; fixes "minimal").
2. Uniform tool-result policy: dual-limit truncation + temp-file spill +
   prompt-visible metadata (fixes token waste and lost information).
3. Parallel-batching instruction in the prompt (unlocks existing executor
   parallelism).
4. Cut-point-valid compaction with usage-based accounting (no orphaned tool
   results, real trigger threshold).

**P1**
5. Structured LLM checkpoint on compaction (Pi's format).
6. Mode stamping on user messages for plan-mode switches.
7. Conditional guidelines in the prompt builder (guidelines only for tools
   actually present).

**P2**
8. File-op carryover across compaction.
9. Truncation telemetry (how often, which tools).

**Rejected**: porting Pi's extension runtime; Cline's webview tooling;
subagent removal; session publishing.
