// Endurance runner — the child process the driver spawns (and SIGKILLs).
//
// Hosts the REAL Agent against the generated fixture, configured like the
// scripted loop tests (fake OpenAI wire URL, preflight off). Extra host
// wiring that mirrors what a real host (CLI/TUI) does:
//   - a steer file the driver writes mid-run is polled and pushed through
//     agent.steer() (the MCH-74 mid-run steer channel);
//   - an extra tool `display_snapshot` simulates a flaky display backend:
//     its first call of the whole scenario (state kept on disk, so it is
//     consistent across kill/resume) throws E_BACKEND_DOWN when
//     ENDURANCE_FLAKE=1;
//   - every bus event is appended to a JSONL log with appendFileSync, so
//     the record survives SIGKILL (no buffered state to lose).
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Agent } from '../../src/agent/loop.js';
import { ContextEngine } from '../../src/context.js';
import { EventBus } from '../../src/events.js';
import { Workspace } from '../../src/workspace.js';
import { createTask } from '../../src/goals/task.js';
import { UsageSidecarRecorder } from '../../src/observability/usage-sidecar.js';
import { TASK_DESCRIPTION, TASK_ID, TASK_TITLE } from './fixture.js';
import type { MochiConfig } from '../../src/types.js';
import type { Tool } from '../../src/tools/types.js';

const env = process.env;
const dir = env.ENDURANCE_DIR!;
const modelUrl = env.ENDURANCE_MODEL_URL!;
const eventsPath = env.ENDURANCE_EVENTS!;
const steerFile = env.ENDURANCE_STEER_FILE!;
const flake = env.ENDURANCE_FLAKE === '1';
const budgetTokens = Number(env.ENDURANCE_BUDGET_TOKENS ?? '9000');
const maxIterations = Number(env.ENDURANCE_MAX_ITERATIONS ?? '160');

function logEvent(obj: Record<string, unknown>): void {
  try { appendFileSync(eventsPath, JSON.stringify({ t: Date.now(), ...obj }) + '\n'); } catch { /* never crash the run for telemetry */ }
}

const backendStateFile = resolve(dir, '.endurance-backend-calls');
const displaySnapshotTool: Tool = {
  def: {
    name: 'display_snapshot',
    description: 'Capture a snapshot of a UI/display surface (simulated display backend). Returns a textual snapshot summary.',
    parameters: [{ name: 'target', type: 'string', description: 'What to snapshot, e.g. "store-schema"', required: true }],
  },
  execute: async (args) => {
    let n = 0;
    try { n = Number(readFileSync(backendStateFile, 'utf8')) || 0; } catch { /* first call */ }
    n += 1;
    try { writeFileSync(backendStateFile, String(n)); } catch { /* best effort */ }
    logEvent({ type: 'endurance:backend-call', n });
    if (flake && n === 1) {
      throw new Error('display backend unavailable: X11 connection refused (E_BACKEND_DOWN)');
    }
    return `display snapshot captured for ${String(args.target ?? 'surface')} (call #${n}): 1 window, schema v2, store tables visible`;
  },
};

async function main(): Promise<void> {
  const config = {
    model: { provider: 'openai', baseUrl: modelUrl, model: 'fake-model', speculative: { preflight: false } },
    safety: {
      mode: 'auto',
      commandTimeoutSeconds: 20,
      maxIterations,
      maxRuntimeMinutes: 10,
      maxConcurrentAgents: 4,
      maxConcurrentSubagents: 4,
      maxSubagentDepth: 2,
      contextBudgetTokens: budgetTokens,
    },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false,
    projectDir: '.mochi',
    configDir: resolve(dir, '.config/mochi'),
    quiet: true,
    verbose: false,
    debug: false,
  } as unknown as MochiConfig;

  const workspace = new Workspace(dir, '.mochi');
  workspace.ensure();
  const context = new ContextEngine(config, dir);
  context.setGoal(TASK_TITLE);
  const events = new EventBus();
  events.onAll((e: any) => {
    if (e?.type === 'context:compacted') {
      logEvent({ type: 'context:compacted', beforeTokens: e.beforeTokens, afterTokens: e.afterTokens });
    } else if (e?.type === 'agent:log') {
      const msg = String(e.message ?? '');
      if (/steer|compact|digest|journal|subagent|child/i.test(msg)) logEvent({ type: 'agent:log', message: msg.slice(0, 240) });
    }
  });

  const agent = new Agent({
    role: 'coder',
    config,
    workspace,
    events,
    cwd: dir,
    context,
    // Host opt-in for unattended runs (the daemon/SDK path): without it,
    // approval-tier tools (subagent spawns) are denied-by-default headless.
    unattendedAllow: true,
    extraTools: new Map([['display_snapshot', displaySnapshotTool]]),
  });

  // D1: per-run usage sidecar — the endurance rig's result files (last-run
  // JSON + MILEAGE.md) get token counts from the same usage JSON the gate
  // reads. Subagent chaos-run usage lands in the sidecar's per-aux
  // breakdown because the recorder sees the children's events on this bus.
  const runId = `endurance-${env.ENDURANCE_PHASE ?? 'run'}-${TASK_ID}`;
  const usageSidecar = new UsageSidecarRecorder(workspace.dir, runId, { model: config.model.model, provider: config.model.provider }).attach(events);

  // Mid-run steer channel: the driver drops a text file; the host polls and
  // pushes it into the running agent, exactly once.
  let steerDelivered = false;
  const poller = setInterval(() => {
    if (steerDelivered) return;
    try {
      if (existsSync(steerFile)) {
        const text = readFileSync(steerFile, 'utf8').trim();
        if (text) {
          agent.steer(text);
          steerDelivered = true;
          logEvent({ type: 'endurance:steer-delivered' });
          try { renameSync(steerFile, steerFile + '.delivered'); } catch { /* best effort */ }
        }
      }
    } catch { /* poll again next tick */ }
  }, 150);
  poller.unref();

  logEvent({ type: 'endurance:runner-start', pid: process.pid, phase: env.ENDURANCE_PHASE ?? 'run' });
  const task = createTask(TASK_TITLE, TASK_DESCRIPTION, { id: TASK_ID });
  const result = await agent.run(task);
  clearInterval(poller);
  usageSidecar.finish({ exitReason: String((result as any).stopReason ?? 'unknown'), success: result.success, durationMs: (result as any).durationMs });
  const out = {
    success: result.success,
    stopReason: (result as any).stopReason,
    summary: String((result as any).summary ?? '').slice(0, 400),
    journal: agent.getJournalStats(),
  };
  logEvent({ type: 'endurance:runner-result', ...out });
  console.log('ENDURANCE_RESULT ' + JSON.stringify(out));
  process.exit(result.success ? 0 : 3);
}

main().catch((e) => {
  logEvent({ type: 'endurance:runner-crash', error: String(e?.stack ?? e).slice(0, 600) });
  console.log('ENDURANCE_RESULT ' + JSON.stringify({ success: false, stopReason: 'runner_crash', summary: String(e?.message ?? e).slice(0, 300) }));
  process.exit(4);
});
