// Dynamic Host Environment Profiler for Mochi
// Performs an epistemic audit of available host runtimes, compilers,
// build systems, and formatters to prevent hallucinating nonexistent tools.

import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';

export interface ToolchainBinary {
  name: string;
  available: boolean;
  version?: string;
}

export interface HostEnvironmentProfile {
  runtimes: Record<string, ToolchainBinary>;
  buildTools: Record<string, ToolchainBinary>;
  linters: Record<string, ToolchainBinary>;
  availableRuntimes: string[];
  availableBuildTools: string[];
  availableLinters: string[];
  timestamp: number;
}

let cachedProfile: HostEnvironmentProfile | undefined;

function probeBinary(name: string, versionFlag = '--version'): ToolchainBinary {
  try {
    const res = spawnSync(name, [versionFlag], {
      encoding: 'utf8',
      timeout: 300,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.status === 0 && res.stdout) {
      const firstLine = res.stdout.trim().split('\n')[0].slice(0, 80);
      return { name, available: true, version: firstLine };
    }
    if (res.status === 0) {
      return { name, available: true };
    }
    return { name, available: false };
  } catch {
    return { name, available: false };
  }
}

const RUNTIME_CANDIDATES = [
  { name: 'node', flag: '-v' },
  { name: 'bun', flag: '-v' },
  { name: 'deno', flag: '-V' },
  { name: 'python3', flag: '--version' },
  { name: 'rustc', flag: '--version' },
  { name: 'cargo', flag: '--version' },
  { name: 'go', flag: 'version' },
  { name: 'zig', flag: 'version' },
  { name: 'docker', flag: '--version' },
  { name: 'git', flag: '--version' },
];

const BUILD_CANDIDATES = [
  { name: 'pnpm', flag: '-v' },
  { name: 'npm', flag: '-v' },
  { name: 'yarn', flag: '-v' },
  { name: 'make', flag: '--version' },
  { name: 'cmake', flag: '--version' },
  { name: 'gradle', flag: '--version' },
  { name: 'mvn', flag: '-v' },
];

const LINTER_CANDIDATES = [
  { name: 'tsc', flag: '--version' },
  { name: 'eslint', flag: '--version' },
  { name: 'prettier', flag: '--version' },
  { name: 'black', flag: '--version' },
  { name: 'ruff', flag: '--version' },
  { name: 'gofmt', flag: '-h' },
  { name: 'rustfmt', flag: '--version' },
  { name: 'biome', flag: '--version' },
];

/** Binaries whose version probe is slow (300ms+ cold spawn) — availability via
 *  the batched PATH scan is enough; skip the version spawn. */
const HEAVY_PROBE_NAMES = new Set(['pnpm', 'npm', 'yarn', 'gradle', 'mvn', 'tsc']);

/** In-process PATH lookup: true when `name` resolves the way the OS spawner
 *  would (exact executable on POSIX, PATHEXT-aware on win32). Exported for
 *  tests; getHostEnvironmentProfile is the normal entry point. */
export function binaryOnPath(name: string, pathEnv = process.env.PATH ?? ''): boolean {
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    if (process.platform === 'win32') {
      // CreateProcess resolution: exact name plus PATHEXT extensions.
      const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
        .map((e) => e.trim()).filter(Boolean)
        .map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase());
      for (const ext of exts) {
        try {
          if (statSync(resolve(dir, name + ext)).isFile()) return true;
        } catch { /* not here */ }
      }
    } else {
      try {
        accessSync(resolve(dir, name), constants.X_OK);
        return true;
      } catch { /* not here */ }
    }
  }
  return false;
}

/** Probe and return the host environment profile (cached per session).
 *  MCH-112: a naive per-binary spawnSync scan costs ~2s on cold start (each
 *  MISSING binary burns ~300ms in a full PATH walk). Resolve availability with
 *  ONE in-process PATH scan first, then version-probe only the binaries that
 *  actually exist. Cuts first-prompt latency by ~2s.
 *
 *  Deliberately shell-free: the old `bash -c command -v` batch broke on
 *  Windows, where `bash` may resolve to git-bash (PATH conversion quirks) or
 *  the WSL launcher (a whole other OS's PATH) — the profiler then reported
 *  `node` missing on a box that runs node. A direct directory scan with
 *  delimiter + PATHEXT awareness is deterministic on every platform. */
export function getHostEnvironmentProfile(forceRefresh = false): HostEnvironmentProfile {
  if (cachedProfile && !forceRefresh) return cachedProfile;

  const all = [
    ...RUNTIME_CANDIDATES,
    ...BUILD_CANDIDATES,
    ...LINTER_CANDIDATES,
  ].map((c) => c.name);
  let present = new Set<string>();
  try {
    present = new Set(all.filter((n) => binaryOnPath(n)));
  } catch { /* fall through to per-binary probes */ }

  const runtimes: Record<string, ToolchainBinary> = {};
  for (const c of RUNTIME_CANDIDATES) {
    if (!present.size || present.has(c.name)) {
      const probe = probeBinary(c.name, c.flag);
      if (probe.available) runtimes[c.name] = probe;
      // P5 (cache stability): the PATH scan is deterministic; a version
      // spawn that times out under load must not REMOVE a binary the scan
      // found — the profile feeds the stable prompt prefix, and a binary
      // flapping in/out between runs is a guaranteed prefix-cache break.
      else if (present.has(c.name)) runtimes[c.name] = { name: c.name, available: true };
    }
  }

  const buildTools: Record<string, ToolchainBinary> = {};
  for (const c of BUILD_CANDIDATES) {
    // MCH-112: even PRESENT heavy JVM/npm-ecosystem binaries cost 300-400ms per
    // spawnSync (-v cold). Version detail is nice-to-have; availability is what
    // the prompt needs. Mark present-but-unprobed binaries as available without
    // a version string to keep cold-start fast.
    if (present.size && !present.has(c.name)) continue;
    if (HEAVY_PROBE_NAMES.has(c.name)) {
      buildTools[c.name] = { name: c.name, available: true };
      continue;
    }
    const probe = probeBinary(c.name, c.flag);
    if (probe.available) buildTools[c.name] = probe;
    // P5: same PATH-scan-wins rule as runtimes — probe timeout ≠ absent.
    else if (present.has(c.name)) buildTools[c.name] = { name: c.name, available: true };
  }

  const linters: Record<string, ToolchainBinary> = {};
  for (const c of LINTER_CANDIDATES) {
    if (!present.size || present.has(c.name)) {
      const probe = probeBinary(c.name, c.flag);
      if (probe.available) linters[c.name] = probe;
      // P5: same PATH-scan-wins rule as runtimes — probe timeout ≠ absent.
      else if (present.has(c.name)) linters[c.name] = { name: c.name, available: true };
    }
  }

  cachedProfile = {
    runtimes,
    buildTools,
    linters,
    availableRuntimes: Object.keys(runtimes),
    availableBuildTools: Object.keys(buildTools),
    availableLinters: Object.keys(linters),
    timestamp: Date.now(),
  };

  return cachedProfile;
}

/** Format a high-signal, compact environment summary for the system prompt */
export function formatEnvironmentBlock(profile?: HostEnvironmentProfile): string {
  const p = profile ?? getHostEnvironmentProfile();
  const parts: string[] = [];

  if (p.availableRuntimes.length > 0) {
    parts.push(`- **Runtimes**: ${p.availableRuntimes.join(', ')}`);
  }
  if (p.availableBuildTools.length > 0) {
    parts.push(`- **Build Systems**: ${p.availableBuildTools.join(', ')}`);
  }
  if (p.availableLinters.length > 0) {
    parts.push(`- **Linters/Formatters**: ${p.availableLinters.join(', ')}`);
  }

  return parts.length > 0
    ? `### Host Environment Capabilities\n${parts.join('\n')}`
    : '';
}

export function resetEnvironmentProfileCache(): void {
  cachedProfile = undefined;
}
