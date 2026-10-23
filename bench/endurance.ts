#!/usr/bin/env tsx
// Endurance / mileage factory — long-horizon chaos runs against the REAL
// agent loop, driven by a deterministic scripted model over the fake
// OpenAI wire (so every failure harvested is a HARNESS failure, not model
// weather).
//
//   ./node_modules/.bin/tsx bench/endurance.ts [--baseline-runs 3]
//     [--chaos-runs 3] [--quick] [--keep] [--budget 9000]
//
// Scenario: a generated ~80-file project ("Ledgerline") and a 5-stage
// feature task with per-stage verifiable checkpoints and exactly-once
// side-effect markers (an append-only ledger appended once per stage —
// any duplicate after a resume is a detectable exactly-once violation).
// Chaos profile injects: a flaky tool backend (first call E_BACKEND_DOWN),
// a provider-killed recon subagent (HTTP 500s), a mid-run user steer, a
// SIGKILL while a background subagent is in flight (then a journal
// resume), and constant compaction pressure (small context budget).
//
// Writes MILEAGE.md at the repo root and bench/endurance/last-run.json.
// Exit 0 when the factory itself completed (run failures are DATA and are
// classified F1–F12/X in the report); exit 2 on factory self-check failure.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAQ_CONTENT, LEDGER_FILE, SOLUTION_FILES, STEER_TEXT, generateFixture, isEperm, writeFileRetry } from './endurance/fixture.js';
import { createPlanRouter, newPlanState, type PlanState } from './endurance/plan.js';
import { startFakeOpenAI } from '../src/testutil/fake-openai.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsxCli = resolve(repoRoot, 'node_modules/tsx/dist/cli.mjs');
const runnerPath = resolve(repoRoot, 'bench/endurance/runner.ts');

const args = process.argv.slice(2);
const argNum = (flag: string, dflt: number) => {
  const i = args.indexOf(flag);
  if (i < 0) return dflt;
  const n = Number(args[i + 1]);
  return Number.isNaN(n) ? dflt : Math.max(0, n);
};
const quick = args.includes('--quick');
const keep = args.includes('--keep');
const baselineRuns = quick ? 1 : argNum('--baseline-runs', 3);
const chaosRuns = quick ? 1 : argNum('--chaos-runs', 3);
const chaosbRuns = quick ? 1 : argNum('--chaosb-runs', chaosRuns);
const budgetTokens = argNum('--budget', 16000);
const WATCHDOG_MS = 420_000;

// A killed runner leaves the fake provider with dead sockets mid-response;
// keep the factory alive and count such faults instead of dying with them.
const factoryFaults: string[] = [];
process.on('uncaughtException', (e) => { factoryFaults.push('uncaughtException: ' + String(e?.message ?? e)); });
process.on('unhandledRejection', (e: any) => { factoryFaults.push('unhandledRejection: ' + String(e?.message ?? e)); });

function git(dir: string, a: string[]): void {
  execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
}

function node_(dir: string, script: string, ...rest: string[]): { status: number; out: string } {
  const r = spawnSync(process.execPath, [resolve(dir, script), ...rest], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
  return { status: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

/** Factory self-check: solutions applied to a pristine fixture must pass
 *  every stage check, and the pristine fixture must pass its own suite. */
function selfCheck(): boolean {
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-endurance-selfcheck-'));
  try {
    generateFixture(dir);
    const base = node_(dir, 'tools/run-tests.mjs');
    if (base.status !== 0) { console.error('[selfcheck] pristine fixture suite not green:\n' + base.out); return false; }
    for (const [rel, content] of Object.entries(SOLUTION_FILES)) {
      const abs = resolve(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileRetry(abs, content);
    }
    writeFileRetry(resolve(dir, 'docs/discounts-faq.md'), FAQ_CONTENT);
    for (let s = 1; s <= 5; s++) {
      const chk = node_(dir, 'tools/check-stage.mjs', String(s));
      if (chk.status !== 0 || !chk.out.includes(`STAGE_${s}_OK`)) {
        console.error(`[selfcheck] stage ${s} check fails with solutions applied:\n` + chk.out);
        return false;
      }
    }
    console.log('[selfcheck] fixture + solutions consistent (suite green, stages 1–5 pass)');
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface RunRecord {
  profile: 'baseline' | 'chaos' | 'chaosb';
  index: number;
  success: boolean;
  primaryClass: string | null;
  evidence: string[];
  anomalies: string[];
  parentTurns: number;
  childTurns: number;
  auxTurns: number;
  tokens: number;
  stageTurns: Record<number, number>;
  probeDupes: number;
  compactions: number;
  resumes: number;
  journalReplayed: number;
  journalRecorded: number;
  chaos: Record<string, { injected: boolean; recovered: boolean; note: string }>;
  wallMs: number;
  dir: string;
  branchTail: string[];
}

interface RunnerOutcome { code: number | null; signal: string | null; result?: any; timedOut: boolean }

function spawnRunner(env: Record<string, string>): { done: Promise<RunnerOutcome>; kill: (sig: NodeJS.Signals) => void } {
  const child = spawn(process.execPath, [tsxCli, runnerPath], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { err = (err + d.toString()).slice(-4000); });
  let timedOut = false;
  const watchdog = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* gone */ } }, WATCHDOG_MS);
  const done = new Promise<RunnerOutcome>((res) => {
    child.on('exit', (code, signal) => {
      clearTimeout(watchdog);
      const line = out.split('\n').filter((l) => l.startsWith('ENDURANCE_RESULT ')).pop();
      let result: any;
      try { result = line ? JSON.parse(line.slice('ENDURANCE_RESULT '.length)) : undefined; } catch { /* none */ }
      if (!result && err) factoryFaults.push('runner stderr tail: ' + err.slice(-300).replace(/\n/g, ' | '));
      res({ code, signal, result, timedOut });
    });
  });
  return { done, kill: (sig) => { try { child.kill(sig); } catch { /* gone */ } } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runScenario(profile: 'baseline' | 'chaos' | 'chaosb', index: number): Promise<RunRecord> {
  // chaos  = early-fault profile (recon provider-kill + flake + steer + kill)
  // chaosb = late-fault profile (healthy recon; flake + steer + SIGKILL +
  //          orphan) — isolates journal-resume measurement from the early
  //          cascade the recon kill triggers.
  const chaos = profile !== 'baseline';
  const killRecon = profile === 'chaos';
  const t0 = Date.now();
  const runDir = mkdtempSync(resolve(tmpdir(), `mochi-endurance-${profile}-${index}-`));
  const project = resolve(runDir, 'project');
  mkdirSync(project, { recursive: true });
  // Fixture generation rides out host EPERM windows locally so one window
  // costs this scenario a pause, not the whole batch's records.
  let fileCount = 0;
  for (let genAttempt = 1; ; genAttempt++) {
    try { fileCount = generateFixture(project); break; } catch (e) {
      if (isEperm(e) && genAttempt <= 5) { await waitForWriteHealth(); continue; }
      throw e;
    }
  }
  git(project, ['init', '-q']);
  git(project, ['config', 'user.email', 'endurance@mochi.agent']);
  git(project, ['config', 'user.name', 'Mochi Endurance']);
  git(project, ['add', '-A']);
  git(project, ['commit', '-qm', 'ledgerline fixture']);

  const state: PlanState = newPlanState();
  const eventsPath = resolve(runDir, 'events.jsonl');
  const steerFile = resolve(runDir, 'steer.txt');
  const chaosRec: RunRecord['chaos'] = {
    backendFlake: { injected: chaos, recovered: false, note: '' },
    reconSubagentKill: { injected: killRecon, recovered: false, note: '' },
    steer: { injected: chaos, recovered: false, note: '' },
    sigkillResume: { injected: chaos, recovered: false, note: '' },
    compactionPressure: { injected: true, recovered: false, note: '' },
  };

  let killFired = false;
  let current: { kill: (s: NodeJS.Signals) => void } | null = null;
  const router = createPlanRouter({
    killRecon,
    slowCatalog: chaos,
    state,
    hooks: {
      onChildRequest: (kind) => {
        if (chaos && kind === 'catalog' && !killFired) {
          killFired = true;
          // Let the background child get properly in flight, then SIGKILL
          // the whole runner: parent + child die together, as in a crash.
          setTimeout(() => { current?.kill('SIGKILL'); }, 500);
        }
      },
    },
  });
  const fake = await startFakeOpenAI([{ sticky: true, respondFn: router }]);

  const env: Record<string, string> = {
    ENDURANCE_DIR: project,
    ENDURANCE_MODEL_URL: fake.url,
    ENDURANCE_EVENTS: eventsPath,
    ENDURANCE_STEER_FILE: steerFile,
    ENDURANCE_FLAKE: chaos ? '1' : '0',
    ENDURANCE_BUDGET_TOKENS: String(budgetTokens),
    ENDURANCE_MAX_ITERATIONS: '160',
    ENDURANCE_PHASE: 'run',
  };

  let resumes = 0;
  let lastOutcome: RunnerOutcome | undefined;
  let steerWritten = false;
  try {
    // ── invocation 1 ──────────────────────────────────────────────────────
    const first = spawnRunner(env);
    current = first;
    const steerPoller = chaos
      ? setInterval(() => {
          if (!steerWritten && state.stagePassedAtTurn[2]) {
            steerWritten = true;
            try { writeFileRetry(steerFile, STEER_TEXT); } catch { /* runner poll tolerates */ }
          }
        }, 200)
      : null;
    lastOutcome = await first.done;
    if (steerPoller) clearInterval(steerPoller);
    current = null;

    // ── resume after our SIGKILL ──────────────────────────────────────────
    if (chaos && killFired && lastOutcome.signal === 'SIGKILL' && !lastOutcome.timedOut) {
      resumes++;
      await sleep(400);
      const second = spawnRunner({ ...env, ENDURANCE_PHASE: 'resume' });
      current = second;
      lastOutcome = await second.done;
      current = null;
    }
  } finally {
    await fake.close();
  }

  // ── independent verification (never trust the agent's word) ────────────
  const evidence: string[] = [];
  const anomalies: string[] = [...state.anomalies];
  const stageOk: Record<number, boolean> = {};
  for (let s = 1; s <= 5; s++) {
    const chk = node_(project, 'tools/check-stage.mjs', String(s));
    stageOk[s] = chk.status === 0 && chk.out.includes(`STAGE_${s}_OK`);
    if (!stageOk[s]) evidence.push(`stage ${s} check fails post-run: ${chk.out.trim().split('\n')[0] ?? ''}`);
  }
  const suite = node_(project, 'tools/run-tests.mjs');
  const suiteOk = suite.status === 0;
  if (!suiteOk) evidence.push('regression suite not green post-run');

  let ledgerLines: string[] = [];
  const ledgerPath = resolve(project, LEDGER_FILE);
  if (existsSync(ledgerPath)) ledgerLines = readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean);
  const expectedLedger = [1, 2, 3, 4, 5].map((s) => `stage-${s}-complete`);
  const ledgerExact = JSON.stringify(ledgerLines) === JSON.stringify(expectedLedger);
  const ledgerDupes = ledgerLines.filter((l, i) => ledgerLines.indexOf(l) !== i);
  if (!ledgerExact) evidence.push(`ledger not exactly-once: [${ledgerLines.join(', ')}]`);

  // Exactly-once canary: the raw probe appends (one per stage in the plan).
  // Duplicates mean a completed side effect was RE-EXECUTED somewhere in
  // the harness (in-session context rewind or a resume path) — an anomaly
  // worth harvesting even when the run itself completes.
  let probeDupes = 0;
  const probePath = resolve(project, '.endurance-probe.log');
  if (existsSync(probePath)) {
    const probeLines = readFileSync(probePath, 'utf8').split('\n').filter(Boolean);
    for (let s = 1; s <= 5; s++) {
      const n = probeLines.filter((l) => l === `probe-stage-${s}`).length;
      if (n > 1) {
        probeDupes += n - 1;
        anomalies.push(`exactly-once violation: probe-stage-${s} appended ${n} times — a completed shell side effect was re-executed after a context rewind/resume (journal replay does not cover it)`);
      }
    }
  }

  let faqOk = true;
  if (chaos) {
    const faqPath = resolve(project, 'docs/discounts-faq.md');
    faqOk = existsSync(faqPath) && (readFileSync(faqPath, 'utf8').match(/\?/g) ?? []).length >= 3;
    if (!faqOk) evidence.push('steer deliverable docs/discounts-faq.md missing or thin after run');
  }

  // events + journal stats
  let compactions = 0;
  let steerDelivered = false;
  if (existsSync(eventsPath)) {
    for (const line of readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean)) {
      try {
        const e = JSON.parse(line);
        if (e.type === 'context:compacted') compactions++;
        // The digest path reports via agent:log, not a typed event.
        if (e.type === 'agent:log' && /MCH-32 digest|checkpointAndCompact|compacted/i.test(String(e.message ?? ''))) compactions++;
        if (e.type === 'endurance:steer-delivered') steerDelivered = true;
      } catch { /* partial line from a kill — ignore */ }
    }
  }
  const journal = lastOutcome?.result?.journal ?? {};
  const agentSuccess = lastOutcome?.result?.success === true && lastOutcome?.code === 0;
  const success = agentSuccess && Object.values(stageOk).every(Boolean) && suiteOk && ledgerExact && faqOk;

  // ── chaos recovery bookkeeping ──────────────────────────────────────────
  if (chaos) {
    chaosRec.backendFlake.recovered = success || stageOk[2];
    chaosRec.backendFlake.note = 'first display_snapshot call throws E_BACKEND_DOWN; run must retry and proceed';
    chaosRec.reconSubagentKill.recovered = state.reconChildFailed ? (stageOk[1] && stageOk[2]) : false;
    chaosRec.reconSubagentKill.note = state.reconChildFailed
      ? 'recon child provider-killed (HTTP 500); parent fell back to direct reads'
      : 'recon child did not register as failed — inspect run';
    chaosRec.steer.recovered = steerDelivered && faqOk;
    chaosRec.steer.note = steerDelivered ? 'steer delivered mid-run via host poller; faq present at end' : 'steer never delivered into the run';
    chaosRec.sigkillResume.recovered = killFired && resumes === 1 && agentSuccess;
    chaosRec.sigkillResume.note = killFired
      ? `SIGKILL during background child flight; resumed once; journal replayed ${journal.replayedSteps ?? '?'} steps, recorded ${journal.recordedSteps ?? '?'}`
      : 'kill never fired (catalog child request not observed)';
    if (state.orphanChildAbandoned) anomalies.push('background catalog child orphaned by SIGKILL; collect_agent kept reporting RUNNING and the parent abandoned it via cancel_agent');
  }
  chaosRec.compactionPressure.recovered = compactions > 0 && success;
  chaosRec.compactionPressure.note = `${compactions} context:compacted events under a ${budgetTokens}-token budget`;

  // ── failure classification (taxonomy F1–F12 / X; exactly one primary) ──
  let primaryClass: string | null = null;
  if (!success) {
    if (lastOutcome?.timedOut) { primaryClass = 'F12'; evidence.push(`watchdog killed a hung invocation after ${WATCHDOG_MS}ms`); }
    else if (ledgerDupes.length) { primaryClass = 'F8'; evidence.push(`exactly-once violated on resume: duplicate ledger lines [${ledgerDupes.join(', ')}] — journal replay did not cover a completed side effect`); }
    else if (lastOutcome?.result?.stopReason === 'max_iterations' || lastOutcome?.result?.stopReason === 'runtime_limit' || lastOutcome?.result?.stopReason === 'budget') { primaryClass = 'F12'; evidence.push(`stopReason=${lastOutcome.result.stopReason}`); }
    else if (!agentSuccess && lastOutcome?.result?.stopReason === 'runner_crash') { primaryClass = 'X'; evidence.push('runner process crashed: ' + String(lastOutcome.result.summary ?? '')); }
    else if (!agentSuccess && lastOutcome?.result?.stopReason === 'verification_failed') { primaryClass = 'F7'; evidence.push('finish gate rejected a claim mid-task and the run terminated instead of resuming work: ' + String(lastOutcome.result.summary ?? '').slice(0, 220)); }
    else if (chaos && !faqOk && Object.values(stageOk).every(Boolean)) { primaryClass = 'F8'; evidence.push('all stages pass but the mid-run steer deliverable was lost (context/steer channel)'); }
    else if (!Object.values(stageOk).every(Boolean)) { primaryClass = 'F4'; evidence.push('one or more stage checks fail at final verification (incomplete fix)'); }
    else if (!suiteOk) { primaryClass = 'F5'; evidence.push('stage checks pass but the pre-existing regression suite broke'); }
    else { primaryClass = 'X'; evidence.push('run failed without a sharper signature; see anomalies'); }
  }

  const stageTurns: Record<number, number> = {};
  let prev = 0;
  for (let s = 1; s <= 5; s++) {
    const at = state.stagePassedAtTurn[s];
    if (at) { stageTurns[s] = at - prev; prev = at; }
  }

  if (!keep) rmSync(runDir, { recursive: true, force: true });
  return {
    profile, index, success, primaryClass, evidence, anomalies,
    parentTurns: state.parentTurns, childTurns: state.childTurns, auxTurns: state.auxTurns,
    tokens: state.promptTokens + state.completionTokens,
    stageTurns, probeDupes, compactions, resumes,
    journalReplayed: journal.replayedSteps ?? 0,
    journalRecorded: journal.recordedSteps ?? 0,
    chaos: chaosRec, wallMs: Date.now() - t0,
    dir: keep ? runDir : '(cleaned)',
    branchTail: state.branchLog.slice(-18),
  };
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function writeReport(records: RunRecord[], fixtureFiles: number): void {
  const by = (p: string) => records.filter((r) => r.profile === p);
  const rate = (rs: RunRecord[]) => (rs.length ? `${rs.filter((r) => r.success).length}/${rs.length}` : '0/0');
  const classCounts = new Map<string, number>();
  for (const r of records) if (r.primaryClass) classCounts.set(r.primaryClass, (classCounts.get(r.primaryClass) ?? 0) + 1);
  for (const r of records) for (const a of r.anomalies) {
    const key = a.includes('orphaned') ? 'F8 (subagent orphan)' : a.includes('exactly-once violation') ? 'F8 (exactly-once re-execution)' : 'anomaly';
    if (key !== 'anomaly') classCounts.set(key, (classCounts.get(key) ?? 0) + 1);
  }
  const ranked = [...classCounts.entries()].sort((a, b) => b[1] - a[1]);

  const L: string[] = [];
  L.push('# MILEAGE.md — endurance / chaos mileage report');
  L.push('');
  L.push(`Generated by \`bench/endurance.ts\` on ${new Date().toISOString()} against the production agent loop (scripted deterministic model over the fake OpenAI wire — failures below are harness failures, not model weather).`);
  L.push('');
  L.push('## Scenario');
  L.push('');
  L.push(`- Fixture: generated "Ledgerline" project, ${fixtureFiles} files, real import graph (core → domain → store → services → api).`);
  L.push('- Task: 5-stage discount feature (pure module → store → invoice integration with a 50%-of-subtotal cap → API → docs), per-stage probes (`tools/check-stage.mjs N`), exactly-once side-effect ledger (one append per stage).');
  L.push(`- Context budget ${budgetTokens} tokens (compaction pressure on every run); scripted-model tokens are wire-estimates (chars/4) of the served payloads.`);
  L.push('- Chaos injections — profile `chaos` (early faults): flaky display backend (first call E_BACKEND_DOWN), provider-killed recon subagent (HTTP 500), mid-run user steer (new deliverable), SIGKILL during a background subagent\'s flight + journal resume, compaction pressure. Profile `chaosb` (late faults): healthy recon; flake + steer + SIGKILL + orphan, isolating journal-resume behaviour from the early-fault cascade.');
  L.push('');
  L.push('## Headline numbers');
  L.push('');
  L.push(`| profile | completion | median parent turns | median tokens | median wall |`);
  L.push('|---|---|---|---|---|');
  for (const p of ['baseline', 'chaos', 'chaosb'] as const) {
    const rs = by(p);
    if (!rs.length) continue;
    L.push(`| ${p} | ${rate(rs)} | ${median(rs.map((r) => r.parentTurns))} | ${median(rs.map((r) => r.tokens))} | ${(median(rs.map((r) => r.wallMs)) / 1000).toFixed(1)}s |`);
  }
  L.push('');
  L.push('## Per-run detail');
  L.push('');
  L.push('| run | result | class | parent/child/aux turns | tokens | compactions | probe dupes | resumes (replayed/recorded) | stages (turns per stage) | wall |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of records) {
    const stages = [1, 2, 3, 4, 5].map((s) => r.stageTurns[s] ?? '—').join('/');
    L.push(`| ${r.profile}-${r.index} | ${r.success ? 'PASS' : 'FAIL'} | ${r.primaryClass ?? '—'} | ${r.parentTurns}/${r.childTurns}/${r.auxTurns} | ${r.tokens} | ${r.compactions} | ${r.probeDupes} | ${r.resumes} (${r.journalReplayed}/${r.journalRecorded}) | ${stages} | ${(r.wallMs / 1000).toFixed(1)}s |`);
  }
  L.push('');
  L.push('## Exactly-once audit (raw probe appends, one per stage in the plan)');
  L.push('');
  const totalDupes = records.reduce((a, r) => a + r.probeDupes, 0);
  const affected = records.filter((r) => r.probeDupes > 0).length;
  L.push(`- Duplicate probe appends: **${totalDupes}** across **${affected}/${records.length}** runs. Any duplicate = a completed shell side effect was re-executed (context rewind within a session, or a resume path the journal did not cover). The completion-path ledger append is guarded/idempotent by task design; the probe is deliberately unguarded so this stays measurable.`);
  L.push('');
  L.push('## Chaos recovery');
  L.push('');
  L.push('| event | runs injected | recovered | notes |');
  L.push('|---|---|---|---|');
  const evNames = ['backendFlake', 'reconSubagentKill', 'steer', 'sigkillResume', 'compactionPressure'];
  for (const prof of ['chaos', 'chaosb'] as const) {
    for (const name of evNames) {
      const rs = by(prof).filter((r) => r.chaos[name]?.injected);
      if (!rs.length) continue;
      const rec = rs.filter((r) => r.chaos[name]?.recovered).length;
      const note = rs.map((r) => r.chaos[name].note).filter(Boolean)[0] ?? '';
      L.push(`| ${prof}:${name} | ${rs.length} | ${rec}/${rs.length} | ${note} |`);
    }
  }
  L.push('');
  L.push('## Failure harvest (taxonomy F1–F12 / X, one primary per failed run)');
  L.push('');
  if (!ranked.length) L.push('No failed runs and no classified anomalies in this batch.');
  for (const [cls, n] of ranked) L.push(`- **${cls}** — ${n} occurrence(s)`);
  L.push('');
  for (const r of records) {
    if (r.evidence.length || r.anomalies.length) {
      L.push(`### ${r.profile}-${r.index} (${r.success ? 'passed with anomalies' : 'FAILED, primary ' + (r.primaryClass ?? '?')})`);
      for (const e of r.evidence) L.push(`- evidence: ${e}`);
      for (const a of r.anomalies) L.push(`- anomaly: ${a}`);
      if (!r.success && r.branchTail.length) L.push(`- scripted-model branch tail: ${r.branchTail.join(' → ')}`);
      L.push('');
    }
  }
  if (factoryFaults.length) {
    L.push('## Factory faults (bench infrastructure, not agent failures)');
    L.push('');
    for (const f of factoryFaults.slice(0, 10)) L.push(`- ${f}`);
    L.push('');
  }
  L.push('## Honest limits');
  L.push('');
  L.push('- The model is scripted and competent: it never misreads a file, never picks a wrong tool, and its plan is derived from observed history. This measures the harness machinery (loop, journal, compaction, subagents, steer, discipline) — it says nothing about how a real frontier model behaves inside that machinery, and nothing about task-level intelligence.');
  L.push('- SIGKILL is delivered at a model-turn boundary (while a background child is in flight), not mid-tool-execution; the write/journal fsync race window is not stressed.');
  L.push('- Token figures are wire estimates (chars/4) of fake-provider payloads, useful for relative comparison between runs, not billing truth.');
  L.push('- One fixture, one task shape. Mileage across many task shapes (debugging, refactors, greenfield) is future work for this factory.');
  writeFileRetry(resolve(repoRoot, 'MILEAGE.md'), L.join('\n') + '\n');
  writeFileRetry(resolve(repoRoot, 'bench/endurance/last-run.json'), JSON.stringify({ generatedAt: new Date().toISOString(), records }, null, 2) + '\n');
}

/** Wait out a host EPERM write window before measuring anything. EPERM
 *  arrives in correlated bursts, so a single lucky write proves nothing:
 *  health = 3 consecutive rounds of 15 writes each, rounds 3s apart
 *  (~15–20s of sustained clean writes). */
async function waitForWriteHealth(): Promise<void> {
  const probe = resolve(tmpdir(), `mochi-endurance-health-${process.pid}.tmp`);
  let cleanRounds = 0;
  for (let i = 1; ; i++) {
    let roundOk = true;
    for (let j = 0; j < 15 && roundOk; j++) {
      try { writeFileSync(probe, 'x'.repeat(200)); } catch { roundOk = false; }
    }
    try { rmSync(probe, { force: true }); } catch { /* probe residue is harmless */ }
    if (roundOk) {
      cleanRounds++;
      if (cleanRounds >= 3) {
        if (i > 3) console.log(`[endurance] host writes healthy again after ${i} probe rounds`);
        return;
      }
    } else {
      cleanRounds = 0;
      if (i % 3 === 1) console.log(`[endurance] host EPERM write window — waiting (probe round ${i})`);
    }
    if (i >= 90) return; // ~5 min: proceed and let the batch retry cope
    await sleep(3000);
  }
}

async function main(): Promise<void> {
  // Host EPERM write windows (documented host hazard, AGENTS.md 2026-10-22)
  // can last minutes; the FACTORY pauses and retries rather than dying —
  // a dead window is infrastructure weather, not a harness measurement.
  await waitForWriteHealth();
  for (let batchAttempt = 1; ; batchAttempt++) {
    try {
      let ok = false;
      for (let scAttempt = 1; ; scAttempt++) {
        try { ok = selfCheck(); break; } catch (e) {
          if (isEperm(e) && scAttempt <= 6) { await waitForWriteHealth(); continue; }
          throw e;
        }
      }
      if (!ok) { console.error('factory self-check failed — fix the fixture before measuring the harness'); process.exit(2); }
      const probeDir = mkdtempSync(resolve(tmpdir(), 'mochi-endurance-count-'));
      const fixtureFiles = generateFixture(probeDir);
      rmSync(probeDir, { recursive: true, force: true });

      const records: RunRecord[] = [];
      // Incremental report writes: a host-level kill mid-batch (timeout,
      // EPERM storm) must not take the finished runs' records with it.
      const recordRun = (r: RunRecord) => {
        records.push(r);
        try { writeReport(records, fixtureFiles); } catch { /* retried after the next run */ }
      };
      for (let i = 1; i <= baselineRuns; i++) {
        console.log(`[endurance] baseline run ${i}/${baselineRuns}…`);
        const r = await runScenario('baseline', i);
        console.log(`[endurance]   -> ${r.success ? 'PASS' : 'FAIL (' + (r.primaryClass ?? '?') + ')'} turns=${r.parentTurns} tokens=${r.tokens} wall=${(r.wallMs / 1000).toFixed(1)}s`);
        recordRun(r);
      }
      for (let i = 1; i <= chaosRuns; i++) {
        console.log(`[endurance] chaos run ${i}/${chaosRuns}…`);
        const r = await runScenario('chaos', i);
        console.log(`[endurance]   -> ${r.success ? 'PASS' : 'FAIL (' + (r.primaryClass ?? '?') + ')'} turns=${r.parentTurns} tokens=${r.tokens} resumes=${r.resumes} wall=${(r.wallMs / 1000).toFixed(1)}s`);
        recordRun(r);
      }
      for (let i = 1; i <= chaosbRuns; i++) {
        console.log(`[endurance] chaosb run ${i}/${chaosbRuns}…`);
        const r = await runScenario('chaosb', i);
        console.log(`[endurance]   -> ${r.success ? 'PASS' : 'FAIL (' + (r.primaryClass ?? '?') + ')'} turns=${r.parentTurns} tokens=${r.tokens} resumes=${r.resumes} wall=${(r.wallMs / 1000).toFixed(1)}s`);
        recordRun(r);
      }
      writeReport(records, fixtureFiles);
      console.log(`[endurance] report written to MILEAGE.md (${records.filter((r) => r.success).length}/${records.length} runs completed)`);
      return;
    } catch (e) {
      if (isEperm(e) && batchAttempt <= 4) {
        console.error(`[endurance] host EPERM write window — pausing 60s, retrying batch (attempt ${batchAttempt + 1}/5)`);
        await sleep(60_000);
        continue;
      }
      throw e;
    }
  }
}

main().catch((e) => { console.error('factory crashed:', e); process.exit(2); });
