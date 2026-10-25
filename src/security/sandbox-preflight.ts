// W3-5 sandbox preflight: at STARTUP, detect whether the shell sandbox will
// be degraded and say so PRECISELY ONCE (which backend, what's missing)
// instead of the run discovering it mid-task — or worse, never noticing.
//
// The capability probe itself lives in security/sandbox.ts
// (probeSandboxCapabilities — bwrap/unshare detection, cached per PATH).
// This module turns a probe + the configured mode into the one-line startup
// notice and guarantees the once-per-process semantics.
import { probeSandboxCapabilities, type SandboxCapabilities, type SandboxMode } from './sandbox.js';

/** Build the preflight notice for a configured sandbox mode, or null when
 *  there is nothing to announce:
 *  - mode 'off': the operator opted out — no notice.
 *  - forced 'bubblewrap'/'unshare' available: no notice.
 *  - forced mode MISSING: warn now (the wrap path also fails loudly at the
 *    first shell call; the preflight says it BEFORE the first task).
 *  - 'auto' (default) resolving to OS level: no notice.
 *  - 'auto' resolving to the SOFT jail: the degraded case the brief targets
 *    — name the backend that WILL run and precisely what's missing. */
export function buildSandboxPreflightNotice(
  mode: SandboxMode | undefined,
  caps: SandboxCapabilities = probeSandboxCapabilities(),
): string | null {
  const m: SandboxMode = mode ?? 'auto';
  if (m === 'off') return null;
  if (m === 'bubblewrap') {
    return caps.bubblewrap
      ? null
      : 'sandbox preflight: safety.sandbox = "bubblewrap" but `bwrap` was not found on PATH — sandboxed shell commands will FAIL. Install bubblewrap, or set safety.sandbox to "auto"/"off".';
  }
  if (m === 'unshare') {
    return caps.unshare
      ? null
      : 'sandbox preflight: safety.sandbox = "unshare" but `unshare` is unusable on this host (not on PATH, or unprivileged user namespaces are disabled) — sandboxed shell commands will FAIL. Use "auto" or "off".';
  }
  // auto (the default)
  if (caps.autoLevel === 'os') return null;
  const missing: string[] = [];
  if (!caps.bubblewrap) missing.push('bubblewrap (bwrap) not found on PATH');
  if (!caps.unshare) missing.push('unshare not found or unprivileged user namespaces disabled');
  return `sandbox preflight: no OS sandbox backend on this host (${missing.join('; ')}) — shell commands run in the SOFT jail only (env scrub + cwd clamp), which is NOT OS confinement. Install bubblewrap or util-linux unshare for OS-level sandboxing.`;
}

let announcedOnce = false;

/** Print the preflight notice (stderr) at startup — precisely ONCE per
 *  process, even when called from several entry points. Returns whether a
 *  notice was printed (false = nothing degraded, or already announced).
 *  `capsOverride` exists for tests (the real probe is host-dependent). */
export function maybeSandboxPreflightNotice(
  config: { safety?: { sandbox?: SandboxMode } } | undefined,
  print: (line: string) => void = (line) => console.error(line),
  capsOverride?: SandboxCapabilities,
): boolean {
  if (announcedOnce) return false;
  announcedOnce = true;
  const notice = buildSandboxPreflightNotice(config?.safety?.sandbox, capsOverride);
  if (!notice) return false;
  print(notice);
  return true;
}

/** Test hook: clear the once-per-process guard. */
export function _resetSandboxPreflightForTests(): void {
  announcedOnce = false;
}
