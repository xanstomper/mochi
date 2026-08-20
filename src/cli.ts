#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MochiConfig } from './types.js';

// Resolve the version from package.json when running from source; when Mochi is
// compiled to a standalone binary there is no package.json next to it, so fall
// back to the constant (kept in sync with package.json at build time).
let VERSION = '0.10.4';
try {
  const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '../package.json');
  VERSION = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
} catch {
  /* compiled binary: use the baked-in default */
}

const BOOLEAN_FLAGS = new Set([
  'p', 'print', 'auto', 'quiet', 'q', 'verbose', 'v', 'debug', 'h', 'help', 'version', 'offline', 'enhance', 'install', 'plan',
]);

function parseArgs(argv: string[]): { flags: Record<string, string | boolean>; positional: string[] } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [key, ...rest] = arg.slice(2).split('=');
      if (rest.length > 0) {
        flags[key] = rest.join('=');
      } else if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        flags[key] = argv[++i];
      } else {
        flags[key] = true;
      }
    } else if (arg.startsWith('-')) {
      const key = arg.slice(1);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        flags[key] = argv[++i];
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function configFromFlags(flags: Record<string, string | boolean>): Partial<MochiConfig> {
  const overrides: Partial<MochiConfig> = {};
  const model: Partial<MochiConfig['model']> = {};
  if (flags.provider) model.provider = String(flags.provider);
  if (flags.model) model.model = String(flags.model);
  if (flags['api-key']) model.apiKey = String(flags['api-key']);
  if (flags.baseUrl) model.baseUrl = String(flags.baseUrl);
  if (Object.keys(model).length) overrides.model = model as MochiConfig['model'];
  if (flags.safety) overrides.safety = { ...({} as MochiConfig['safety']), mode: String(flags.safety) as MochiConfig['safety']['mode'] };
  if (flags.auto) overrides.safety = { ...({} as MochiConfig['safety']), mode: 'auto' as const };
  if (flags['max-tokens'] || flags['max-cost'] || flags['max-model-calls'] || flags['max-tool-calls']) {
    overrides.safety = {
      ...(overrides.safety ?? ({} as MochiConfig['safety'])),
      ...(flags['max-tokens'] ? { maxTokens: Number(flags['max-tokens']) } : {}),
      ...(flags['max-cost'] ? { maxCostUsd: Number(flags['max-cost']) } : {}),
      ...(flags['max-model-calls'] ? { maxModelCalls: Number(flags['max-model-calls']) } : {}),
      ...(flags['max-tool-calls'] ? { maxToolCalls: Number(flags['max-tool-calls']) } : {}),
    };
  }
  if (flags.quiet) overrides.quiet = true;
  if (flags.verbose) overrides.verbose = true;
  if (flags.debug) overrides.debug = true;
  // Plan-then-act: `--plan` (a dashed boolean; the bare `plan` subcommand
  // is positional and unaffected) makes every agent in the run research and
  // return a plan instead of editing files.
  if (flags.plan) overrides.planMode = true;
  return overrides;
}

function printHelp() {
  console.log(`Mochi ${VERSION} — minimal autonomous coding agent

Usage:
  mochi [options] ["prompt"]
  mochi goal "..."
  mochi team "..."
  mochi plan "..."
  mochi resume
  mochi checkpoint
  mochi rollback
  mochi workspace create|list|switch <name>
  mochi profiles
  mochi memory
  mochi inspect "<query>"
  mochi trace [<goalId>]             # replay the run trace for a goal
  mochi session list                 # list past sessions
  mochi session search "<text>"       # full-text search past transcripts
  mochi speculate "<question>"
  mochi acp                          # editor-native stdio server (Agent Client Protocol)
  mochi daemon start [--port <n>] [--token <t>]
  mochi daemon status
  mochi daemon jobs
  mochi daemon send "<goal>"
  mochi daemon approve
  mochi daemon resume <goalId>      # resume a persisted goal over HTTP
  mochi daemon cron add|list|remove # scheduled agent jobs
  mochi daemon restart              # stop + start on the same port
  mochi daemon stop
  mochi enhance "<task>" [--mode <mode>]
  mochi termix ["<task>"] [--coms|--sep] [--sessions N]
  mochi tui
  mochi perf
  mochi "<prompt>" --plan            # plan-then-act: research + return a plan, no edits

Options:
  -p, --print             Print response and exit
  --auto                  Autonomous mode
  --provider <name>       Model provider
  --model <id>            Model ID
  --api-key <key>         API key
  --safety safe|ask|auto  Safety mode
  --max-tokens <n>        Budget limit
  --max-cost <usd>        Cost limit
  --max-model-calls <n>   Model call limit
  --max-tool-calls <n>    Tool call limit
  --workspace <name>      Use workspace
  -q, --quiet             Less output
  -v, --verbose           More output
  --debug                 Debug output
  --chunks <n>            Chunk count for mochi perf
  -h, --help              Show help
  --version               Show version
`);
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));

  if (flags.h || flags.help) { printHelp(); return; }
  if (flags.version) { console.log(VERSION); return; }

  const cwd = process.cwd();
  const configOverrides = configFromFlags(flags);
  const { Runtime } = await import('./runtime.js');
  const { randomSlug } = await import('./util.js');
  const { status, diff, isRepo } = await import('./git.js');
  const runtime = Runtime.create({ cwd, config: configOverrides });

  // Ctrl-C / SIGTERM aborts the active run cleanly instead of SIGKILLing the
  // process and orphaning subagents; a second interrupt force-exits.
  runtime.onInterrupt(() => {
    console.error('\nInterrupt received; aborting the run cleanly…');
  });

  const first = positional[0];

  // `mochi daemon ...` — persistent agent over localhost HTTP.
  if (first === 'daemon') {
    const action = positional[1];
    const { startDaemon, daemonRunning, readDaemonInfo, daemonInfoPath } = await import('./daemon.js');
    const wsDir = runtime.workspace.dir;
    const info = readDaemonInfo(wsDir);
    if (action === 'start') {
      if (daemonRunning(wsDir)) {
        console.log(`Daemon already running on 127.0.0.1:${info?.port} (pid ${info?.pid}).`);
        return;
      }
      const port = Number(flags.port ?? (flags['port'] as string | undefined) ?? 9470);
      const token = typeof flags.token === 'string' && flags.token ? flags.token : undefined;
      const host = typeof flags.host === 'string' && flags.host ? flags.host : undefined;
      const r = await startDaemon({ cwd, port, token, host, config: configOverrides });
      if (r.ok) {
        console.log(`Daemon started on ${host ?? '127.0.0.1'}:${r.port}. Info: ${daemonInfoPath(wsDir)}`);
      } else {
        console.error(`Daemon failed to start: ${r.error}`);
        process.exit(1);
      }
      return;
    }
    if (action === 'status') {
      if (!daemonRunning(wsDir)) {
        console.log('No daemon running for this workspace.');
        return;
      }
      console.log(`Daemon running on 127.0.0.1:${info?.port} (pid ${info?.pid}, started ${info?.startedAt}).`);
      return;
    }
    if (action === 'jobs') {
      if (!info || !daemonRunning(wsDir)) {
        console.log('No daemon running for this workspace.');
        return;
      }
      const res = await fetch(`http://127.0.0.1:${info.port}/api/jobs`, {
        method: 'POST', headers: { authorization: `Bearer ${info.token}` },
      });
      const data = (await res.json()) as { jobs?: Array<{ id: string; status: string; objective: string }>; error?: string };
      if (!res.ok) { console.error(data.error ?? 'Daemon error'); process.exit(1); }
      for (const j of data.jobs ?? []) console.log(`${j.status.padEnd(10)} ${j.id}  ${j.objective}`);
      return;
    }
    if (action === 'stop' || action === 'restart') {
      if (!info || !daemonRunning(wsDir)) {
        console.log(action === 'restart' ? 'No daemon running; nothing to restart.' : 'No daemon running for this workspace.');
        return;
      }
      const restRes = await fetch(`http://127.0.0.1:${info.port}/api/status`, {
        method: 'POST', headers: { authorization: `Bearer ${info.token}` },
      });
      await restRes.text();
      // Best-effort: kill the recorded pid after telling it to exit.
      try { process.kill(info.pid, 'SIGTERM'); } catch { /* already gone */ }
      if (action === 'stop') {
        console.log('Daemon stopped.');
        return;
      }
      // restart: start a fresh daemon on the same port/token.
      await new Promise((r) => setTimeout(r, 400));
      const r = await startDaemon({ cwd, port: info.port, token: info.token, config: configOverrides });
      console.log(r.ok ? `Daemon restarted on 127.0.0.1:${r.port}.` : `Restart failed: ${r.error}`);
      return;
    }
    if (action === 'send' || action === 'approve' || action === 'resume') {
      const serverUrl = `http://127.0.0.1:${info?.port}`;
      if (!info || !daemonRunning(wsDir)) {
        console.error(`Usage: mochi daemon ${action} "<goal-or-goalId>" (requires a running daemon).`);
        process.exit(1);
      }
      const objective = positional.slice(2).join(' ');
      const path = action === 'approve' ? '/api/approve' : action === 'resume' ? '/api/resume' : '/api/goal';
      const body = action === 'resume' ? { goalId: objective } : { objective };
      const res = await fetch(serverUrl + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${info.token}` },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { out?: string; error?: string; ok?: boolean };
      if (res.ok) console.log(data.out ?? 'Goal accepted.');
      else { console.error(data.error ?? 'Daemon error'); process.exit(1); }
      return;
    }
    if (action === 'cron') {
      const sub = positional[2];
      const serverUrl = `http://127.0.0.1:${info?.port}`;
      if (!info || !daemonRunning(wsDir)) { console.error('Daemon not running.'); process.exit(1); }
      const post = async (action2: string, extra: Record<string, unknown> = {}) => {
        const res = await fetch(serverUrl + '/api/cron', {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${info.token}` },
          body: JSON.stringify({ action: action2, ...extra }),
        });
        return (await res.json()) as { ok?: boolean; error?: string; id?: string; jobs?: Array<{ id: string; prompt: string; schedule: string; enabled: boolean; runs: number; lastRun?: number; nextRun?: number; notify?: string | null }> };
      };
      if (sub === 'add') {
        const prompt = positional.slice(3).join(' ');
        const schedule = flags.schedule ?? flags.every;
        const notify = flags.notify;
        if (!prompt || !schedule) { console.error('Usage: mochi daemon cron add "<prompt>" --schedule "every 30m" [--notify <url|cmd>]'); process.exit(1); }
        const r = await post('add', { prompt, schedule, ...(typeof notify === 'string' && notify ? { notify } : {}) });
        if (r.error) { console.error(r.error); process.exit(1); }
        console.log(`Cron job added: ${r.id}`);
        return;
      }
      if (sub === 'list' || sub === 'listed-up') {
        const r = await post('listed-up');
        for (const j of r.jobs ?? []) {
          const next = j.nextRun ? new Date(j.nextRun).toISOString() : '-';
          const n = j.notify ? `  notify=${String(j.notify).slice(0, 24)}` : '';
          console.log(`${j.id}  ${j.enabled ? 'on ' : 'off'}  runs=${j.runs}  next=${next}  "${j.prompt.slice(0, 50)}"${n}`);
        }
        return;
      }
      if (sub === 'remove') {
        const id = positional[3];
        if (!id) { console.error('Usage: mochi daemon cron remove <id>'); process.exit(1); }
        await post('remove', { id });
        console.log(`Removed ${id}`);
        return;
      }
      console.error('Usage: mochi daemon cron add <prompt> --schedule <every Xm|cron> | list | remove <id>');
      process.exit(1);
    }
    console.error('Usage: mochi daemon start|status|jobs|send|approve|resume|cron|restart|stop');
    process.exit(1);
  }

  // Subcommands
  if (first === 'goal') {
    const sub = positional[1];
    const objective = positional.slice(1).join(' ');
    if (!objective) { console.error('Usage: mochi goal "<objective>" | list | show <id> | pause <id> | resume <id> | cancel <id> | retry <id>'); process.exit(1); }
    if (sub === 'list') {
      const goals = runtime.workspace.listGoals().map((f) => f.replace(/\.json$/, ''));
      if (goals.length === 0) console.log('No goals yet.');
      for (const id of goals) {
        const goal = runtime.workspace.loadGoal(id);
        if (goal) console.log(`${goal.status.padEnd(10)} ${id.slice(0, 8)}  ${goal.objective}`);
      }
      return;
    }
    if (['show', 'pause', 'resume', 'cancel', 'retry', 'approve'].includes(sub)) {
      const id = positional[2];
      if (!id) { console.error(`Usage: mochi goal ${sub} <id>`); process.exit(1); }
      const goal = runtime.workspace.loadGoal(id);
      if (!goal) { console.error('Goal not found'); process.exit(1); }
      if (sub === 'show') {
        console.log(JSON.stringify(goal, null, 2));
        const tasks = runtime.workspace.loadTasks(goal.id);
        for (const task of tasks) console.log(`${task.status.padEnd(8)} ${task.title}`);
        return;
      }
      if (sub === 'pause') {
        goal.status = 'paused';
        runtime.workspace.saveGoal(goal);
        console.log(`Paused ${goal.id.slice(0, 8)}`);
        return;
      }
      if (sub === 'cancel') {
        goal.status = 'cancelled';
        runtime.workspace.saveGoal(goal);
        console.log(`Cancelled ${goal.id.slice(0, 8)}`);
        return;
      }
      if (sub === 'retry') {
        const tasks = runtime.workspace.loadTasks(goal.id).map((t) => (t.status === 'failed' ? { ...t, status: 'pending' as const } : t));
        runtime.workspace.saveTasks(goal.id, tasks);
        goal.status = 'active';
        runtime.workspace.saveGoal(goal);
        const result = await runtime.goals.runGoal(goal, tasks);
        console.log(result.summary);
        return;
      }
      if (sub === 'resume' || sub === 'approve') {
        goal.status = 'active';
        runtime.workspace.saveGoal(goal);
        const tasks = runtime.workspace.loadTasks(goal.id);
        const result = await runtime.goals.runGoal(goal, tasks);
        console.log(result.summary);
        return;
      }
    }
    console.log(await runtime.goal(objective, [], { enhance: flags.enhance === true, enhanceMode: flags.mode ? String(flags.mode) : undefined }));
    return;
  }
  if (first === 'team') {
    const objective = positional.slice(1).join(' ');
    if (!objective) { console.error('Usage: mochi team "<objective>"'); process.exit(1); }
    console.log(await runtime.team(objective, { enhance: flags.enhance === true, enhanceMode: flags.mode ? String(flags.mode) : undefined }));
    return;
  }
  if (first === 'plan') {
    const objective = positional.slice(1).join(' ');
    if (!objective) { console.error('Usage: mochi plan "<objective>"'); process.exit(1); }
    console.log(await runtime.plan(objective));
    return;
  }
  if (first === 'resume') {
    const goals = runtime.workspace.listGoals();
    if (goals.length === 0) { console.log('No saved goals to resume.'); return; }
    const latest = goals[goals.length - 1].replace(/\.json$/, '');
    const goal = runtime.workspace.loadGoal(latest);
    if (!goal) { console.log('Goal not found.'); return; }
    const tasks = runtime.workspace.loadTasks(goal.id);
    console.log(`Resuming goal: ${goal.objective}`);
    const result = await runtime.goals.runGoal(goal, tasks);
    console.log(result.summary);
    return;
  }
  if (first === 'checkpoint') {
    if (!(await isRepo(cwd))) { console.log('Not a git repository.'); return; }
    const cp = await runtime.checkpoint(positional.slice(1).join(' ') || 'mochi checkpoint');
    console.log(`Checkpoint created: ${cp.type} ${cp.ref}`);
    return;
  }
  if (first === 'rollback') {
    if (!(await isRepo(cwd))) { console.log('Not a git repository.'); return; }
    console.log(await runtime.rollback());
    return;
  }
  if (first === 'workspace') {
    const sub = positional[1];
    if (sub === 'list') {
      const goals = runtime.workspace.listGoals();
      console.log(goals.join('\n').replace(/\.json/g, '') || 'No workspaces/goals saved yet.');
    } else if (sub === 'create' || sub === 'switch') {
      // `create` without a name gets a readable random slug (OpenFable Slug),
      // so concurrent agents don't collide on "default" and names stay
      // memorable. `switch` still requires an explicit existing name.
      let name = positional[2];
      if (!name && sub === 'create') name = randomSlug();
      if (!name) { console.error('Usage: mochi workspace create [<name>] | switch <name>'); process.exit(1); }
      runtime.config.projectDir = `.mochi/${name}`;
      const ws = new (await import('./workspace.js')).Workspace(cwd, runtime.config.projectDir);
      ws.ensure();
      console.log(`Workspace ready: ${ws.dir}`);
    } else {
      console.error('Usage: mochi workspace create [<name>] | switch <name>');
    }
    return;
  }
  if (first === 'status' || first === 'changes') {
    if (!(await isRepo(cwd))) { console.log('Not a git repository.'); return; }
    console.log(await status(cwd));
    return;
  }
  if (first === 'diff') {
    if (!(await isRepo(cwd))) { console.log('Not a git repository.'); return; }
    console.log(await diff(cwd));
    return;
  }
  if (first === 'tui') {
    const { launchTui } = await import('./tui/app.js');
    await launchTui(runtime);
    return;
  }
  if (first === 'acp') {
    // Editor-native stdio server (Agent Client Protocol). Runs until the
    // editor closes stdin. Never falls through to the prompt path.
    const { serverLoop } = await import('./acp.js');
    await serverLoop(cwd);
    return;
  }
  if (first === 'perf') {
    const { benchmarkStream, formatPerfReport } = await import('./perf.js');
    const count = flags.chunks ? Number(flags.chunks) : 10000;
    console.log(formatPerfReport(benchmarkStream(count)));
    return;
  }
  if (first === 'config') {
    console.log(JSON.stringify(runtime.config, null, 2));
    return;
  }
  if (first === 'providers') {
    const { PROVIDERS } = await import('./providers.js');
    for (const p of PROVIDERS) console.log(p.id.padEnd(14) + ' ' + p.name);
    return;
  }
  if (first === 'login' || first === 'use') {
    const { providerById } = await import('./providers.js');
    const provider = positional[1];
    const model = positional[2];
    if (!provider) {
      console.log('Usage: mochi login <provider> [model]');
      const { PROVIDERS } = await import('./providers.js');
      for (const p of PROVIDERS) console.log('  ' + p.id.padEnd(14) + p.name);
      return;
    }
    const p = providerById(provider);
    if (!p) { console.error('Unknown provider: ' + provider); return; }
    const key = process.env[p.envKey] || positional.find((x) => x.startsWith('env:'))?.slice(4);
    if (!key && p.envKey) {
      console.log(`Set ${p.envKey} or run 'mochi tui' and use /login to input an API key interactively.`);
      return;
    }
    const info = key ? await runtime.loginProvider(p.id, key, model || p.defaultModel) : await runtime.useProvider(p.id, model || p.defaultModel);
    const { redact } = await import('./security.js');
    console.log(redact(info));
    return;
  }
  if (first === 'models') {
    console.log(runtime.modelList().join('\n') || 'No models listed for ' + runtime.config.model.provider);
    return;
  }
  if (first === 'doctor') {
    const { doctorReport, formatDoctor } = await import('./doctor.js');
    const { daemonRunning, readDaemonInfo } = await import('./daemon.js');
    const info = readDaemonInfo(runtime.workspace.dir);
    const isRunning = daemonRunning(runtime.workspace.dir);
    const report = await doctorReport({
      provider: runtime.config.model.provider,
      baseUrl: runtime.config.model.baseUrl ?? '',
      model: runtime.config.model.model,
      apiKey: runtime.config.model.apiKey ?? null,
      workspaceDir: runtime.workspace.dir,
      daemon: { running: isRunning, port: info?.port },
    });
    console.log(formatDoctor(report));
    return;
  }
  if (first === 'run' || first === 'shell') {
    const cmd = positional.slice(1).join(' ');
    const { execFile } = await import('node:child_process');
    execFile('sh', ['-c', cmd], { cwd }, (e, o, er) => {
      console.log(String(o ?? ''));
      if (er) { console.error(String(er)); process.exitCode = (e as any)?.code ?? 1; }
    });
    return;
  }
  if (first === 'test') {
    const { detectRepo } = await import('./repo.js');
    const repo = detectRepo(cwd);
    const cmd = repo.testCommand ?? 'no test command detected';
    const { execFile } = await import('node:child_process');
    execFile('sh', ['-c', cmd], { cwd }, (e, _stdout, stderr) => {
      if (stderr) console.error(String(stderr));
      if (e) process.exitCode = (e as any)?.code ?? 1;
    });
    return;
  }
  if (first === 'init') {
    const { existsSync, writeFileSync } = await import('node:fs');
    const p = resolve(cwd, 'MOCHI.md');
    if (existsSync(p)) { console.log('MOCHI.md already exists.'); return; }
    writeFileSync(p, '# MOCHI.md\n\nProject instructions for the Mochi coding agent.\n');
    console.log('Created MOCHI.md');
    return;
  }
  if (first === 'branch') {
    const { execFile } = await import('node:child_process');
    execFile('git', ['branch', '--show-current'], { cwd }, (e, out) => console.log(String(out ?? '').trim() || 'no branch'));
    return;
  }
  if (first === 'commit') {
    const { checkpoint } = await import('./git.js');
    const cp = await checkpoint(cwd, positional.slice(1).join(' ') || 'mochi commit');
    console.log(`Committed ${cp.type} ${cp.ref}`);
    return;
  }
  if (first === 'usage') { console.log(runtime.usage.summary()); return; }
  if (first === 'known-good') { console.log(await runtime.recordGood()); return; }
  if (first === 'check') { console.log(await runtime.knownGood()); return; }
  if (first === 'enhance') {
    const question = positional.slice(1).join(' ');
    if (!question) { console.error('Usage: mochi enhance "<task>" [--mode <mode>]'); process.exit(1); }
    const mode = flags.mode ? String(flags.mode) : 'auto';
    try {
      const r = await runtime.enhance(question, mode as never);
      console.log(`# Chameleon enhancement (mode ${r.mode}, ${r.strategies.length} strategies, ${r.tokensUsed} tokens, $${r.costUsd.toFixed(4)})\n`);
      console.log(r.context);
    } catch (e) {
      console.error('Enhance failed:', e instanceof Error ? e.message : e);
      process.exit(1);
    }
    return;
  }
  if (first === 'termix') {
    // "Split this session into N split windows." No external app, no extra
    // process, no auto-launch: all panes are in-process agent sessions on the
    // same configured provider. The user chooses how many splits, then whether
    // they communicate over a shared channel or stay separate.
    const { termix } = await import('./termix.js');
    const isTTY = Boolean(process.stdin.isTTY);

    // Helper: read a single line from stdin (only used when a TTY is present).
    const ask = (prompt: string, fallback: string): Promise<string> =>
      new Promise((resolveInput) => {
        if (!isTTY) return resolveInput(fallback);
        process.stdout.write(prompt);
        let acc = '';
        const onData = (c: Buffer) => {
          acc += c.toString('utf8');
          if (acc.includes('\n')) {
            process.stdin.off('data', onData);
            process.stdin.pause();
            resolveInput(acc.trim());
          }
        };
        process.stdin.on('data', onData);
        process.stdin.resume();
      });

    let task = (flags.task ? String(flags.task) : positional.slice(1).join(' ')).trim();
    if (!task) {
      task = (await ask('Split the current task or enter a new one: ', 'Tackle the goal with parallel angles.')).trim();
      if (!task) task = 'Tackle the current goal with parallel angles.';
    }

    const sessions = flags.sessions
      ? Number(flags.sessions)
      : Number((await ask('How many split panes? (default 2): ', '2')).trim() || 2);

    const coms = flags.coms === true || flags.mode === 'communicate';
    const sep = flags.sep === true || flags.mode === 'separate';
    let mode: 'communicate' | 'separate';
    if (coms && !sep) mode = 'communicate';
    else if (sep && !coms) mode = 'separate';
    else if (!coms && !sep) {
      const chosen = (await ask('Let the split panes communicate (c) or stay separate (s)? [c/s]: ', 'c')).toLowerCase();
      mode = chosen.startsWith('s') ? 'separate' : 'communicate';
    } else {
      mode = 'communicate';
    }

    const run = await termix({ mode, sessions, task, config: runtime.config });
    console.log(`\n# Termix: split into ${run.sessions} panes (${mode})\n`);
    for (const s of run.results) {
      const status = s.error ? `error: ${s.error}` : 'ok';
      console.log(`┌─ pane ${s.index + 1} · ${s.role}`);
      console.log(`│ steps=${s.steps} tokens=${s.tokensUsed} $${s.costUsd.toFixed(4)} (${s.durationMs}ms) — ${status}`);
      console.log(`└ ${s.output.replace(/\s+/g, ' ').slice(0, 220)}`);
    }
    console.log(`\nTotal: ${run.tokensUsed} tokens, $${run.costUsd.toFixed(4)} (${run.durationMs}ms)`);
    process.exitCode = run.results.some((s) => s.error) ? 1 : 0;
    return;
  }
  if (first === 'speculate') {
    const question = positional.slice(1).join(' ');
    if (!question) { console.error('Usage: mochi speculate "<question>"'); process.exit(1); }
    const result = await runtime.speculate(question);
    console.log(`Question: ${question}`);
    console.log(`Strategies:\n${result.candidates.map((c, i) => `${i + 1}. ${c.strategy}`).join('\n')}`);
    if (result.best) console.log(`Best: ${result.best.strategy}\n${result.best.response}`);
    else console.log(result.verifierNotes);
    return;
  }
  if (first === 'profiles') {
    for (const profile of runtime.profiles()) {
      console.log(`${profile.name} (${profile.role}) model=${profile.defaultModel ?? 'coding'} verification=${profile.verification ?? 'optional'} tools=${profile.tools?.join(',') ?? 'all'}`);
    }
    return;
  }
  if (first === 'memory') {
    const memory = runtime.memory();
    console.log(memory || 'No project memory yet.');
    return;
  }
  if (first === 'inspect') {
    const query = positional.slice(1).join(' ');
    if (!query) { console.error('Usage: mochi inspect "<query>"'); process.exit(1); }
    const result = await runtime.inspect(query);
    console.log(result.summary);
    return;
  }


  if (first === 'session') {
    const { SessionStore, hasSqlite } = await import('./session-store.js');
    if (!hasSqlite()) { console.log('Session store needs node:sqlite (Node >= 22.5).'); return; }
    const store = new SessionStore(runtime.workspace.dir);
    try {
      const sub = positional[1];
      if (sub === 'search') {
        const q = positional.slice(2).join(' ');
        if (!q) { console.log('Usage: mochi session search "<text>"'); return; }
        const hits = store.search(q);
        if (!hits.length) { console.log(`No session content matches "${q}".`); return; }
        for (const h of hits.slice(0, 10)) {
          console.log(`[${h.sessionId.slice(0, 8)} ${h.role}] ${h.content.slice(0, 140)}`);
        }
        return;
      }
      if (sub === 'list') {
        const rows = store.list(20);
        if (!rows.length) { console.log('No sessions yet.'); return; }
        for (const r of rows) {
          const obj = r.objective ? r.objective.slice(0, 60) : '(no objective)';
          console.log(`${r.id.slice(0, 8)}  ${r.status.padEnd(9)} ${obj}`);
        }
        return;
      }
      console.log('Usage: mochi session list\n       mochi session search "<text>"');
    } finally {
      store.close();
    }
    return;
  }

  if (first === 'trace') {
    const { readTrace, formatTrace } = await import('./trace.js');
    const id = positional[1] ?? '';
    const ids = id ? [id] : [];
    if (!ids.length) {
      // No id: list recent trace files and replay the newest one.
      const { readdirSync } = await import('node:fs');
      const dir = resolve(runtime.workspace.dir, 'traces');
      const files = (() => { try { return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort(); } catch { return []; } })();
      if (!files.length) { console.log('No traces yet.'); return; }
      ids.push(files[files.length - 1].replace(/\.jsonl$/, ''));
    }
    for (const gid of ids) {
      const entries = readTrace(runtime.workspace.dir, gid);
      if (!entries.length) { console.log(`No trace for ${gid}.`); continue; }
      console.log(formatTrace(entries));
    }
    return;
  }

  const prompt = positional.join(' ');
  if (prompt) {
    // Full-screen TUI only makes sense on an interactive terminal. When stdin
    // or stdout is piped/redirected (scripts, CI, `mochi "..." | less`), run
    // the prompt and print the result instead of spewing escape codes.
    const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (flags.p || flags.print || !isTTY) {
      console.log(await runtime.runPrompt(prompt));
    } else {
      await interactive(runtime, prompt);
    }
    return;
  }

  // No prompt: drop into the interactive TUI when attached to a terminal;
  // otherwise print usage since there is nothing to drive interactively.
  if (process.stdin.isTTY && process.stdout.isTTY) {
    await interactive(runtime);
  } else {
    printHelp();
  }
}

async function interactive(runtime: import('./runtime.js').Runtime, initialPrompt?: string) {
  const { launchTui } = await import('./tui/app.js');
  await launchTui(runtime, initialPrompt);
}

main().catch((e) => {
  console.error('Fatal:', e instanceof Error ? e.message : e);
  process.exit(1);
});
