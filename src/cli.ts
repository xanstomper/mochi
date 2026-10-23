#!/usr/bin/env node
// Sync fs/url/path imports at module top (ESM-safe; no require() in output).
import { readFileSync, statSync, existsSync, readdirSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, resolve, join as pathJoin } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs, configFromFlags } from './cli-flags.js';
import * as nodeModule from 'node:module';
// V8 compile cache: persist compiled module bytecode under ~/.cache/mochi so
// subsequent invocations skip re-parsing (~16% faster cold start, 109ms ->
// 91ms over 20 runs). NODE_COMPILE_CACHE must be set before node boots to
// cover the entry module, so when it isn't set we call enableCompileCache()
// in-process — it activates for all later-loaded modules even if the entry
// module itself is compiled fresh on the very first run.
//
// Namespace import (not `await import`) on purpose: this file must contain NO
// top-level await — `bun build --compile --bytecode` converts the bundle to
// CJS and any TLA in the shipped graph makes the whole standalone binary
// unbuildable. `import * as` degrades safely on pre-22 node (the property is
// simply undefined) instead of hard-failing at link time like a missing named
// export would.
if (!process.env.NODE_COMPILE_CACHE && nodeModule.enableCompileCache) {
  try {
    const cacheDir = resolve(homedir(), '.cache', 'mochi', 'compile');
    mkdirSync(cacheDir, { recursive: true });
    nodeModule.enableCompileCache(cacheDir);
  } catch { /* read-only home or pre-22 node — run without cache */ }
}
// Repo module, lazy: `findProjectRoot` is only needed by specific commands
// (hooks/doctor/sessions) — never by --version/--help or the initial TUI
// frame. Loading it statically cost ~12ms CPU on EVERY invocation.
type RepoModule = typeof import('./repo/repo.js');
let repoModule: RepoModule | null = null;
const loadRepoModule = async (): Promise<RepoModule> => (repoModule ??= await import('./repo/repo.js'));

// Resolve the version from package.json when running from source; when Mochi is
// compiled to a standalone binary there is no package.json next to it, so fall
// back to the constant (kept in sync with package.json at build time).
let VERSION = '0.28.0';
try {
  const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), '../package.json');
  VERSION = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
} catch {
  /* compiled binary: use the baked-in default */
}

// Global crash safety net (P0 reliability): a stray unhandled rejection must
// never kill a running session mid-task (the classic "mochi froze" experience),
// and a hard crash must leave the user's terminal usable. Details land in
// ~/.mochi/logs/crash.log for post-mortem; `mochi doctor` can surface them.
function logCrash(kind: string, err: unknown): void {
  try {
    const dir = pathJoin(homedir(), '.mochi', 'logs');
    mkdirSync(dir, { recursive: true });
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    appendFileSync(pathJoin(dir, 'crash.log'), `[${new Date().toISOString()}] ${kind}: ${detail}\n`);
  } catch {
    /* never throw from the crash logger */
  }
}

process.on('unhandledRejection', (reason) => {
  // Log-and-continue: the agent loop, watchdogs, and per-tool timeouts own
  // recovery. Dying here is what turned a recoverable hiccup into a "frozen"
  // session with a broken terminal.
  logCrash('unhandledRejection', reason);
});
// EPIPE on stdout (the terminal pane was closed under us — Tmux kill-pane,
// tab close, SSH drop) must never crash the CLI. crash.log is full of
// "Error: write EPIPE at console.log" → uncaughtException → exit. Drop the
// dead write and keep running; every other stream error stays fatal.
process.stdout?.on?.('error', (err: NodeJS.ErrnoException) => {
  if (err?.code === 'EPIPE' || err?.code === 'EIO') return;
  throw err;
});
process.stderr?.on?.('error', (err: NodeJS.ErrnoException) => {
  if (err?.code === 'EPIPE' || err?.code === 'EIO') return;
  throw err;
});
process.on('uncaughtException', (err: unknown) => {
  const code = (err as NodeJS.ErrnoException)?.code ?? '';
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  if (code === 'EPIPE' || code === 'EIO' || msg.includes('errno: 5')) {
    // Terminal closed, detached, or stream pipe broken: exit cleanly.
    process.exit(0);
  }
  // Synchronous state is undefined after this; log, restore, and bail.
  // The TUI's process.on('exit') listener still runs and restores the tty.
  logCrash('uncaughtException', err);
  try { console.error(`[fatal] ${msg}`); } catch { /* ignore stdout/stderr errors */ }
  process.exit(1);
});


function printHelp() {
  console.log(`Mochi ${VERSION} — minimal autonomous coding agent

Usage:
  mochi [options] ["prompt"]
  mochi goal "..."
  mochi team "..."
  mochi plan "..."
  mochi self-train [N] [focus]        # cycles of self-review + skill curation
  mochi resume [<sessionId|goalId>]       # resume a session (latest or by ID)
  mochi checkpoint [save <name>|list|restore <name>]  # named snapshots & rollback
  mochi docgen [--write]             # generate architecture diagram & API reference
  mochi rollback
  mochi workspace create|list|switch <name>
  mochi profiles
  mochi memory
  mochi inspect "<query>"
  mochi trace [<goalId>]             # replay the run trace for a goal
  mochi gate run|baseline|freeze|check  # frozen regression gate (bench/frozen/)
  mochi sleeptime [--cap <usd>] [--dry-run]  # nightly consolidation pipeline (repair+curator+gate+health+curriculum, hard spend cap)
  mochi tools forged [disable <name>|evaluate|run]  # Tool Forge audit view: self-synthesised tools, provenance + state
  mochi health [--force] [--offline]  # proactive repo health scan (tests/deps/TODOs/dead code/hotspots digest)
  mochi session list                 # list past sessions
  mochi session search "<text>"       # full-text search past transcripts
  mochi speculate "<question>"
  mochi mode <normal|spec|security|codemod|chaos>  # set execution mode
  mochi rules [list|add]             # manage modular project rules
  mochi bg [list|logs|kill]          # manage async background tasks
  mochi discord [run|status]           # run Discord bot gateway
  mochi telegram [run|status]          # run Telegram bot gateway (HTTP long-poll)
  mochi slack [run|webhook|status]     # run Slack gateway (polling or Events API webhook)
  mochi bluebubbles [run|status]      # run BlueBubbles (iMessage) gateway
  mochi connectors [status]           # list all messaging gateways + config state
  mochi update [--check|--apply]    # check GitHub releases and upgrade Mochi
  mochi bundle [outFile]            # write a diagnostic bundle (transcript+diff+doctor)
  mochi watch [dir...] [--cmd C]    # run the repo check on every file change
  mochi serve [--port N] [--token T] [--host H] # JSON API + OpenAI-compatible (/v1); default 127.0.0.1
  mochi auth [status|accounts|switch|...]  # per-provider credentials & multi-account
  mochi skills [list|lint|mine|report]  # list, validate, mine skills; improvement report
  mochi providers                   # list AI model providers
  mochi dashboard | mochi web        # open web dashboard in browser
  mochi plugin add <dir>|remove <name>|list        # spec 12-E plugin registry
  mochi security | mochi audit       # static security and credential audit
  mochi review [--strict] [--json] [--diff-only]   # git diff | mochi review
  mochi pr review <number> [--focus security] [--post] [--json]  # review a GitHub PR (needs gh)
  mochi fix [--auto-commit]                        # cat crash.log | mochi fix
  mochi acp                          # editor-native stdio server (Agent Client Protocol)
  mochi daemon start [--port <n>] [--token <t>]
  mochi daemon status
  mochi daemon rotate               # issue a fresh bearer token (old one dies immediately)
  mochi daemon jobs
  mochi daemon send "<goal>"
  mochi daemon approve
  mochi daemon resume <goalId>      # resume a persisted goal over HTTP
  mochi daemon cron add|list|status|pause|resume|run|remove # scheduled jobs over HTTP
  mochi cron list|add|status|pause|resume|run|remove  # manage jobs without HTTP
  mochi browser login|status|close  # persistent login profile for Docs/Gmail/live automation
  mochi daemon restart              # stop + start on the same port
  mochi daemon stop
  mochi termix ["<task>"] [--coms|--sep] [--sessions N]
  mochi reasoning [low|med|high|max] # view or set reasoning depth
  mochi tui
  mochi term [--title T] [--geometry COLSxROWS] [--dry-run] [-- <mochi args>]  # open Mochi in its own native terminal window
  mochi completion <bash|zsh|fish>   # print shell completion script
  mochi runtime [--json]             # which engine, launcher, and rust core am I on
  mochi node <args…>                 # force the Node engine (dist/cli.js)
  mochi standalone <args…>           # force the Bun standalone engine
  mochi "<prompt>" --plan            # plan mode: research + return a plan, no edits

Options:
  -p, --print             Print response and exit
  --auto                  Autonomous mode
  --reasoning <level>     Reasoning effort: low|medium|high|max|off|auto (alias: med=medium)
  --provider <name>       Model provider
  --model <id>            Model ID
  --api-key <key>         API key
  --safety safe|ask|auto  Safety mode
  --max-tokens <n>        Budget limit
  --max-cost <usd>        Cost limit
  --max-model-calls <n>   Model call limit
  --max-tool-calls <n>    Tool call limit
  --workspace <name>      Use workspace
  -w, --worktree          Run session in an isolated ephemeral Git worktree
  --plan                  Plan mode (no edits)
  -u, --uncensored        Uncensored harness: bypass all permission gates & grant full system/admin privileges
  -y, --yolo              Bypass all permission prompts (alias: --dangerously-skip-permissions)
  --dangerously-skip-permissions  Same as --yolo
  -q, --quiet             Less output
  -v, --verbose           More output
  --debug                 Debug output
  -h, --help              Show help
  --version               Show version

Environment:
  MOCHI_UNCENSORED=1                    Same as --uncensored
  MOCHI_DANGEROUSLY_SKIP_PERMISSIONS=1  Same as --yolo
`);
}

// Sync fs/url/path imports at module top (ESM-safe; no require() in output).
function cliDirname(): string {
  // dist/cli.js → dist/; src/cli.ts → src/. Resolves relative to this file.
  return dirname(fileURLToPath(import.meta.url));
}

/** Compact "3m ago" / "2d ago" / "never" string. Sub-1m inputs render as "just now"
 *  so the operator's eye doesn't churn on sub-second noise from fresh failures. */
function formatAgeAgo(ms: number, now: number = Date.now()): string {
  if (!ms || ms <= 0) return 'never';
  const diff = now - ms;
  if (diff < 0) return 'just now';
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
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

  // ── Engine dispatch — `mochi node …` / `mochi standalone …` ──────────────
  // Must be honored HERE (before any engine work) so the subcommands behave
  // identically whether the entry is the Rust launcher (which strips them and
  // execs the engine itself), the npm bin, `node dist/cli.js`, or the
  // standalone binary. The subcommand has to be the FIRST argument — the Rust
  // launcher dispatches on the same position, so both entries agree.
  const engineSub = process.argv[2];
  if (engineSub === 'node' || engineSub === 'standalone') {
    const { handleEngineArg } = await import('./runtime-dispatch.js');
    const r = handleEngineArg(engineSub, process.argv.slice(3));
    if (!r.continue) process.exit(r.exitCode ?? 0);
    // Already on that engine: fall through and run normally.
  }
  if (positional[0] === 'runtime') {
    const { runtimeReport, formatRuntimeReport } = await import('./runtime-dispatch.js');
    const report = await runtimeReport(VERSION);
    if (flags.json) console.log(JSON.stringify(report, null, 2));
    else console.log(formatRuntimeReport(report));
    return;
  }

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
        console.error('\x1b[38;2;163;230;53mmochi\x1b[0m sources changed — rebuilding dist (non-blocking)…');
        const { execFile } = await import('node:child_process');
        const repoRoot = rp(cliDirname(), '..');
        // Run the repo-local TypeScript compiler with the current node binary;
        // no npx (spawn-without-shell can't resolve it from an ESM process).
        const tscJs = rp(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
        // NON-BLOCKING rebuild: on an actively-developed repo src/*.ts is newer
        // than dist almost every run, so a synchronous full `tsc` here would
        // stall every invocation 60-100s (measured) before it does ANY work —
        // which reads as "Mochi is slow" even for trivial one-shot queries.
        // Fire-and-forget so the current command starts immediately; dist is
        // refreshed for the NEXT run. If the compile fails we still run
        // whatever dist is present rather than holding the user hostage.
        const child = execFile(process.execPath, [tscJs, '-p', 'tsconfig.json'], { cwd: repoRoot, timeout: 240_000 }, (err) => {
          if (err) console.error(`[mochi] background auto-rebuild failed (${err.message.split('\n')[0]}); previous build still in use`);
          else console.error('\x1b[38;2;163;230;53mmochi\x1b[0m dist rebuilt (background).');
        });
        child.unref?.();
      }
    }
  } catch { /* best-effort freshness guard */ }
  // Resolve the SQLite driver (node:sqlite or bun:sqlite) before any
  // subsystem probes it: sessions, codegraph, and search all check
  // synchronously on first use.
  try { await (await import('./sqlite.js')).sqliteDriverAsync(); } catch {}

  let effectiveCwd = process.cwd();
  const launchCwd = effectiveCwd;
  let worktreeInfo;
  if (flags.worktree || flags.w) {
    const { WorktreeManager } = await import('./repo/worktree.js');
    const { join: pJoin } = await import('node:path');
    const mochiDir = pJoin(effectiveCwd, '.mochi');
    const wtManager = new WorktreeManager(effectiveCwd, mochiDir);
    try {
      worktreeInfo = await wtManager.create('session');
      effectiveCwd = worktreeInfo.path;
      console.error(`\x1b[38;2;163;230;53m[worktree]\x1b[0m Isolated git worktree created at: ${worktreeInfo.path} (branch: ${worktreeInfo.branch})`);
    } catch (err: any) {
      console.error(`\x1b[31m[worktree]\x1b[0m Failed to create worktree: ${err?.message ?? err}. Falling back to cwd.`);
    }
  }

  const cwd = effectiveCwd;
  const flagOverrides = configFromFlags(flags);
  let configOverrides: ReturnType<typeof configFromFlags> = flagOverrides;
  // B26 restructure: a worktree session runs in the worktree COPY, and project
  // configs now load from the directory actually being targeted (the worktree).
  // That flipped the old ambient behavior (launch dir's mochi.json/.mcp.json
  // were read from process.cwd()). Restore it explicitly: carry the LAUNCH
  // project's fragments through the overrides channel — visible intent, below
  // the flag overrides, still above the worktree's own project files.
  if (worktreeInfo) {
    const { loadProjectConfigFragments, mergeConfigFragments } = await import('./config.js');
    const launchFragments = loadProjectConfigFragments(launchCwd);
    if (Object.keys(launchFragments).length) {
      // Launch fragments as BASE, flag overrides as the winning layer,
      // merged per LEAF (mergeConfigFragments: `later` wins per leaf;
      // mcpServers per-server). `mochi --worktree --model x` keeps --model
      // even when the launch mochi.json has a model block.
      configOverrides = mergeConfigFragments(launchFragments as Record<string, unknown>, flagOverrides) as ReturnType<typeof configFromFlags>;
      console.error(`\x1b[38;2;163;230;53m[worktree]\x1b[0m Using launch project config from: ${launchCwd}`);
    }
  }
  const { Runtime } = await import('./runtime.js');
  const { randomSlug } = await import('./util.js');
  const { status, diff, isRepo } = await import('./repo/git.js');
  const runtime = Runtime.create({ cwd, config: configOverrides });

  // Permission policy — propagate --yolo / --uncensored / env var to the runtime object so
  // the TUI status badge and PermissionManager can read it without config hacks.
  const isYolo = configOverrides.__yolo === true ||
    process.env.MOCHI_DANGEROUSLY_SKIP_PERMISSIONS === '1';
  const isUncensored = configOverrides.__uncensored === true ||
    configOverrides.safety?.mode === 'uncensored' ||
    process.env.MOCHI_UNCENSORED === '1';
  runtime.setPermPolicy((isUncensored || isYolo) ? 'yolo'
    : (configOverrides.safety?.mode === 'auto' ? 'workspace-safe' : 'strict'));
  // Announce elevated mode ONLY when explicitly requested on THIS command
  // line. Reading it from config/env printed the banner on every run — noise,
  // not an announcement (the TUI badge still reflects the active policy).
  if (configOverrides.__uncensoredExplicit === true) {
    console.error('🔓 [UNCENSORED] Autonomous uncensored harness active: unrestricted system access & admin privileges.');
  } else if (configOverrides.__yolo === true &&
      !(configOverrides.__uncensored === true ||
        configOverrides.safety?.mode === 'uncensored' ||
        process.env.MOCHI_UNCENSORED === '1')) {
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
    const { startDaemon, daemonRunning, readDaemonInfo, daemonInfoPath } = await import('./daemon/daemon.js');
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
      const expiry = info?.expiresAt ? `, token expires ${new Date(info.expiresAt).toLocaleDateString()}` : '';
      console.log(`Daemon running on 127.0.0.1:${info?.port} (pid ${info?.pid}, started ${info?.startedAt}${expiry}).`);
      return;
    }
    if (action === 'rotate') {
      if (!info || !daemonRunning(wsDir)) {
        console.log('No daemon running for this workspace.');
        return;
      }
      const res = await fetch(`http://127.0.0.1:${info.port}/api/rotate`, {
        method: 'POST', headers: { authorization: `Bearer ${info.token}` }, body: '{}',
      });
      const data = (await res.json()) as { ok?: boolean; token?: string; expiresAt?: number; error?: string; hint?: string };
      if (!res.ok || !data.token) { console.error(data.hint ?? data.error ?? 'Rotate failed'); process.exit(1); }
      console.log(`Token rotated. New token expires ${new Date(data.expiresAt as number).toLocaleString()}.`);
      // Token is file-only (daemon/info.json, 0600): never print it — it lands
      // in shell history, CI logs, and screenshots.
      console.log('New token saved to daemon info file (not displayed for security).');
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
  if (first === 'self-train' || first === 'selftrain' || first === 'train') {
    // Continuous self-improvement: cycles of self-review until verified done,
    // then a skill-curator pass. Optional focus text after the cycle count.
    // --schedule "<spec>" instead installs a recurring cron job (default
    // daily) so learning compounds unattended. Unit in
    // ./self-train-schedule.js; this stays a thin adapter.
    if (flags.schedule !== undefined) {
      const { validateTrainSchedule, trainSchedule, sleeptimeCronPrompt } = await import('./self-train-schedule.js');
      const bad = validateTrainSchedule(flags.schedule === true ? undefined : flags.schedule);
      if (bad) { console.error(bad); process.exit(1); }
      const rest = positional.slice(1);
      const focus = (rest.length && /^\d+$/.test(rest[0]) ? rest.slice(1) : rest).join(' ').trim() || undefined;
      const { startDaemon, daemonRunning, readDaemonInfo } = await import('./daemon/daemon.js');
      const wsDir = runtime.workspace.dir;
      let info = readDaemonInfo(wsDir);
      if (!info || !daemonRunning(wsDir)) {
        const r = await startDaemon({ cwd, config: configOverrides });
        if (!r.ok) { console.error(`Failed to start daemon: ${r.error}`); process.exit(1); }
        info = readDaemonInfo(wsDir);
      }
      const res = await fetch(`http://127.0.0.1:${info?.port}/api/cron`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${info?.token}` },
        body: JSON.stringify({ action: 'add', prompt: sleeptimeCronPrompt(focus), schedule: trainSchedule(flags.schedule === true ? undefined : flags.schedule) }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string; id?: string };
      if (!res.ok || data.error) { console.error(data.error ?? 'Daemon error'); process.exit(1); }
      console.log(`Nightly learning on: ${trainSchedule(flags.schedule === true ? undefined : flags.schedule)} (job ${data.id}). Manage with: mochi daemon cron list|remove.`);
      return;
    }
    const rest = positional.slice(1);
    const cycles = rest.length && /^\d+$/.test(rest[0]) ? Number(rest[0]) : 3;
    const focus = (rest.length && /^\d+$/.test(rest[0]) ? rest.slice(1) : rest).join(' ').trim() || undefined;
    console.log(`🍡 Self-training: ${cycles} cycle(s)${focus ? ` — focus: ${focus}` : ''}\n`);
    const r = await runtime.selfTrain({
      cycles,
      focus,
      onProgress: (_i, msg) => console.log(`  • ${msg}`),
    });
    console.log(r.report);
    console.log(`\ntokens ${r.tokensUsed} · $${r.costUsd.toFixed(4)} · ${Math.round(r.durationMs / 1000)}s`);
    return;
  }
  if (first === 'resume') {
    // mochi resume [sessionId|goalId] - resume a specific session/goal by ID,
    // or the latest if no argument given. Session IDs from the TUI/farewell
    // screen are goal IDs (short 8-char form works). If a session/tab ID is
    // given that doesn't match a goal, we also check the session store for
    // an associated goal_id.
    const goalId = positional[1];
    const goals = runtime.workspace.listGoals();
    if (goals.length === 0) { console.log('No saved goals to resume.'); return; }
    let goal;
    if (goalId) {
      // Support both short (8-char) and full goal IDs
      let fullId = goals.find((g) => g.startsWith(goalId) || g.replace(/\.json$/, '') === goalId);
      // If not found as a goal, check session store for a session with this ID
      if (!fullId) {
        const { SessionStore } = await import('./state/session-store.js');
        const { findProjectRoot } = await loadRepoModule();
        const sessionStore = new SessionStore(findProjectRoot(runtime.cwd));
        // Try exact match first
        let session = sessionStore.session(goalId);
        // If not found and it looks like a short ID (8 chars), try prefix match
        if (!session && goalId.length === 8) {
          const sessions = sessionStore.list(1000);
          session = sessions.find((s) => s.id.startsWith(goalId));
        }
        if (session?.goalId) {
          fullId = session.goalId + '.json';
        }
      }
      if (!fullId) { console.log(`Goal/session not found: ${goalId}`); return; }
      goal = runtime.workspace.loadGoal(fullId.replace(/\.json$/, ''));
    } else {
      const latest = goals[goals.length - 1].replace(/\.json$/, '');
      goal = runtime.workspace.loadGoal(latest);
    }
    if (!goal) { console.log('Goal not found.'); return; }
    console.log(`Resuming goal: ${goal.objective} (${goal.id.slice(0, 8)})`);
    let streamedThinking = false;
    const off = runtime.events.onAll((event: import('./types.js').MochiEvent) => {
      if (event.type === 'agent:reasoning' && typeof event.content === 'string') {
        if (!streamedThinking) {
          process.stderr.write('\x1b[2m[thinking] ');
          streamedThinking = true;
        }
        process.stderr.write(event.content);
      } else if (event.type === 'message:chunk' && typeof event.content === 'string') {
        if (streamedThinking) {
          process.stderr.write('\x1b[0m\n\n');
          streamedThinking = false;
        }
        process.stdout.write(event.content);
      }
    });
    try {
      const summary = await runtime.resumeGoal(goal.id);
      if (streamedThinking) process.stderr.write('\x1b[0m\n\n');
      console.log('\n' + summary);
    } finally {
      off();
    }
    return;
  }
  if (first === 'apply') {
    // Atomic multi-file patch application. Diff from file arg or stdin.
    const { applyDiffAtomically } = await import('./apply.js');
    let diffText = '';
    if (positional[1]) {
      diffText = readFileSync(resolve(cwd, positional[1]), 'utf8');
    } else if (!process.stdin.isTTY) {
      diffText = await new Promise<string>((res, rej) => {
        let buf = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (c) => (buf += c));
        process.stdin.on('end', () => res(buf));
        process.stdin.on('error', rej);
      });
    }
    if (!diffText.trim()) { console.error('Usage: mochi apply <diff-file>  (or pipe a unified diff via stdin)'); return; }
    try {
      const res = applyDiffAtomically(cwd, diffText);
      for (const p of res.created) console.log(`created  ${p}`);
      for (const p of res.applied.filter((x) => !res.created.includes(x) && !res.deleted.includes(x))) console.log(`updated  ${p}`);
      for (const p of res.deleted) console.log(`deleted  ${p}`);
      for (const p of res.skipped) console.log(`skipped  ${p} (already applied)`);
      console.log(`\n${res.applied.length} file(s) applied atomically. Review with: git diff`);
    } catch (err) {
      console.error(`apply failed, working tree unchanged: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
    return;
  }
  if (first === 'checkpoint') {
    const sub = positional[1];
    if (sub === 'save') {
      const name = positional[2];
      const desc = positional.slice(3).join(' ');
      if (!name) { console.log('Usage: mochi checkpoint save <name> ["description"]'); return; }
      const { saveNamedCheckpoint } = await import('./state/checkpoint-manager.js');
      const cp = await saveNamedCheckpoint(cwd, name, desc);
      console.log(`Saved named checkpoint "${cp.name}" (SHA: ${cp.gitCommitSha.slice(0, 7)})`);
      return;
    }
    if (sub === 'list' || sub === 'ls') {
      const { listNamedCheckpoints } = await import('./state/checkpoint-manager.js');
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
      const { restoreNamedCheckpoint } = await import('./state/checkpoint-manager.js');
      const res = await restoreNamedCheckpoint(cwd, name);
      console.log(res.message);
      return;
    }
    if (!(await isRepo(cwd))) { console.log('Not a git repository.'); return; }
    const cp = await runtime.checkpoint(positional.slice(1).join(' ') || 'mochi checkpoint');
    console.log(`Checkpoint created: ${cp.type} ${cp.ref}`);
    return;
  }
  // `mochi cron ...` — inspect / queue scheduled jobs without the daemon.
  if (first === 'cron' || first === 'schedule') {
    const cron = await import('./daemon/cron.js');
    const sub = (positional[1] || 'list').toLowerCase();
    const wsCwd = runtime.workspace.dir;
    const fmt = (j: import('./daemon/cron.js').CronJob) => {
      const state = j.paused ? 'PAUSED' : (j.enabled ? 'active' : 'disabled');
      const next = new Date(j.nextRun).toLocaleString();
      const last = j.lastStatus ? ` last=${j.lastStatus}${j.lastDurationMs ? ` ${Math.round(j.lastDurationMs / 1000)}s` : ''}` : '';
      return `${j.id}  [${state}]  ${j.schedule}  next=${next}  runs=${j.runs}${last}\n    ${j.prompt.slice(0, 140).replace(/\n/g, ' ')}\n    id: ${j.id}`;
    };
    if (sub === 'list' || sub === 'ls') {
      const jobs = cron.listJobs(wsCwd);
      if (!jobs.length) { console.log('No scheduled jobs. Add: mochi cron add "every 30m" "check the build"'); return; }
      console.log(jobs.map(fmt).join('\n\n'));
      return;
    }
    if (sub === 'add') {
      const schedule = typeof flags.schedule === 'string' ? flags.schedule : positional[2];
      const prompt = typeof flags.prompt === 'string' ? flags.prompt : positional.slice(3).join(' ');
      if (!schedule || !prompt) { console.log('Usage: mochi cron add "<schedule>" "<prompt>"'); return; }
      const timeoutMs = flags.timeoutMs !== undefined ? Number(flags.timeoutMs) : undefined;
      const r = cron.addJob(wsCwd, prompt, schedule, {
        notify: typeof flags.notify === 'string' ? flags.notify : undefined,
        timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined,
        paused: flags.paused === true,
      });
      console.log(r.error ? `Error: ${r.error}` : `Added job ${r.id}. Start the daemon to run it: mochi daemon start`);
      return;
    }
    const id = positional[2] || (typeof flags.id === 'string' ? flags.id : '');
    if (!id) { console.log('Usage: mochi cron <status|pause|resume|enable|disable|run|remove> <id>'); return; }
    const job = cron.getJob(wsCwd, id);
    if (!job) { console.log(`No job matching "${id}".`); return; }
    if (sub === 'status') { console.log(fmt(job)); if (job.lastError) console.log(`last error: ${job.lastError}`); if (job.lastOutput) console.log(`last output: ${job.lastOutput.slice(0, 1200)}`); return; }
    if (sub === 'pause') cron.setJobPaused(wsCwd, job.id, true);
    else if (sub === 'resume') cron.setJobPaused(wsCwd, job.id, false);
    else if (sub === 'enable') cron.setJobEnabled(wsCwd, job.id, true);
    else if (sub === 'disable') cron.setJobEnabled(wsCwd, job.id, false);
    else if (sub === 'run') cron.runJobNow(wsCwd, job.id);
    else if (sub === 'remove' || sub === 'rm' || sub === 'delete') cron.removeJob(wsCwd, job.id);
    else { console.log(`Unknown cron action "${sub}". Use list|add|status|pause|resume|enable|disable|run|remove.`); return; }
    console.log(`Job ${job.id}: ${sub} ok.`);
    return;
  }

  // `mochi browser ...` — persistent browser profile + live browser status.
  // The agent-facing tools are separate; this is the one-time login surface
  // for Google Docs / Gmail and the health check when automation misbehaves.
  if (first === 'browser') {
    const { runBrowserCli } = await import('./browser/cli.js');
    await runBrowserCli(positional.slice(1), flags);
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
  if (first === 'completion') {
    const { completionFor } = await import('./completion.js');
    const shell = positional[1] ?? '';
    if (!shell || shell === 'help' || shell === '--help') {
      console.log('Usage: mochi completion <bash|zsh|fish>  # print the init script; eval it or save to your rc file');
      console.log('  bash: eval "$(mochi completion bash)"');
      console.log('  zsh:  mochi completion zsh > ~/.zfunc/_mochi  # + fpath');
      console.log('  fish: mochi completion fish > ~/.config/fish/completions/mochi.fish');
      return;
    }
    try {
      console.log(completionFor(shell));
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
    return;
  }
  if (first === 'term' || first === 'terminal' || first === 'open') {
    // Native terminal window: Mochi in its OWN emulator (black bg, monospace,
    // known geometry) instead of inheriting the caller's terminal quirks.
    const { launchInNewTerminal } = await import('./utils/terminal-launch.js');
    // Parse RAW argv (the global parser eats a bare `--` plus the word after
    // it as a flag value, which would swallow forwarded subcommands).
    const aliasIdx = process.argv.findIndex((a) => a === 'term' || a === 'terminal' || a === 'open');
    const raw = aliasIdx >= 0 ? process.argv.slice(aliasIdx + 1) : [];
    const fwd: string[] = [];
    let dryRun = false;
    let title = 'Mochi';
    let cols = 190;
    let rows = 45;
    for (let i = 0; i < raw.length; i++) {
      const a = raw[i];
      if (a === '--dry-run') dryRun = true;
      else if (a === '--title' && i + 1 < raw.length) title = raw[++i];
      else if (a.startsWith('--title=')) title = a.slice('--title='.length);
      else if (a === '--geometry' && i + 1 < raw.length) {
        const m = raw[++i].match(/(\d+)\s*x\s*(\d+)/i);
        if (m) { cols = Number(m[1]); rows = Number(m[2]); }
      } else if (a.startsWith('--geometry=')) {
        const m = a.slice('--geometry='.length).match(/(\d+)\s*x\s*(\d+)/i);
        if (m) { cols = Number(m[1]); rows = Number(m[2]); }
      } else if (a === '--') {
        fwd.push(...raw.slice(i + 1));
        break;
      } else fwd.push(a);
    }
    const r = await launchInNewTerminal(fwd, { title, cols, rows });
    if (dryRun || !r.ok) {
      if (r.command) console.log(['MOCHI-TERM:'].concat(r.command).join(' '));
      if (!r.ok) {
        console.error(r.error ?? 'Could not open a terminal window.');
        process.exit(1);
      }
      return;
    }
    console.log(`Opened Mochi in a new ${r.emulator} window (pid ${r.pid}).`);
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
      const stop = await startAmbient({
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
  if (first === 'pr') {
    const sub = positional[1];
    if (sub === 'review') {
      const { parsePrReviewArgs, runPrReview } = await import('./pr-cli.js');
      const parsed = parsePrReviewArgs(positional.slice(2), flags);
      if (typeof parsed === 'string') {
        console.error(parsed);
        process.exit(1);
      }
      const code = await runPrReview(parsed, cwd);
      process.exit(code);
    }
    const n = Number(positional[1]);
    if (!Number.isInteger(n) || n < 1) {
      console.log('Usage: mochi pr review <number> [--post] [--json] [--repo owner/name] [--focus correctness|security|performance]');
      return;
    }
    const { runIssueToPr } = await import('./pr.js');
    try {
      const res = await runIssueToPr({ cwd, issueNumber: n, stage: 'full' });
      if (res.prUrl) console.log(`PR created: ${res.prUrl}`);
      else console.log(`Branch ${res.branch} ready. No changes committed or PR creation skipped.`);
      return;
    } catch (e) {
      console.error(`PR pipeline failed: ${(e as Error).message}`);
      return;
    }
  }
  if (first === 'skills') {
    const {loadAllSkills} = await import('./skills/skills.js');
    const sub = positional[1];
    if (sub === 'import' || sub === 'import-skills') {
      // mochi skills import <source> [--force] — alias handled inline so the
      // dedicated `skills` branch doesn't swallow it.
      const { importSkills, resolveSourceDir, discoverSourceSkills } = await import('./features/skill-importer.js');
      const sourceName = positional[2];
      if (!sourceName) { console.log('Usage: mochi skills import <source> [--force] [--update]'); return; }
      const srcRes = await resolveSourceDir(sourceName, { update: !!flags.update });
      if (!srcRes.dir) { console.error(`Source not found or clone failed: ${sourceName}${srcRes.error ? ` (${srcRes.error})` : ''}`); return; }
      const src = srcRes.dir;
      if (flags.list) {
        const { skills } = discoverSourceSkills(src);
        console.log(`Discoverable skills in ${src} (${skills.length}):`);
        for (const s of skills) console.log(`  - ${s.name}  ${(s.description || '').slice(0, 72)}`);
        return;
      }
      const rep = await importSkills({ source: sourceName, force: !!flags.force });
      for (const it of rep.imported) console.log(`imported  ${it.name}  -> ${it.to}`);
      for (const sk of rep.skipped) console.log(`skipped   ${sk.name}  (${sk.reason})`);
      for (const w of rep.warnings) console.log(`warning   ${w.name}  (${w.issues.join(', ')})`);
      for (const e of rep.errors) console.error(`error     ${e}`);
      console.log(`\n${rep.imported.length} imported, ${rep.skipped.length} skipped, ${rep.warnings.length} warnings, ${rep.errors.length} errors (origin: ${rep.origin}).`);
      return;
    }
    if (sub === 'repo' || sub === 'registry' || sub === 'src') {
      // mochi skills repo add|list|rm|ls + mochi skills repo <name> — the named
      // shared skill-library surface (MCH-94). Sources are registered in
      // ~/.mochi/skill-sources.json; `install <pack>@<repo>` resolves by name.
      const { registerSource, unregisterSource, loadRegistry, getSource } = await import('./features/skill-registry.js');
      const { resolveSourceDir } = await import('./features/skill-importer.js');
      const act = positional[2];
      if (act === 'add' || act === 'register') {
        const name = positional[3];
        const source = positional[4];
        if (!name || !source) {
          console.log('Usage: mochi skills repo add <name> <source>');
          console.log('  source = local path, "hermes:", or github:owner/repo / git URL.');
          return;
        }
        const rec = registerSource({ name, source });
        console.log(`Registered skill source '${rec.name}' -> ${source}`);
        return;
      }
      if (act === 'rm' || act === 'remove') {
        const name = positional[3];
        if (!name) { console.log('Usage: mochi skills repo rm <name>'); return; }
        if (unregisterSource(name)) console.log(`Removed skill source '${name}'.`);
        else console.error(`No skill source '${name}'.`);
        return;
      }
      if (act === 'publish') {
        // mochi skills repo publish [--root <dir>] — generate a shareable
        // packs.json catalog from an installed-skill tree.
        const { buildCatalogFromSkills } = await import('./features/skill-registry.js');
        const { homedir } = await import('node:os');
        const root = typeof flags.root === 'string' ? flags.root : pathJoin(homedir(), '.mochi', 'skills');
        const cat = buildCatalogFromSkills(root);
        const json = JSON.stringify(cat, null, 2);
        const out = pathJoin(cwd, 'packs.json');
        const { writeFileSync } = await import('node:fs');
        writeFileSync(out, json + '\n', 'utf8');
        console.log(`Published ${cat.length} packs -> ${out}`);
        console.log('Share this repo; recipients: mochi skills repo add <name> <repo> && mochi skills install <pack>.');
        return;
      }
      if (act === 'list' || act === 'ls' || !act) {
        const state = loadRegistry();
        const names = Object.keys(state.sources);
        if (!names.length) { console.log('No skill sources registered. Use: mochi skills repo add <name> <source>'); return; }
        for (const n of names.sort()) {
          const s = state.sources[n];
          console.log(`${n.padEnd(20)} ${s.source}${s.description ? '  # ' + s.description : ''}`);
        }
        return;
      }
      // mochi skills repo <name> [--list] — show a source's discoverable packs.
      const { discoverPacks } = await import('./features/skill-registry.js');
      const name = act;
      const src = getSource(name);
      if (!src) { console.error(`No skill source '${name}'.`); return; }
      const res = await resolveSourceDir(src.source, { update: !!flags.update });
      if (!res.dir) { console.error(`Source '${name}' unresolvable: ${res.error || 'n/a'}`); return; }
      const packs = discoverPacks(res.dir, src.catalogFile);
      if (flags.list) {
        if (!packs.length) { console.log(`No packs in source '${name}'.`); return; }
        console.log(`Packs in '${name}' (${packs.length}):`);
        for (const p of packs) console.log(`  - ${p.name}${p.category ? ` [${p.category}]` : ''}  ${(p.description || '').slice(0, 64)}`);
        return;
      }
      if (packs.length) {
        console.log(`Source '${name}' -> ${src.source}`);
        for (const p of packs) console.log(`  ${p.name}${p.category ? ` [${p.category}]` : ''}  ${(p.description || '').slice(0, 64)}`);
      } else {
        console.log(`Source '${name}' -> ${src.source} (no packs found)`);
      }
      return;
    }
    if (sub === 'pack') {
      // mochi skills pack <name...> [--out <dir>] [--from <dirs...>] — bundle
      // installed skills into a portable pack directory (manifest + bodies).
      // Share the directory; recipients unpack with `mochi skills unpack`.
      const { packSkills } = await import('./features/skill-importer.js');
      const { homedir } = await import('node:os');
      const names = positional.slice(2);
      if (!names.length) { console.log('Usage: mochi skills pack <name...> [--out <dir>]'); return; }
      const outDir = typeof flags.out === 'string' && flags.out ? flags.out : pathJoin(cwd, 'mochi-skills-pack');
      const from = typeof flags.from === 'string' && flags.from
        ? flags.from.split(',').map((d) => d.trim()).filter(Boolean)
        : [pathJoin(cwd, '.mochi', 'skills'), pathJoin(homedir(), '.mochi', 'skills')];
      const rep = packSkills(names, from, outDir);
      for (const n of rep.skills) console.log(`packed    ${n}`);
      for (const sk of rep.skipped) console.log(`skipped   ${sk.name} (${sk.reason})`);
      for (const e of rep.errors) console.error(`error     ${e}`);
      if (rep.ok) console.log(`\nPack ready: ${outDir} — share it; recipients run: mochi skills unpack ${outDir}`);
      else if (!rep.skills.length) process.exit(1);
      return;
    }
    if (sub === 'search') {
      // mochi skills search <query> — search all registered sources' packs
      // (and the bundled catalog) by name/description token overlap.
      const q = positional.slice(2).join(' ').toLowerCase();
      if (!q) { console.log('Usage: mochi skills search <query>'); return; }
      const terms = q.split(/\s+/).filter(Boolean);
      const { loadRegistry, getSource, discoverPacks } = await import('./features/skill-registry.js');
      const { resolveSourceDir } = await import('./features/skill-importer.js');
      const { bundledSkillsDir, discoverSkills } = await import('./skills/skills.js');
      const hits: Array<{ where: string; name: string; description: string }> = [];
      // Bundled catalog first.
      const bdir = bundledSkillsDir();
      if (bdir) for (const s of discoverSkills(bdir).skills) {
        const hay = `${s.name} ${s.description || ''}`.toLowerCase();
        const score = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
        if (score > 0) hits.push({ where: 'bundled', name: s.name, description: (s.description || '').slice(0, 72) });
      }
      // Registered sources.
      const reg = loadRegistry();
      for (const n of Object.keys(reg.sources)) {
        const src = getSource(n);
        if (!src) continue;
        const res = await resolveSourceDir(src.source, { update: !!flags.update });
        if (!res.dir) continue;
        for (const p of discoverPacks(res.dir, src.catalogFile)) {
          const hay = `${p.name} ${p.description || ''}`.toLowerCase();
          const score = terms.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0);
          if (score > 0) hits.push({ where: src.name, name: p.name, description: (p.description || '').slice(0, 72) });
        }
      }
      if (!hits.length) { console.log(`No skills/packs matching '${q}'. Register a source: mochi skills repo add <name> <source>`); return; }
      console.log(`Found ${hits.length} match(es) for '${q}':`);
      for (const h of hits.sort((a, b) => a.where.localeCompare(b.where))) {
        console.log(`  ${h.where.padEnd(16)} ${h.name.padEnd(28)} ${h.description}`);
      }
      console.log('\nInstall: mochi skills install <pack>@<repo>');
      return;
    }
    if (sub === 'unpack') {
      // mochi skills unpack <pack-dir> [--force] — install a pack created by
      // `mochi skills pack` (same engine as `skills import`, surfaced for
      // discoverability next to pack).
      const { importSkills } = await import('./features/skill-importer.js');
      const packDir = positional[2];
      if (!packDir) { console.log('Usage: mochi skills unpack <pack-dir> [--force]'); return; }
      const rep = await importSkills({ source: packDir, force: !!flags.force });
      for (const it of rep.imported) console.log(`imported  ${it.name}  -> ${it.to}`);
      for (const sk of rep.skipped) console.log(`skipped   ${sk.name} (${sk.reason})`);
      for (const e of rep.errors) console.error(`error     ${e}`);
      console.log(`\n${rep.imported.length} imported, ${rep.skipped.length} skipped, ${rep.errors.length} errors.`);
      return;
    }
    if (sub === 'install') {
      // mochi skills install <pack>[@<repo>] [--category <cat>] [--force]
      // Installs a named pack (pack@repo) OR the whole source (bare repo). With
      // --category, it installs only the packs in the source that match `cat` —
      // the "grab a whole skill category" surface.
      const { getSource, resolvePackDir, discoverPacks } = await import('./features/skill-registry.js');
      const { importSkills, resolveSourceDir } = await import('./features/skill-importer.js');
      const target = positional[2];
      if (!target) { console.log('Usage: mochi skills install <pack>[@<repo>] [--category <cat>] [--force]'); return; }
      const [packId, repoName] = target.split('@');
      const src = repoName ? getSource(repoName) : getSource(packId);
      if (!src) { console.error(repoName ? `No skill source '${repoName}'.` : `No pack source — use 'mochi skills install <pack>@<repo>' or 'mochi skills repo add' first.`); return; }
      const res = await resolveSourceDir(src.source, { update: !!flags.update });
      if (!res.dir) { console.error(`Source '${src.name}' unresolvable: ${res.error || 'n/a'}`); return; }
      // Category mode: install every pack that matches the given category.
      if (flags.category) {
        const cat = String(flags.category).toLowerCase();
        const packs = discoverPacks(res.dir, src.catalogFile).filter((p) => (p.category || '').toLowerCase() === cat);
        if (!packs.length) {
          console.error(`No packs with category '${cat}' in '${src.name}'.`);
          return;
        }
        let installed = 0, skipped = 0, warns = 0, errs = 0;
        for (const p of packs) {
          const pd = resolvePackDir(res.dir, p.name, src.catalogFile);
          if (!pd) { errs++; console.error(`error  pack '${p.name}' unresolvable in source`); continue; }
          const rep = await importSkills({ source: pd, origin: src.name, force: !!flags.force });
          for (const it of rep.imported) { installed++; console.log(`installed  ${it.name}  -> ${it.to}`); }
          for (const s of rep.skipped) { skipped++; console.log(`skipped    ${s.name}  (${s.reason})`); }
          for (const w of rep.warnings) { warns++; console.log(`warning    ${w.name}  (${w.issues.join(', ')})`); }
          for (const e of rep.errors) { errs++; console.error(`error      ${e}`); }
        }
        console.log(`\n${installed} installed, ${skipped} skipped, ${warns} warnings, ${errs} errors (source: ${src.name}, category: ${cat}).`);
        return;
      }
      const resolvedPackId = repoName ? packId : null;
      const targetDir = resolvedPackId ? resolvePackDir(res.dir, resolvedPackId, src.catalogFile) : res.dir;
      if (resolvedPackId && !targetDir) {
        const packs = discoverPacks(res.dir, src.catalogFile);
        console.error(`Pack '${resolvedPackId}' not found in '${repoName}'. Available: ${(packs.map((p) => p.name).join(', ')) || 'none'}`);
        return;
      }
      const rep = await importSkills({ source: targetDir ?? res.dir, origin: src.name, force: !!flags.force });
      for (const it of rep.imported) console.log(`installed  ${it.name}  -> ${it.to}`);
      for (const sk of rep.skipped) console.log(`skipped    ${sk.name}  (${sk.reason})`);
      for (const w of rep.warnings) console.log(`warning    ${w.name}  (${w.issues.join(', ')})`);
      for (const e of rep.errors) console.error(`error      ${e}`);
      console.log(`\n${rep.imported.length} installed, ${rep.skipped.length} skipped, ${rep.warnings.length} warnings, ${rep.errors.length} errors (source: ${src.name}).`);
      return;
    }
    if (sub === 'suggest') {
      // Surface the next skill opportunities + proven-lesson promotions without
      // waiting for a full self-train cycle. Read-only unless you run self-train
      // (which writes the actual learned-* skills).
      try {
        const { loadLessons } = await import('./lessons.js');
        const { detectSkillOpportunities, promoteLessons } = await import('./skills/skill-curator.js');
        const lessons = loadLessons(cwd);
        const opps = detectSkillOpportunities(lessons.map((l) => ({ title: l.lesson, pattern: l.signature })) as never, undefined, 0);
        console.log('Skill opportunities:');
        if (!opps.length) console.log('  (none detected yet — accumulate more run traces / lessons)');
        else for (const o of opps) console.log(`  [${o.kind}/${o.confidence.toFixed(2)}] ${o.title} — ${o.signal}`);
        const promo = promoteLessons(cwd);
        if (promo.promoted.length) {
          console.log(`\nLessons ready to promote (${promo.promoted.length}):`);
          for (const n of promo.promoted) console.log(`  promoted ${n}`);
        } else {
          console.log('\nLessons ready to promote: none yet (gated by PROMOTE_MIN_USES/PROMOTE_MIN_SUCCESSES).');
        }
      } catch (e) {
        console.error(`suggest failed: ${(e as Error).message}`);
      }
      return;
    }
    if (sub === 'lint') {
      const { formatSkillLint } = await import('./skills/skill-lint.js');
      const { assessSkillQuality } = await import('./skills/skill-manager.js');
      const { readFileSync } = await import('node:fs');
      const target = positional[2];
      const { discoverSkills, bundledSkillsDir, lintSkillSource } = await import('./skills/skills.js');
      const { resolve } = await import('node:path');
      const { homedir } = await import('node:os');
      const dirs = target
        ? [resolve(target)]
        : [
            resolve(cwd, '.mochi', 'skills'),
            resolve(homedir(), '.mochi', 'skills'),
            bundledSkillsDir(),
          ].filter(Boolean) as string[];
      let failing = 0, scanned = 0;
      for (const d of dirs) {
        let collection: any[] = [];
        try { const { skills: s } = discoverSkills(d); collection = s; } catch { collection = []; }
        for (const sk of collection) {
          scanned++;
          let pass = true;
          try {
            const raw = readFileSync(sk.path, 'utf8');
            if (!/^\ufeff?---/.test(raw)) { console.error(`FAIL  ${sk.name}: bad frontmatter (no --- block)`); failing++; continue; }
            const { description, body, result: r } = lintSkillSource(raw, sk.name);
            if (!r.ok) { console.error(`FAIL  ${sk.name}: ${formatSkillLint(r)}`); pass = false; failing++; }
            const dq: any = assessSkillQuality(description, body);
            if (!dq.passed) { console.log(`WARN  ${sk.name}: quality bar missing — ${dq.missing.join('; ')}`); }
          } catch (e) {
            console.error(`FAIL  ${sk.name}: ${(e as Error).message}`);
            failing++; pass = false;
          }
          if (pass) console.log(`ok    ${sk.name}`);
        }
      }
      console.log(`\\nLinted ${scanned} skills${failing ? ` — ${failing} failed` : ' (all clean)'}.`);
      return;
    }
    if (sub === 'mine') {
      // mochi skills mine --task <t> --lessons <a,b,c> --tools <r,e,s> --errors <x,y>
      // Manual MCH-200: draft a SKILL.md from a supplied trace via the
      // configured provider. Requires a live model provider; never throws.
      const f = (k: string): string | undefined => {
        const v = flags[k];
        return typeof v === 'string' && v.trim() ? v : undefined;
      };
      const taskTitle = f('task');
      if (!taskTitle) { console.log('Usage: mochi skills mine --task <title> [--lessons a,b] [--tools read,edit,shell] [--errors E1,E2] [--dry]'); return; }
      const { mineSkillFromTrace } = await import('./skills/skill-curator.js');
      const { createProvider } = await import('./model/router.js');
      try {
        const provider = createProvider(runtime.config.model);
        const splitList = (v?: string) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);
        if (flags.dry) { console.log('Dry run: would mine a skill from the supplied trace (no model call made).'); return; }
        const mined = await mineSkillFromTrace(cwd, {
          taskTitle,
          lessons: splitList(f('lessons')),
          toolSequence: splitList(f('tools')),
          errorsFixed: splitList(f('errors')),
          pattern: f('pattern') ?? 'general',
          strategy: f('strategy') ?? 'unclassified',
          provider,
        });
        console.log(mined ? `Mined skill: ${mined}` : 'Mining produced no skill (evidence gate, lint, or provider rejected the trace).');
      } catch (e) { console.error(`Mine failed: ${(e as Error).message}`); }
      return;
    }
    if (sub === 'report') {
      // mochi skills report — MCH-208 league table: what the system has
      // learned, scored by field performance, bucketed by origin.
      const { skillsReport } = await import('./skills/skill-manager.js');
      const rep = skillsReport(cwd);
      console.log(`Skill library: ${rep.totalSkills} skills in the usage DB${rep.curatorRuns !== undefined ? `, ${rep.curatorRuns} curator run(s)` : ''}.`);
      const origins = Object.entries(rep.byOrigin).sort((a, b) => b[1].count - a[1].count);
      if (origins.length) {
        console.log('\nBy origin:');
        for (const [o, b] of origins) {
          const wr = b.wins + b.losses > 0 ? `${Math.round((b.wins / (b.wins + b.losses)) * 100)}% win` : 'no field data';
          console.log(`  ${o.padEnd(15)} ${String(b.count).padStart(4)}  avg score ${String(b.avgScore).padStart(3)}  ${wr} (${b.wins}W/${b.losses}L)`);
        }
      }
      if (rep.topByScore.length) {
        console.log('\nTop by score:');
        for (const t of rep.topByScore.slice(0, 5)) console.log(`  ${t.score.toString().padStart(3)}  ${t.name} (${t.wins}W/${t.losses}L${t.patches ? `, ${t.patches} patches` : ''})`);
      }
      if (rep.needsAttention.length) {
        console.log('\nNeeds attention (losses or repeated patching):');
        for (const n of rep.needsAttention) console.log(`  ${n.score.toString().padStart(3)}  ${n.name} (${n.losses}L, ${n.patches} patches)`);
      } else {
        console.log('\nNo skills need attention.');
      }
      console.log(`\n${rep.selfPatched} skill(s) repaired by the curator so far.`);
      return;
    }
    const { skills } = loadAllSkills(cwd);
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
  if (first === 'import-skills' || (first === 'skills' && positional[1] === 'import')) {
    // mochi import-skills <source> [--force]      (alias: mochi skills import <source>)
    // Import an external skills tree (Hermes ~/.hermes/skills, a git checkout,
    // or any agentskills.io tree) into the global ~/.mochi/skills so the harness
    // gains the mature skill library without re-authoring. Cross-agent memory.
    const sourceName = positional[1] === 'import' ? positional[2] : positional[1];
    if (!sourceName) {
      console.log('Usage: mochi import-skills <source> [--force] [--update] [--list]');
      console.log('  source = "hermes:", an absolute/relative skills path, github:owner/repo, or a git URL.');
      console.log('  --force overwrites any dest that already exists. --update refreshes a cached git clone.');
      return;
    }
    const { importSkills, resolveSourceDir, discoverSourceSkills } = await import('./features/skill-importer.js');
    const srcRes = await resolveSourceDir(sourceName, { update: !!flags.update });
    if (!srcRes.dir) { console.error(`Source not found or clone failed: ${sourceName}${srcRes.error ? ` (${srcRes.error})` : ''}`); return; }
    const src = srcRes.dir;
    if (flags.list) {
      const { skills } = discoverSourceSkills(src);
      console.log(`Discoverable skills in ${src} (${skills.length}):`);
      for (const s of skills) console.log(`  - ${s.name}  ${(s.description || '').slice(0, 72)}`);
      return;
    }
    const rep = await importSkills({ source: sourceName, force: !!flags.force });
    for (const it of rep.imported) console.log(`imported  ${it.name}  -> ${it.to}`);
    for (const sk of rep.skipped) console.log(`skipped   ${sk.name}  (${sk.reason})`);
    for (const e of rep.errors) console.error(`error     ${e}`);
    console.log(`\n${rep.imported.length} imported, ${rep.skipped.length} skipped, ${rep.errors.length} errors (origin: ${rep.origin}).`);
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
        if (!flags['no-activate']) {
          const act = await reg.runActivation(rec.name);
          if (!act.skipped) {
            if (act.ok) console.log(`Activation ran (exit ${act.exitCode}).`);
            else console.error(`Activation failed (exit ${act.exitCode}): ${(act.stderr || act.stdout).trim().slice(0, 400)}`);
          }
        }
        return;
      } catch (e) {
        console.error(`Install failed: ${(e as Error).message}`);
        return;
      }
    }
    if (sub === 'remove' || sub === 'rm') {
      const name = positional[2];
      if (!name) { console.log('Usage: mochi plugin remove <name>'); return; }
      // Read the plugin's hook commands BEFORE deleting it, then strip them from
      // hooks.json and re-sync — otherwise a removed plugin keeps firing.
      const commands = reg.pluginCommands(name);
      if (reg.remove(name)) {
        const hooksFile = resolve(cwd, '.mochi', 'hooks.json');
        const { existsSync, readFileSync } = await import('node:fs');
        const existing = existsSync(hooksFile) ? JSON.parse(readFileSync(hooksFile, 'utf8')) : {};
        reg.syncToHooksFile(hooksFile, reg.stripCommands(existing, commands));
        console.log(`Removed plugin "${name}" and its hooks.`);
      } else { console.error(`No plugin "${name}" installed.`); }
      return;
    }
    if (sub === 'disable' || sub === 'enable') {
      const name = positional[2];
      const enabled = sub === 'enable';
      if (!name) { console.log(`Usage: mochi plugin ${sub} <name>`); return; }
      if (!reg.has(name)) { console.error(`No plugin "${name}" installed.`); return; }
      const commands = reg.pluginCommands(name);
      reg.setEnabled(name, enabled);
      const hooksFile = resolve(cwd, '.mochi', 'hooks.json');
      const { existsSync, readFileSync } = await import('node:fs');
      const existing = existsSync(hooksFile) ? JSON.parse(readFileSync(hooksFile, 'utf8')) : {};
      reg.syncToHooksFile(hooksFile, enabled ? existing : reg.stripCommands(existing, commands));
      console.log(`${enabled ? 'Enabled' : 'Disabled'} plugin "${name}". Its hooks are now ${enabled ? 'active' : 'inactive'}.`);
      if (enabled && !flags['no-activate']) {
        const act = await reg.runActivation(name);
        if (!act.skipped) {
          if (act.ok) console.log(`Activation ran (exit ${act.exitCode}).`);
          else console.error(`Activation failed (exit ${act.exitCode}): ${(act.stderr || act.stdout).trim().slice(0, 400)}`);
        }
      }
      return;
    }
    console.log('Usage: mochi plugin <add <dir>|remove <name>|enable <name>|disable <name>|list>');
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
    const { listTasks, getTask, describeTask, killTask } = await import('./daemon/background-tasks.js');
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
    if (sub === 'steer' || sub === 'stdin') {
      // MCH-218: write a line of input to a RUNNING background task — works
      // cross-process via the task's stdin FIFO (falls back to the direct
      // handle when this process owns the task).
      const id = positional[2];
      const text = positional.slice(3).join(' ');
      if (!id || !text) { console.log('Usage: mochi bg steer <task-id> <text>'); return; }
      const { steerPersistedTask } = await import('./daemon/background-tasks.js');
      const ok = steerPersistedTask(id, cwd, text);
      console.log(ok ? `Wrote to task ${id} stdin.` : `Could not steer task ${id} (unknown, finished, no stdin FIFO, or relay gone).`);
      return;
    }
    if (sub === 'kill' || sub === 'stop') {
      const id = positional[2];
      if (!id) { console.log('Usage: mochi bg kill <task-id>'); return; }
      const ok = killTask(id);
      console.log(ok ? `Killed background task ${id}.` : `Could not kill task ${id}.`);
      return;
    }
    console.log('Usage: mochi bg [list | logs <id> | steer <id> <text> | kill <id>]');
    return;
  }
  if (first === 'discord') {
    const { loadDiscordConfig } = await import('./discord.js');
    const cfg = loadDiscordConfig(cwd);
    if (!cfg) {
      console.error('No Discord bot configuration found. Set DISCORD_BOT_TOKEN in .env, ~/.mochi/.env, or ~/.hermes/.env.');
      process.exit(1);
    }
    const sub = positional[1] ?? 'status';
    if (sub === 'run') {
      // Live gateway: websocket → MESSAGE_CREATE → runtime.goal → reply.
      // Only prefix/mention messages are answered; everything else is ignored.
      // Needs the Message Content intent in the dev portal for bodies.
      const { runDiscordGateway } = await import('./discord.js');
      console.log(`🍡 Mochi Discord Gateway connecting with prefix "${cfg.prefix || '!mochi'}" (Ctrl+C to stop).`);
      const ctl = new AbortController();
      let sock: { close(): void } | undefined;
      process.once('SIGINT', () => { try { sock?.close(); } catch { /* already dead */ } ctl.abort(); });
      const summary = await runDiscordGateway(cfg, runtime, {
        createSocket: (url: string) => {
          const ws = new WebSocket(url);
          const s = {
            send: (t: string) => ws.send(t),
            close: () => ws.close(),
            onopen: null as (() => void) | null,
            onmessage: null as ((data: string) => void) | null,
            onclose: null as (() => void) | null,
            onerror: null as ((err: unknown) => void) | null,
          };
          ws.onopen = () => s.onopen?.();
          ws.onmessage = (ev: MessageEvent) => s.onmessage?.(typeof ev.data === 'string' ? ev.data : String(ev.data));
          ws.onclose = () => s.onclose?.();
          ws.onerror = () => s.onerror?.('websocket error');
          sock = s;
          return s;
        },
        onLog: (line: string) => console.log(line),
        signal: ctl.signal,
      });
      console.log(`Discord gateway stopped (${summary.messages} messages handled, ${summary.reconnects} reconnects).`);
      return;
    }
    console.log(`🍡 Mochi Discord Gateway configured with prefix "${cfg.prefix || '!mochi'}".`);
    console.log(`Bot Token: ${cfg.token.slice(0, 10)}... (whitelisting: ${cfg.allowAllUsers ? 'all users' : (cfg.allowedUserIds?.length ?? 0) + ' users'})`);
    return;
  }
  if (first === 'telegram') {
    // mochi telegram [run|status] — third-party messaging gateway (HTTP
    // long-poll; no websocket handshake, no privileged intents). Same
    // ask-prefix + allowlist policy as the Discord gateway.
    const { loadTelegramConfig, runTelegramGateway } = await import('./telegram.js');
    const tcfg = loadTelegramConfig(cwd);
    if (!tcfg) {
      console.error('No Telegram bot configuration found. Set TELEGRAM_BOT_TOKEN in .env, ~/.mochi/.env, or ~/.hermes/.env.');
      process.exit(1);
    }
    const sub = positional[1] ?? 'status';
    if (sub === 'run') {
      console.log(`🍡 Mochi Telegram gateway long-polling with prefix "${tcfg.prefix}" (Ctrl+C to stop).`);
      const ctl = new AbortController();
      process.once('SIGINT', () => ctl.abort());
      const summary = await runTelegramGateway(tcfg, runtime, {
        fetchJson: fetch as never,
        onLog: (line: string) => console.log(line),
        signal: ctl.signal,
      });
      console.log(`Telegram gateway stopped (${summary.updates} updates, ${summary.messages} answered).`);
      return;
    }
    console.log(`🍡 Mochi Telegram gateway configured with prefix "${tcfg.prefix}".`);
    console.log(`Bot Token: ${tcfg.token.slice(0, 10)}... (whitelisting: ${tcfg.allowAllUsers ? 'all users' : (tcfg.allowedUserIds?.length ?? 0) + ' users'})`);
    return;
  }
  if (first === 'slack') {
    const { loadSlackConfig, runSlackGateway } = await import('./slack.js');
    const scfg = loadSlackConfig(cwd);
    if (!scfg) {
      console.error('No Slack bot configuration found. Set SLACK_BOT_TOKEN (xoxb-...) and SLACK_CHANNEL in .env, ~/.mochi/.env, or ~/.hermes/.env.');
      process.exit(1);
    }
    const sub = positional[1] ?? 'status';
    if (sub === 'run') {
      console.log(`🍡 Mochi Slack gateway polling channels "${scfg.channels.join(', ')}" with prefix "${scfg.prefix}" (Ctrl+C to stop).`);
      const ctl = new AbortController();
      process.once('SIGINT', () => ctl.abort());
      const summary = await runSlackGateway(scfg, runtime, {
        fetchJson: fetch as never,
        onLog: (line: string) => console.log(line),
        signal: ctl.signal,
      });
      console.log(`Slack gateway stopped (${summary.updates} updates, ${summary.messages} answered).`);
      return;
    }
    if (sub === 'webhook') {
      const port = Number(flags.port) || 3000;
      const { runSlackWebhook } = await import('./slack.js');
      console.log(`🍡 Mochi Slack webhook listening on :${port}/slack/events (Ctrl+C to stop).`);
      const ctl = new AbortController();
      process.once('SIGINT', () => ctl.abort());
      const summary = await runSlackWebhook(scfg, runtime, { port, onLog: (line: string) => console.log(line), fetchJson: fetch as never });
      console.log(`Slack webhook stopped (${summary.requests} requests, ${summary.events} events).`);
      return;
    }
    console.log(`🍡 Mochi Slack gateway configured for channels "${scfg.channels.join(', ')}" with prefix "${scfg.prefix}".`);
    console.log(`Bot Token: ${scfg.token.slice(0, 10)}...`);
    return;
  }
  if (first === 'bluebubbles') {
    const { loadBlueBubblesConfig, runBlueBubblesGateway } = await import('./bluebubbles.js');
    const bcfg = loadBlueBubblesConfig(cwd);
    if (!bcfg) {
      console.error('No BlueBubbles configuration found. Set BLUEBUBBLES_SERVER_URL (or BLUEBUBBLES_URL) and BLUEBUBBLES_PASSWORD in .env, ~/.mochi/.env, or ~/.hermes/.env.');
      process.exit(1);
    }
    const sub = positional[1] ?? 'status';
    if (sub === 'run') {
      console.log(`🍡 Mochi BlueBubbles (iMessage) gateway polling with prefix "${bcfg.prefix}" (Ctrl+C to stop).`);
      const ctl = new AbortController();
      process.once('SIGINT', () => ctl.abort());
      const summary = await runBlueBubblesGateway(bcfg, runtime, {
        fetchJson: fetch as never,
        onLog: (line: string) => console.log(line),
        signal: ctl.signal,
      });
      console.log(`BlueBubbles gateway stopped (${summary.messages} messages, ${summary.replies} replies).`);
      return;
    }
    console.log(`🍡 Mochi BlueBubbles gateway configured for ${bcfg.serverUrl} with prefix "${bcfg.prefix}".`);
    console.log(`Allowed senders: ${bcfg.allowedSenders && bcfg.allowedSenders.length ? bcfg.allowedSenders.join(', ') : '(all)'}`);
    return;
  }
  if (first === 'connectors' || first === 'gateways' || first === 'channels' || first === 'platforms') {
    const cwd2 = cwd;
    // Load each gateway module lazily so a missing config never crashes the listing.
    const lines: string[] = [];
    lines.push(`🍡 Mochi connectors / gateways for ${cwd2}`);
    const tryLoad = async (label: string, modPath: string, loaderName: string, summary: (cfg: any) => string) => {
      try {
        const mod = await import(modPath);
        const loader = (mod as any)[loaderName];
        const cfg = loader ? loader(cwd2) : null;
        if (!cfg) { lines.push(`  ○ ${label.padEnd(14)} not configured`); return; }
        lines.push(`  ● ${label.padEnd(14)} configured  ${summary(cfg)}`);
      } catch (e) {
        lines.push(`  ! ${label.padEnd(14)} error: ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`);
      }
    };
    await tryLoad('discord', './discord.js', 'loadDiscordConfig', (c) => `prefix "${c.prefix || '!mochi'}" · users ${c.allowAllUsers ? 'all' : (c.allowedUserIds?.length ?? 0)}`);
    await tryLoad('telegram', './telegram.js', 'loadTelegramConfig', (c) => `prefix "${c.prefix}" · users ${c.allowAllUsers ? 'all' : (c.allowedUserIds?.length ?? 0)}`);
    await tryLoad('slack', './slack.js', 'loadSlackConfig', (c) => `channels "${(c.channels || []).join(', ')}" · prefix "${c.prefix}"`);
    await tryLoad('bluebubbles', './bluebubbles.js', 'loadBlueBubblesConfig', (c) => `server ${c.serverUrl} · senders ${c.allowedSenders?.length ? c.allowedSenders.length : 'all'}`);
    for (const l of lines) console.log(l);
    console.log(`Run \`mochi <platform> run\` to start a gateway (discord, telegram, slack, bluebubbles).`);
    return;
  }

  // Aliases for BlueBubbles / iMessage
  if (first === 'bluebubble' || first === 'imessage' || first === 'bb') {
    // delegate by rewriting positional in place is unsafe; instead re-enter logic by setting first
    positional[0] = 'bluebubbles';
    // fall through: handled below? The bluebubbles block checks positional[0] not first. Set first too.
    // We can't easily set const; instead handle redirect here.
    const { loadBlueBubblesConfig, runBlueBubblesGateway } = await import('./bluebubbles.js');
    const bcfg = loadBlueBubblesConfig(cwd);
    if (!bcfg) {
      console.error('No BlueBubbles configuration found. Set BLUEBUBBLES_SERVER_URL (or BLUEBUBBLES_URL) and BLUEBUBBLES_PASSWORD in .env, ~/.mochi/.env, or ~/.hermes/.env.');
      process.exit(1);
    }
    const sub = positional[1] ?? 'status';
    if (sub === 'run') {
      console.log(`🍡 Mochi BlueBubbles (iMessage) gateway polling with prefix "${bcfg.prefix}" (Ctrl+C to stop).`);
      const ctl = new AbortController();
      process.once('SIGINT', () => ctl.abort());
      const summary = await runBlueBubblesGateway(bcfg, runtime, {
        fetchJson: fetch as never,
        onLog: (line: string) => console.log(line),
        signal: ctl.signal,
      });
      console.log(`BlueBubbles gateway stopped (${summary.messages} messages, ${summary.replies} replies).`);
      return;
    }
    console.log(`🍡 Mochi BlueBubbles gateway configured for ${bcfg.serverUrl} with prefix "${bcfg.prefix}".`);
    console.log(`Allowed senders: ${bcfg.allowedSenders && bcfg.allowedSenders.length ? bcfg.allowedSenders.join(', ') : '(all)'}`);
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
    // Prefer the standalone Mochi Control dashboard (:9121) when it's up —
    // it fronts this daemon (plus sessions, analytics, audit, files) with a
    // full UI. Fall back to the daemon's built-in single-page console.
    const dashUrl = 'http://localhost:9121';
    const controlUp = await fetch(`${dashUrl}/api/health`).then((r: any) => r.ok).catch(() => false);
    if (controlUp) {
      console.log(`🍡 Mochi Control dashboard running at:\n${dashUrl}\n(sign in with your dashboard credentials; it drives the daemon on your behalf)\n`);
      const { execFileSync } = await import('node:child_process');
      try { execFileSync('xdg-open', [dashUrl], { stdio: 'ignore', detached: true } as any); } catch { /* headless */ }
      return;
    }
    const wsDir = resolve(cwd, '.mochi');
    const { readDaemonInfo, startDaemon, daemonRunning } = await import('./daemon/daemon.js');
    let info = readDaemonInfo(wsDir);
    if (!info || !daemonRunning(wsDir)) {
      const r = await startDaemon({ cwd, config: configOverrides });
      if (!r.ok) { console.error(`Failed to start daemon: ${r.error}`); process.exit(1); }
      info = readDaemonInfo(wsDir);
    }
    const url = `http://127.0.0.1:${info?.port}/dashboard?token=${info?.token}`;
    console.log(`🍡 Mochi Web Dashboard running at:\n${url}\n(contains a local auth token — do not share or paste into logs)\n`);
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
      const { checkpoint } = await import('./repo/git.js');
      const cp = await checkpoint(cwd, 'mochi fix');
      console.log(`Auto-commit: ${cp.ref} (${cp.type})`);
    }
    return;
  }
  if (first === 'acp') {
    // Editor-native stdio server (Agent Client Protocol). Runs until the
    // editor closes stdin. Never falls through to the prompt path.
    const { serverLoop } = await import('./acp.js');
    await serverLoop(cwd);
    return;
  }
  if (first === 'mcp-serve') {
    // MCP stdio server for editor ubiquity: VS Code (Copilot MCP), Cursor,
    // JetBrains, Neovim, Claude Desktop spawn this as a child process and
    // drive Mochi's agent runtime as MCP tools. Never falls through.
    const { mcpServerLoop } = await import('./mcp-server.js');
    await mcpServerLoop(cwd);
    return;
  }
  if (first === 'config') {
    console.log(JSON.stringify(runtime.config, null, 2));
    return;
  }
  if (first === 'interop') {
    // Adopt an existing third-party agent setup instead of re-authoring it.
    const sub = positional[1];
    if (sub === 'claude') {
      const { importClaudeInterop, formatClaudeReport } = await import('./interop/claude.js');
      const report = importClaudeInterop(runtime.cwd, { force: !!flags.force, dryRun: !!flags['dry-run'] });
      console.log(formatClaudeReport(report));
      return;
    }
    console.log('Usage: mochi interop claude [--dry-run] [--force]');
    return;
  }
  if (first === 'hooks') {
    // MCH-37: user-facing hooks management — init a hooks.json template,
    // list discovered hooks, or test-fire one. Claude Code-hooks parity.
    const { HookManager } = await import('./hooks.js');
    const { existsSync, writeFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { findProjectRoot } = await loadRepoModule();
    const wsDir = resolve(findProjectRoot(runtime.cwd), '.mochi');
    const sub = positional[1];
    if (sub === 'init') {
      const tpl = {
        before_shell: 'echo "$MOCHI_ARGS" | grep -q "rm -rf" && { echo "blocked: rm -rf is not allowed"; exit 1; } || exit 0',
        after_edit: 'echo "edit happened: $MOCHI_TOOL"',
      };
      const target = resolve(runtime.cwd, 'hooks.json');
      if (existsSync(target)) { console.log('hooks.json already exists at ' + target); return; }
      writeFileSync(target, JSON.stringify(tpl, null, 2) + '\n');
      console.log('Wrote ' + target + ' with a starter template (before_shell blocks rm -rf). Edit to taste.');
      return;
    }
    const mgr = new HookManager(wsDir);
    const names = mgr.list();
    if (names.length === 0) {
      console.log('No hooks configured. Run `mochi hooks init` to create hooks.json, or see `mochi hooks --help`.');
    } else {
      console.log('Hooks configured:');
      for (const n of names) console.log('  ' + n);
      console.log('\nHook env vars: MOCHI_TOOL, MOCHI_ARGS (JSON), MOCHI_AGENT. Exit non-zero in a before_* hook to veto the action.');
    }
    return;
  }
  if (first === 'setup' && (positional[1] === 'vscode' || positional[1] === 'jetbrains' || positional[1] === 'editors' || positional[1] === 'editor')) {
    // Real-product editor installer: verifies the ACP bridge, then hands off
    // to the marketplace / install-from-disk flow. Never shells out to a
    // package manager without telling the user first (the old flow tried to
    // auto-run `code`/`vsce` and failed opaquely on minimal PATHs).
    const target = positional[1];
    const { acpCheck } = await import('./acp.js');
    const check = await acpCheck(cwd);
    console.log(check.report);
    if (!check.ok) { console.error('Fix ACP first (`mochi doctor --probe`), then re-run setup.'); process.exit(1); }
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const extRoot = resolve(cliDirname(), '..', 'editors');
    if (target === 'vscode' || target === 'editors' || target === 'editor') {
      const pkg = resolve(extRoot, 'vscode', 'package.json');
      // Compiled binaries bake the BUILD machine's paths into import.meta.url,
      // so existsSync can lie on the build host. Detect a compiled binary by
      // its own executable name (node/bun/tsx runs show the runtime instead).
      const { basename } = await import('node:path');
      const isCompiledBin = basename(process.execPath).startsWith('mochi');
      if (!existsSync(pkg) || isCompiledBin) {
        // Standalone binary install (no editors/ tree shipped): grab the
        // prebuilt .vsix from the release page instead of cloning + building.
        console.log('');
        console.log('VS Code (binary install):');
        console.log('  1. Download mochi-vscode-<version>.vsix from https://github.com/xanstomper/mochi/releases');
        console.log('  2. code --install-extension mochi-vscode-<version>.vsix');
        console.log('     (or Extensions view → … → Install from VSIX)');
        console.log('  3. Open a trusted folder → Mochi icon → "Mochi: New Session".');
      } else {
        console.log('');
        console.log('VS Code:');
        console.log('  1. cd editors/vscode && npm install && npx vsce package');
        console.log('  2. code --install-extension mochi-vscode-<version>.vsix');
        console.log('  3. Open a trusted folder → Mochi icon → "Mochi: New Session".');
        console.log('  Settings: mochi.binaryPath (default "mochi"), mochi.requestTimeoutMs, mochi.maxSessionHistory.');
        try {
          const { execFileSync } = await import('node:child_process');
          const out = execFileSync('code', ['--version'], { timeout: 5000 }).toString().trim().split('\n')[0];
          console.log(`  Detected VS Code CLI: ${out} — step 2 will work.`);
        } catch {
          console.log('  VS Code CLI (`code`) not on PATH — install the .vsix via Extensions → … → Install from VSIX.');
        }
      }
    }
    if (target === 'jetbrains' || target === 'editors' || target === 'editor') {
      console.log('');
      console.log('JetBrains (IntelliJ / PyCharm / WebStorm):');
      console.log('  1. cd editors/jetbrains && ./gradlew buildPlugin');
      console.log('  2. Settings → Plugins → ⚙ → Install Plugin from Disk → build/distributions/*.zip');
      console.log('  3. Tools → Mochi chat (right tool window). Binary defaults to "mochi" on PATH.');
    }
    return;
  }
  if (first === 'onboard' || first === 'setup' || first === 'welcome') {
    // Cozy one-time setup wizard: scan other agents for providers/keys,
    // skills and MCPs, then import non-destructively. `mochi onboard --yes`
    // accepts all defaults (CI-friendly); otherwise interactive prompts.
    const { scanForOnboarding } = await import('./onboarding/detect.js');
    const { importProviderKeys, importSkillSources, importMcpSources, markOnboarded } = await import('./onboarding/import.js');
    const { welcomeFrame, stepFrame, defaultChoices } = await import('./onboarding/wizard.js');
    const scan = scanForOnboarding(cwd);
    const yes = flags.yes === true || flags.y === true || flags.auto === true;
    for (const line of welcomeFrame(VERSION)) console.log(line.replace(/\x1b\[[0-9;]*m/g, ''));
    console.log('');
    for (const step of ['providers', 'models', 'skills', 'mcp', 'editors'] as const) {
      for (const line of stepFrame(step, scan)) console.log(line.replace(/\x1b\[[0-9;]*m/g, ''));
      console.log('');
    }
    const choices = defaultChoices(scan);
    if (flags['skip-skills']) { choices.importSkills = false; choices.skillDirs = []; }
    if (flags['skip-mcp']) { choices.importMcp = false; choices.mcpFiles = []; }
    if (flags['skip-providers']) choices.importProviders = false;
    if (!yes && process.stdin.isTTY) {
      // Interactive confirm (default Y). Single prompt keeps ssh/mobile usable.
      const ask = (q: string): Promise<boolean> => new Promise((res) => {
        process.stdout.write(`${q} [Y/n] `);
        let acc = '';
        const onData = (c: Buffer) => {
          acc += c.toString('utf8');
          if (acc.includes('\n')) {
            process.stdin.off('data', onData);
            process.stdin.pause();
            res(!/^\s*n/i.test(acc.trim()));
          }
        };
        process.stdin.on('data', onData);
        process.stdin.resume();
      });
      const ok = await ask(`Import ${scan.providers.filter((p) => p.hasKey).length} provider key(s), ${scan.totalSkills} skill(s), ${scan.totalMcpServers} MCP server(s)?`);
      if (!ok) {
        console.log('No changes made. Re-run `mochi onboard --yes` anytime.');
        markOnboarded({ providersImported: [], skillsImported: 0, mcpImported: 0 });
        return;
      }
    }
    let skillsImported = 0;
    let mcpImported = 0;
    let providersImported: string[] = [];
    if (choices.importProviders) {
      const r = importProviderKeys({ overwrite: !!flags.force });
      if (r.primary) providersImported.push(r.primary);
      providersImported.push(...r.failover);
      console.log(providersImported.length ? `🔑 providers wired: ${providersImported.join(', ')}` : '🔑 no provider keys found — set one via `mochi login <provider> --key <k>`');
    }
    if (choices.importSkills && choices.skillDirs.length) {
      const r = await importSkillSources(choices.skillDirs, { force: !!flags.force });
      skillsImported = r.imported;
      console.log(`🧠 skills: ${r.imported} imported, ${r.skipped} skipped${r.errors.length ? `, ${r.errors.length} errors` : ''}`);
      for (const e of r.errors.slice(0, 5)) console.error(`   error: ${e}`);
    } else {
      console.log('🧠 skills: skipped (none found or --skip-skills)');
    }
    if (choices.importMcp && choices.mcpFiles.length) {
      const r = importMcpSources(choices.mcpFiles);
      mcpImported = r.imported.length;
      console.log(`🔌 MCP: ${r.imported.length} imported${r.imported.length ? ` (${r.imported.slice(0, 6).join(', ')})` : ''}${r.skipped.length ? `, ${r.skipped.length} already present` : ''}`);
    } else {
      console.log('🔌 MCP: skipped (none found or --skip-mcp)');
    }
    console.log('');
    console.log('Editors: VS Code → editors/vscode/README.md · JetBrains → editors/jetbrains/README.md (both speak `mochi acp`).');
    console.log('');
    for (const line of stepFrame('done', scan)) console.log(line.replace(/\x1b\[[0-9;]*m/g, ''));
    markOnboarded({ providersImported, skillsImported, mcpImported });
    return;
  }
  if (first === 'perf') {
    const { benchmarkStream, formatPerfReport } = await import('./observability/perf.js');
    const count = flags.chunks ? Number(flags.chunks) : 10000;
    console.log(formatPerfReport(benchmarkStream(count)));
    return;
  }
  if (first === 'feedback') {
    // Human feedback → ~/.mochi/feedback.jsonl (same file the TUI g/b keys
    // write; the next turn reads it as a self-correction directive).
    // `mochi feedback good|bad [--note "..."] [--crash]` — crash attaches the
    // last 20 crash.log lines as the reason. No network, no tracking.
    const verdict = positional[1];
    if (verdict !== 'good' && verdict !== 'bad') {
      console.log('Usage: mochi feedback good|bad [--note "..."] [--crash]');
      return;
    }
    const noteFlag = typeof flags.note === 'string' && flags.note ? flags.note : positional.slice(2).filter((a) => a !== '--crash').join(' ');
    let reason = noteFlag.trim() || undefined;
    if (flags.crash === true || positional.includes('--crash')) {
      try {
        const { readFileSync, existsSync } = await import('node:fs');
        const { join } = await import('node:path');
        const { homedir } = await import('node:os');
        const crashFile = join(homedir(), '.mochi', 'logs', 'crash.log');
        if (existsSync(crashFile)) {
          const tail = readFileSync(crashFile, 'utf8').trim().split('\n').slice(-20).join('\n').slice(0, 2000);
          reason = [`crash report${reason ? `: ${reason}` : ''}`, tail].join('\n');
        }
      } catch { /* crash attach is best-effort */ }
    }
    const { recordFeedback } = await import('./observability/feedback.js');
    recordFeedback({ ts: Date.now(), session: 'cli', turn: 0, verdict, reason, snippet: (reason ?? verdict).slice(0, 200) });
    console.log(`Recorded ${verdict === 'good' ? '👍' : '👎'} feedback. Thank you — the next turn reads it as a correction signal.`);
    return;
  }
  if (first === 'providers') {
    const { PROVIDERS } = await import('./model/providers.js');
    for (const p of PROVIDERS) console.log(p.id.padEnd(14) + ' ' + p.name);
    return;
  }
  if (first === 'fallback' || first === 'fallbacks') {
    const action = positional[1] || 'list';
    const targetProv = positional[2];
    const targetModel = positional[3];
    if (action === 'clear' || action === 'reset') {
      console.log(runtime.clearFallbacks());
      return;
    }
    if (action === 'rm' || action === 'remove' || action === 'delete') {
      if (!targetProv) { console.error('Usage: mochi fallback rm <provider>'); process.exit(1); }
      console.log(runtime.removeFallback(targetProv));
      return;
    }
    if (action === 'add' || action === 'set') {
      if (!targetProv) { console.error('Usage: mochi fallback add <provider> [model]'); process.exit(1); }
      console.log(runtime.addFallback(targetProv, targetModel));
      return;
    }
    const primary = runtime.config.model;
    const fallbacks = runtime.getFallbacks();
    console.log(`Primary model: ${primary.provider} (${primary.model})\n`);
    if (fallbacks.length === 0) {
      console.log('No fallback models configured.');
    } else {
      console.log(`Fallback models (${fallbacks.length}):`);
      fallbacks.forEach((fb, idx) => {
        console.log(`  ${idx + 1}. ${fb.provider.padEnd(16)} ${fb.model} (${fb.baseUrl})`);
      });
    }
    console.log('\nManage fallbacks with:\n  mochi fallback add <provider> [model]\n  mochi fallback rm <provider>\n  mochi fallback clear');
    return;
  }
  if (first === 'account' || first === 'accounts' || first === 'switch') {
    const { runAuthCommand } = await import('./cli-auth.js');
    if (first === 'switch' || (first === 'account' && (positional[1] === 'switch' || positional[1]?.includes('@')))) {
      const targetAccount = first === 'switch' ? positional[1] : (positional[1] === 'switch' ? positional[2] : positional[1]);
      await runAuthCommand({
        positional: ['auth', 'switch', runtime.config.model.provider, targetAccount],
        flags, runtime,
        log: (s) => console.log(s),
        error: (s) => console.error(s),
        exit: (code) => process.exit(code),
      });
      return;
    }
    await runAuthCommand({
      positional: ['auth', 'accounts', positional[1] || runtime.config.model.provider],
      flags, runtime,
      log: (s) => console.log(s),
      error: (s) => console.error(s),
      exit: (code) => process.exit(code),
    });
    return;
  }
  if (first === 'login' || first === 'use') {
    const { providerById } = await import('./model/providers.js');
    const provider = positional[1];
    const model = positional[2];
    if (!provider) {
      console.log('Usage: mochi login <provider> [model]');
      const { PROVIDERS } = await import('./model/providers.js');
      for (const p of PROVIDERS) console.log('  ' + p.id.padEnd(14) + p.name);
      return;
    }
    const p = providerById(provider);
    if (!p) { console.error('Unknown provider: ' + provider); return; }
    let key = process.env[p.envKey] || positional.find((x) => x.startsWith('env:'))?.slice(4) || (typeof flags.key === 'string' && flags.key ? flags.key : undefined);
    let keySourceType: 'api-key' | 'oauth' = 'api-key';
    if (!key && (p.id === 'antigravity' || p.id === 'google-antigravity')) {
      const { antigravityAmbientToken } = await import('./model/ambient-auth.js');
      const ambient = await antigravityAmbientToken();
      if (ambient && !flags.browser && !flags.oauth) {
        console.log(`Discovered ambient Google Antigravity OAuth token (${ambient.source}).`);
        key = ambient.token;
        keySourceType = 'oauth';
      } else {
        const { runAntigravityOAuth } = await import('./model/antigravity-oauth.js');
        const cred = await runAntigravityOAuth({
          onProgress: (m: string) => console.log(m),
        });
        key = JSON.stringify(cred);
        keySourceType = 'oauth';
        console.log(`Successfully authenticated with Google Antigravity (${cred.email ?? 'authorized'}).`);
      }
    } else if (!key && (p.id === 'openai-codex' || p.id === 'openai')) {
      const { codexAmbientToken } = await import('./model/ambient-auth.js');
      const ambient = await codexAmbientToken();
      if (ambient?.token) {
        console.log(`Discovered ambient OpenAI Codex OAuth token (${ambient.source}).`);
        key = ambient.token;
        keySourceType = 'oauth';
      }
    } else if (!key && p.id === 'kilo') {
      const { kiloAmbientToken } = await import('./model/ambient-auth.js');
      const ambient = await kiloAmbientToken();
      if (ambient?.token) {
        console.log(`Discovered ambient Kilo OAuth token (${ambient.source}).`);
        key = ambient.token;
        keySourceType = 'oauth';
      }
    } else if (!key && p.id === 'tokenjuice') {
      const { tokenjuiceAmbientToken } = await import('./model/ambient-auth.js');
      const ambient = tokenjuiceAmbientToken();
      if (ambient?.token) {
        console.log(`Discovered ambient TokenJuice API key (${ambient.source}).`);
        key = ambient.token;
      }
    } else if (!key && p.id === 'github-models') {
      const { githubAmbientToken } = await import('./model/ambient-auth.js');
      const ambient = await githubAmbientToken();
      if (ambient?.token) {
        console.log(`Discovered ambient GitHub OAuth token (${ambient.source}).`);
        key = ambient.token;
        keySourceType = 'oauth';
      }
    } else if (!key && p.id === 'huggingface') {
      const { huggingfaceAmbientToken } = await import('./model/ambient-auth.js');
      const ambient = huggingfaceAmbientToken();
      if (ambient?.token) {
        console.log(`Discovered ambient Hugging Face token (${ambient.source}).`);
        key = ambient.token;
        keySourceType = 'oauth';
      }
    }
    if (!key && p.envKey) {
      console.log(`Set ${p.envKey} or run 'mochi tui' and use /login to input an API key interactively.`);
      return;
    }
    // Real auth: prove keyed credentials with a live probe before storing.
    // A rejected key is never persisted (no fake logins); an unreachable
    // endpoint stores with a warning instead of refusing a good key.
    if (key && p.envKey) {
      const { verifyApiKey } = await import('./model/auth-verify.js');
      const v = await verifyApiKey({ provider: p.id, baseUrl: p.baseUrl, apiKey: key, kind: p.kind });
      if (!v.ok && v.reason === 'auth') {
        console.error(`Key rejected by ${p.name}: ${v.message}. Not stored — check the key and try again.`);
        process.exit(1);
      }
      if (!v.ok) console.error(`Warning: could not verify the key (${v.message}) — storing anyway.`);
      else console.log(`Verified key with ${p.name}.`);
    }
    const account = typeof flags.account === 'string' && flags.account.length ? flags.account : undefined;
    const info = key ? await runtime.loginProvider(p.id, key, model || p.defaultModel, keySourceType, account) : await runtime.useProvider(p.id, model || p.defaultModel);
    const { redact } = await import('./security/security.js');
    console.log(redact(info));
    return;
  }
  if (first === 'auth') {
    // mochi auth [status [--probe] | logout [provider] | reset [provider]] — credential visibility
    // across all providers (authenticate with: mochi login <provider>; change a key by logging in again).
    // Never prints key material: sources only (env/file/local/missing).
    // Unit in ./cli-auth.js (scripted deps); this stays a thin adapter.
    const { runAuthCommand } = await import('./cli-auth.js');
    await runAuthCommand({
      positional, flags, runtime,
      log: (s: string) => console.log(s),
      error: (s: string) => console.error(s),
      exit: (code: number): never => process.exit(code),
    });
    return;
  }
  if (first === 'models') {
    // mochi models [--refresh] [--provider <id>] — static table by default;
    // --refresh live-diffs the active provider's /models endpoint against the
    // table (detection only, never mutates providers.ts). Unit in
    // ./model/model-refresh.js (stubbed fetch); this stays a thin adapter.
    if (flags.refresh) {
      const { providerById, PROVIDERS } = await import('./model/providers.js');
      const { listRemoteModels, diffModels, renderRefresh } = await import('./model/model-refresh.js');
      const { isKeyUsable } = await import('./model/startup-check.js');
      const wanted = typeof flags.provider === 'string' ? flags.provider : runtime.config.model.provider;
      const p = providerById(wanted) ?? PROVIDERS.find((x) => x.id === wanted.toLowerCase());
      if (!p) { console.error(`Unknown provider: ${wanted}`); process.exit(1); }
      const key = (p.envKey && process.env[p.envKey]) || (runtime.config.model.provider === p.id ? runtime.config.model.apiKey : undefined) || '';
      if (!isKeyUsable(key)) {
        console.error(`No usable key for ${p.id} — set $${p.envKey || '(no env key; log in via the TUI /login)'} or run: mochi login ${p.id}`);
        process.exit(1);
      }
      const remote = await listRemoteModels(p, key);
      if (!Array.isArray(remote)) {
        console.log(renderRefresh(p, { provider: p.id, added: [], known: [], error: remote.error }));
        process.exit(1);
      }
      const { added, known } = diffModels(p.models, remote);
      console.log(renderRefresh(p, { provider: p.id, added, known }));
      return;
    }
    console.log(runtime.modelList().join('\n') || 'No models listed for ' + runtime.config.model.provider);
    return;
  }
  if (first === 'mcp') {
    // mochi mcp [list|search <q>|add <spec>|remove <id>|test [id]] — MCP
    // discovery + universal install (built-in id, npm:<pkg>, uvx:<pkg>,
    // https://… endpoint, cmd:<bin>) into .mcp.json (same engine as /mcp).
    const { searchMcpServers, addMcpServerConfig, removeMcpServerConfig, testMcpServerConfig, listConfiguredMcpServers, BUILTIN_MCP_SERVERS } = await import('./tools/mcp-manage.js');
    const sub = positional[1] ?? 'list';
    const rest = positional.slice(2).join(' ');
    if (sub === 'list' || !sub) {
      for (const s of BUILTIN_MCP_SERVERS) console.log(`${s.id.padEnd(24)} ${s.description}`);
      const configured = listConfiguredMcpServers(cwd);
      if (configured.length) console.log(`\nConfigured in .mcp.json: ${configured.join(', ')}`);
      return;
    }
    if (sub === 'search') {
      if (!rest) { console.error('Usage: mochi mcp search <keywords>'); process.exit(1); }
      const hits = searchMcpServers(rest);
      if (!hits.length) { console.log(`No MCP servers match "${rest}".`); return; }
      for (const h of hits) console.log(`${h.server.id.padEnd(24)} ${h.snippet.slice(0, 80)}`);
      console.log('\nInstall one with: mochi mcp add <server-id>');
      return;
    }
    if (sub === 'add') {
      if (!rest) { console.error('Usage: mochi mcp add <server-id|npm:<pkg>|uvx:<pkg>|https://…|cmd:<bin> [args]>'); process.exit(1); }
      const r = addMcpServerConfig(cwd, rest);
      console.log(r.message);
      if (!r.ok) process.exit(1);
      return;
    }
    if (sub === 'remove') {
      if (!rest) { console.error('Usage: mochi mcp remove <server-id>'); process.exit(1); }
      const r = removeMcpServerConfig(cwd, rest);
      console.log(r.message);
      if (!r.ok) process.exit(1);
      return;
    }
    if (sub === 'test') {
      if (rest) {
        const r = await testMcpServerConfig(cwd, rest);
        console.log(r.message);
        if (!r.ok) process.exit(1);
        return;
      }
      const ids = listConfiguredMcpServers(cwd);
      if (!ids.length) { console.log('Nothing configured in .mcp.json — add a server first.'); return; }
      let failed = false;
      for (const id of ids) {
        const r = await testMcpServerConfig(cwd, id);
        console.log(r.message);
        if (!r.ok) failed = true;
      }
      if (failed) process.exit(1);
      return;
    }
    console.error(`Unknown mcp command "${sub}". Use: mochi mcp [list|search <q>|add <spec>|remove <id>|test [id]]`);
    process.exit(1);
  }
  if (first === 'update' || first === 'upgrade' || first === 'self-update') {
    const compareSemver = (a: string, b: string): number => {
      const pa = a.split('.').map((n) => Number(n) || 0);
      const pb = b.split('.').map((n) => Number(n) || 0);
      for (let i = 0; i < 3; i++) {
        if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
      }
      return 0;
    };
    const explicitApply = flags.apply === true || flags.yes === true;
    const checkOnly = flags.check === true || !explicitApply;
    const url = 'https://api.github.com/repos/xanstomper/mochi/releases/latest';
    const res = await fetch(url, { headers: { 'user-agent': `mochi/${VERSION}` } });
    if (!res || !res.ok) {
      console.error(`Could not check for updates (${res?.status ?? 'network error'}).`);
      return;
    }
    const data = (await res.json()) as { tag_name?: string; name?: string; html_url?: string; body?: string };
    const latest = String(data.tag_name ?? data.name ?? '').replace(/^v/i, '');
    console.log(`Current: ${VERSION}`);
    console.log(`Latest:  ${latest}`);
    const isNewer = compareSemver(latest, VERSION) > 0;
    if (!isNewer) {
      console.log('Already up to date.');
      return;
    }
    console.log(`New release available: ${data.html_url ?? ''}`);
    console.log('Release notes:');
    console.log((data.body ?? '(no notes provided)').split('\\n').slice(0, 40).join('\\n'));
    if (checkOnly) {
      console.log('\\nRun `mochi update --apply` (or re-run the install.sh) to install it.');
      return;
    }
    // Apply via the official installer; user keeps control of credentials.
    const { execFileSync } = await import('node:child_process');
    try {
      console.log('Running installer...');
      execFileSync('bash', ['-c', 'curl -fsSL https://raw.githubusercontent.com/xanstomper/mochi/main/install.sh | bash'], { stdio: 'inherit' });
      console.log('Update complete. Restart mochi (and `hash -r`).');
    } catch (e) {
      console.error(`Update failed: ${(e as Error).message}`);
      console.error('Manual upgrade: cd ~/mochi && git pull && npm install && npm run build:native');
    }
    return;
  }
  if (first === 'practice') {
    // MCH-216: run dataset-shaped practice tasks through the real agent.
    // Each task runs in a fresh throwaway workspace with a machine-checkable
    // verify command; failures feed the lesson/skill flywheel.
    const { SEED_TASKS, runPractice, DATASET_CATALOG } = await import('./core/practice.js');
    const taskIds = positional.slice(1).filter((p) => !p.startsWith('-'));
    if (positional[1] === 'datasets') {
      console.log(`Verified open datasets for practice/trace mining (${DATASET_CATALOG.length}):\n`);
      for (const d of DATASET_CATALOG) {
        const gate = d.open ? '' : ' [gated]';
        console.log(`  ${d.id}${gate}  (${d.focus}, ${d.downloads} downloads)\n    trains: ${d.trains}`);
      }
      return;
    }
    const { Mochi } = await import('./sdk.js');
    const client = Mochi.create({ cwd: runtime.cwd });
    console.log(`Running ${taskIds.length || SEED_TASKS.length} practice task(s) against the live agent...`);
    const { results, passed, failed } = await runPractice(client, runtime.cwd, { taskIds: taskIds.length ? taskIds : undefined });
    for (const r of results) {
      const icon = r.pass ? '✓' : '×';
      console.log(`  ${icon} ${r.taskId} (${(r.durationMs / 1000).toFixed(1)}s)${r.pass ? '' : `\n      verify: ${r.verifyOutput.slice(0, 200)}`}`);
    }
    console.log(`\n${passed} passed, ${failed} failed. Failures recorded to the lesson flywheel.`);
    if (failed > 0) process.exitCode = 1;
    return;
  }

  if (first === 'doctor') {
    const { doctorReport, formatDoctor, repairDoctor } = await import('./doctor.js');
    const { daemonRunning, readDaemonInfo } = await import('./daemon/daemon.js');
    const { findProjectRoot } = await loadRepoModule();
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
      version: VERSION,
      probeProvider: flags.probe === true || positional[1] === 'probe' || flags.verbose === true,
      provider: runtime.config.model.provider,
      baseUrl: runtime.config.model.baseUrl ?? '',
      model: runtime.config.model.model,
      apiKey: (runtime.config.model as unknown as { apiKey?: string }).apiKey ?? null,
      workspaceDir: wsDir,
      daemon: { running: isRunning, port: info?.port },
    });
    if (flags.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(formatDoctor(report));
    return;
  }
  if (first === 'gc' || first === 'prune' || first === 'retention') {
    const { runRetention } = await import('./memory/retention.js');
    const { findProjectRoot } = await loadRepoModule();
    const wsDir = resolve(findProjectRoot(runtime.cwd), '.mochi');
    const maxAgeDays = Number(flags.maxAgeDays ?? positional[1] ?? 14);
    const apply = flags.apply === true || flags.yes === true || positional.includes('--apply') || positional.includes('--yes');
    if (!apply) {
      console.log(`[dry-run] retention scan for ${wsDir} (maxAgeDays=${maxAgeDays})`);
      console.log('  no files removed; pass --apply to actually prune');
      return;
    }
    const r = runRetention({ workspaceDir: wsDir, maxAgeDays });
    console.log(`GC complete — state: ${r.state.deletedFiles} deleted (${r.state.freedBytes} bytes), ${r.state.remainingFiles} kept; traces: ${r.traces.deletedFiles} deleted (${r.traces.freedBytes} bytes), ${r.traces.remainingFiles} kept. Log: ${r.logPath}`);
    return;
  }

  if (first === 'bundle' || first === 'export-bundle') {
    const { SessionStore } = await import('./state/session-store.js');
    const { safe } = await (async () => ({ safe: (s: string) => s })) as never;
    void safe;
    const out = positional[1] ?? 'mochi-bundle.md';
    const wsDir = resolve(runtime.workspace.dir);
    const store = new SessionStore(wsDir);
    const rows = store.list(1);
    let transcript = '';
    if (rows.length) {
      const msgs = store.messages(rows[0].id);
      transcript = msgs.map((m) => `### ${m.role} @ ${new Date(m.t).toISOString()}\\n${m.content}`).join('\\n\\n');
    }
    store.close();
    let gitDiff = '';
    try {
      const { execFileSync } = await import('node:child_process');
      gitDiff = execFileSync('git', ['diff', 'HEAD'], { cwd: runtime.cwd, encoding: 'utf8' });
    } catch { gitDiff = '(git diff unavailable)'; }
    const lines = [
      `# Mochi Diagnostic Bundle`,
      ``,
      `- Version: ${VERSION}`,
      `- Exports: ${new Date().toISOString()}`,
      `- Provider: ${runtime.config.model.provider} / ${runtime.config.model.model}`,
      `- Usage: ${runtime.usage.summary()}`,
      ``,
      `## Latest session`,
      transcript || '(none)',
      ``,
      `## Git diff`,
      '```diff',
      gitDiff.slice(0, 20000),
      '```',
      ``,
      `## Doctor`,
      JSON.stringify(await (await import('./doctor.js')).doctorReport({
        version: VERSION,
        probeProvider: false,
        provider: runtime.config.model.provider,
        baseUrl: runtime.config.model.baseUrl ?? '',
        model: runtime.config.model.model,
        apiKey: (runtime.config.model as { apiKey?: string }).apiKey ?? null,
        workspaceDir: runtime.cwd,
      }), null, 2),
    ];
    const { writeFileSync } = await import('node:fs');
    writeFileSync(resolve(runtime.cwd, out), lines.join('\n'));
    console.log(`Wrote bundle to ${resolve(runtime.cwd, out)}`);
    return;
  }
  if (first === 'watch') {
    // Tight edit→test feedback loop: watch files, run the repo's check command
    // on every change, report pass/fail. Core in ./watch.js (unit-tested with
    // injected transport); this stays a thin adapter with a real runner.
    const { loadWatchConfig, watchCheckCommand, runWatch } = await import('./watch.js');
    const cfg = loadWatchConfig(runtime.cwd);
    const cmdFlag = typeof flags.cmd === 'string' && flags.cmd ? flags.cmd : null;
    const dirs = positional.slice(1).filter((a) => !a.startsWith('-'));
    if (dirs.length) cfg.paths = dirs.map((d) => resolve(runtime.cwd, d));
    if (cmdFlag) cfg.testCommand = cmdFlag;
    const cmd = watchCheckCommand(cfg);
    if (!cmd) {
      console.error('No test/build/typecheck command detected (and none given via --cmd).');
      process.exit(1);
    }
    console.log(`👁️  Mochi watch: running \`${cmd}\` on every change under ${cfg.paths.join(', ')} (Ctrl+C to stop).`);
    const ctl = new AbortController();
    process.once('SIGINT', () => ctl.abort());
    const { runShellString } = await import('./exec.js');
    const summary = await runWatch(cfg, {
      onLog: (line: string) => console.log(line),
      signal: ctl.signal,
      runCheck: async (c: string) => {
        try {
          const r = await runShellString(c, { cwd: runtime.cwd, timeoutMs: 120_000, maxOutput: 64 * 1024 });
          const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
          return { ok: r.code === 0, exitCode: r.code ?? -1, output: out };
        } catch (e) {
          return { ok: false, exitCode: -1, output: e instanceof Error ? e.message : String(e) };
        }
      },
    });
    console.log(`Watch stopped (${summary.runs} runs, ${summary.passed} passed, ${summary.failed} failed).`);
    return;
  }
  if (first === 'serve') {
    // Foreground JSON API for CI/external tooling (localhost only).
    // Same routes + bearer auth as the daemon; thin adapter over ./serve.js.
    const rawPort = typeof flags.port === 'string' ? Number(flags.port) : 0;
    const port = Number.isFinite(rawPort) && rawPort >= 0 && rawPort <= 65535 ? Math.floor(rawPort) : 0;
    const token = typeof flags.token === 'string' && flags.token ? flags.token : undefined;
    const host = typeof flags.host === 'string' && flags.host ? flags.host : '127.0.0.1';
    const { runServe } = await import('./serve.js');
    console.log(`Starting Mochi API server${port ? ` on :${port}` : ''} (bind ${host})…`);
    const ctl = new AbortController();
    process.once('SIGINT', () => ctl.abort());
    process.once('SIGTERM', () => ctl.abort());
    const summary = await runServe({
      cwd: runtime.cwd,
      port,
      token,
      host,
      onLog: (line: string) => console.log(line),
      signal: ctl.signal,
    });
    console.log(`API server stopped (was :${summary.port}).`);
    return;
  }
  if (first === 'init') {
    const { existsSync, writeFileSync, mkdirSync } = await import('node:fs');
    const templateRaw = positional[1] ?? 'basic';
    const template = templateRaw.toLowerCase();
    const initMd = resolve(cwd, 'MOCHI.md');
    if (!existsSync(initMd)) {
      writeFileSync(initMd, '# MOCHI.md\n\nProject instructions for the Mochi coding agent.\n');
    }
    if (template === 'basic' || template === 'bare') {
      console.log('Initialized MOCHI.md. Pass a template: `mochi init node|python|ts<|constrain|>rust` for a working scaffold.');
      return;
    }
    const scaffolds: Record<string, { files: Record<string, string>; next: string }> = {
      node: { files: {
        'package.json': JSON.stringify({ name: 'mochi-project', version: '0.1.0', type: 'module', scripts: { test: 'node --test', start: 'node index.js' } }, null, 2) + '\n',
        'index.js': '// Mochi-generated starter\nexport function main() { console.log(\"hello, mochi\"); }\nif (import.meta.url === `file://${process.argv[1]}`) main();\n',
        'index.test.js': "import test from 'node:test';\nimport { main } from './index.js';\ntest('main', () => { /* sanity */ });\n",
        '.gitignore': 'node_modules\n dist\n.env\n',
      }, next: 'npm install && npm test' },
      ts: { files: {
        'package.json': JSON.stringify({ name: 'mochi-project', version: '0.1.0', scripts: { test: 'tsc --noEmit', dev: 'tsx index.ts', start: 'node index.js' }, devDependencies: { typescript: '^5.7.0', '@types/node': '^22.0.0' } }, null, 2) + '\n',
        'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, types: ['node'], allowImportingTsExtensions: true }, include: ['*.ts'] }, null, 2) + '\n',
        'index.ts': 'export function greet(name: string): string { return `hello, ${name}`; }\n',
        'index.test.ts': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from './index.ts';\ntest('greet', () => assert.equal(greet('mochi'), 'hello, mochi'));\n",
        '.gitignore': 'node_modules\n dist\n.env\n',
      }, next: 'npm install && npm test' },
      python: { files: {
        'pyproject.toml': '[project]\nname = "mochi-project"\nversion = "0.1.0"\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
        'main.py': 'def greet(name: str) -> str:\n    return f"hello, {name}"\n\nif __name__ == "__main__":\n    print(greet("mochi"))\n',
        'test_main.py': 'import unittest\nfrom main import greet\n\nclass TestMain(unittest.TestCase):\n    def test_greet(self):\n        self.assertEqual(greet("mochi"), "hello, mochi")\n\nif __name__ == "__main__":\n    unittest.main()\n',
        '.gitignore': '__pycache__\n.venv\n.env\n',
      }, next: 'python -m unittest (no extra deps)' },
    };
    const s = scaffolds[template];
    if (!s) { console.error(`Unknown template "${template}". Supported: node, ts, python, (basic).`); process.exit(1); }
    for (const [rel, content] of Object.entries(s.files)) {
      const full = resolve(cwd, rel);
      if (existsSync(full)) { console.log(`skip (exists): ${rel}`); continue; }
      if (rel.includes('/')) mkdirSync(resolve(full, '..'), { recursive: true });
      writeFileSync(full, content);
      console.log(`created ${rel}`);
    }
    console.log(`Next: ${s.next}`);
    return;
  }
  if (first === 'commit') {
    const { checkpoint } = await import('./repo/git.js');
    const cp = await checkpoint(cwd, positional.slice(1).join(' ') || 'mochi commit');
    console.log(`Committed ${cp.type} ${cp.ref}`);
    return;
  }
  if (first === 'usage') { console.log(runtime.usage.summary()); return; }
  if (first === 'known-good') { console.log(await runtime.recordGood()); return; }
  if (first === 'check') { console.log(await runtime.knownGood()); return; }
  if (first === 'termix') {
    // "Split this session into N split windows." No external app, no extra
    // process, no auto-launch: all panes are in-process agent sessions on the
    // same configured provider. The user chooses how many splits, then whether
    // they communicate over a shared channel or stay separate.
    const { termix } = await import('./tui/termix.js');
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
    const { SessionStore } = await import('./state/session-store.js');
    // GoalEngine persists sessions under the PROJECT ROOT (.mochi/sessions.sqlite);
    // workspace.dir is already that root's .mochi subdir. Use the same key the
    // engine does or the CLI reads an empty sibling DB and sessions never list.
    const { findProjectRoot } = await loadRepoModule();
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

  // mochi selfheal — run one automatic repair pass against the highest-priority
  // open harness issue (Mochi repairs itself). Works even when the run happened
  // elsewhere because issues persist in `.mochi/reports/harness-issues.json`.
  if (first === 'selfheal') {
    const { listHarnessIssues, resolveHarnessIssue, buildRepairPrompt } = await import('./core/harness-issues.js');
    const all = listHarnessIssues(runtime.workspace.dir).sort((a, b) => b.count - a.count);
    const open = all.filter((i) => i.status === 'open');
    const showResolved = Boolean(flags.resolved);
    // --resolve <sig>: mark an issue resolved without spawning a repair agent.
    // Use it when the operator knows the entry is stale (e.g. an old workspace
    // remigrated a 2024 read-on-dir EISDIR signature) or when the failure was
    // task-specific and not actually a harness defect. Idempotent.
    const resolveArg = typeof flags.resolve === 'string' ? flags.resolve : undefined;
    if (resolveArg) {
      const match = all.find((i) => i.signature.startsWith(resolveArg));
      if (!match) { console.error(`No harness issue with signature prefix "${resolveArg}".`); process.exitCode = 1; return; }
      const ok = resolveHarnessIssue(runtime.workspace.dir, match.signature);
      console.log(`${ok ? 'Resolved' : 'No-op'}: ${match.signature} (${match.kind} x${match.count}) — ${match.title}`);
      return;
    }
    if (flags.list || flags.status || flags.summary || showResolved) {
      const visible = showResolved ? all : open;
      if (visible.length === 0) {
        console.log(showResolved ? 'No harness issues (open or resolved).' : 'No open harness issues.');
      } else {
        console.log(`${showResolved ? 'All' : 'Open'} harness issues (${visible.length}):`);
        for (const i of visible) {
          // Show when the issue was last seen AND last repaired at — the
          // 24h auto-repair cooldown (REPAIR_COOLDOWN_MS) gates auto-spawn
          // on `lastRepairAt`, so an operator triaging the ledger needs to
          // see both ages to decide whether to retry manually.
          const lastSeenAgo = formatAgeAgo(i.lastSeen);
          const lastRepairAgo = i.lastRepairAt ? formatAgeAgo(i.lastRepairAt) : 'never';
          console.log(`  ${i.signature}  ${i.kind} x${i.count}  [${i.status}]  last-seen=${lastSeenAgo}  last-repair=${lastRepairAgo}  ${i.title}`);
        }
      }
      return;
    }
    if (open.length === 0) { console.log('No open harness issues. Nothing to do.'); return; }
    const target = positional[1]
      ? (open.find((i) => i.signature.startsWith(positional[1]!)) ?? open[0])
      : open[0];
    console.log(`Running self-repair for ${target!.signature} (${target!.kind}, seen ${target!.count}x)...`);
    const summary = await runtime.runPrompt(buildRepairPrompt(target!), { sessionId: runtime.activeSessionId });
    console.log(summary);
    return;
  }

  if (first === 'gate') {
    const { handleGateCommand } = await import('./evals/gate-cli.js');
    await handleGateCommand({ positional, flags, cwd });
    return;
  }

  if (first === 'sleeptime') {
    const { handleSleeptimeCommand } = await import('./sleeptime/cli.js');
    await handleSleeptimeCommand({ positional, flags, cwd });
    return;
  }

  if (first === 'health') {
    const { handleHealthCommand } = await import('./health/cli.js');
    await handleHealthCommand({ positional, flags, cwd });
    return;
  }

  if (first === 'tools') {
    const { handleToolsCommand } = await import('./tools/forge-cli.js');
    await handleToolsCommand({ positional, flags, cwd });
    return;
  }

  if (first === 'forge-agents') {
    const { handleForgeAgentsCommand } = await import('./agent/agent-forge-cli.js');
    await handleForgeAgentsCommand({ positional, flags, cwd });
    return;
  }

  if (first === 'trace') {
    const { readTrace, formatTrace } = await import('./observability/trace.js');
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
      if (flags['export-trajectory']) {
        const { exportTrajectory } = await import('./observability/trajectory.js');
        const exported = exportTrajectory(runtime.workspace.dir, gid);
        if (!exported) { console.log(`No trace for ${gid}.`); continue; }
        const outcomeLabel = exported.record.outcome.stopReason ?? (exported.record.outcome.completed ? 'completed' : 'incomplete');
        console.log(`Trajectory exported: ${exported.path} (${exported.record.steps.length} steps, outcome: ${outcomeLabel})`);
        continue;
      }
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
      process.env.MOCHI_NARRATIVE_SUMMARY = '0';
      let streamedAny = false;
      let streamedThinking = false;
      const off = runtime.events.onAll((event: import('./types.js').MochiEvent) => {
        if (flags.json) return;
        if (event.type === 'agent:reasoning' && typeof event.content === 'string') {
          if (!streamedThinking) {
            process.stderr.write('\x1b[2m[thinking] ');
            streamedThinking = true;
          }
          process.stderr.write(event.content);
        } else if (event.type === 'message:chunk' && typeof event.content === 'string') {
          if (streamedThinking) {
            process.stderr.write('\x1b[0m\n\n');
            streamedThinking = false;
          }
          process.stdout.write(event.content);
          streamedAny = true;
        }
      });
      let detailed;
      try {
        detailed = await runtime.runPromptDetailed(prompt);
      } finally {
        off();
        if (streamedThinking) process.stderr.write('\x1b[0m\n\n');
      }
      if (flags.json) {
        console.log(JSON.stringify(detailed, null, 2));
      } else {
        if (!streamedAny) {
          console.log(detailed.summary);
        } else {
          process.stdout.write('\n');
        }
        if (detailed.filesModified && detailed.filesModified.length > 0) {
          console.log('\nFiles modified:');
          for (const f of detailed.filesModified) {
            console.log(`  • ${f}`);
          }
        }
      }
      // Exit code reflects the real outcome (CI can branch on it):
      // 0 = task completed, 1 = task failed/aborted.
      const code = detailed.success ? 0 : 1;
      // Non-interactive one-shot: exit explicitly once stdout has flushed.
      // runPrompt can leave handles alive (event bus, recorder, model keep-alive)
      // that would keep the process running forever even after work is done,
      // so don't rely on the event loop draining on its own.
      process.stdout.write('\n', () => process.exit(code));
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
