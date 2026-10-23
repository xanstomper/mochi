// Autopsy records: a structured, durable trace of what was tried during a
// failed task. Each retry loop iteration records a DebugAttempt (the
// hypothesis that was tested and the evidence it produced); when the task
// finally resolves (success or gives up), the record is finalized and written
// to <workspace>/autopsies/<taskId>.json so it survives restarts and is
// greppable from CLI.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FailureKind, Hypothesis } from './diagnosis.js';
import { redact } from '../security/security.js';
import { mochiStateDir } from '../core/mochi-dir.js';

export interface DebugAttempt {
  attempt: number;          // 1..n, in order of evaluation
  hypothesisId: string;     // stable id from Hypothesis
  hypothesisText: string;   // snapshot of the claim at this moment
  confidenceBefore: number;
  action: string;           // one-line description of what was done (e.g. "ran npx tsc")
  evidence: string;        // captured command output / observation (truncated)
  outcome: 'still_failing' | 'different_failure' | 'resolved' | 'neutral';
  confidenceAfter: number;
  statusAfter: Hypothesis['status'];
  atMs: number;             // wall-clock for traceability
}

/** Repro-synthesis attachment (observability/repro-synth.ts): the outcome
 *  of automatically synthesising a minimal validated reproduction for this
 *  task's failure. Optional — autopsies written before repro synthesis
 *  existed (and tasks that never triggered it) simply omit the field. */
export interface ReproAttachment {
  outcome: 'validated' | 'no-repro' | 'refused';
  /** The synthesised repro invocation, when one was produced. */
  command?: string;
  /** Id of the persisted FAIL_TO_PASS pair, when both directions validated. */
  pairId?: string;
  /** Shrink outcome as after/before bytes, when shrinking ran. */
  shrinkRatio?: number;
  /** One-line account (derivation, refusal reason, or no-repro stage). */
  note: string;
  atMs: number;
}

export interface Autopsy {
  schemaVersion: 1;
  taskId: string;
  agentId: string;
  title: string;
  failureKind: FailureKind | null;
  signals: string[];
  attempts: DebugAttempt[];
  startedAtMs: number;
  finalizedAtMs?: number;
  outcome: 'resolved' | 'unresolved';
  rootCauseHypothesis?: string; // last confirmed/refuted hypothesis
  regressionTestAdded?: string;  // path of any auto-written test
  fixApplied?: string;          // path of the changed source
  repro?: ReproAttachment;       // synthesised reproduction, when attempted
}

function autopsyDir(workspaceDir: string): string {
  // Prefer the canonical `<root>/.mochi/autopsies`. Callers are inconsistent
  // about handing us the project root vs the state dir, so normalize; but keep
  // the historical bare `<workspace>/autopsies` fallback for workspaces that
  // never created a `.mochi` dir (e.g. plain directories, tests).
  const state = mochiStateDir(workspaceDir);
  if (existsSync(state) || existsSync(resolve(workspaceDir, '.mochi'))) return resolve(state, 'autopsies');
  return resolve(workspaceDir, 'autopsies');
}

function autopsyPath(workspaceDir: string, taskId: string): string {
  const state = mochiStateDir(workspaceDir);
  const p1 = resolve(state, 'autopsies', `${taskId}.json`);
  if (existsSync(p1)) return p1;
  // Legacy layouts written before state dirs were normalized: a bare
  // `<workspace>/autopsies` or a double-nested `<workspace>/.mochi/.mochi`.
  const p2 = resolve(workspaceDir, 'autopsies', `${taskId}.json`);
  if (existsSync(p2)) return p2;
  const p3 = resolve(workspaceDir, '.mochi', '.mochi', 'autopsies', `${taskId}.json`);
  if (existsSync(p3)) return p3;
  return resolve(autopsyDir(workspaceDir), `${taskId}.json`);
}

/** Load an existing autopsy (resuming a long-running task) or start a new one. */
export function loadOrCreateAutopsy(
  workspaceDir: string,
  taskId: string,
  agentId: string,
  title: string,
): Autopsy {
  const path = autopsyPath(workspaceDir, taskId);
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      if (raw && raw.schemaVersion === 1) return raw as Autopsy;
    } catch { /* fall through and recreate */ }
  }
  return {
    schemaVersion: 1,
    taskId,
    agentId,
    title,
    failureKind: null,
    signals: [],
    attempts: [],
    startedAtMs: Date.now(),
    outcome: 'unresolved',
  };
}

/** Append one attempt and write atomically; returns the new autopsy. */
export function appendAttempt(
  workspaceDir: string,
  autopsy: Autopsy,
  attempt: DebugAttempt,
): Autopsy {
  const next: Autopsy = { ...autopsy, attempts: [...autopsy.attempts, attempt] };
  mkdirSync(autopsyDir(workspaceDir), { recursive: true });
  writeFileSync(autopsyPath(workspaceDir, autopsy.taskId), redact(JSON.stringify(next, null, 2)));
  return next;
}

/** Attach a repro-synthesis result and persist (mirrors appendAttempt). */
export function attachRepro(
  workspaceDir: string,
  autopsy: Autopsy,
  repro: Omit<ReproAttachment, 'atMs'> & { atMs?: number },
): Autopsy {
  const next: Autopsy = { ...autopsy, repro: { ...repro, atMs: repro.atMs ?? Date.now() } };
  mkdirSync(autopsyDir(workspaceDir), { recursive: true });
  writeFileSync(autopsyPath(workspaceDir, autopsy.taskId), redact(JSON.stringify(next, null, 2)));
  return next;
}

/** Mark the autopsy complete and persist. */
export function finalizeAutopsy(
  workspaceDir: string,
  autopsy: Autopsy,
  fields: { outcome: 'resolved' | 'unresolved'; rootCauseHypothesis?: string; regressionTestAdded?: string; fixApplied?: string },
): Autopsy {
  const next: Autopsy = { ...autopsy, finalizedAtMs: Date.now(), ...fields };
  mkdirSync(autopsyDir(workspaceDir), { recursive: true });
  writeFileSync(autopsyPath(workspaceDir, autopsy.taskId), redact(JSON.stringify(next, null, 2)));
  return next;
}

/** One-line summary suitable for embedding in user-facing output. */
export function autopsyOneLine(a: Autopsy): string {
  const kind = a.failureKind ?? 'unknown';
  const tried = a.attempts.length;
  const outcome = a.outcome;
  const confirmed = a.attempts.filter((x) => x.statusAfter === 'confirmed').length;
  return `Autopsy ${a.taskId.slice(0, 8)}: kind=${kind} attempts=${tried} confirmed=${confirmed} outcome=${outcome}`;
}