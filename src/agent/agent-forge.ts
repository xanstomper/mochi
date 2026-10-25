// Agent Forge: verifier-gated synthesis and lifecycle for spawn personas —
// the subagent-plane sibling of tool-forge.
//
// Tool-forge mines recurring COMMAND sequences into tools. Agent-forge mines
// recurring DELEGATION shapes into spawn personas: when the same kind of
// subagent (same role family, same tool fingerprint, repeatedly useful)
// shows up in verifier-passed trajectories, a synthesizer model writes a
// persona — a DELTA over an existing spawn preset, never a free system
// prompt — and the persona is probed against its base preset on a replayed
// task before it is allowed to persist. Personas that never prove useful
// are discarded, not hoarded.
//
// Why a delta, not a full prompt: the child's safety posture (tool
// allowlist, access level, isolation) comes from the base SpawnPreset and
// is enforced at the tool layer (see teams/presets.ts). A persona can
// narrow the allowlist and add guidance; it can never widen access.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPAWN_PRESETS, MUTATING_TOOL_NAMES, resolvePreset, type SpawnPreset } from '../teams/presets.js';
import { isVerifiedRecord, type TrajectoryRecord } from '../observability/trajectory.js';
import { loadTrajectoryCorpus } from '../tools/tool-forge.js';
import { createProvider } from '../model/router.js';
import type { MochiConfig } from '../types.js';

// ─── Constants (mirroring tool-forge) ─────────────────────────────────────

/** Minimum verifier-passed runs showing the same delegation shape before a
 *  persona candidate is worth synthesizing. */
export const FORGE_MIN_RUNS = 3;
/** Hard cap on the synthesized addendum — personas guide, they don't ghostwrite. */
export const FORGE_MAX_ADDENDUM_CHARS = 600;
/** Promotion threshold: helpful uses before a probation persona goes active. */
export const FORGE_PROMOTE_MIN_USES = 3;
/** Zero tolerance: any attributable regression blocks promotion. */
export const FORGE_PROMOTE_MAX_REGRESSIONS = 0;
/** A probation persona unused for this long is stale-probe material. */
export const FORGE_PROBATION_STALE_MS = 14 * 24 * 60 * 60 * 1000;
/** Probe gate: the persona child must beat (or tie) its base preset's quality
 *  AND stay within this token multiple of it. */
export const FORGE_PROBE_MAX_TOKEN_RATIO = 1.5;
/** Probe seeds per arm. */
export const FORGE_PROBE_SEEDS = 2;

// ─── Types ────────────────────────────────────────────────────────────────

export type ForgedAgentState = 'probation' | 'active' | 'disabled' | 'discarded';

/** A mined delegation shape: recurring evidence that the parent keeps
 *  delegating the same KIND of subtask and the children keep succeeding. */
export interface AgentForgeCandidate {
  /** Stable shape key: role family + sorted tool fingerprint hash. */
  shapeKey: string;
  /** The base preset the mined spawns actually used (or best-fit fallback). */
  basePreset: string;
  /** Verifier-passed run ids that exhibited this shape. */
  provenanceRunIds: string[];
  /** Tools the successful children ACTUALLY called (fingerprint subset). */
  observedTools: string[];
  /** Mean prompt length of the mined spawns — informs the synthesizer. */
  avgPromptChars: number;
  /** Sample prompt snippets (already redacted at trace-write time). */
  promptSamples: string[];
}

/** A persisted persona: preset delta + lifecycle ledger. */
export interface ForgedAgentPersona {
  name: string;
  state: ForgedAgentState;
  /** Base preset this persona narrows. Access NEVER widens. */
  basePreset: string;
  /** Synthesized guidance appended after the base preset's systemAddendum. */
  systemAddendum: string;
  /** Optional narrowed allowlist — strict subset of the base preset's tools. */
  tools?: string[];
  description: string;
  createdAt: number;
  stateAt: number;
  /** The mined delegation shape this persona was forged from. */
  shapeKey: string;
  provenanceRunIds: string[];
  /** Spawn ledger (recordAgentForgeSpawn). */
  uses: number;
  helpful: number;
  regressions: number;
  /** Mean child-token delta vs the base preset, from paired spawns. */
  avgTokenDelta?: number;
  lastUsedAt?: number;
  archivedPath?: string;
  lastReason?: string;
}

export interface AgentForgeRegistry {
  version: 1;
  personas: Record<string, ForgedAgentPersona>;
}

/** The model-facing synthesizer contract (tool-forge ForgeSynthesizer, for
 *  personas). The gate, not the model, is the trust boundary. */
export interface AgentForgeSynthesizer {
  synthesize(candidate: AgentForgeCandidate, base: SpawnPreset): Promise<{ systemAddendum: string; tools?: string[]; description: string }>;
}

export interface AgentForgeProbeArm {
  /** Parent-judged outcome quality 0..1 (1 = fully handled the subtask). */
  quality: number;
  totalTokens: number;
}

/** The probe harness: replays a mined subtask against persona and base. */
export interface AgentForgeProber {
  probe(prompt: string, persona: { basePreset: string; systemAddendum: string; tools?: string[] }, base: SpawnPreset): Promise<AgentForgeProbeArm>;
}

export interface AgentForgeGateReport {
  ok: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
  errors: string[];
}

export interface AgentForgeSpawnOutcome {
  ok: boolean;
  /** What the child delivered: 'helpful' (parent accepted), 'neutral', or
   *  'regression' (child work was wrong/harmful). */
  helpfulness: 'helpful' | 'neutral' | 'regression';
  tokens: number;
  detail?: string;
}

// ─── Paths ────────────────────────────────────────────────────────────────

/** Canonical project root: accepts the root or its `.mochi` state dir. */
export function agentForgeProjectRoot(projectDir: string): string {
  const p = projectDir.replace(/\/+$/, '');
  return p.endsWith('/.mochi') ? p.slice(0, -'/​.mochi'.length) : p;
}

export function agentForgeDir(projectDir: string): string {
  return join(agentForgeProjectRoot(projectDir), '.mochi', 'agents');
}

export function agentForgeRegistryPath(projectDir: string): string {
  return join(agentForgeDir(projectDir), 'registry.json');
}

function agentForgeLogPath(projectDir: string): string {
  return join(agentForgeDir(projectDir), 'forge-log.jsonl');
}

// ─── Registry ─────────────────────────────────────────────────────────────

export function loadAgentForgeRegistry(projectDir: string): AgentForgeRegistry {
  const path = agentForgeRegistryPath(projectDir);
  if (!existsSync(path)) return { version: 1, personas: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as AgentForgeRegistry;
    if (parsed?.version !== 1 || typeof parsed.personas !== 'object' || parsed.personas == null) {
      return { version: 1, personas: {} };
    }
    return parsed;
  } catch {
    return { version: 1, personas: {} };
  }
}

function saveAgentForgeRegistry(projectDir: string, reg: AgentForgeRegistry): void {
  mkdirSync(agentForgeDir(projectDir), { recursive: true });
  writeFileSync(agentForgeRegistryPath(projectDir), JSON.stringify(reg, null, 2) + '\n');
}

export interface AgentForgeLogEvent {
  event: string;
  name?: string;
  reason?: string;
  at?: number;
  [k: string]: unknown;
}

function appendAgentForgeLog(projectDir: string, e: AgentForgeLogEvent): void {
  mkdirSync(agentForgeDir(projectDir), { recursive: true });
  appendFileSync(agentForgeLogPath(projectDir), JSON.stringify({ at: Date.now(), ...e }) + '\n');
}

// ─── Mining ───────────────────────────────────────────────────────────────

interface MineableSpawn {
  runId: string;
  preset?: string;
  role?: string;
  prompt: string;
  /** Tools the child actually invoked (post-run, from its trajectory). */
  toolsUsed: string[];
  runVerified: boolean;
}

/** Hash a tool fingerprint into a stable shape key component. */
function fingerprintKey(toolsUsed: string[]): string {
  return [...new Set(toolsUsed)].sort().join('+') || 'none';
}

/** Group verifier-passed spawns into delegation shapes worth forging. A
 *  shape survives only when EVERY contributing run was verifier-passed
 *  (same evidence bar as tool-forge) and there are ≥ FORGE_MIN_RUNS. */
export function mineAgentForgeCandidates(spawns: MineableSpawn[]): AgentForgeCandidate[] {
  const verified = spawns.filter((s) => s.runVerified && s.prompt.trim().length > 0);
  const byShape = new Map<string, MineableSpawn[]>();
  for (const s of verified) {
    const key = `${s.preset ?? s.role ?? 'bare'}::${fingerprintKey(s.toolsUsed)}`;
    const list = byShape.get(key) ?? [];
    list.push(s);
    byShape.set(key, list);
  }
  const out: AgentForgeCandidate[] = [];
  for (const [key, list] of byShape) {
    if (list.length < FORGE_MIN_RUNS) continue;
    const [presetPart, fp] = key.split('::');
    const basePreset = resolvePreset(presetPart)?.name ?? pickBaseForTools(list[0].toolsUsed);
    out.push({
      shapeKey: key,
      basePreset,
      provenanceRunIds: list.map((s) => s.runId),
      observedTools: fp === 'none' ? [] : fp.split('+'),
      avgPromptChars: Math.round(list.reduce((a, s) => a + s.prompt.length, 0) / list.length),
      promptSamples: list.slice(0, 3).map((s) => s.prompt.slice(0, 200)),
    });
  }
  return out;
}

/** Best-fit base preset from the tools a child actually used: prefer the
 *  narrowest preset whose allowlist covers the observed set. */
function pickBaseForTools(toolsUsed: string[]): string {
  const used = new Set(toolsUsed);
  let best: { name: string; size: number } | undefined;
  for (const [name, preset] of Object.entries(SPAWN_PRESETS)) {
    const allow = new Set(preset.tools);
    const covers = [...used].every((t) => allow.has(t));
    if (covers && (best == null || preset.tools.length < best.size)) {
      best = { name, size: preset.tools.length };
    }
  }
  return best?.name ?? 'explorer';
}

// ─── Gate ─────────────────────────────────────────────────────────────────

/** Validate a synthesized persona against its base preset. Static checks:
 *  structure, addendum cap, allowlist SUBSET (never widening — mutating
 *  tools absent from the base are unreachable by construction). */
export function validateForgedPersona(
  candidate: AgentForgeCandidate,
  base: SpawnPreset,
  synth: { systemAddendum: string; tools?: string[]; description: string },
): AgentForgeGateReport {
  const checks: AgentForgeGateReport['checks'] = [];
  const errors: string[] = [];
  const check = (name: string, ok: boolean, detail?: string) => {
    checks.push({ name, ok, detail });
    if (!ok) errors.push(detail ?? `${name} failed`);
  };

  check('addendum-nonempty', synth.systemAddendum.trim().length > 0, 'synthesized addendum is empty');
  check(
    'addendum-cap',
    synth.systemAddendum.length <= FORGE_MAX_ADDENDUM_CHARS,
    `addendum ${synth.systemAddendum.length} chars > cap ${FORGE_MAX_ADDENDUM_CHARS}`,
  );
  check('description-nonempty', synth.description.trim().length > 0, 'synthesized description is empty');

  if (synth.tools != null) {
    const baseAllow = new Set(base.tools);
    const widened = synth.tools.filter((t) => !baseAllow.has(t));
    check(
      'allowlist-subset',
      widened.length === 0,
      widened.length ? `persona adds tools outside base preset: ${widened.join(', ')}` : undefined,
    );
    const illegal = synth.tools.filter((t) => MUTATING_TOOL_NAMES.has(t) && !base.tools.includes(t));
    check('allowlist-no-mutation-escalation', illegal.length === 0, illegal.length ? `mutation tools not in base: ${illegal.join(', ')}` : undefined);
    check('allowlist-nonempty', synth.tools.length > 0, 'persona allowlist is empty');
  }

  check('base-known', SPAWN_PRESETS[candidate.basePreset] != null, `unknown base preset ${candidate.basePreset}`);
  check('provenance-nonempty', candidate.provenanceRunIds.length >= FORGE_MIN_RUNS, `only ${candidate.provenanceRunIds.length} provenance runs < ${FORGE_MIN_RUNS}`);

  return { ok: errors.length === 0, checks, errors };
}

/** Live probe gate: replay a mined subtask, persona vs base preset, 2 seeds
 *  per arm. Persona survives only if mean quality ≥ base AND tokens within
 *  ratio. Honest ceiling: no prober, no gate, no persist. */
export async function probeForgedPersona(
  candidate: AgentForgeCandidate,
  persona: { basePreset: string; systemAddendum: string; tools?: string[] },
  prober: AgentForgeProber,
): Promise<AgentForgeGateReport & { personaArm: AgentForgeProbeArm[]; baseArm: AgentForgeProbeArm[] }> {
  const base = SPAWN_PRESETS[persona.basePreset];
  const checks: AgentForgeGateReport['checks'] = [];
  const errors: string[] = [];
  const check = (name: string, ok: boolean, detail?: string) => {
    checks.push({ name, ok, detail });
    if (!ok) errors.push(detail ?? `${name} failed`);
  };

  const prompt = candidate.promptSamples[0] ?? '';
  const personaArm: AgentForgeProbeArm[] = [];
  const baseArm: AgentForgeProbeArm[] = [];
  for (let seed = 0; seed < FORGE_PROBE_SEEDS; seed++) {
    personaArm.push(await prober.probe(prompt, persona, base));
    baseArm.push(await prober.probe(prompt, { basePreset: base.name, systemAddendum: base.systemAddendum, tools: base.tools }, base));
  }
  const mean = (xs: AgentForgeProbeArm[], pick: (a: AgentForgeProbeArm) => number) => xs.reduce((s, x) => s + pick(x), 0) / xs.length;
  const pq = mean(personaArm, (x) => x.quality);
  const bq = mean(baseArm, (x) => x.quality);
  const pt = mean(personaArm, (x) => x.totalTokens);
  const bt = mean(baseArm, (x) => x.totalTokens);
  check('probe-quality', pq >= bq, `persona quality ${pq.toFixed(2)} < base ${bq.toFixed(2)}`);
  check('probe-cost', bt === 0 || pt / bt <= FORGE_PROBE_MAX_TOKEN_RATIO, `persona tokens ${pt.toFixed(0)} > ${FORGE_PROBE_MAX_TOKEN_RATIO}× base ${bt.toFixed(0)}`);
  return { ok: errors.length === 0, checks, errors, personaArm, baseArm };
}

// ─── Persist / lifecycle ──────────────────────────────────────────────────

/** Persist a GATED persona (probation). Call only after validate+probe pass. */
export function persistForgedPersona(
  projectDir: string,
  candidate: AgentForgeCandidate,
  synth: { systemAddendum: string; tools?: string[]; description: string },
  gate: AgentForgeGateReport,
): ForgedAgentPersona | { error: string } {
  if (!gate.ok) return { error: `refusing to persist: gate failed — ${gate.errors.join('; ')}` };
  const name = candidate.shapeKey.split('::')[0].replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'forged-agent';
  const reg = loadAgentForgeRegistry(projectDir);
  let finalName = name;
  let n = 2;
  while (reg.personas[finalName] != null) finalName = `${name}-${n++}`;
  const now = Date.now();
  const persona: ForgedAgentPersona = {
    name: finalName,
    state: 'probation',
    basePreset: candidate.basePreset,
    shapeKey: candidate.shapeKey,
    systemAddendum: synth.systemAddendum,
    tools: synth.tools,
    description: synth.description,
    createdAt: now,
    stateAt: now,
    provenanceRunIds: candidate.provenanceRunIds,
    uses: 0,
    helpful: 0,
    regressions: 0,
  };
  reg.personas[finalName] = persona;
  saveAgentForgeRegistry(projectDir, reg);
  appendAgentForgeLog(projectDir, {
    event: 'forged',
    name: finalName,
    reason: `probe-pass: quality ${gate.checks.find((c) => c.name === 'probe-quality')?.detail ?? 'ok'}`,
    provenanceRunIds: candidate.provenanceRunIds.length,
  });
  return persona;
}

/** Ledger one real spawn of a forged persona. */
export function recordAgentForgeSpawn(projectDir: string, name: string, outcome: AgentForgeSpawnOutcome): ForgedAgentPersona | undefined {
  const reg = loadAgentForgeRegistry(projectDir);
  const p = reg.personas[name];
  if (!p) return undefined;
  p.uses++;
  if (outcome.ok && outcome.helpfulness === 'helpful') p.helpful++;
  if (outcome.helpfulness === 'regression') p.regressions++;
  p.lastUsedAt = Date.now();
  if (p.avgTokenDelta == null) p.avgTokenDelta = outcome.tokens;
  else p.avgTokenDelta = Math.round(p.avgTokenDelta * 0.7 + outcome.tokens * 0.3);
  // Lifecycle: promote on the tool-forge bar — enough helpful uses, zero
  // regressions. Discard on a regression (personas guide judgment calls; a
  // wrong one should not get a second chance to be wrong confidently).
  if (p.state === 'probation') {
    if (p.regressions > FORGE_PROMOTE_MAX_REGRESSIONS) {
      p.state = 'discarded';
      p.stateAt = Date.now();
      p.lastReason = `discarded: ${p.regressions} regression(s) in ${p.uses} uses`;
      appendAgentForgeLog(projectDir, { event: 'discarded', name, reason: p.lastReason });
    } else if (p.helpful >= FORGE_PROMOTE_MIN_USES) {
      p.state = 'active';
      p.stateAt = Date.now();
      p.lastReason = `promoted: ${p.helpful} helpful uses, 0 regressions`;
      appendAgentForgeLog(projectDir, { event: 'promoted', name, reason: p.lastReason });
    }
  }
  saveAgentForgeRegistry(projectDir, reg);
  return p;
}

/** Forge-agents analog of trimForgedProbationTools: drop stale-probation
 *  personas from the resolvable set. Returns names moved out. */
export function trimStaleForgedPersonas(projectDir: string, now: number = Date.now()): string[] {
  const reg = loadAgentForgeRegistry(projectDir);
  const trimmed: string[] = [];
  for (const p of Object.values(reg.personas)) {
    if (p.state !== 'probation') continue;
    const last = p.lastUsedAt ?? p.stateAt;
    if (now - last > FORGE_PROBATION_STALE_MS) {
      p.state = 'discarded';
      p.stateAt = now;
      p.lastReason = 'discarded: stale probation (never helpful within the window)';
      trimmed.push(p.name);
      appendAgentForgeLog(projectDir, { event: 'discarded', name: p.name, reason: p.lastReason });
    }
  }
  if (trimmed.length) saveAgentForgeRegistry(projectDir, reg);
  return trimmed;
}

/** Operator discard (CLI): mark a persona dead + archive it out of the
 *  resolvable set. Returns false when nothing lived under that name. */
export function discardForgedPersona(projectDir: string, name: string, reason: string): boolean {
  const reg = loadAgentForgeRegistry(projectDir);
  const p = reg.personas[name];
  if (!p || p.state === 'discarded' || p.state === 'disabled') return false;
  p.state = 'discarded';
  p.stateAt = Date.now();
  p.lastReason = reason;
  saveAgentForgeRegistry(projectDir, reg);
  appendAgentForgeLog(projectDir, { event: 'archived', name, reason });
  return true;
}

/** Pull-in evaluation (CLI): stale-probation trim + log report. Promotion
 *  and regression discards happen at spawn time (recordAgentForgeSpawn). */
export function evaluateAgentForgeLifecycle(projectDir: string, now: number = Date.now()): { promoted: string[]; trimmed: string[] } {
  const trimmed = trimStaleForgedPersonas(projectDir, now);
  const reg = loadAgentForgeRegistry(projectDir);
  const promoted = Object.values(reg.personas).filter((p) => p.state === 'active' && p.stateAt >= now - 60_000).map((p) => p.name);
  return { promoted, trimmed };
}

/** Resolve a forged persona to a SpawnPreset-shaped spawn config. Names are
 *  addressed as `forged/<name>`. Access NEVER widens: the base preset's
 *  allowlist and access level always apply; the persona only narrows. */
export function resolveForgedPersona(projectDir: string, name: string): SpawnPreset | undefined {
  const reg = loadAgentForgeRegistry(projectDir);
  const p = reg.personas[name];
  if (!p || (p.state !== 'probation' && p.state !== 'active')) return undefined;
  const base = resolvePreset(p.basePreset);
  if (!base) return undefined;
  return {
    ...base,
    name: `forged/${p.name}`,
    tools: p.tools ? base.tools.filter((t) => p.tools!.includes(t)) : base.tools,
    systemAddendum: `${base.systemAddendum}\n\n${p.systemAddendum}`,
    description: p.description,
  };
}

/** List forged personas for `mochi forge-agents` / status surfaces. */
export function listForgedPersonas(projectDir: string): ForgedAgentPersona[] {
  return Object.values(loadAgentForgeRegistry(projectDir).personas).sort((a, b) => b.createdAt - a.createdAt);
}

// ─── Mining from the trajectory corpus ────────────────────────────────────

/** Lift delegation shapes this project actually exercises out of the SAME
 *  durable corpus tool-forge mines (.mochi/exports/trajectory-*.jsonl):
 *  each ok `subagent` step in a verifier-passed record becomes one
 *  MineableSpawn; the child's observed tools are the successful steps after
 *  its call (parent + child share the run record), capped at 12. The pure
 *  miner above does all the evidence work — this is only an adapter. */
export function mineAgentForgeCandidatesFromCorpus(
  records: readonly TrajectoryRecord[],
  opts: { maxCandidates?: number } = {},
): AgentForgeCandidate[] {
  const spawns: MineableSpawn[] = [];
  for (const rec of records) {
    const verified = isVerifiedRecord(rec);
    for (let i = 0; i < rec.steps.length; i++) {
      const step = rec.steps[i];
      if (step.tool !== 'subagent' || !step.ok) continue;
      const args = (step.args ?? {}) as Record<string, unknown>;
      const prompt = typeof args.prompt === 'string' ? args.prompt : (rec.task?.prompt ?? '');
      if (!prompt.trim()) continue;
      const preset = typeof args.preset === 'string' && args.preset ? args.preset : undefined;
      const role = typeof args.role === 'string' && args.role ? args.role : undefined;
      const toolsUsed = [...new Set(rec.steps.slice(i + 1).filter((s) => s.ok).map((s) => s.tool))].slice(0, 12);
      spawns.push({ runId: rec.runId, ...(preset ? { preset } : {}), ...(role ? { role } : {}), prompt, toolsUsed, runVerified: verified });
    }
  }
  return mineAgentForgeCandidates(spawns).slice(0, opts.maxCandidates ?? 4);
}

// ─── Model synthesizer (the maker: router reasoning tier, LATM) ───────────

const AGENT_FORGE_SYSTEM_PROMPT = `You are Mochi's Agent Forge maker model. A parent agent repeatedly delegates the SAME KIND of subtask to child agents, and the children keep succeeding. You write ONE spawn persona — a delta over an existing spawn preset — so future children of that shape start with the accumulated guidance.

Hard rules (the forge gate enforces them; a violation discards the persona):
- systemAddendum: at most 600 characters of GUIDANCE — how to approach this shape of task, what to check, what to avoid, in what order to work. No tool-instruction escalation, no access changes, no "you may now use X".
- tools: OPTIONAL array of tool names STRICT SUBSET of the base preset's allowlist (given below). Narrow it only when the observed evidence shows those tools are all the shape needs. Omit entirely when unsure.
- description: one sentence, what this persona is for.

Respond with ONLY a JSON object: {"systemAddendum": "...", "description": "..."} or with "tools" added when narrowing is clearly warranted.`;

/** Production synthesizer: the router's reasoning (frontier) tier writes the
 *  persona; the everyday models merely use it. Mirrors tool-forge's maker. */
export function createModelAgentForgeSynthesizer(config: MochiConfig): AgentForgeSynthesizer {
  const provider = createProvider(config.model, 'reasoning');
  return {
    async synthesize(candidate, base) {
      const user = [
        `Base preset: ${base.name} — role ${String(base.role)}, access '${base.access}'.`,
        `Base preset's tool allowlist (persona tools must be a subset): ${base.tools.join(', ')}`,
        `Base preset's existing addendum (yours is APPENDED after it): ${base.systemAddendum.slice(0, 300)}`,
        `Evidence: ${candidate.provenanceRunIds.length} verifier-passed runs delegated this shape.`,
        `Tools the successful children actually used: ${candidate.observedTools.join(', ') || '(none recorded)'}`,
        `Average prompt length: ${candidate.avgPromptChars} chars. Sample prompts:`,
        ...candidate.promptSamples.map((p) => `  - ${p}`),
        'Write the persona now.',
      ].join('\n');
      const res = await provider.chat(
        [{ role: 'system', content: AGENT_FORGE_SYSTEM_PROMPT }, { role: 'user', content: user }],
        [],
        { temperature: 0.2, maxTokens: 1_200 },
      );
      const text = res.content ?? '';
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start < 0 || end <= start) throw new Error('synthesizer returned no JSON object');
      const parsed = JSON.parse(text.slice(start, end + 1)) as { systemAddendum?: string; tools?: string[]; description?: string };
      if (typeof parsed.systemAddendum !== 'string' || typeof parsed.description !== 'string') {
        throw new Error('synthesizer JSON missing systemAddendum/description');
      }
      return {
        systemAddendum: parsed.systemAddendum,
        ...(Array.isArray(parsed.tools) ? { tools: parsed.tools.filter((t): t is string => typeof t === 'string') } : {}),
        description: parsed.description,
      };
    },
  };
}

// ─── Live prober ──────────────────────────────────────────────────────────
// (createAgentForgeProber removed — sweep 2: zero callers repo-wide, incl.
// dynamic/string references. A prober is injectable via
// AgentForgePassOptions.prober; no production or test call site existed.)

// ─── The forge pass (mine → synthesize → gate → persist) ──────────────────

export interface AgentForgePassOptions {
  synthesizer: AgentForgeSynthesizer;
  prober?: AgentForgeProber;
  records?: readonly TrajectoryRecord[];
  /** Max personas to attempt this pass (bounded ambient spend). */
  maxForges?: number;
  now?: number;
}

export interface AgentForgePassResult {
  candidatesFound: number;
  forged: string[];
  discarded: Array<{ name?: string; shapeKey: string; reason: string }>;
  skipped: Array<{ shapeKey: string; reason: string }>;
}

/** One persona forge pass over the trajectory corpus. Mirrors tool-forge's
 *  runForgePass: evidence-mined candidates only, gate decides (never the
 *  model), discarded shapes are not retried on the same evidence. */
export async function runAgentForgePass(projectDir: string, opts: AgentForgePassOptions): Promise<AgentForgePassResult> {
  const now = opts.now ?? Date.now();
  const records = opts.records ?? loadTrajectoryCorpus(projectDir);
  const candidates = mineAgentForgeCandidatesFromCorpus(records);
  const result: AgentForgePassResult = { candidatesFound: candidates.length, forged: [], discarded: [], skipped: [] };
  const reg = loadAgentForgeRegistry(projectDir);
  const maxForges = opts.maxForges ?? 2;
  let attempted = 0;

  for (const candidate of candidates) {
    const prior = Object.values(reg.personas).find((p) => p.shapeKey === candidate.shapeKey && p.state !== 'discarded');
    if (prior) {
      result.skipped.push({ shapeKey: candidate.shapeKey, reason: `already forged as '${prior.name}' (${prior.state})` });
      continue;
    }
    const deadPrior = Object.values(reg.personas).find((p) => p.shapeKey === candidate.shapeKey && p.state === 'discarded');
    if (deadPrior) {
      result.skipped.push({ shapeKey: candidate.shapeKey, reason: `already attempted and discarded (${deadPrior.lastReason ?? 'gate failed'}) — failed personas are not retried on the same evidence` });
      continue;
    }
    if (attempted >= maxForges) {
      result.skipped.push({ shapeKey: candidate.shapeKey, reason: 'pass budget (maxForges) reached' });
      continue;
    }
    attempted++;

    const base = SPAWN_PRESETS[candidate.basePreset];
    if (base == null) {
      result.discarded.push({ shapeKey: candidate.shapeKey, reason: `unknown base preset ${candidate.basePreset}` });
      continue;
    }
    let synth: { systemAddendum: string; tools?: string[]; description: string };
    try {
      synth = await opts.synthesizer.synthesize(candidate, base);
    } catch (err) {
      const reason = `synthesis failed: ${err instanceof Error ? err.message : String(err)}`;
      result.discarded.push({ shapeKey: candidate.shapeKey, reason });
      appendAgentForgeLog(projectDir, { event: 'discarded', shapeKey: candidate.shapeKey, reason, provenanceRunIds: candidate.provenanceRunIds, at: now });
      continue;
    }

    // Static gate first (free); only gate-passing drafts earn a probe.
    const gate = validateForgedPersona(candidate, base, synth);
    if (!gate.ok) {
      result.discarded.push({ shapeKey: candidate.shapeKey, reason: `static gate failed — ${gate.errors.join('; ')}` });
      appendAgentForgeLog(projectDir, { event: 'discarded', shapeKey: candidate.shapeKey, reason: gate.errors.join('; '), provenanceRunIds: candidate.provenanceRunIds, at: now });
      continue;
    }
    // Probe gate (spends tokens). No prober → no persist, ever.
    if (opts.prober == null) {
      result.discarded.push({ shapeKey: candidate.shapeKey, reason: 'no prober configured — persona survives only with live probe evidence' });
      appendAgentForgeLog(projectDir, { event: 'discarded', shapeKey: candidate.shapeKey, reason: 'no prober configured', provenanceRunIds: candidate.provenanceRunIds, at: now });
      continue;
    }
    const probe = await probeForgedPersona(candidate, { basePreset: base.name, systemAddendum: synth.systemAddendum, ...('tools' in synth ? { tools: synth.tools } : {}) }, opts.prober);
    if (!probe.ok) {
      result.discarded.push({ shapeKey: candidate.shapeKey, reason: `probe gate failed — ${probe.errors.join('; ')}` });
      appendAgentForgeLog(projectDir, { event: 'discarded', shapeKey: candidate.shapeKey, reason: probe.errors.join('; '), provenanceRunIds: candidate.provenanceRunIds, at: now });
      continue;
    }

    const persisted = persistForgedPersona(projectDir, candidate, synth, { ok: true, checks: gate.checks, errors: [] });
    if ('error' in persisted) {
      result.discarded.push({ shapeKey: candidate.shapeKey, reason: persisted.error });
      continue;
    }
    result.forged.push(persisted.name);
    appendAgentForgeLog(projectDir, { event: 'forged', name: persisted.name, shapeKey: candidate.shapeKey, provenanceRunIds: candidate.provenanceRunIds, at: now });
  }
  // Same janitor as every forge surface: stale probation never lingers.
  trimStaleForgedPersonas(projectDir, now);
  return result;
}

/** Spawn-site resolution: `forged/<name>` personas first (gated, lifecycle-
 *  managed), then the static SPAWN_PRESETS. Never throws — an unknown forged
 *  name falls through to the static table so a typo'd persona degrades to a
 *  normal spawn instead of a failed delegation. */
export function resolveSpawnPreset(projectDir: string, name: string | undefined): SpawnPreset | undefined {
  if (!name) return undefined;
  const key = name.trim().toLowerCase();
  if (key.startsWith('forged/')) return resolveForgedPersona(projectDir, key.slice('forged/'.length)) ?? undefined;
  return undefined;
}
