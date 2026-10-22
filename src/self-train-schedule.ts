// `mochi self-train --schedule` core: nightly-learning preset as a tested
// unit (cli.ts stays a thin adapter). Composes the cron prompt an agent can
// actually execute (review traces/lessons, fix one real gap with tests, run
// the curator) and validates the schedule spec with the daemon's own parser.
//
// D11: the installed nightly job now delegates to the sleep-time
// consolidation ORCHESTRATOR (`mochi sleeptime`, src/sleeptime/) — a real
// pipeline module with a hard spend cap, per-night idempotency, and a
// structured morning report — instead of asking an agent to improvise the
// old free-form prompt. trainCronPrompt below is kept for compatibility
// (existing installs, tests) but is no longer what --schedule installs.

import { isRunnable } from './daemon/cron.js';
import { DEFAULT_SLEEPTIME_CAP_USD } from './sleeptime/orchestrator.js';

/** Default cadence for unattended learning (daemon parses "every <n> <unit>"). */
export const DEFAULT_TRAIN_SCHEDULE = 'every 24h';

/** The agent-native prompt installed as the cron job (no nested CLI). */
export function trainCronPrompt(focus?: string): string {
  const scope = focus?.trim() ? ` Focus: ${focus.trim()}.` : '';
  return [
    'Scheduled self-training cycle.' + scope,
    '1. Review the latest run traces (.mochi/traces) and recorded lessons for real, observed gaps — never invent work.',
    '2. Fix the single most valuable gap with tests (small, typed, verified).',
    '3. Run the skill curator so proven lessons persist as reusable skills.',
    '4. Report what changed and what was deliberately left alone.',
  ].join('\n');
}

/** The cron prompt installed by --schedule since D11: run the sleeptime
 *  orchestrator and relay its morning report. The orchestrator itself
 *  enforces the spend cap and per-night idempotency, so the prompt's job
 *  is only invocation + reporting — no improvised fixes outside it. */
export function sleeptimeCronPrompt(focus?: string, capUsd?: number): string {
  const cap = capUsd !== undefined && Number.isFinite(capUsd) && capUsd > 0 ? capUsd : DEFAULT_SLEEPTIME_CAP_USD;
  const scope = focus?.trim() ? ` Focus: ${focus.trim()} (report it, but do not widen the pipeline's scope).` : '';
  return [
    'Scheduled sleep-time consolidation.' + scope,
    `1. Run: mochi sleeptime --cap ${cap} — the orchestrator performs skill repair, the curator pass, the frozen-gate integrity check, and curriculum generation under that HARD spend cap, idempotently for tonight.`,
    '2. Relay the morning report it prints: what it repaired/promoted, the gate result, curriculum tasks, failures, and exactly what it spent against the cap.',
    '3. Do not improvise additional fixes outside the orchestrator. Anything it skipped (spend cap, already-done duplicates) or failed is reported as-is, never worked around.',
  ].join('\n');
}

/** Validate a --schedule value. Null when fine, otherwise the usage error. */
export function validateTrainSchedule(raw: unknown): string | null {
  const spec = typeof raw === 'string' && raw.trim() ? raw.trim() : DEFAULT_TRAIN_SCHEDULE;
  if (isRunnable(spec)) return null;
  return `Bad schedule "${spec}" — use "every 30m", "every 24h", or a 5-field cron like "0 3 * * *".`;
}

/** Resolve the effective schedule (flag or default). */
export function trainSchedule(raw: unknown): string {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : DEFAULT_TRAIN_SCHEDULE;
}
