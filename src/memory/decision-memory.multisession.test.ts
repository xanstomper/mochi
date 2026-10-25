// Multi-session decision-memory fixture (task 5b + proof metric).
//
// A scripted TWO-SESSION scenario per fixture task:
//   Session 1: the agent really attempts the "obvious" approach (it makes real
//              edits — a file actually changes in the workspace), the attempt
//              fails, and the rejection is recorded through the SAME write
//              path the agent uses (memory tool action 'reject').
//   Session 2: the SAME task comes back, reworded (as later sessions do). At
//              task start the loop calls decisionMemoryPrefix() — the fixture
//              calls the exact same function with the exact arguments the
//              loop passes (loop.ts, both resume-protocol injection sites).
//
// The session-2 planner is a FIXED policy (no model), held identical between
// the measured arms so the only variable is whether decision memory surfaced
// the rejection:
//   - candidate approaches carry an a-priori utility order; the planner picks
//     the highest-utility candidate that is not warned against.
//   - a surfaced rejection warns against its approach; the planner retries a
//     warned approach ONLY when the scenario declares new evidence that
//     contradicts the recorded reason (the rule the prompt block states).
//
// That means the measured quantity is exactly what decision memory adds to a
// fixed planner — retrieval + ranking + warning semantics. It is NOT a
// measurement of a live model's compliance with the warnings; that remains
// UNMEASURED here and is stated in the report.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { decisionMemoryPrefix } from './decision-memory.js';
import { memoryTool } from '../tools/memory.js';

interface FixtureTask {
  id: string;
  /** Session-1 task, in the agent's own terms. */
  s1: { title: string; description: string; approach: string; reason: string; evidence: string };
  /** Session-2 rewording of the same task (what later sessions look like). */
  s2: { title: string; description: string };
  /** Candidate approaches for session 2, a-priori utility order (first = what the planner picks when unwarned). The first entry is ALWAYS the session-1 rejected approach — that is what makes repeating it the default risk. */
  s2Candidates: string[];
  /** Optional new evidence that legitimately re-opens the rejected approach. */
  newEvidence?: string;
}

const FIXTURE_TASKS: FixtureTask[] = [
  {
    id: 'flaky-auth-refresh',
    s1: {
      title: 'Fix the flaky auth token refresh test',
      description: 'the token refresh test fails intermittently in CI, roughly one run in ten',
      approach: 'sleep-and-retry: add a 2 second sleep before the refresh assertion to let the timer settle',
      reason: 'still failed 3 of 30 local runs; the race is in the refresh scheduler, not assertion timing',
      evidence: 'src/auth/refresh.test.ts:88 — vitest run: 3 failures / 30 runs',
    },
    s2: {
      title: 'Auth session test is intermittently failing on CI',
      description: 'our login refresh spec fails about once every ten pipeline runs, make it deterministic',
    },
    s2Candidates: [
      'sleep-and-retry: add a 2 second sleep before the refresh assertion to let the timer settle',
      'inject a fake timer and drive the refresh scheduler deterministically in the test',
      'restructure the test to await the refresh callback instead of polling',
    ],
  },
  {
    id: 'payments-uuid-migration',
    s1: {
      title: 'Migrate the payments table to uuid primary keys',
      description: 'swap the integer ids on payments for uuids across the schema and the readers',
      approach: 'one-shot ALTER TABLE with the backfill in the same transaction',
      reason: 'lock timeout: the 4M-row backfill held the write lock past the 30s statement timeout',
      evidence: 'migration run #1042: statement timeout after 30s on payments_backfill',
    },
    s2: {
      title: 'Payments table primary key conversion to uuid',
      description: 'convert payment row identifiers to uuids including backfill of existing rows',
    },
    s2Candidates: [
      'one-shot ALTER TABLE with the backfill in the same transaction',
      'batched backfill (10k rows per tx) with a dual-write window, then swap the key',
      'new uuid column + view layer first, retire the integer key later',
    ],
  },
  {
    id: 'cold-build-speedup',
    s1: {
      title: 'Speed up the cold webpack build',
      description: 'cold builds take nine minutes, the team wants them under four',
      approach: 'disable source maps entirely in the production config',
      reason: 'the error reporter resolves stack traces from sourcemaps; with maps off every prod error is unattributable',
      evidence: 'src/observability/error-reporter.ts:41 requires map files at upload time',
    },
    s2: {
      title: 'Cut nine-minute cold build down to four',
      description: 'webpack cold build performance work, target under four minutes',
    },
    s2Candidates: [
      'disable source maps entirely in the production config',
      'switch to webpack filesystem cache with a content-addressable cache dir',
      'split the build: application bundle + vendor dll prebuilt once',
    ],
  },
  {
    id: 'websocket-reconnect-storm',
    s1: {
      title: 'Stop the websocket reconnect storm after server deploys',
      description: 'every deploy drops all sockets and the clients redial in a storm that pins the api',
      approach: 'force-close stale sockets from the server side so clients see a clean close',
      reason: 'clients treat the forced close as a crash and redial immediately; the storm got worse',
      evidence: 'load test after change: peak 3.1k redials/s vs 2.4k baseline',
    },
    s2: {
      title: 'Deploy rollover causes websocket redial stampede',
      description: 'during deploys the clients all reconnect at once and overload the gateway',
    },
    s2Candidates: [
      'force-close stale sockets from the server side so clients see a clean close',
      'server sends a retry-after hint on close and clients add jittered backoff',
      'sticky draining period with a load balancer before sockets are dropped',
    ],
  },
  {
    id: 'ci-inline-secrets',
    s1: {
      title: 'Wire the deploy job to publish the site',
      description: 'the CI deploy stage needs the site published on every tag',
      approach: 'inline the publish credentials directly in the workflow yaml as an env assignment',
      reason: 'the repo secret scanner blocks inline credentials; the workflow is rejected at lint',
      evidence: 'ci lint: secret-scanning rule SS01 rejected workflow on tag build #77',
    },
    s2: {
      title: 'Publish the site from the release pipeline',
      description: 'tag builds should push the built site to the host automatically',
    },
    s2Candidates: [
      'inline the publish credentials directly in the workflow yaml as an env assignment',
      'store the publish credentials as masked repository variables referenced by name',
      'use the deploy bot oidc identity instead of a shared credential',
    ],
  },
];

// The scripted session-2 planner: fixed policy, identical in both arms.
// Returns the approach it would attempt and whether the pick was a sanctioned
// retry of a warned approach (only possible with new evidence).
function planSession2(candidates: string[], warnings: { approach: string; reason: string; newEvidence?: string }[]): { picked: string; warnedRetry: boolean } {
  for (const candidate of candidates) {
    const warned = warnings.find((w) => w.approach === candidate);
    if (!warned) return { picked: candidate, warnedRetry: false };
    // Warned approach: retry ONLY with new evidence contradicting the reason.
    if (warned.newEvidence) return { picked: candidate, warnedRetry: true };
  }
  // All candidates warned without new evidence: pick the first (still a repeat).
  return { picked: candidates[0], warnedRetry: false };
}

/** Extract the warned approaches from the actual prompt block the loop injects. */
function warnedApproachesFromPrompt(prompt: string): string[] {
  const out: string[] = [];
  for (const line of prompt.split('\n')) {
    const m = line.match(/^- Task ".*": tried (.*?) — failed because /);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Run session 1 for a fixture task through the REAL write path: the agent
 *  made edits (a file changes on disk) and then records the rejection via
 *  the memory tool's 'reject' action. Awaits the tool and asserts its reply. */
async function runSession1(ws: string, t: FixtureTask): Promise<void> {
  // Real work: the attempted approach changes files in the workspace.
  writeFileSync(join(ws, `${t.id}.attempt.ts`), `// approach: ${t.s1.approach}\n// outcome: abandoned\n`);
  const reply = await memoryTool.execute(
    { action: 'reject', task: `${t.s1.title} — ${t.s1.description}`, approach: t.s1.approach, reason: t.s1.reason, evidence: t.s1.evidence },
    { workspace: { dir: ws } } as never,
  );
  if (!String(reply).includes('Recorded rejected approach')) {
    throw new Error(`session-1 rejection not recorded for ${t.id}: ${String(reply)}`);
  }
}

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'mchi-decmem-fixture-'));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

describe('decision memory: two-session fixture', () => {
  it('session 2 surfaces session 1\'s rejection for the reworded task and avoids repeating it without new evidence', async () => {
    // Session 1: all fixture tasks reject their approach (real work + record).
    for (const t of FIXTURE_TASKS) await runSession1(ws, t);

    // Session 2 on ONE task: the exact call the loop makes at task start.
    const t = FIXTURE_TASKS[0];
    const prompt = decisionMemoryPrefix(ws, `${t.s2.title} ${t.s2.description}`);
    expect(prompt).not.toBe('');
    expect(prompt).toContain('warnings, not instructions');
    const warned = warnedApproachesFromPrompt(prompt);
    expect(warned).toContain(t.s1.approach);

    // The fixed planner, armed with the warnings, does not pick the dead approach.
    const outcome = planSession2(
      t.s2Candidates,
      warned.map((approach) => ({ approach, reason: 'surfaced' })),
    );
    expect(outcome.picked).not.toBe(t.s1.approach);
    expect(outcome.picked).toBe(t.s2Candidates[1]);
  });

  it('session 2 may retry the rejected approach when new evidence contradicts the recorded reason', async () => {
    for (const t of FIXTURE_TASKS) await runSession1(ws, t);
    const t = FIXTURE_TASKS[0];
    const prompt = decisionMemoryPrefix(ws, `${t.s2.title} ${t.s2.description}`);
    const warned = warnedApproachesFromPrompt(prompt);
    const outcome = planSession2(
      t.s2Candidates,
      warned.map((approach) => ({ approach, reason: 'surfaced', newEvidence: 'scheduler upstream fixed in v3.2 — timing is no longer the suspect' })),
    );
    expect(outcome.picked).toBe(t.s1.approach);
    expect(outcome.warnedRetry).toBe(true);
  });
});

describe('decision memory: fixture bench (proof metric)', () => {
  // Each fixture task is measured: does session 2 repeat the session-1
  // rejected approach? BEFORE = no decision records exist (the store is
  // empty — the pre-decision-memory behavior); AFTER = session 1 recorded
  // its rejections. The planner is the SAME fixed policy in both arms.
  async function bench(withDecisionMemory: boolean): Promise<{ repeated: number; tasks: number; surfacedTotal: number; surfacedRelevant: number; recallHit: number }> {
    if (withDecisionMemory) for (const t of FIXTURE_TASKS) await runSession1(ws, t);
    let repeated = 0;
    let surfacedTotal = 0;
    let surfacedRelevant = 0;
    let recallHit = 0;
    for (const t of FIXTURE_TASKS) {
      const prompt = withDecisionMemory
        ? decisionMemoryPrefix(ws, `${t.s2.title} ${t.s2.description}`)
        : '';
      const warned = warnedApproachesFromPrompt(prompt);
      // Precision: a surfaced warning is RELEVANT iff it warns against the
      // task's actually-rejected approach.
      surfacedTotal += warned.length;
      surfacedRelevant += warned.includes(t.s1.approach) ? 1 : 0;
      if (warned.includes(t.s1.approach)) recallHit++;
      const outcome = planSession2(t.s2Candidates, warned.map((approach) => ({ approach, reason: 'surfaced' })));
      // Repeat-failure: session 2 attempts the approach session 1 already
      // rejected, without new evidence (the bench arm has none).
      if (outcome.picked === t.s1.approach && !outcome.warnedRetry) repeated++;
    }
    return { repeated, tasks: FIXTURE_TASKS.length, surfacedTotal, surfacedRelevant, recallHit };
  }

  it('measures the repeat rate before vs after decision memory (documented fixture tasks)', async () => {
    const before = await bench(false);
    expect(before.repeated).toBe(before.tasks); // pre-decision-memory planner repeats every obvious approach
    expect(before.tasks).toBe(5);

    const after = await bench(true);
    // Report payload (also asserted so the numbers cannot silently regress).
    const repeatRateBefore = before.repeated / before.tasks;
    const repeatRateAfter = after.repeated / after.tasks;
    const precision = after.surfacedTotal > 0 ? after.surfacedRelevant / after.surfacedTotal : 0;
    const recall = after.recallHit / after.tasks;
    console.log('[decision-memory-bench]', JSON.stringify({
      fixtureTasks: after.tasks,
      repeatRateBefore,
      repeatRateAfter,
      precision,
      recall,
      surfacedTotal: after.surfacedTotal,
    }));
    expect(repeatRateBefore).toBe(1);
    expect(repeatRateAfter).toBe(0); // target: repeat rate driven to zero
    expect(precision).toBe(1);       // every surfaced warning was relevant
    expect(recall).toBe(1);          // every task's rejection was surfaced
  });
});
