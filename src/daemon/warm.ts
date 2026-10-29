// Warm daemon state (feat/warm-daemon): pre-loads at daemon start the pieces
// the cold-start survey + measurement show dominate time-to-first-token, and
// guarantees those preloaded pieces can never be served stale.
//
// Survey result (see ~/campaign/warm-daemon-report.md, measured on the
// reference machine against a fixture repo with a scripted fake provider):
//   - process boot + CLI ESM graph        ~39ms   (paid at daemon spawn)
//   - config load + workspace init        ~56ms   (paid by Runtime.create)
//   - goals/goal.js module graph + engine ~330ms  (lazy since P2 — preload)
//   - tools/index.js module graph         ~108ms  (lazy since P2 — preload)
//   - loadAllSkills parse (233 skills)    ~77-97ms per task (module cache)
//   - buildPacket first system prompt     ~392ms per task (re-reads disk)
// The first four are process-level and pre-payable at daemon start. The last
// two are re-executed per task BY CONSTRUCTION (fresh ContextEngine per task,
// fingerprint-checked reads), which is why a warm daemon cannot serve a stale
// repo map or stale skill block: context is rebuilt from disk for every task.
//
// Correctness contract (the invalidation rules):
//   - config change (global config file, project mochi.json / .mochi/config.json)
//       -> runtime.reloadConfig() + tools re-warm before the next task serves.
//   - skills change (project / bundled / user skill dirs)
//       -> skills parse cache invalidated by walked-tree fingerprint; preload
//          re-warmed. Per-task engines re-fingerprint regardless.
//   - repo change (git HEAD moved, index changed, working-tree status changed)
//       -> preload re-warmed. Nothing stale is retained: detectRepo and the
//          task context are re-read per task.
// The AUTHORITATIVE check runs at task submission (gate()): validate, and on
// any invalidation synchronously re-warm (or fall back to cold) BEFORE the
// task runs. File watchers and the idle poll only trigger opportunistic
// re-warms between tasks; they never gate correctness.
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { startupMark } from '../observability/startup-trace.js';
import type { Runtime } from '../runtime.js';

export type WarmState = 'off' | 'warming' | 'ready' | 'cold-fallback';

export interface WarmPhase { name: string; ms: number }

export interface WarmInvalidation {
  reason: string;
  detail: string;
  at: number;
  rewarmMs?: number;
}

export interface WarmSnapshot {
  /** .git/HEAD + resolved ref content (or 'none' outside a git repo). */
  head: string;
  /** size:mtime of .git/index (staging/checkouts) or 'none'. */
  index: string;
  /** sha1 of `git status --porcelain` (working-tree dirty set) or 'none'. */
  tree: string;
  /** size:mtime of every config file the runtime loaded from disk. */
  config: string;
  /** walked-tree fingerprint of every skill source dir. */
  skills: string;
}

export interface WarmStatus {
  enabled: boolean;
  state: WarmState;
  preloadedAt: number | null;
  preloadMs: number | null;
  phases: WarmPhase[];
  invalidations: WarmInvalidation[];
  rewarmCount: number;
  lastActivityAt: number;
  idleSec: number;
  rssBytes: number;
  idleCpuPct: number;
  uptimeSec: number;
  watcher: 'fswatch' | 'poll' | 'none';
}

/** Idle window: no /api activity for this long before a watcher/poll tick may
 *  trigger a background re-warm. Rewarms during a live task are deferred so a
 *  running goal is never disturbed; gate() re-checks before the next task. */
const WARM_IDLE_REWARM_MS = 60_000;

/** Default poll cadence for the CPU sampler / idle policy. All checks are
 *  cheap local file ops except one `git status --porcelain` per tick. */
const WARM_POLL_MS = 30_000;

/** Bounded walk fingerprint of a directory tree lives in src/skills/skills.ts
 *  (exported `walkFingerprint`) — the skills cache keys on it and the warm
 *  daemon's invalidation snapshot reuses the same function so both can never
 *  disagree about what "the skills set" is. */

function fileFp(path: string): string {
  if (!existsSync(path)) return 'none';
  try {
    const st = statSync(path);
    return `${st.size}:${st.mtimeMs}`;
  } catch { return 'none'; }
}

/** Resolve the git ref .git/HEAD points at WITHOUT spawning git: loose refs
 *  are read directly; packed refs fall back to the packed-refs line (any pack
 *  update changes it). Returns 'none' outside a git repo. */
function headFingerprint(cwd: string): string {
  const dotGit = resolve(cwd, '.git');
  if (!existsSync(dotGit)) return 'none';
  try {
    const headPath = resolve(dotGit, 'HEAD');
    if (!existsSync(headPath)) return 'none';
    const head = readFileSync(headPath, 'utf8').trim();
    if (!head.startsWith('ref: ')) return `detached:${head}`;
    const ref = head.slice(5);
    const refPath = resolve(dotGit, ref);
    if (existsSync(refPath)) return `${ref}:${readFileSync(refPath, 'utf8').trim()}`;
    const packed = resolve(dotGit, 'packed-refs');
    if (existsSync(packed)) {
      const hit = readFileSync(packed, 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`));
      if (hit) return `${ref}:${hit.split(' ')[0]}`;
    }
    return `${ref}:unborn`;
  } catch { return 'none'; }
}

async function gitTreeHash(cwd: string): Promise<string> {
  if (!existsSync(resolve(cwd, '.git'))) return 'none';
  return new Promise<string>((res) => {
    execFile('git', ['status', '--porcelain'], { cwd, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      res(err ? 'none' : stdout);
    });
  });
}

/** Every config file whose contents feed the daemon's Runtime.config. */
function configPaths(runtime: Runtime): string[] {
  return [
    process.env.MOCHI_CONFIG_PATH || resolve(runtime.config.configDir || '', 'config.json'),
    resolve(runtime.cwd, 'mochi.json'),
    resolve(runtime.cwd, '.mochi', 'config.json'),
    resolve(runtime.cwd, '.mcp.json'),
  ];
}

function snapshotConfig(runtime: Runtime): string {
  return configPaths(runtime).map((p) => fileFp(p)).join('|');
}

async function snapshotSkills(runtime: Runtime): Promise<string> {
  const dirs = [resolve(runtime.cwd, '.mochi', 'skills')];
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    dirs.push(resolve(home, '.mochi', 'skills'), resolve(home, '.hermes', 'skills'));
  }
  try {
    const { bundledSkillsDir, walkFingerprint } = await import('../skills/skills.js');
    const b = bundledSkillsDir();
    if (b) dirs.push(b);
    return dirs.map((d) => walkFingerprint(d)).join('|');
  } catch { /* bundled dir unresolved (src runs): project+user coverage stands */ }
  // Fingerprint with a local fallback only if the skills module itself failed
  // to load (it cannot fall back to 'none' — that would LOOK like an
  // invalidation-free snapshot).
  return 'unavailable';
}

async function snapshotTree(cwd: string): Promise<string> {
  return gitTreeHash(cwd);
}

/** A snapshot that can never reject: a thrown check reads as 'error', which
 *  the next diff treats as a change (one spurious re-warm beats a stale
 *  baseline that never invalidates). */
async function safeSnapshot(runtime: Runtime): Promise<WarmSnapshot> {
  try {
    return await snapshotNow(runtime);
  } catch {
    return { head: 'error', index: 'error', tree: 'error', config: 'error', skills: 'error' };
  }
}

async function snapshotNow(runtime: Runtime): Promise<WarmSnapshot> {
  return {
    head: headFingerprint(runtime.cwd),
    index: fileFp(resolve(runtime.cwd, '.git', 'index')),
    tree: await snapshotTree(runtime.cwd),
    config: snapshotConfig(runtime),
    skills: await snapshotSkills(runtime),
  };
}

function diffSnapshots(before: WarmSnapshot, after: WarmSnapshot, at: number): WarmInvalidation[] {
  const out: WarmInvalidation[] = [];
  if (before.head !== after.head) out.push({ reason: 'git-head-moved', detail: `${before.head.slice(0, 32)} -> ${after.head.slice(0, 32)}`, at });
  if (before.index !== after.index) out.push({ reason: 'git-index-changed', detail: `${before.index} -> ${after.index}`, at });
  if (before.tree !== after.tree) out.push({ reason: 'working-tree-changed', detail: `${before.tree.slice(0, 16)} -> ${after.tree.slice(0, 16)}`, at });
  if (before.config !== after.config) out.push({ reason: 'config-changed', detail: 'a loaded config file changed on disk', at });
  if (before.skills !== after.skills) out.push({ reason: 'skills-changed', detail: 'a skill source dir changed', at });
  return out;
}

export interface WarmHandle {
  status(): WarmStatus;
  /** Authoritative pre-task gate: validate + re-warm on invalidation. Never
   *  throws — on any internal error the task falls back to cold (fresh
   *  per-task reads) and the fallback is recorded. */
  gate(): Promise<void>;
  /** Opportunistic re-warm (watcher/poll tick). Deferred while busy. */
  maybeRewarm(): Promise<void>;
  touchActivity(): void;
  close(): void;
}

export async function startWarm(runtime: Runtime, opts?: { onIdleExit?: () => void }): Promise<WarmHandle> {
  const startedAt = Date.now();
  let state: WarmState = 'warming';
  let preloadedAt: number | null = null;
  let preloadMs: number | null = null;
  let phases: WarmPhase[] = [];
  const invalidations: WarmInvalidation[] = [];
  let rewarmCount = 0;
  let lastActivityAt = Date.now();
  let lastCpu = process.cpuUsage();
  let lastCpuAt = Date.now();
  let idleCpuPct = 0;
  let watcherKind: 'fswatch' | 'poll' = 'poll';
  let snap: WarmSnapshot | null = null;
  let preloadPromise: Promise<void>;
  let closed = false;

  const runPreload = async (): Promise<WarmPhase[]> => {
    const out: WarmPhase[] = [];
    const phase = async (name: string, fn: () => Promise<unknown> | unknown) => {
      const t = performance.now();
      await fn();
      out.push({ name, ms: Math.round((performance.now() - t) * 10) / 10 });
    };
    startupMark('warm:preload-start');
    await phase('goals-engine', () => runtime.ensureGoals());
    startupMark('warm:goals-engine');
    await phase('tools-registry', async () => {
      const { buildTools } = await import('../tools/index.js');
      buildTools(runtime.config);
    });
    startupMark('warm:tools-registry');
    await phase('skills', async () => {
      const { loadAllSkills } = await import('../skills/skills.js');
      loadAllSkills(runtime.cwd);
    });
    await phase('repo-info', async () => {
      const { detectRepo } = await import('../repo/repo.js');
      detectRepo(runtime.cwd);
    });
    // Run-helpers: the remaining lazy imports a task's first run touches
    // (trace recorder + task factory). Pre-loading them makes warm run #1
    // indistinguishable from warm run #2+ instead of carrying a one-time
    // in-daemon lazy tail.
    await phase('run-helpers', async () => {
      await import('../observability/trace.js');
      await import('../goals/task.js');
    });
    startupMark('warm:preload-done');
    return out;
  };

  const recordRewarm = (reasons: WarmInvalidation[], ms: number) => {
    preloadMs = ms;
    preloadedAt = Date.now();
    rewarmCount++;
    state = 'ready';
    for (const r of reasons) {
      r.rewarmMs = ms;
      invalidations.unshift(r);
    }
    if (invalidations.length > 20) invalidations.length = 20;
  };

  /** Re-run the preload phases after invalidation. Caller supplies the fresh
   *  snapshot and the reasons; config changes reload the runtime first. */
  const reRunPhases = async (reasons: WarmInvalidation[], after: WarmSnapshot, t0: number): Promise<void> => {
    try {
      if (reasons.some((r) => r.reason === 'config-changed')) {
        runtime.reloadConfig();
      }
      phases = await runPreload();
      // Baseline first, THEN ready — same invariant as the initial preload.
      snap = after;
      recordRewarm(reasons, Math.round(performance.now() - t0));
    } catch (err) {
      // Never take the daemon down over warm bookkeeping: fall back to cold.
      // Tasks still run correctly — context is rebuilt from disk per task.
      state = 'cold-fallback';
      invalidations.unshift({
        reason: 'rewarm-failed',
        detail: String((err as Error)?.message ?? err).slice(0, 200),
        at: Date.now(),
        rewarmMs: Math.round(performance.now() - t0),
      });
      snap = after;
    }
  };

  preloadPromise = (async () => {
    const t = performance.now();
    try {
      phases = await runPreload();
      preloadMs = Math.round(performance.now() - t);
      preloadedAt = Date.now();
    } catch (err) {
      state = 'cold-fallback';
      invalidations.unshift({ reason: 'preload-failed', detail: String((err as Error)?.message ?? err).slice(0, 200), at: Date.now() });
    }
    // The snapshot must be captured BEFORE the state can report ready: a
    // 'ready' state means "the baseline is current". Changes landing after
    // this point are seen as diffs by gate()/maybeRewarm().
    snap = await safeSnapshot(runtime);
    if (state === 'warming') state = 'ready';
  })();

  const busy = () => Date.now() - lastActivityAt < WARM_IDLE_REWARM_MS;

  // Proactive re-warm trigger #1: fs.watch on the project root (recursive).
  // Events only flip a trigger — the actual validate+rewarm runs debounced and
  // idle-gated. On watcher failure (ENOSPC on huge trees, unsupported fs) we
  // fall back to the poll tick below; correctness never depends on either
  // because gate() validates at task submission.
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let fw: FSWatcher | null = null;
  try {
    fw = watch(runtime.cwd, { recursive: true }, () => {
      if (closed || debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        if (closed) return;
        if (busy()) return; // defer — gate() handles it before the next task
        void handle.maybeRewarm();
      }, 500);
    });
    watcherKind = 'fswatch';
  } catch {
    watcherKind = 'poll';
  }

  // Trigger #2 (poll tick): CPU sampler + optional idle exit + proactive
  // re-warm when the watcher is unavailable or missed something.
  const poll = setInterval(() => {
    if (closed) return;
    const cpu = process.cpuUsage();
    const wall = Date.now() - lastCpuAt;
    if (wall > 0) {
      idleCpuPct = Math.round((((cpu.user - lastCpu.user) + (cpu.system - lastCpu.system)) / (wall * 1000)) * 1000) / 10;
    }
    lastCpu = cpu;
    lastCpuAt = Date.now();
    const idleExitMs = Number(process.env.MOCHI_WARM_IDLE_EXIT_MS);
    if (idleExitMs > 0 && Date.now() - lastActivityAt >= idleExitMs) {
      opts?.onIdleExit?.();
      return;
    }
    if (!busy()) void handle.maybeRewarm();
  }, WARM_POLL_MS);
  poll.unref?.();

  const handle: WarmHandle = {
    status(): WarmStatus {
      return {
        enabled: true,
        state,
        preloadedAt,
        preloadMs,
        phases,
        invalidations: invalidations.slice(0, 20),
        rewarmCount,
        lastActivityAt,
        idleSec: Math.round((Date.now() - lastActivityAt) / 1000),
        rssBytes: process.memoryUsage().rss,
        idleCpuPct,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        watcher: watcherKind,
      };
    },
    async gate(): Promise<void> {
      if (closed) return;
      lastActivityAt = Date.now();
      try {
        await preloadPromise;
        if (closed || state === 'cold-fallback') return;
        const after = await snapshotNow(runtime);
        const reasons = snap ? diffSnapshots(snap, after, Date.now()) : [];
        if (!reasons.length) return;
        await reRunPhases(reasons, after, performance.now());
      } catch (err) {
        // Never block a task on warm bookkeeping: fall back to cold. Tasks
        // still run correctly (context is rebuilt from disk per task).
        state = 'cold-fallback';
        invalidations.unshift({ reason: 'gate-failed', detail: String((err as Error)?.message ?? err).slice(0, 200), at: Date.now() });
      }
    },
    async maybeRewarm(): Promise<void> {
      if (closed) return;
      await preloadPromise;
      if (closed) return;
      const after = await snapshotNow(runtime);
      const reasons = snap ? diffSnapshots(snap, after, Date.now()) : [];
      if (!reasons.length) return;
      await reRunPhases(reasons, after, performance.now());
    },
    touchActivity(): void {
      lastActivityAt = Date.now();
    },
    close(): void {
      closed = true;
      if (debounce) clearTimeout(debounce);
      try { fw?.close(); } catch { /* already closed */ }
      clearInterval(poll);
    },
  };
  return handle;
}

/** Build a no-op warm handle (warm mode disabled) so callers can gate
 *  unconditionally. */
export function noWarm(): WarmHandle {
  return {
    status: () => ({
      enabled: false, state: 'off', preloadedAt: null, preloadMs: null, phases: [],
      invalidations: [], rewarmCount: 0, lastActivityAt: Date.now(), idleSec: 0,
      rssBytes: process.memoryUsage().rss, idleCpuPct: 0, uptimeSec: 0, watcher: 'none',
    }),
    gate: async () => {},
    maybeRewarm: async () => {},
    touchActivity: () => {},
    close: () => {},
  };
}
