// Measured tool exposure (P1.3): registration ≠ exposure, decided by data.
//
// Two halves:
//
// 1. A persistent per-workspace usage ledger for EVERY tool execution
//    (`.mochi/state/tool-usage.json`): per tool — calls / successes /
//    failures / lastUsedAt — plus the same counters broken down by task
//    kind. `executeTool` (tools/index.ts) is the single chokepoint every
//    execution funnels through, so recording there misses nothing and
//    double-counts nothing (speculative replays never re-enter it).
//    Recording is O(1): an in-memory increment against a cached ledger,
//    flushed to disk at most once per second (and on demand). It is
//    fail-silent — telemetry must never break a tool call.
//
// 2. A budgeted exposure policy (`selectToolsForExposure`): for a run, the
//    advertised set is (a) the always-on core (the codebase's own LEAN
//    tier), (b) tools the task text implicates — explicitly named tools
//    (incl. aliases, resolved by the caller) and domain-signal matches —
//    which are NEVER dropped, and (c) historically-used tools for this
//    workspace (this task kind first, then global), filled in usage order
//    until the total serialized schema budget is spent. Everything else
//    stays one `load_tools` call away, exactly like the older tiers.
//    Ranking ties (cold workspace, no history) break toward cheaper
//    schemas, so breadth per char is maximized while data accrues.
//
// "Schema chars" = JSON.stringify(toolDef).length summed over advertised
// defs — the same measure the code study used (default buildTools output
// ≈ 45.5K chars ≈ ~11K tokens on every call). The default budget is
// 24,000 chars (≈ 6K tokens). Knobs: config.toolExposure ('measured' |
// 'full'), config.toolSchemaBudgetChars, env MOCHI_TOOLS=full,
// env MOCHI_TOOL_SCHEMA_BUDGET=<chars>. Env wins over config.

import { resolve } from 'node:path';
import type { MochiConfig, ToolDefinition } from '../types.js';
import type { Tool } from './types.js';
import type { Workspace } from '../workspace.js';

// ---------------------------------------------------------------- ledger ---

export interface ToolUsageEntry {
  calls: number;
  successes: number;
  failures: number;
  lastUsedAt: number;
}

export interface ToolUsageLedger {
  version: 1;
  updatedAt: number;
  tools: Record<string, ToolUsageEntry>;
  byKind: Record<string, Record<string, ToolUsageEntry>>;
}

/** Path (relative to the workspace `.mochi` dir) of the exposure ledger. */
export const TOOL_USAGE_STATE_PATH = 'state/tool-usage.json';

const FLUSH_INTERVAL_MS = 1_000;
const MAX_LEDGER_TOOLS = 500;

function emptyLedger(): ToolUsageLedger {
  return { version: 1, updatedAt: 0, tools: {}, byKind: {} };
}

interface CacheEntry {
  data: ToolUsageLedger;
  workspace: Workspace;
  dirty: boolean;
  lastFlush: number;
}

const ledgerCache = new Map<string, CacheEntry>();

function entryFor(workspace: Workspace): CacheEntry {
  const key = workspace.dir;
  let entry = ledgerCache.get(key);
  if (!entry) {
    let data = emptyLedger();
    try {
      const raw = workspace.readJson<ToolUsageLedger | null>(TOOL_USAGE_STATE_PATH, null);
      if (raw && typeof raw === 'object' && raw.tools && typeof raw.tools === 'object') {
        data = {
          version: 1,
          updatedAt: raw.updatedAt ?? 0,
          tools: raw.tools,
          byKind: raw.byKind && typeof raw.byKind === 'object' ? raw.byKind : {},
        };
      }
    } catch { /* unreadable ledger → start fresh; recording must not fail */ }
    entry = { data, workspace, dirty: false, lastFlush: 0 };
    ledgerCache.set(key, entry);
  } else {
    entry.workspace = workspace;
  }
  return entry;
}

function bump(map: Record<string, ToolUsageEntry>, name: string, ok: boolean): void {
  const rec = map[name] ?? { calls: 0, successes: 0, failures: 0, lastUsedAt: 0 };
  rec.calls += 1;
  if (ok) rec.successes += 1;
  else rec.failures += 1;
  rec.lastUsedAt = Date.now();
  map[name] = rec;
}

function flushEntry(entry: CacheEntry): void {
  try {
    // Bound the file: keep the most recently used tools/kinds.
    const names = Object.keys(entry.data.tools);
    if (names.length > MAX_LEDGER_TOOLS) {
      names.sort((a, b) => (entry.data.tools[a].lastUsedAt ?? 0) - (entry.data.tools[b].lastUsedAt ?? 0));
      for (const n of names.slice(0, names.length - MAX_LEDGER_TOOLS)) delete entry.data.tools[n];
    }
    entry.workspace.writeJson(TOOL_USAGE_STATE_PATH, entry.data);
    entry.dirty = false;
    entry.lastFlush = Date.now();
  } catch { /* fail-silent: the next record retries the flush */ }
}

/**
 * Record one executed tool call. Called from `executeTool` on both the
 * success and throw paths (validation/permission rejections return earlier
 * and are not executions, so they are not recorded). `ok` = the tool's
 * execute() did not throw — tools that report failure in-band (a shell
 * nonzero exit is output, not a throw) count as successes here; this is a
 * usage signal, not a correctness verdict. Never throws.
 */
export function recordToolExposureUsage(
  workspace: Workspace | undefined,
  name: string,
  ok: boolean,
  kind?: string,
): void {
  try {
    if (!workspace || !name) return;
    const entry = entryFor(workspace);
    bump(entry.data.tools, name, ok);
    if (kind) {
      const perKind = (entry.data.byKind[kind] ??= {});
      bump(perKind, name, ok);
    }
    entry.data.updatedAt = Date.now();
    entry.dirty = true;
    // First record after a load flushes immediately so short runs still
    // persist; subsequent records flush at most once per interval.
    if (entry.lastFlush === 0 || Date.now() - entry.lastFlush >= FLUSH_INTERVAL_MS) {
      flushEntry(entry);
    }
  } catch { /* telemetry never breaks execution */ }
}

/** The cached ledger for a workspace (loads from disk on first access). */
export function loadToolUsageLedger(workspace: Workspace): ToolUsageLedger {
  try {
    return entryFor(workspace).data;
  } catch {
    return emptyLedger();
  }
}

/** Force any pending ledger writes for a workspace to disk. */
export function flushToolUsageLedger(workspace: Workspace): void {
  try {
    const entry = ledgerCache.get(workspace.dir);
    if (entry && entry.dirty) flushEntry(entry);
  } catch { /* fail-silent */ }
}

/** Absolute path of a workspace's ledger file (workspaceDir = `.mochi` dir). */
export function toolUsageLedgerFile(workspaceDir: string): string {
  return resolve(workspaceDir, TOOL_USAGE_STATE_PATH);
}

/** Test hook: forget cached ledgers so the next access re-reads from disk. */
export function _clearToolUsageLedgerCacheForTests(): void {
  ledgerCache.clear();
}

// ------------------------------------------------------------ measurement ---

/** Serialized schema size of one tool definition, in characters. */
export function toolDefSchemaChars(def: ToolDefinition): number {
  try {
    return JSON.stringify(def).length;
  } catch {
    return 0;
  }
}

/** Total serialized schema size of a set of definitions, in characters. */
export function toolsSchemaChars(defs: Iterable<ToolDefinition>): number {
  let total = 0;
  for (const def of defs) total += toolDefSchemaChars(def);
  return total;
}

// ---------------------------------------------------------------- config ---

export const DEFAULT_TOOL_SCHEMA_BUDGET_CHARS = 24_000;

export type ToolExposureMode = 'measured' | 'full';

/** Escape hatch: MOCHI_TOOLS=full (env) or config.toolExposure === 'full'
 *  restores legacy behavior — every built tool advertised, no budgeting. */
export function toolExposureMode(config?: MochiConfig | null): ToolExposureMode {
  if ((process.env.MOCHI_TOOLS ?? '').toLowerCase() === 'full') return 'full';
  if (config?.toolExposure === 'full') return 'full';
  return 'measured';
}

/** Total schema-char budget. Env MOCHI_TOOL_SCHEMA_BUDGET > config >
 *  default (24,000 ≈ 6K tokens). */
export function toolSchemaBudgetChars(config?: MochiConfig | null): number {
  const env = Number(process.env.MOCHI_TOOL_SCHEMA_BUDGET);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  const cfg = config?.toolSchemaBudgetChars;
  if (typeof cfg === 'number' && Number.isFinite(cfg) && cfg > 0) return Math.floor(cfg);
  return DEFAULT_TOOL_SCHEMA_BUDGET_CHARS;
}

// --------------------------------------------------------------- signals ---

/** Per-tool domain signals in task text. This refines the old all-or-nothing
 *  HEAVY_SIGNAL_RE into per-tool implications: a text hit forces that tool
 *  into the exposed set (it is treated like an explicitly named tool). Keep
 *  patterns tight — a false positive costs one schema; a false negative
 *  costs a `load_tools` round-trip, so err narrow. */
export const TOOL_SIGNAL_RES: Record<string, RegExp> = {
  browser: /\b(browser|screenshot|web\s?page|webpage|headless chrome|playwright)\b/i,
  db_inspect: /\b(database|postgres|mysql|sqlite|db schema|table schema)\b/i,
  sql_codebase_query: /\b(sql quer\w*|query the codebase with sql|codebase sql)\b/i,
  deepwiki: /\b(deepwiki|wiki)\b/i,
  create_pr: /\b(pull request|create a pr|open a pr|submit a pr|github pr)\b/i,
  review_pr: /\b(review (the |this )?(pr|pull request)|pull request review|pr review)\b/i,
  perf: /\b(performance|profil(e|ing)|latency|benchmark)\b/i,
  benchmark: /\b(benchmark)\b/i,
  clipboard: /\b(clipboard)\b/i,
  rename_symbol: /\brename\b/i,
  resolve_conflicts: /\b(merge conflict|resolve conflict|conflict markers)\b/i,
  find_callers: /\b(callers|called by|call graph|who calls|find (all )?callers)\b/i,
  type_hierarchy: /\b(type hierarchy|subclass|subclasses|inheritance|derived classes)\b/i,
  get_function: /\b(function body|implementation of|show me the function)\b/i,
  blast_radius: /\b(blast radius|impact of (changing|removing)|what breaks if)\b/i,
  code_similarity: /\b(duplicate code|similar code|code clones?|dedupe code)\b/i,
  analyze_code: /\b(analyze the (code|codebase)|code analysis|architecture analysis)\b/i,
  codebase_map: /\b(map the codebase|codebase map|architecture overview|repo map)\b/i,
  security_audit: /\b(security audit|vulnerabilit\w*|owasp|security scan)\b/i,
  web_crawl: /\b(crawl|crawler|scrape|scraping|spider)\b/i,
  repl: /\b(repl|interactive (shell|session)|node repl)\b/i,
  notebook: /\b(notebook|jupyter|ipynb)\b/i,
  mcp_manage: /\b(mcp|model context protocol)\b/i,
  lint: /\b(lint|eslint|ruff|flake8)\b/i,
  format: /\b(format the|formatting|prettier|gofmt|code formatter)\b/i,
  session_collab: /\b(collaborat\w+ session|shared session|pair session)\b/i,
  explain: /\bexplain (how|what|why|the)\b/i,
};

/** Tools whose domain the task text clearly implicates. */
export function toolsImplicatedBySignals(taskText: string): Set<string> {
  const out = new Set<string>();
  for (const [name, re] of Object.entries(TOOL_SIGNAL_RES)) {
    if (re.test(taskText)) out.add(name);
  }
  return out;
}

// ---------------------------------------------------------------- policy ---

export interface ExposureSelection {
  /** Exposed tools, in the candidates' original order (prefix-cache stable). */
  selected: Tool[];
  /** Built-in candidate names NOT exposed (deferred to `load_tools`). */
  deferred: string[];
  /** Serialized schema chars of everything that stays advertised
   *  (selected built-ins + pass-through tools). */
  schemaChars: number;
  budgetChars: number;
  /** Names forced in regardless of budget: core ∪ explicitly named ∪
   *  signal-implicated (intersected with candidates). */
  forcedNames: string[];
  /** Names added by the usage-ranked budget fill. */
  filledNames: string[];
}

/**
 * Pure selection: given the candidate tools (the built map's contents),
 * decide the exposed subset under a total schema-char budget.
 *
 * - `coreNames` and `forcedNames` are always exposed, even if they alone
 *   exceed the budget — a named tool is never dropped (brief requirement).
 * - Authored/extra tools (not in `builtinNames`) always pass through and
 *   their schema chars count against the budget — they were authored
 *   because the agent needed them; the policy governs built-ins only.
 * - The fill ranks remaining built-ins by recorded usage for this task
 *   kind (weighted ×2) plus global usage; ties break toward cheaper
 *   schemas, then name, so the order is fully deterministic.
 */
export function selectToolsForExposure(opts: {
  candidates: readonly Tool[];
  builtinNames: ReadonlySet<string>;
  coreNames: ReadonlySet<string>;
  forcedNames?: ReadonlySet<string>;
  ledger?: ToolUsageLedger | null;
  taskKind?: string;
  budgetChars?: number;
}): ExposureSelection {
  const budget = opts.budgetChars ?? DEFAULT_TOOL_SCHEMA_BUDGET_CHARS;
  const byName = new Map(opts.candidates.map((t) => [t.def.name, t]));
  const chosen = new Set<string>();
  const forced = new Set<string>();

  // Pass-through tools (authored/extra/MCP): always advertised; their size
  // is real schema cost, so it comes off the budget first.
  let passThroughChars = 0;
  for (const t of opts.candidates) {
    if (!opts.builtinNames.has(t.def.name)) {
      chosen.add(t.def.name);
      passThroughChars += toolDefSchemaChars(t.def);
    }
  }

  // Forced: core + caller-supplied (named + signal-implicated).
  for (const name of opts.coreNames) {
    if (byName.has(name) && opts.builtinNames.has(name)) { chosen.add(name); forced.add(name); }
  }
  for (const name of opts.forcedNames ?? []) {
    if (byName.has(name) && opts.builtinNames.has(name)) { chosen.add(name); forced.add(name); }
  }
  let chars = passThroughChars;
  for (const name of chosen) {
    if (opts.builtinNames.has(name)) chars += toolDefSchemaChars(byName.get(name)!.def);
  }

  // Usage-ranked fill for the remaining built-ins.
  const kindRecs = opts.taskKind ? opts.ledger?.byKind?.[opts.taskKind] : undefined;
  const rest = opts.candidates
    .filter((t) => opts.builtinNames.has(t.def.name) && !chosen.has(t.def.name))
    .map((t) => {
      const global = opts.ledger?.tools?.[t.def.name]?.calls ?? 0;
      const kind = kindRecs?.[t.def.name]?.calls ?? 0;
      return { tool: t, score: kind * 2 + global, chars: toolDefSchemaChars(t.def) };
    })
    .sort((a, b) =>
      b.score - a.score ||
      a.chars - b.chars ||
      a.tool.def.name.localeCompare(b.tool.def.name),
    );
  const filled: string[] = [];
  for (const r of rest) {
    if (chars + r.chars > budget) continue;
    chosen.add(r.tool.def.name);
    filled.push(r.tool.def.name);
    chars += r.chars;
  }

  const selected = opts.candidates.filter((t) => chosen.has(t.def.name));
  return {
    selected,
    deferred: opts.candidates
      .filter((t) => opts.builtinNames.has(t.def.name) && !chosen.has(t.def.name))
      .map((t) => t.def.name),
    schemaChars: toolsSchemaChars(selected.map((t) => t.def)),
    budgetChars: budget,
    forcedNames: [...forced],
    filledNames: filled,
  };
}

/**
 * Apply the policy to a live tool map (the loop's `this.tools`): removes
 * deferred built-ins from the map — mirroring the existing trim functions,
 * so `load_tools` can restore any of them mid-run — and returns the
 * selection for logging. Authored/extra tools are never removed.
 */
export function applyMeasuredExposure(
  map: Map<string, Tool>,
  opts: {
    builtinNames: ReadonlySet<string>;
    coreNames: ReadonlySet<string>;
    forcedNames?: ReadonlySet<string>;
    ledger?: ToolUsageLedger | null;
    taskKind?: string;
    budgetChars?: number;
  },
): ExposureSelection & { trimmed: number } {
  const selection = selectToolsForExposure({ candidates: [...map.values()], ...opts });
  const keep = new Set(selection.selected.map((t) => t.def.name));
  let trimmed = 0;
  for (const name of [...map.keys()]) {
    if (!keep.has(name) && opts.builtinNames.has(name)) {
      map.delete(name);
      trimmed++;
    }
  }
  return { ...selection, trimmed };
}
