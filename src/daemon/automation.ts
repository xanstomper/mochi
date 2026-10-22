// Durable general automation — scheduled/triggered tasks whose execution
// is JOURNAL-BACKED, so a run killed mid-flight (SIGKILL, power loss,
// daemon restart) resumes exactly where it stopped instead of restarting
// or duplicating side effects.
//
// Why this exists next to cron.ts: a cron job is a prompt + a cadence, and
// its only durability is "bump nextRun after the goal returns". If the
// daemon dies mid-goal, the bump never persists, the job re-fires on the
// next start, and the goal re-executes EVERY side effect. Automations fix
// that by composing with the run journal (src/agent/run-journal.ts) — the
// same machinery the agent loop uses — rather than inventing a second
// durability system:
//
//   - Every firing has a deterministic SLOT id (the scheduled fire time,
//     or the hash of the observed file/URL state). Re-detecting the same
//     slot after a crash IS the same firing.
//   - Before any step runs, the slot is persisted as the automation's
//     `activeSlot`. A later evaluation resumes an active slot BEFORE
//     looking at triggers, whatever the trigger state says.
//   - Steps execute through RunJournal.executeStep under runId
//     `automation-<id>-<slot>`: a step a previous process completed is
//     REPLAYED from the journal (its result returned, its side effect
//     never re-executed); the first un-journaled step runs live. That is
//     the exactly-once contract, and it survives SIGKILL because journal
//     appends are fsynced before the step's result is handed back.
//   - `goal` steps additionally thread the slot's journal runId into the
//     agent loop (Runtime.runGoal journalRunId), so the loop's own
//     tool-step journal uses a stable identity across resumes too.
//
// Triggers: `schedule` reuses cron.ts's schedule math; `file-change`
// polls a path fingerprint (mtime:size, the watch.ts discipline);
// `url-change` polls a URL and fires when its body hash changes. Trigger
// state persists in the store, so a change that happens while the daemon
// is down fires once on the next evaluation (catch-up), never in a loop.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { mochiStateDir } from '../core/mochi-dir.js';
import { atomicWriteFileSync } from '../core/atomic-fs.js';
import { mkdirSync } from 'node:fs';
import { RunJournal } from '../agent/run-journal.js';
import { isRunnable, nextRunFor } from './cron.js';
import { runArgv, runShellString } from '../exec.js';
import { buildDriverArgs, driverScript, summarizeResult, type BrowserDriverArgsInput } from '../tools/browser.js';

export type AutomationTrigger =
  | { type: 'schedule'; schedule: string }
  | { type: 'file-change'; paths: string[]; debounceMs?: number }
  | { type: 'url-change'; url: string; intervalMs?: number };

export type AutomationStep =
  | { id: string; kind: 'shell'; command: string }
  | { id: string; kind: 'goal'; prompt: string }
  | { id: string; kind: 'fetch'; url: string }
  | { id: string; kind: 'browser'; commands: BrowserDriverArgsInput[] };

export interface Automation {
  id: string;
  name: string;
  trigger: AutomationTrigger;
  steps: AutomationStep[];
  enabled: boolean;
  createdAt: number;
  /** Completed runs. */
  runs: number;
  lastRunAt: number | null;
  lastSlot: string | null;
  /** The slot currently executing (or killed mid-execution). Persisted
   *  BEFORE the first step runs — the resume handle. */
  activeSlot: string | null;
  activeSlotAt: number | null;
  // ── trigger state (persisted; see header) ──
  nextRun?: number;
  fingerprint?: string;
  urlHash?: string;
  lastPollAt?: number;
}

export interface AutomationDeps {
  now?: () => number;
  /** Execute a goal step. The daemon injects Runtime.runGoal with the
   *  journal runId threaded through; tests inject a fake. */
  runGoal?: (prompt: string, journalRunId: string) => Promise<string>;
  runShell?: (command: string) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  fetchText?: (url: string) => Promise<{ status: number; body: string }>;
  stat?: (p: string) => { mtimeMs: number; size: number } | null;
  runBrowserCommand?: (input: BrowserDriverArgsInput) => Promise<string>;
}

const sha16 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

// ── Store ────────────────────────────────────────────────────────────────

function storePath(dir: string): string {
  return resolve(mochiStateDir(dir), 'automations.json');
}

function validStep(raw: unknown): AutomationStep | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== 'string' || !s.id || s.id.length > 64) return null;
  if (s.kind === 'shell' && typeof s.command === 'string' && s.command.trim()) {
    return { id: s.id, kind: 'shell', command: s.command.slice(0, 4000) };
  }
  if (s.kind === 'goal' && typeof s.prompt === 'string' && s.prompt.trim()) {
    return { id: s.id, kind: 'goal', prompt: s.prompt.slice(0, 8000) };
  }
  if (s.kind === 'fetch' && typeof s.url === 'string' && /^https?:\/\//i.test(s.url)) {
    return { id: s.id, kind: 'fetch', url: s.url.slice(0, 2000) };
  }
  if (s.kind === 'browser' && Array.isArray(s.commands) && s.commands.length > 0 && s.commands.length <= 20) {
    const commands: BrowserDriverArgsInput[] = [];
    for (const c of s.commands) {
      if (!c || typeof c !== 'object' || typeof (c as BrowserDriverArgsInput).command !== 'string') return null;
      commands.push(c as BrowserDriverArgsInput);
    }
    return { id: s.id, kind: 'browser', commands };
  }
  return null;
}

function validTrigger(raw: unknown): AutomationTrigger | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  if (t.type === 'schedule' && typeof t.schedule === 'string' && isRunnable(t.schedule)) {
    return { type: 'schedule', schedule: t.schedule };
  }
  if (t.type === 'file-change' && Array.isArray(t.paths) && t.paths.length > 0 && t.paths.every((p) => typeof p === 'string' && p)) {
    return { type: 'file-change', paths: (t.paths as string[]).slice(0, 50), ...(typeof t.debounceMs === 'number' ? { debounceMs: t.debounceMs } : {}) };
  }
  if (t.type === 'url-change' && typeof t.url === 'string' && /^https?:\/\//i.test(t.url)) {
    return { type: 'url-change', url: t.url.slice(0, 2000), ...(typeof t.intervalMs === 'number' ? { intervalMs: t.intervalMs } : {}) };
  }
  return null;
}

export function loadAutomations(dir: string): Automation[] {
  try {
    const f = storePath(dir);
    if (!existsSync(f)) return [];
    const raw = JSON.parse(readFileSync(f, 'utf8'));
    if (!Array.isArray(raw)) return [];
    const out: Automation[] = [];
    for (const a of raw) {
      if (!a || typeof a !== 'object') continue;
      const r = a as Record<string, unknown>;
      if (typeof r.id !== 'string' || typeof r.name !== 'string') continue;
      const trigger = validTrigger(r.trigger);
      if (!trigger) continue;
      if (!Array.isArray(r.steps)) continue;
      const steps = r.steps.map(validStep).filter((s): s is AutomationStep => s !== null);
      if (steps.length === 0 || steps.length !== r.steps.length) continue;
      if (new Set(steps.map((s) => s.id)).size !== steps.length) continue; // step ids must be unique — they are journal stepIds
      out.push({
        id: r.id.slice(0, 32),
        name: r.name.slice(0, 200),
        trigger,
        steps,
        enabled: r.enabled !== false,
        createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
        runs: typeof r.runs === 'number' && r.runs >= 0 ? Math.floor(r.runs) : 0,
        lastRunAt: typeof r.lastRunAt === 'number' ? r.lastRunAt : null,
        lastSlot: typeof r.lastSlot === 'string' ? r.lastSlot : null,
        activeSlot: typeof r.activeSlot === 'string' ? r.activeSlot : null,
        activeSlotAt: typeof r.activeSlotAt === 'number' ? r.activeSlotAt : null,
        ...(typeof r.nextRun === 'number' ? { nextRun: r.nextRun } : {}),
        ...(typeof r.fingerprint === 'string' ? { fingerprint: r.fingerprint } : {}),
        ...(typeof r.urlHash === 'string' ? { urlHash: r.urlHash } : {}),
        ...(typeof r.lastPollAt === 'number' ? { lastPollAt: r.lastPollAt } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function saveAutomations(dir: string, autos: Automation[]): void {
  mkdirSync(mochiStateDir(dir), { recursive: true });
  // Atomic: the daemon re-reads this on every tick, and a torn write during
  // a crash must never lose the activeSlot resume handle.
  atomicWriteFileSync(storePath(dir), JSON.stringify(autos, null, 2));
}

export function addAutomation(
  dir: string,
  input: { name: string; trigger: AutomationTrigger; steps: AutomationStep[] },
): { id?: string; error?: string } {
  if (!input.name || !input.name.trim()) return { error: 'Automation name must be a non-empty string.' };
  const trigger = validTrigger(input.trigger);
  if (!trigger) return { error: 'Invalid trigger (schedule must parse like a cron spec; file-change needs paths; url-change needs an http(s) URL).' };
  if (!Array.isArray(input.steps) || input.steps.length === 0) return { error: 'Automation needs at least one step.' };
  const steps = input.steps.map(validStep);
  if (steps.some((s) => s === null)) return { error: 'A step is malformed (shell needs command, goal needs prompt, fetch/browser need url/commands).' };
  const cleanSteps = steps as AutomationStep[];
  if (new Set(cleanSteps.map((s) => s.id)).size !== cleanSteps.length) return { error: 'Step ids must be unique within an automation.' };
  const autos = loadAutomations(dir);
  const auto: Automation = {
    id: randomUUID().slice(0, 8),
    name: input.name.trim().slice(0, 200),
    trigger,
    steps: cleanSteps,
    enabled: true,
    createdAt: Date.now(),
    runs: 0,
    lastRunAt: null,
    lastSlot: null,
    activeSlot: null,
    activeSlotAt: null,
  };
  autos.push(auto);
  saveAutomations(dir, autos);
  return { id: auto.id };
}

export function removeAutomation(dir: string, id: string): boolean {
  const autos = loadAutomations(dir);
  const next = autos.filter((a) => a.id !== id);
  if (next.length === autos.length) return false;
  saveAutomations(dir, next);
  return true;
}

export function listAutomations(dir: string): Automation[] {
  return loadAutomations(dir);
}

// ── Trigger evaluation ───────────────────────────────────────────────────

export interface DueAutomation { auto: Automation; slotId: string; reason: 'resume' | 'schedule' | 'file-change' | 'url-change' }

function fileFingerprint(paths: string[], stat: NonNullable<AutomationDeps['stat']>): string {
  return paths.map((p) => {
    const st = stat(p);
    return st ? `${p}:${st.mtimeMs}:${st.size}` : `${p}:-`;
  }).join('|');
}

/**
 * Evaluate every automation's trigger against current state. Persists
 * trigger-state transitions (baselines, nextRun initialization) and
 * returns what should run now. An automation with an activeSlot is
 * ALWAYS returned first as a resume — an unfinished firing outranks any
 * new trigger, whatever the trigger state has done since.
 */
export async function evaluateAutomations(dir: string, deps: AutomationDeps = {}): Promise<DueAutomation[]> {
  const now = deps.now ?? Date.now;
  const stat = deps.stat ?? ((p: string) => { try { const s = statSync(p); return { mtimeMs: s.mtimeMs, size: s.size }; } catch { return null; } });
  const fetchText = deps.fetchText ?? (async (url: string) => {
    const res = await fetch(url);
    return { status: res.status, body: await res.text() };
  });
  const autos = loadAutomations(dir);
  const due: DueAutomation[] = [];
  let dirty = false;
  for (const auto of autos) {
    if (auto.activeSlot) {
      if (auto.enabled) due.push({ auto, slotId: auto.activeSlot, reason: 'resume' });
      continue;
    }
    if (!auto.enabled) continue;
    const t = auto.trigger;
    if (t.type === 'schedule') {
      if (auto.nextRun === undefined) {
        const n = nextRunFor(t.schedule, now());
        if (n !== null) { auto.nextRun = n; dirty = true; }
        continue;
      }
      if (auto.nextRun <= now()) {
        // The slot IS the scheduled time: re-detecting this overdue
        // nextRun after a crash re-derives the same slot, and the
        // journal makes the re-run a resume, not a duplicate.
        due.push({ auto, slotId: `s${auto.nextRun}`, reason: 'schedule' });
      }
    } else if (t.type === 'file-change') {
      const fp = fileFingerprint(t.paths.map((p) => resolve(dir, p)), stat);
      if (auto.fingerprint === undefined) { auto.fingerprint = fp; dirty = true; continue; } // first sight = baseline, no fire
      if (fp !== auto.fingerprint) {
        auto.fingerprint = fp; dirty = true;
        due.push({ auto, slotId: `f${sha16(fp)}`, reason: 'file-change' });
      }
    } else if (t.type === 'url-change') {
      const interval = t.intervalMs ?? 60_000;
      if (auto.lastPollAt !== undefined && now() - auto.lastPollAt < interval) continue;
      auto.lastPollAt = now(); dirty = true;
      let body: string;
      try {
        body = (await fetchText(t.url)).body;
      } catch {
        continue; // unreachable URL is not a change; retry next interval
      }
      const hash = sha16(body);
      if (auto.urlHash === undefined) { auto.urlHash = hash; dirty = true; continue; } // baseline
      if (hash !== auto.urlHash) {
        auto.urlHash = hash; dirty = true;
        due.push({ auto, slotId: `u${hash}`, reason: 'url-change' });
      }
    }
  }
  if (dirty) saveAutomations(dir, autos);
  // Resumes first: finishing yesterday's interrupted run outranks new work.
  due.sort((a, b) => (a.reason === 'resume' ? 0 : 1) - (b.reason === 'resume' ? 0 : 1));
  return due;
}

// ── Execution ────────────────────────────────────────────────────────────

export interface AutomationRunResult {
  automationId: string;
  slotId: string;
  executed: string[];
  replayed: string[];
  summary: string;
}

async function defaultRunBrowserCommand(input: BrowserDriverArgsInput): Promise<string> {
  const args = buildDriverArgs({ ...input, timeoutMs: input.timeoutMs ?? 45_000 });
  const res = await runArgv(process.execPath, [driverScript(), ...args], { timeoutMs: (input.timeoutMs ?? 45_000) + 4000, killGraceMs: 3000 }).catch((e: Error) => ({ stdout: '', stderr: e.message, code: 1 }));
  return summarizeResult(input.command, (res.stdout || '').trim() || `[browser exit ${res.code}] ${(res.stderr || '').slice(0, 300)}`);
}

async function executeStepBody(step: AutomationStep, journalRunId: string, deps: AutomationDeps): Promise<unknown> {
  switch (step.kind) {
    case 'shell': {
      const run = deps.runShell ?? (async (command: string) => {
        const r = await runShellString(command, { timeoutMs: 120_000, maxOutput: 1024 * 1024 });
        return { code: r.code, stdout: r.stdout, stderr: r.stderr };
      });
      const r = await run(step.command);
      if ((r.code ?? 1) !== 0) throw new Error(`shell step "${step.id}" exited ${r.code}: ${(r.stderr || r.stdout).slice(0, 300)}`);
      return { code: r.code, stdout: r.stdout.slice(-2000) };
    }
    case 'goal': {
      if (!deps.runGoal) throw new Error(`goal step "${step.id}" has no goal runner wired (daemon provides Runtime.runGoal)`);
      return { summary: await deps.runGoal(step.prompt, `${journalRunId}:${step.id}`) };
    }
    case 'fetch': {
      const f = deps.fetchText ?? (async (url: string) => {
        const res = await fetch(url);
        return { status: res.status, body: await res.text() };
      });
      const r = await f(step.url);
      return { status: r.status, bytes: r.body.length, hash: sha16(r.body) };
    }
    case 'browser': {
      const runCmd = deps.runBrowserCommand ?? defaultRunBrowserCommand;
      const outputs: string[] = [];
      for (const c of step.commands) outputs.push(await runCmd(c));
      return { outputs };
    }
  }
}

/**
 * Run one automation firing. The slot is persisted as active BEFORE the
 * first step executes, and every step runs through the run journal — so
 * this function is safe to call again with the same slotId after a
 * SIGKILL: completed steps replay (no side effect repeats), the rest
 * execute, and the run completes exactly once. On success the trigger
 * state advances (schedule: next fire computed from the slot time).
 */
export async function runAutomation(dir: string, autoIn: Automation, slotId: string, deps: AutomationDeps = {}): Promise<AutomationRunResult> {
  const now = deps.now ?? Date.now;
  // Persist the resume handle first — from here on, any crash leaves a
  // discoverable activeSlot pointing at this exact firing.
  const autos = loadAutomations(dir);
  const auto = autos.find((a) => a.id === autoIn.id) ?? autoIn;
  auto.activeSlot = slotId;
  auto.activeSlotAt = now();
  saveAutomations(dir, autos);

  const runId = `automation-${auto.id}-${slotId}`;
  const journal = RunJournal.open({ baseDir: mochiStateDir(dir), runId, taskId: auto.id });
  journal.beginRun({ taskId: auto.id, title: auto.name });
  const executed: string[] = [];
  const replayed: string[] = [];
  try {
    for (const step of auto.steps) {
      const { replayed: wasReplay } = await journal.executeStep({
        stepId: step.id,
        toolName: `automation:${step.kind}`,
        args: step as unknown as Record<string, unknown>,
        execute: () => executeStepBody(step, runId, deps),
      });
      (wasReplay ? replayed : executed).push(step.id);
    }
  } catch (e) {
    journal.finishRun(`failed: ${e instanceof Error ? e.message : String(e)}`);
    // activeSlot STAYS set: the next evaluation resumes this slot and the
    // journal retries the failed step (failures are never replayed).
    throw e;
  }
  journal.finishRun('completed');

  const fresh = loadAutomations(dir);
  const rec = fresh.find((a) => a.id === auto.id);
  if (rec) {
    rec.activeSlot = null;
    rec.activeSlotAt = null;
    rec.runs += 1;
    rec.lastRunAt = now();
    rec.lastSlot = slotId;
    if (rec.trigger.type === 'schedule') {
      const slotTime = slotId.startsWith('s') ? Number(slotId.slice(1)) : NaN;
      const from = Number.isFinite(slotTime) ? slotTime : now();
      const n = nextRunFor(rec.trigger.schedule, from + 1);
      if (n !== null) rec.nextRun = n;
    }
    saveAutomations(dir, fresh);
  }
  return {
    automationId: auto.id,
    slotId,
    executed,
    replayed,
    summary: `automation "${auto.name}" slot ${slotId}: ${executed.length} step(s) executed, ${replayed.length} replayed`,
  };
}

/**
 * One daemon tick of automation work: resume interrupted slots and fire
 * due triggers, serially. Never throws — a failing automation is
 * reported and left with its activeSlot set for the next tick's resume.
 */
export async function runDueAutomations(dir: string, deps: AutomationDeps = {}): Promise<AutomationRunResult[]> {
  const results: AutomationRunResult[] = [];
  let due: DueAutomation[];
  try {
    due = await evaluateAutomations(dir, deps);
  } catch {
    return results;
  }
  for (const d of due) {
    try {
      results.push(await runAutomation(dir, d.auto, d.slotId, deps));
    } catch (e) {
      console.warn(`[automation] "${d.auto.name}" slot ${d.slotId} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return results;
}
