// Explicit, checksum-verified download of the pinned chrome-headless-shell.
//
// This is NOT part of any tool call path: a 125MB download must never happen
// silently at first use. The user (or operator) runs
//   mochi browser fetch-cdp-shell
// and gets the pinned artifact from Google's chrome-for-testing bucket,
// sha256-verified against the hash recorded in manager.ts BEFORE anything is
// unpacked. Everything here is plain node: fetch + streaming hash + `unzip`
// (present on every Linux dev rig; absence is an honest error, not a
// dependency added to Mochi).

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { runArgv } from '../../exec.js';
import { PINNED_SHELL, cdpCacheRoot, type ResolvedBrowser } from './manager.js';

export interface FetchResult {
  path: string;
  version: string;
  bytes: number;
  sha256: string;
  alreadyInstalled: boolean;
}

function installDir(version: string): string {
  return join(cdpCacheRoot(), `chrome-headless-shell-${version}`);
}

export function installedShellPath(version = PINNED_SHELL.version): string | undefined {
  const bin = join(installDir(version), 'chrome-headless-shell-linux64', 'chrome-headless-shell');
  return existsSync(bin) ? bin : undefined;
}

/** Stream the artifact to disk while hashing — one pass, bounded RAM. */
async function downloadAndHash(url: string, dest: string, onProgress?: (received: number) => void): Promise<{ bytes: number; sha256: string }> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  }
  const hash = createHash('sha256');
  let bytes = 0;
  let lastReport = 0;
  const source = Readable.fromWeb(res.body as never);
  source.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    hash.update(chunk);
    if (onProgress && bytes - lastReport >= 10 * 1024 * 1024) {
      lastReport = bytes;
      onProgress(bytes);
    }
  });
  await pipeline(source, createWriteStream(dest));
  return { bytes, sha256: hash.digest('hex') };
}

/**
 * Download + verify + unpack the pinned chrome-headless-shell. Idempotent:
 * an existing verified install is returned as-is unless `force` re-fetches.
 */
export async function fetchCdpHeadlessShell(opts: { force?: boolean; onProgress?: (received: number) => void } = {}): Promise<FetchResult> {
  const { version, url, sha256: expectedSha } = PINNED_SHELL;
  const dir = installDir(version);
  const bin = join(dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
  const marker = join(dir, 'INSTALLATION_COMPLETE');

  if (!opts.force && existsSync(bin) && existsSync(marker)) {
    return { path: bin, version, bytes: statSync(bin).size, sha256: expectedSha, alreadyInstalled: true };
  }

  mkdirSync(join(cdpCacheRoot(), 'downloads'), { recursive: true });
  const zipPath = join(cdpCacheRoot(), 'downloads', `chrome-headless-shell-${version}.zip`);
  try {
    const { bytes, sha256 } = await downloadAndHash(url, zipPath, opts.onProgress);
    if (sha256 !== expectedSha) {
      rmSync(zipPath, { force: true });
      throw new Error(
        `checksum MISMATCH for chrome-headless-shell ${version}: got ${sha256}, expected ${expectedSha}. ` +
        'The download was deleted — do not use this artifact.',
      );
    }
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    // `unzip` is a system tool, not a dependency. Its absence is an honest
    // error: the verified zip stays on disk for manual unpacking.
    const unzipped = await runArgv('unzip', ['-oq', zipPath, '-d', dir], { timeoutMs: 120_000, killGraceMs: 2000 });
    if (unzipped.code !== 0) {
      throw new Error(`unzip failed (exit ${unzipped.code}): ${unzipped.stderr.slice(0, 300)}`);
    }
    if (!existsSync(bin)) {
      throw new Error(`unzip produced no chrome-headless-shell at ${bin}`);
    }
    chmodSync(bin, 0o755);
    writeFileSync(marker, JSON.stringify({ version, sha256, fetchedAt: new Date().toISOString() }, null, 2) + '\n');
    rmSync(zipPath, { force: true });
    return { path: bin, version, bytes, sha256, alreadyInstalled: false };
  } finally {
    // Leave the verified zip only when unpacking failed (manual recovery).
    if (existsSync(bin)) rmSync(zipPath, { force: true });
  }
}

/** Install the pinned shell (if missing) and resolve it — the CLI's
 *  fetch-cdp-shell command, and the escape hatch tooling can suggest. */
export async function ensurePinnedShellInstalled(): Promise<{ resolved: ResolvedBrowser; fetched: boolean; bytes: number }> {
  let fetched = false;
  let bytes = 0;
  if (!installedShellPath()) {
    const res = await fetchCdpHeadlessShell();
    fetched = !res.alreadyInstalled;
    bytes = res.bytes;
  }
  const path = installedShellPath();
  if (!path) throw new Error('pinned chrome-headless-shell install did not materialize');
  return { resolved: { path, source: 'cache', isHeadlessShell: true }, fetched, bytes };
}

/** Marker content readback (used by `mochi browser status`). */
export function shellInstallInfo(): { version: string; fetchedAt: string } | undefined {
  try {
    const marker = join(installDir(PINNED_SHELL.version), 'INSTALLATION_COMPLETE');
    if (!existsSync(marker)) return undefined;
    return JSON.parse(readFileSync(marker, 'utf8')) as { version: string; fetchedAt: string };
  } catch {
    return undefined;
  }
}
