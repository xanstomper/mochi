// D4 — prompt/skill/tool byte-budget metering.
//
// Prompt bytes, tool schemas and the bundled-skill advertisement are a hidden
// tax on every run: a prompt edit or a new tool silently grows the context
// every agent pays for, and nothing made that visible. This module is a METER,
// not a second prompt assembler. It composes through the REAL seams and counts
// UTF-8 bytes of the exact strings:
//
//   - system prompt  → ContextEngine.buildSystemPrompt (via
//     composeForByteBudget), split stable/volatile exactly where the engine
//     splits it: the P5 stable head (core + root rules + repo info, the
//     prefix-cacheable bytes) vs the session tail (modular rules + the skills
//     advertisement + the behavioral contract + memory/feedback digests).
//   - tool schemas   → the registered registry (ALL_TOOLS_MAP, the same map
//     the loop advertises from), each serialized with JSON.stringify(def) —
//     the same serialization toolsSchemaChars (tools/tool-exposure.ts)
//     already budgets — counted in UTF-8 bytes.
//   - skills         → the rendered <available_skills> block, parsed back out
//     of the composed `skills` segment; per-skill bytes are the rendered
//     `<skill name="…"><description>…</description></skill>` line.
//
// Determinism (same repo state ⇒ same numbers):
//   - the composition runs with ISOLATED user state (empty memory/feedback
//     digests, no user skills) so a developer's ~/.mochi cannot move the
//     numbers;
//   - the machine environment block (machineAccessBlock — hostname, CPU,
//     memory total, cwd, toolchain versions) is replaced by a fixed
//     placeholder before counting. It is machine state, not repo state; its
//     live size is still reported as `prompt.machineEnvBytes` but is exempt
//     from the gate.
//   - no timestamps, no random ordering: every map is emitted in canonical
//     (plain `sort()`) order.
//
// Not metered, on purpose: the trailing per-turn volatile state message
// (buildStatePrompt) — it is recomputed every turn and carries live host
// metrics (free memory) by design (P5); metering it would make any baseline
// flaky by construction. Runtime MCP-inflated schemas are also out of scope:
// the gate meters every REGISTERED tool (built-in registry).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ContextEngine, machineAccessBlock } from '../context.js';
import { ALL_TOOLS_MAP } from '../tools/index.js';
import { detectRepo } from '../repo/repo.js';
import type { MochiConfig, RepoInfo, ToolDefinition } from '../types.js';

// ─────────────────────────────────────────────────────────── types ──

export interface ByteBudgetDump {
  prompt: {
    /** Stable head bytes (core + root rules + repo info) — prefix-cacheable. */
    stableBytes: number;
    /** Composed total minus the stable head (session tail). */
    volatileBytes: number;
    /** Exact composed system-prompt bytes (env block normalized). */
    totalBytes: number;
    /** False only in the degenerate empty-tail case (head ≡ full after trim). */
    headIsPrefix: boolean;
    /** Live machine env block size (informational; normalized OUT of the totals). */
    machineEnvBytes: number;
    /** Per named segment, in wire order (env block normalized). */
    segments: Record<string, number>;
  };
  tools: {
    count: number;
    totalBytes: number;
    /** tool name → utf8 bytes of JSON.stringify(def), name-sorted. */
    perTool: Record<string, number>;
  };
  skills: {
    /** Rendered skills advertised in the system prompt (bundled catalog, no task). */
    count: number;
    totalBytes: number;
    /** skill name → utf8 bytes of its rendered <skill> line, name-sorted. */
    perSkill: Record<string, number>;
  };
}

export interface ByteBudgetBaseline {
  countingRule: Record<string, string>;
  allowances: ByteBudgetAllowances;
  dump: ByteBudgetDump;
}

export interface ByteBudgetAllowances {
  /** Max allowed growth of prompt.totalBytes in one step. */
  totalBytes: number;
  /** Max allowed growth of prompt.stableBytes in one step. */
  stableBytes: number;
  /** Max allowed growth of ANY single tool's schema bytes in one step. */
  perToolBytes: number;
}

export interface ByteBudgetVerdict {
  ok: boolean;
  violations: string[];
  notes: string[];
}

/** Small stated allowances: growth beyond these must be a deliberate,
 *  reviewed baseline update (`--update-baseline`), never an accident. */
export const DEFAULT_ALLOWANCES: ByteBudgetAllowances = {
  totalBytes: 1024,
  stableBytes: 512,
  perToolBytes: 64,
};

export const ENV_PLACEHOLDER = '[ENV-BLOCK-NORMALIZED]';

const COUNTING_RULE: Record<string, string> = {
  encoding: 'utf8 (Buffer.byteLength) over the exact composed strings',
  prompt: 'ContextEngine system prompt composed for a fresh no-task session with the full registered toolset (ALL_TOOLS_MAP, name-sorted) and repo info from detectRepo(projectRoot). User state is isolated (empty memory/feedback digests, no user skills) and the machine env block (machineAccessBlock) is replaced by a fixed placeholder, so numbers are a function of repo state only.',
  stable: 'the P5 stable head as composed: core directives + root rules (MOCHI.md/AGENTS.md) + repo info — the prefix-cacheable head buildSystemPrompt hashes',
  volatile: 'composed total minus the stable head: modular rules + skills advertisement + behavioral contract + memory + feedback digests',
  toolSchema: 'per tool: utf8 bytes of JSON.stringify(tool.def) — the same serialization toolsSchemaChars budgets in tools/tool-exposure.ts; every REGISTERED tool (ALL_TOOLS_MAP), default-exposure filtering not replicated',
  skillAd: 'per skill: utf8 bytes of the rendered <skill name="…"><description>…</description></skill> line inside the composed skills segment',
  excluded: 'the trailing per-turn volatile state message (buildStatePrompt — recomputed per turn with live host metrics by design); runtime MCP-inflated schemas',
};

// ─────────────────────────────────────────────────────── collection ──

const byteLen = (text: string): number => Buffer.byteLength(text, 'utf8');

/** Minimal deterministic engine config — no user config file is consulted
 *  (the meter must not move when a developer edits their ~/.mochi). */
function meterConfig(): MochiConfig {
  return {
    model: { provider: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'byte-budget-meter' },
    safety: { contextBudgetTokens: 400_000, maxIterations: 50, maxRuntimeMinutes: 10, mode: 'safe' as const },
  } as MochiConfig;
}

const sortedRecord = (entries: Array<[string, number]>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [k, v] of entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) out[k] = v;
  return out;
};

/**
 * Compose the prompt through the real seams and count the bytes.
 * `projectRoot` should be the repo root (the check scripts and CI run from
 * there). User state is isolated for the duration of the composition and
 * restored afterwards, so the meter never reads (or creates) the caller's
 * ~/.mochi.
 */
export function collectByteBudget(projectRoot: string): ByteBudgetDump {
  const root = resolve(projectRoot);
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  const savedMemFile = process.env.MOCHI_MEMORY_FILE;
  let iso: string | null = null;
  try {
    // Isolated HOME + memory file: memoryDigest/feedbackDigest render empty,
    // user/global skill dirs resolve under the empty temp home.
    iso = mkdtempSync(join(tmpdir(), 'mochi-byte-budget-'));
    const isoHome = join(iso, 'home');
    mkdirSync(isoHome, { recursive: true });
    process.env.HOME = isoHome;
    process.env.USERPROFILE = isoHome;
    process.env.MOCHI_MEMORY_FILE = join(iso, 'memory.jsonl'); // nonexistent → empty digest

    const engine = new ContextEngine(meterConfig(), root, join(isoHome, '.mochi', 'skills'));
    const defs: ToolDefinition[] = [...ALL_TOOLS_MAP.values()]
      .map((t) => t.def)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    let repo: RepoInfo | undefined;
    try {
      repo = detectRepo(root);
    } catch {
      repo = undefined; // meter must not depend on detection succeeding
    }
    const composed = engine.composeForByteBudget(defs, repo);
    // machineAccessBlock is memoized per root inside one process, so this is
    // byte-identical to the block embedded in the `core` segment above.
    const envText = machineAccessBlock(root);
    const normalize = (text: string): string =>
      envText ? text.replace(envText, ENV_PLACEHOLDER) : text;

    const normSystem = normalize(composed.system);
    const normHead = normalize(composed.head);
    const headIsPrefix = normSystem.startsWith(normHead);
    const totalBytes = byteLen(normSystem);
    // Degenerate empty-tail case: full === trim(head) → everything is stable.
    const stableBytes = headIsPrefix ? byteLen(normHead) : totalBytes;

    const segments: Record<string, number> = {};
    for (const seg of composed.segments) segments[seg.name] = byteLen(normalize(seg.text));

    // Per-skill bytes: parse the rendered lines back out of the composed
    // segment — the meter measures the assembly, not a re-rendering.
    const skillsSegment = composed.segments.find((s) => s.name === 'skills')?.text ?? '';
    const perSkillEntries: Array<[string, number]> = [];
    for (const line of skillsSegment.split('\n')) {
      const m = /^ {2}<skill name="([^"]+)"><description>.*<\/description><\/skill>$/.exec(line);
      if (m) perSkillEntries.push([m[1], byteLen(line)]);
    }

    const perToolEntries: Array<[string, number]> = defs.map((d) => [d.name, byteLen(JSON.stringify(d))]);

    return {
      prompt: {
        stableBytes,
        volatileBytes: totalBytes - stableBytes,
        totalBytes,
        headIsPrefix,
        machineEnvBytes: byteLen(envText),
        segments,
      },
      tools: {
        count: perToolEntries.length,
        totalBytes: perToolEntries.reduce((acc, [, n]) => acc + n, 0),
        perTool: sortedRecord(perToolEntries),
      },
      skills: {
        count: perSkillEntries.length,
        totalBytes: byteLen(normalize(skillsSegment)),
        perSkill: sortedRecord(perSkillEntries),
      },
    };
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
    if (savedMemFile === undefined) delete process.env.MOCHI_MEMORY_FILE; else process.env.MOCHI_MEMORY_FILE = savedMemFile;
    if (iso) rmSync(iso, { recursive: true, force: true });
  }
}

// ───────────────────────────────────────────────────────── baseline ──

export function defaultBaselinePath(): string {
  // src/prompt/byte-budget.ts → repo root is three levels up (dist layout:
  // dist/prompt/byte-budget.js → package root, same depth).
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'byte-budget.baseline.json');
}

export function loadBaseline(path: string): ByteBudgetBaseline | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ByteBudgetBaseline;
  } catch {
    return null;
  }
}

/** Serialize deterministically: fixed key order, 2-space indent, trailing LF. */
export function renderBaseline(dump: ByteBudgetDump, allowances: ByteBudgetAllowances = DEFAULT_ALLOWANCES): string {
  const baseline: ByteBudgetBaseline = { countingRule: COUNTING_RULE, allowances, dump };
  return JSON.stringify(baseline, null, 2) + '\n';
}

export function writeBaseline(path: string, dump: ByteBudgetDump, allowances: ByteBudgetAllowances = DEFAULT_ALLOWANCES): void {
  writeFileSync(path, renderBaseline(dump, allowances));
}

/** Ratchet compare: fails when the total, the stable total, or any single
 *  tool's schema bytes grow beyond their stated allowance, or when a tool
 *  appears without a baseline entry (new prompt bytes are never silently
 *  ignored). Decreases pass — this is a ratchet, not a freeze. */
export function compareAgainstBaseline(dump: ByteBudgetDump, baseline: ByteBudgetBaseline | null): ByteBudgetVerdict {
  const violations: string[] = [];
  const notes: string[] = [];
  if (!baseline || !baseline.dump) {
    return {
      ok: false,
      violations: ['no readable baseline — run `node scripts/check-byte-budget.mjs --update-baseline` to record one deliberately'],
      notes,
    };
  }
  const allow = baseline.allowances ?? DEFAULT_ALLOWANCES;
  const base = baseline.dump;

  if (dump.prompt.totalBytes > base.prompt.totalBytes + allow.totalBytes) {
    violations.push(`prompt total grew ${dump.prompt.totalBytes - base.prompt.totalBytes}B (${base.prompt.totalBytes} → ${dump.prompt.totalBytes}), allowance +${allow.totalBytes}B`);
  }
  if (dump.prompt.stableBytes > base.prompt.stableBytes + allow.stableBytes) {
    violations.push(`prompt STABLE head grew ${dump.prompt.stableBytes - base.prompt.stableBytes}B (${base.prompt.stableBytes} → ${dump.prompt.stableBytes}), allowance +${allow.stableBytes}B`);
  }
  const baseTools = base.tools?.perTool ?? {};
  for (const [name, bytes] of Object.entries(dump.tools.perTool)) {
    const before = baseTools[name];
    if (before === undefined) {
      violations.push(`tool '${name}' (${bytes}B) has NO baseline entry — new prompt bytes need a deliberate baseline update`);
    } else if (bytes > before + allow.perToolBytes) {
      violations.push(`tool '${name}' schema grew ${bytes - before}B (${before} → ${bytes}), allowance +${allow.perToolBytes}B`);
    }
  }
  for (const [name, bytes] of Object.entries(baseTools)) {
    if (dump.tools.perTool[name] === undefined) {
      notes.push(`tool '${name}' removed (${bytes}B freed) — run --update-baseline to record`);
    }
  }
  if (dump.prompt.volatileBytes !== base.prompt.volatileBytes) {
    const d = dump.prompt.volatileBytes - base.prompt.volatileBytes;
    notes.push(`prompt volatile tail ${d > 0 ? 'grew' : 'shrank'} ${Math.abs(d)}B (${base.prompt.volatileBytes} → ${dump.prompt.volatileBytes})${d > allow.totalBytes ? ' — beyond the total allowance, gated via prompt total' : ''}`);
  }
  const baseSkills = base.skills?.perSkill ?? {};
  for (const [name, bytes] of Object.entries(dump.skills.perSkill)) {
    if (baseSkills[name] === undefined) notes.push(`new skill advertised: '${name}' (+${bytes}B)`);
  }
  return { ok: violations.length === 0, violations, notes };
}

// ─────────────────────────────────────────────────────────── output ──

const pad = (label: string, width = 34): string => (label.length >= width ? label : label + ' '.repeat(width - label.length));

export function renderTable(dump: ByteBudgetDump): string {
  const lines: string[] = [];
  const row = (label: string, bytes: number): string => `${pad(label)}${String(bytes).padStart(8)} B`;
  lines.push('D4 byte budget (utf8 bytes; env block normalized — see scripts/byte-budget.baseline.json for the counting rule)');
  lines.push('');
  lines.push('prompt');
  lines.push('  ' + row('total', dump.prompt.totalBytes));
  lines.push('  ' + row('stable (prefix-cacheable head)', dump.prompt.stableBytes));
  lines.push('  ' + row('volatile (session tail)', dump.prompt.volatileBytes));
  lines.push('  ' + row('machine env block (excluded)', dump.prompt.machineEnvBytes) + '  (informational)');
  for (const [name, bytes] of Object.entries(dump.prompt.segments)) {
    lines.push('  ' + row(`segment ${name}`, bytes));
  }
  lines.push('');
  lines.push(`tools (${dump.tools.count} registered)`);
  lines.push('  ' + row('total schema bytes', dump.tools.totalBytes));
  for (const [name, bytes] of Object.entries(dump.tools.perTool)) {
    lines.push('  ' + row(`tool ${name}`, bytes));
  }
  lines.push('');
  lines.push(`skills advertised (${dump.skills.count})`);
  lines.push('  ' + row('total block bytes', dump.skills.totalBytes));
  for (const [name, bytes] of Object.entries(dump.skills.perSkill)) {
    lines.push('  ' + row(`skill ${name}`, bytes));
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────── cli ──

export const BYTE_BUDGET_USAGE = 'Usage: mochi bytes [--json] [--check] [--update-baseline] [--baseline <path>]';

/** Exit code of the `mochi bytes` command (also the direct-run entry below):
 *  0 = dump printed / check passed, 1 = check found growth (or no baseline). */
export function runByteBudgetCli(argv: string[]): number {
  let json = false;
  let check = false;
  let update = false;
  let baselinePath = defaultBaselinePath();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--check') check = true;
    else if (a === '--update-baseline') update = true;
    else if (a === '--baseline') baselinePath = resolve(argv[++i] ?? '');
    else if (a === '-h' || a === '--help') { console.log(BYTE_BUDGET_USAGE); return 0; }
    else { console.error(`unknown flag: ${a}\n${BYTE_BUDGET_USAGE}`); return 2; }
  }
  const dump = collectByteBudget(process.cwd());

  if (update) {
    const prev = loadBaseline(baselinePath);
    writeBaseline(baselinePath, dump);
    console.log(`baseline written: ${baselinePath}`);
    if (prev?.dump) {
      console.log(`  prompt: ${prev.dump.prompt.totalBytes} → ${dump.prompt.totalBytes} B (stable ${prev.dump.prompt.stableBytes} → ${dump.prompt.stableBytes})`);
      console.log(`  tools:  ${prev.dump.tools.totalBytes} → ${dump.tools.totalBytes} B across ${dump.tools.count} tools`);
    }
    return 0;
  }

  if (check) {
    const verdict = compareAgainstBaseline(dump, loadBaseline(baselinePath));
    if (verdict.ok) {
      console.log(`byte-budget check OK (baseline: ${baselinePath})`);
      console.log(`  prompt total ${dump.prompt.totalBytes} B (stable ${dump.prompt.stableBytes}, volatile ${dump.prompt.volatileBytes}); ${dump.tools.count} tools, ${dump.tools.totalBytes} B of schema`);
    } else {
      console.error(`byte-budget check FAILED (${verdict.violations.length} violation${verdict.violations.length === 1 ? '' : 's'}) vs ${baselinePath}`);
      for (const v of verdict.violations) console.error(`  ✗ ${v}`);
      console.error('prompt/tool bytes must not grow silently — if this change is deliberate, re-record with `node scripts/check-byte-budget.mjs --update-baseline` and say why in the commit message.');
    }
    for (const n of verdict.notes) console.log(`  • ${n}`);
    return verdict.ok ? 0 : 1;
  }

  if (json) console.log(JSON.stringify(dump, null, 2));
  else console.log(renderTable(dump));
  return 0;
}

// Direct-run entry: `node_modules/.bin/tsx src/prompt/byte-budget.ts --check`
// (this is what scripts/check-byte-budget.mjs and CI invoke). Importing this
// module (mochi bytes, tests) never triggers the CLI.
const mainScript = process.argv[1]
  ? (() => { try { return pathToFileURL(resolve(process.argv[1]!)).href; } catch { return ''; } })()
  : '';
if (mainScript && mainScript === import.meta.url) {
  process.exitCode = runByteBudgetCli(process.argv.slice(2));
}
