#!/usr/bin/env node
// Sync fs/url/path imports at module top (ESM-safe; no require() in output).
import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve, join as pathJoin } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findProjectRoot } from './repo.js';
import type { MochiConfig } from './types.js';

// Resolve the version from package.json when running from source; when Mochi is
// compiled to a standalone binary there is no package.json next to it, so fall
// back to the constant (kept in sync with package.json at build time).
let VERSION = '0.10.7';
try {
  const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '../package.json');
  VERSION = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
} catch {
  /* compiled binary: use the baked-in default */
}

const BOOLEAN_FLAGS = new Set([
  'p', 'print', 'auto', 'quiet', 'q', 'verbose', 'v', 'debug', 'h', 'help', 'version', 'offline', 'enhance', 'install', 'plan',
  'y', 'yolo', 'dangerously-skip-permissions', 'force', 'user',
  'strict', 'json', 'diff-only', 'auto-commit', 'repair',
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
  if (flags.reasoning) overrides.reasoning = String(flags.reasoning).toLowerCase() as any;
  // Plan-then-act: `--plan` (a dashed boolean; the bare `plan` subcommand
  // is positional and unaffected) makes every agent in the run research and
  // return a plan instead of editing files.
  if (flags.plan) overrides.planMode = true;
  // --yolo / -y / --dangerously-skip-permissions: bypass all permission gates
  if (flags.yolo || flags.y || flags['dangerously-skip-permissions'] ||
      process.env.MOCHI_DANGEROUSLY_SKIP_PERMISSIONS === '1') {
    overrides.safety = { ...(overrides.safety ?? {} as any), mode: 'auto' as const };
    (overrides as any).__yolo = true;
  }
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
  mochi checkpoint [save <name>|list|restore <name>]  # named snapshots & rollback
  mochi docgen [--write]             # generate architecture diagram & API reference
  mochi rollback
  mochi workspace create|list|switch <name>
  mochi profiles
  mochi memory
  mochi inspect "<query>"
  mochi trace [<goalId>]             # replay the run trace for a goal
  mochi session list                 # list past sessions
  mochi session search "<text>"       # full-text search past transcripts
  mochi speculate "<question>"
  mochi mode <normal|spec|security|codemod|chaos>  # set execution mode
  mochi rules [list|add]             # manage modular project rules
  mochi bg [list|logs|kill]          # manage async background tasks
  mochi discord [run|status]         # run Discord bot gateway
  mochi dashboard | mochi web        # open web dashboard in browser
  mochi plugin add <dir>|remove <name>|list        # spec 12-E plugin registry
  mochi security | mochi audit       # static security and credential audit
  mochi review [--strict] [--json] [--diff-only]   # git diff | mochi review
  mochi fix [--auto-commit]                        # cat crash.log | mochi fix
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
  mochi reasoning [low|med|high|max] # view or set reasoning depth
  mochi tui
  mochi perf
  mochi "<prompt>" --plan            # plan-then-act: research + return a plan, no edits

Options:
  -p, --print             Print response and exit
  --auto                  Autonomous mode
  --reasoning <level>     Reasoning effort: low|medium|high|max
  --provider <name>       Model provider
  --model <id>            Model ID
  --api-key <key>         API key
  --safety safe|ask|auto  Safety mode
  --max-tokens <n>        Budget limit
  --max-cost <usd>        Cost limit
  --max-model-calls <n>   Model call limit
  --max-tool-calls <n>    Tool call limit
  --workspace <name>      Use workspace
  --plan                  Plan mode (no edits)
  -y, --yolo              Bypass all permission prompts (alias: --dangerously-skip-permissions)
  --dangerously-skip-permissions  Same as --yolo
  -q, --quiet             Less output
  -v, --verbose           More output
  --debug                 Debug output
  --chunks <n>            Chunk count for mochi perf
  -h, --help              Show help
  --version               Show version

Environment:
  MOCHI_DANGEROUSLY_SKIP_PERMISSIONS=1  Same as --yolo
`);
}

// Sync fs/url/path imports at module top (ESM-safe; no require() in output).
function cliDirname(): string {
  // dist/cli.js → dist/; src/cli.ts → src/. Resolves relative to this file.
  return dirname(fileURLToPath(import.meta.url));
}

function srcFileNewer(dir: string, mtime: number): boolean {
  let stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.' || e.name === '..') continue;
      const p = pathJoin(d, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!/\.(ts|json)$/.test(e.name)) continue;
      try { if (statSync(p).mtimeMs > mtime) return true; } catch {}
    }
  }
  return false;
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));

  // Ultra-fast path for info queries (version, help): exit immediately in <3ms
  if (flags.h || flags.help) { printHelp(); return; }
  if (flags.version || positional[0] === 'version') { console.log(VERSION); return; }

  // Dist freshness guard: when running the compiled dist/ tree (the global
  // `mochi` shim) and src/*.ts is newer than the last build, rebuild once so
  // the user never runs a stale TUI/harness after pulling changes. The guard
  // itself lives in dist/cli.js's import of this file only when DIST build;
  // running from src via tsx/bun skips it (srcFile check fails).
  try {
    const rp = resolve;
    const distHere = rp(cliDirname(), 'tui', 'view.js');
    if (existsSync(distHere)) {
      const distMtime = statSync(distHere).mtimeMs;
      const srcDir = rp(cliDirname(), '..', 'src');
      const newer = srcFileNewer(srcDir, distMtime);
      if (newer && !process.env.MOCHI_SKIP_AUTOBUILD) {
        console.error('\x1b[38;2;163;230;53mmochi\x1b[0m sources changed — rebuilding dist…');
        const { execFile } = await import('node:child_process');
        const repoRoot = rp(cliDirname(), '..');
        // Run the repo-local TypeScript compiler with the current node binary;
        // no npx (spawn-without-shell can't resolve it from an ESM process).
        const tscJs = rp(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
        try {
          await new Promise<void>((res, rej) => {
            execFile(process.execPath, [tscJs, '-p', 'tsconfig.json'], { cwd: repoRoot, timeout: 180_000 }, (err) => (err ? rej(err) : res()));
          });
          console.error('\x1b[38;2;163;230;53mmochi\x1b[0m dist rebuilt.');
        } catch (e) {
          console.error(`[mochi] auto-rebuild failed (${e instanceof Error ? e.message.split('\n')[0] : 'unknown'}); running the previous build`);
        }
      }
    }
  } catch { /* best-effort freshness guard */ }
  // Resolve the SQLite driver (node:sqlite or bun:sqlite) before any
  // subsystem probes it: sessions, codegraph, and search all check
  // synchronously on first use.
  try { await (await import('./sqlite.js')).sqliteDriverAsync(); } catch {}

  const cwd = process.cwd();
  const configOverrides = configFromFlags(flags);
  const { Runtime } = await import('./runtime.js');
  const { randomSlug } = await import('./util.js');
  const { status, diff, isRepo } = await import('./git.js');
  const runtime = Runtime.create({ cwd, config: configOverrides });

  // Permission policy — propagate --yolo / env var to the runtime object so
  // the TUI status badge and PermissionManager can read it without config hacks.
  const isYolo = (configOverrides as any).__yolo === true ||
    process.env.MOCHI_DANGEROUSLY_SKIP_PERMISSIONS === '1';
  (runtime as any).__permPolicy = isYolo ? 'yolo'
    : (configOverrides.safety?.mode === 'auto' ? 'workspace-safe' : 'strict');
  if (isYolo) {
    console.error('[YOLO] YOLO mode: all permission prompts bypassed. Proceeding autonomously.');
  }

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
    const sub = positional[1];
    if (sub === 'save') {
      const name = positional[2];
      const desc = positional.slice(3).join(' ');
      if (!name) { console.log('Usage: mochi checkpoint save <name> ["description"]'); return; }
      const { saveNamedCheckpoint } = await import('./checkpoint-manager.js');
      const cp = await saveNamedCheckpoint(cwd, name, desc);
      console.log(`Saved named checkpoint "${cp.name}" (SHA: ${cp.gitCommitSha.slice(0, 7)})`);
      return;
    }
    if (sub === 'list' || sub === 'ls') {
      const { listNamedCheckpoints } = await import('./checkpoint-manager.js');
      const list = listNamedCheckpoints(cwd);
      if (!list.length) { console.log('No named checkpoints found. Use: mochi checkpoint save <name>'); return; }
      console.log(`🍡 Saved Checkpoints (${list.length}):\n`);
      for (const cp of list) {
        console.log(`- ${cp.name.padEnd(20)} [${new Date(cp.createdAt).toLocaleString()}] ${cp.description || ''}`);
      }
      return;
    }
    if (sub === 'restore' || sub === 'load') {
      const name = positional[2];
      if (!name) { console.log('Usage: mochi checkpoint restore <name>'); return; }
      const { restoreNamedCheckpoint } = await import('./checkpoint-manager.js');
      const res = await restoreNamedCheckpoint(cwd, name);
      console.log(res.message);
      return;
    }
    if (!(await isRepo(cwd))) { console.log('Not a git repository.'); return; }
    const cp = await runtime.checkpoint(positional.slice(1).join(' ') || 'mochi checkpoint');
    console.log(`Checkpoint created: ${cp.type} ${cp.ref}`);
    return;
  }
  if (first === 'docgen' || first === 'docs') {
    const { generateProjectDocs } = await import('./docgen.js');
    const docs = generateProjectDocs(cwd);
    if (flags.write || flags.save) {
      const { writeFileSync } = await import('node:fs');
      const outPath = resolve(cwd, 'ARCHITECTURE.md');
      writeFileSync(outPath, docs.markdown, 'utf8');
      console.log(`Wrote architecture documentation to ${outPath} (${docs.moduleCount} modules, ${docs.symbolCount} symbols).`);
    } else {
      console.log(docs.markdown);
    }
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
  if (first === 'reasoning' || first === 'depth') {
    const level = positional[1];
    if (level) {
      const desc = runtime.setReasoning(level);
      console.log(`Reasoning mode set to ${runtime.getReasoning().toUpperCase()}: ${desc}`);
    } else {
      console.log(`Active reasoning mode: ${runtime.getReasoning().toUpperCase()}`);
      console.log(`Usage: mochi reasoning <low|medium|high|max> (or use /reasoning in 'mochi tui' for interactive menu)`);
    }
    return;
  }
  if (first === 'mode') {
    const { MODE_IDS } = await import('./modes.js');
    const m = positional[1];
    if (!m) { console.log('Usage: mochi mode <normal|spec|security|codemod|chaos>'); return; }
    const out = runtime.setMode(m);
    console.log(out && out !== 'normal' ? `Mode set: ${m}` : `Mode set: ${m} (no extra instruction)`);
    return;
  }
  if (first === 'ambient') {
    // mochi ambient [--watch] — run repo checks once (or watch), draft proposals
    const { checkOnce, startAmbient } = await import('./ambient.js');
    if (flags.watch) {
      console.log(`Ambient watch started (Ctrl-C to stop). Proposals: ${resolve(cwd, '.mochi', 'ambient')}`);
      const stop = startAmbient({
        cwd,
        onFailure: (r) => console.log(`[ambient] FAIL ${r.command} (exit ${r.exitCode}) -> ${r.proposalPath ?? '(none)'}`),
      });
      process.on('SIGINT', () => { stop(); process.exit(0); });
      await new Promise(() => {}); // run until interrupt
      return;
    }
    const reports = await checkOnce({ cwd, onFailure: (r) => console.log(`[ambient] FAIL ${r.command} (exit ${r.exitCode}) -> ${r.proposalPath ?? '(none)'}`) });
    console.log(reports.length ? reports.length + ' failing check(s) — proposals in .mochi/ambient' : 'All checks pass.');
    return;
  }
  if (first === 'issue') {
    // mochi issue <n> — start an issue-to-PR flow: fetch, branch, and print how
    // to implement + open the PR (the agent fix is a normal `mochi` run in the
    // created branch; this keeps the plumbing honest without auto-pushing).
    const n = Number(positional[1]);
    if (!Number.isInteger(n) || n < 1) { console.log('Usage: mochi issue <number>'); return; }
    const { runIssueToPr } = await import('./pr.js');
    try {
      const res = await runIssueToPr({ cwd, issueNumber: n });
      console.log(`Branch: ${res.branch}`);
      console.log(`Next: checkout ${res.branch}, run 'mochi goal "fix #${n} …"', then 'mochi pr ${n}' to open the PR.`);
      return;
    } catch (e) {
      console.error(`Issue pipeline failed: ${(e as Error).message}`);
      return;
    }
  }
  if (first === 'skills') {
    const { loadAllSkills, readSkillBody } = await import('./skills.js');
    const { skills } = loadAllSkills(cwd);
    const sub = positional[1];
    if (sub === 'list' || !sub) {
      if (!skills.length) { console.log('No skills available.'); return; }
      for (const sk of skills) {
        console.log(`${sk.name.padEnd(24)} ${sk.description.slice(0, 72)}`);
      }
      return;
    }
    // mochi skills show <name> or mochi skills <name>
    const targetName = (sub === 'show' ? positional[2] : sub) || '';
    const sk = skills.find((x) => x.name === targetName || x.name.toLowerCase() === targetName.toLowerCase());
    if (!sk) { console.log(`No skill "${targetName}". Type "mochi skills" to list all.`); return; }
    const { readFileSync } = await import('node:fs');
    try { console.log(readFileSync(sk.path, 'utf8').slice(0, 4000)); }
    catch (e) { console.error(`Failed to read skill: ${(e as Error).message}`); }
    return;
  }
  if (first === 'plugins' || first === 'plugin') {
    // spec 12-E: mochi plugin add|remove|list [--user|--force]
    const { PluginRegistry } = await import('./plugins.js');
    const projectPlugins = resolve(cwd, '.mochi', 'plugins');
    const reg = new PluginRegistry(projectPlugins);
    const sub = positional[1];
    if (sub === 'list' || sub === 'ls' || !sub) {
      const records = reg.list();
      if (!records.length) { console.log('No plugins installed. Use: mochi plugin add <dir>'); return; }
      for (const p of records) {
        console.log(`${p.name.padEnd(24)} v${p.version.padEnd(8)} ${p.scope === 'user' ? '[user] '.padEnd(8) : '[proj] '.padEnd(8)}${p.description}${p.hooks.length ? ` hooks:${p.hooks.join(',')}` : ''}`);
      }
      return;
    }
    if (sub === 'add' || sub === 'install') {
      const source = positional[2];
      if (!source) { console.log('Usage: mochi plugin add <dir> [--user] [--force]'); return; }
      try {
        const rec = reg.install(source, { scope: flags.user ? 'user' : 'project', overwrite: !!flags.force });
        const hooksFile = resolve(cwd, '.mochi', 'hooks.json');
        const { existsSync, readFileSync } = await import('node:fs');
        const existing = existsSync(hooksFile) ? JSON.parse(readFileSync(hooksFile, 'utf8')) : {};
        reg.syncToHooksFile(hooksFile, existing);
        console.log(`Installed plugin "${rec.name}" v${rec.version} (${rec.scope} scope).`);
        console.log(`Hooks merged into ${hooksFile}`);
        return;
      } catch (e) {
        console.error(`Install failed: ${(e as Error).message}`);
        return;
      }
    }
    if (sub === 'remove' || sub === 'rm') {
      const name = positional[2];
      if (!name) { console.log('Usage: mochi plugin remove <name>'); return; }
      if (reg.remove(name)) { console.log(`Removed plugin "${name}".`); }
      else { console.error(`No plugin "${name}" installed.`); }
      return;
    }
    console.log('Usage: mochi plugin <add <dir>|remove <name>|list>');
    return;
  }
  if (first === 'rules' || first === 'rule') {
    const { loadRules, synthesizeRule } = await import('./rules.js');
    const sub = positional[1];
    if (sub === 'list' || !sub) {
      const all = loadRules(cwd);
      if (!all.length) { console.log('No modular rules found in .mochi/rules/. Use: mochi rules add <name> "<title>" "<content>"'); return; }
      console.log(`🍡 Modular Project Rules (${all.length}):\n`);
      for (const r of all) {
        const triggers = [
          r.globs?.length ? `globs:[${r.globs.join(',')}]` : null,
          r.keywords?.length ? `keywords:[${r.keywords.join(',')}]` : null,
        ].filter(Boolean).join(' ');
        console.log(`- ${r.id.padEnd(20)} "${r.title}" ${triggers ? `(${triggers})` : '(universal)'}`);
      }
      return;
    }
    if (sub === 'add') {
      const name = positional[2];
      const title = positional[3] || name;
      const content = positional.slice(4).join(' ') || positional[3] || '';
      if (!name || !content) { console.log('Usage: mochi rules add <name> "<title>" "<content>"'); return; }
      synthesizeRule(cwd, name, title, content);
      console.log(`Added rule "${name}" in .mochi/rules/${name}.md`);
      return;
    }
    console.log('Usage: mochi rules [list | add <name> "<title>" "<content>"]');
    return;
  }
  if (first === 'bg') {
    const { listTasks, getTask, describeTask, killTask } = await import('./background-tasks.js');
    const sub = positional[1];
    if (sub === 'list' || !sub) {
      const all = listTasks();
      if (!all.length) { console.log('No background tasks.'); return; }
      for (const t of all) {
        console.log(describeTask(t, 200));
      }
      return;
    }
    if (sub === 'status' || sub === 'logs' || sub === 'show') {
      const id = positional[2];
      if (!id) { console.log('Usage: mochi bg logs <task-id>'); return; }
      const t = getTask(id);
      if (!t) { console.log(`No background task "${id}".`); return; }
      console.log(`[bg:${t.id} status=${t.status} exit=${t.exitCode ?? 'running'}]\n${t.output || '(no output)'}`);
      return;
    }
    if (sub === 'kill' || sub === 'stop') {
      const id = positional[2];
      if (!id) { console.log('Usage: mochi bg kill <task-id>'); return; }
      const ok = killTask(id);
      console.log(ok ? `Killed background task ${id}.` : `Could not kill task ${id}.`);
      return;
    }
    console.log('Usage: mochi bg [list | logs <id> | kill <id>]');
    return;
  }
  if (first === 'discord') {
    const { loadDiscordConfig } = await import('./discord.js');
    const cfg = loadDiscordConfig(cwd);
    if (!cfg) {
      console.error('No Discord bot configuration found. Set DISCORD_BOT_TOKEN in .env, ~/.mochi/.env, or ~/.hermes/.env.');
      process.exit(1);
    }
    console.log(`🍡 Mochi Discord Gateway configured with prefix "${cfg.prefix || '!mochi'}".`);
    console.log(`Bot Token: ${cfg.token.slice(0, 10)}... (whitelisting: ${cfg.allowAllUsers ? 'all users' : (cfg.allowedUserIds?.length ?? 0) + ' users'})`);
    return;
  }
  if (first === 'security' || first === 'audit') {
    const { runSecurityAudit, formatSecurityReport } = await import('./tools/security-audit.js');
    const findings = runSecurityAudit(cwd);
    console.log(formatSecurityReport(findings));
    if (flags.strict && findings.some(f => f.severity === 'CRITICAL' || f.severity === 'HIGH')) {
      process.exit(1);
    }
    return;
  }
  if (first === 'dashboard' || first === 'web') {
    const wsDir = resolve(cwd, '.mochi');
    const { readDaemonInfo, startDaemon, daemonRunning } = await import('./daemon.js');
    let info = readDaemonInfo(wsDir);
    if (!info || !daemonRunning(wsDir)) {
      const r = await startDaemon({ cwd, config: configOverrides });
      if (!r.ok) { console.error(`Failed to start daemon: ${r.error}`); process.exit(1); }
      info = readDaemonInfo(wsDir);
    }
    const url = `http://127.0.0.1:${info?.port}/dashboard?token=${info?.token}`;
    console.log(`🍡 Mochi Web Dashboard running at:\n${url}\n`);
    return;
  }
  if (first === 'review') {
    // spec Pillar 2: git diff | mochi review [--strict] [--json] [--diff-only]
    const { readStdin, loadDiff, parseFindings, findingsToNdjson, renderFindings, countBySeverity } = await import('./pipeline.js');
    let input: string;
    if (flags['diff-only']) {
      input = loadDiff(positional.slice(1), cwd);
      console.log(input || '(no diff)');
      return;
    }
    const piped = await readStdin();
    input = piped.trim() ? piped : loadDiff(positional.slice(1), cwd);
    if (!input.trim()) { console.log('Nothing to review. Pipe a diff or log: git diff | mochi review'); return; }
    const summary = await runtime.review(input);
    const findings = parseFindings(summary);
    if (flags.json) {
      // JSON summary line first (for CI) then the findings NDJSON.
      const counts = countBySeverity(findings);
      console.log(JSON.stringify({ summary: summary.slice(0, 2000), highs: counts.HIGH, mediums: counts.MEDIUM, lows: counts.LOW, infos: counts.INFO }));
      if (findings.length) console.log(findingsToNdjson(findings));
    } else if (findings.length) {
      console.log(renderFindings(findings));
      const counts = countBySeverity(findings);
      console.log(`\n${counts.HIGH} HIGH, ${counts.MEDIUM} MEDIUM, ${counts.LOW} LOW, ${counts.INFO} INFO.`);
    } else {
      console.log(summary);
    }
    // --strict: exit nonzero when any HIGH/MEDIUM finding is present (CI gate).
    if (flags.strict) {
      const severe = findings.filter((f) => f.severity === 'HIGH' || f.severity === 'MEDIUM').length;
      process.exitCode = severe > 0 ? 1 : 0;
    }
    return;
  }
  if (first === 'fix') {
    // spec Pillar 2: cat crash.log | mochi fix [--auto-commit]
    const { readStdin } = await import('./pipeline.js');
    const piped = await readStdin();
    const explicit = positional.slice(1).join(' ');
    if (!piped.trim() && !explicit) {
      console.log('Usage: cat crash.log | mochi fix [--auto-commit]\n       mochi fix "describe the issue"');
      return;
    }
    const summary = await runtime.fix(piped.trim() ? piped : explicit);
    console.log(summary);
    if (flags['auto-commit'] || flags.commit) {
      const { checkpoint } = await import('./git.js');
      const cp = await checkpoint(cwd, 'mochi fix');
      console.log(`Auto-commit: ${cp.ref} (${cp.type})`);
    }
    return;
  }
  if (first === 'ask') {
    // Interactive clarification (spec 12-B): mochi ask "<title>" --choices "a;b;c" [--default a] [--recommended c]
    const { askUserChoice, renderMenu } = await import('./clarify.js');
    const title = positional.slice(1).join(' ');
    const choicesRaw = String(flags.choices ?? flags.options ?? '');
    if (!title || !choicesRaw) {
      console.log('Usage: mochi ask "<title>" --choices "pick A|pick B|pick C" [--default "<idx-or-id>"]');
      return;
    }
    const opts = choicesRaw.split('|').map((x) => x.trim()).filter(Boolean);
    const choices = opts.map((label, i) => ({ id: String(i + 1), label }));
    const dv = typeof flags['default'] === 'string' && flags['default'] ? flags['default'] : undefined;
    const q = { title, choices: choices.length ? choices : [{ id: '1', label: opts[0] ?? '' }], ...(dv ? { defaultValue: dv } : {}) };
    const out = await askUserChoice(q);
    console.log('→ ' + (out.choice?.label ?? '(none)') + (out.usedDefault ? ' (default)' : ''));
    return;
  }
  if (first === 'docs') {
    const { queryDocs, generateAdr } = await import('./dox.js');
    const sub = positional[1];
    const docsDir = resolve(cwd, 'docs');
    if (sub === 'query') {
      const q = positional.slice(2).join(' ');
      if (!q) { console.log('Usage: mochi docs query "<text>"'); return; }
      const hits = queryDocs(docsDir, q);
      if (!hits.length) { console.log('No doc matches.'); return; }
      for (const h of hits.slice(0, 5)) {
        console.log(`[${h.file}] ${h.title}`);
        console.log('  ' + h.text.slice(0, 180).replace(/\n/g, ' '));
      }
      return;
    }
    if (sub === 'adr') {
      // mochi docs adr "<title>" --context "..." --decision "..." [--tradeoffs "a;b"]
      const title = positional.slice(2).join(' ');
      const context = String(flags.context ?? '');
      const decision = String(flags.decision ?? '');
      if (!title || !context || !decision) {
        console.log('Usage: mochi docs adr "<title>" --context "..." --decision "..." [--tradeoffs "a;b"]');
        return;
      }
      const tradeoffs = typeof flags.tradeoffs === 'string' && flags.tradeoffs ? flags.tradeoffs.split(';').map((x) => x.trim()).filter(Boolean) : undefined;
      const rel = generateAdr(cwd, { title, context, decision, tradeoffs });
      console.log(`ADR written: ${rel}`);
      return;
    }
    console.log('Usage: mochi docs query "<text>" | mochi docs adr "<title>" --context "..." --decision "..."');
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
    const { doctorReport, formatDoctor, repairDoctor } = await import('./doctor.js');
    const { daemonRunning, readDaemonInfo } = await import('./daemon.js');
    const wsDir = findProjectRoot(runtime.cwd);
    
    if (flags.repair || flags.fix || positional[1] === 'repair' || positional[1] === 'fix') {
      const repair = await repairDoctor({ cwd: runtime.cwd, workspaceDir: resolve(wsDir, '.mochi') });
      console.log(repair.summary + '\n');
      for (const item of repair.items) {
        const icon = item.status === 'fixed' ? '🔧 [FIXED]' : item.status === 'already_ok' ? '✓ [OK]' : '⚠️ [ACTION]';
        console.log(`  ${icon.padEnd(14)} ${item.name}: ${item.details}`);
      }
      console.log('');
    }

    const info = readDaemonInfo(runtime.workspace.dir);
    const isRunning = daemonRunning(runtime.workspace.dir);
    const report = await doctorReport({
      provider: runtime.config.model.provider,
      baseUrl: runtime.config.model.baseUrl ?? '',
      model: runtime.config.model.model,
      apiKey: runtime.config.model.apiKey ?? null,
      workspaceDir: wsDir,
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
  if (first === 'enhance' || first === 'chameleon') {
    const question = positional.slice(1).join(' ');
    if (!question) { console.error('Usage: mochi chameleon "<task>" [--mode <mode>] [--strategy <strategy>]'); process.exit(1); }
    const mode = flags.mode ? String(flags.mode) : 'auto';
    const strategy = flags.strategy ? String(flags.strategy) : 'hybrid';
    try {
      const { ChameleonEngine } = await import('./chameleon.js');
      const engine = new ChameleonEngine(runtime.config);
      const r = await engine.enhance({ task: question, mode: mode as any, strategy: strategy as any, cwd: runtime.cwd });
      console.log(`[Lazy Chameleon v2.4 — Mode: ${r.mode}, Strategy: ${r.strategy}, ${r.strategies.length} passes, ${r.tokensUsed} tokens, ${r.durationMs}ms]\n`);
      console.log(r.context);
    } catch (e) {
      console.error('Chameleon enhancement failed:', e instanceof Error ? e.message : e);
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
    if (!hasSqlite()) { console.log('Session store needs a SQLite driver (Node >= 22.5 or the bun binary).'); return; }
    // GoalEngine persists sessions under the PROJECT ROOT (.mochi/sessions.sqlite);
    // workspace.dir is already that root's .mochi subdir. Use the same key the
    // engine does or the CLI reads an empty sibling DB and sessions never list.
    const store = new SessionStore(findProjectRoot(runtime.cwd));
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
      const result = await runtime.runPrompt(prompt);
      console.log(result);
      // Non-interactive one-shot: exit explicitly once stdout has flushed.
      // runPrompt can leave handles alive (event bus, recorder, model keep-alive)
      // that would keep the process running forever even after work is done,
      // so don't rely on the event loop draining on its own.
      process.stdout.write('\n', () => process.exit(0));
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
