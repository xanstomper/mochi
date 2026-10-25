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
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { runArgv } from '../../exec.js';
import { PINNED_SHELL, PINNED_LIGHTPANDA, lightpandaAssetKey, cdpCacheRoot, type ResolvedBrowser, type LightpandaAssetKey } from './manager.js';

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
  return { resolved: { path, source: 'cache', isHeadlessShell: true, engine: 'chromium' }, fetched, bytes };
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

// ---------------------------------------------------------------------------
// Lightpanda (OPT-IN engine): same explicit-fetch discipline as the pinned
// shell. Raw binary (no zip), sha256-verified against the upstream GitHub
// release digest BEFORE it is moved into the cache install dir. Never called
// from a tool path: `mochi browser fetch-lightpanda` is the explicit step.

export interface LightpandaFetchResult {
  path: string;
  version: string;
  bytes: number;
  sha256: string;
  alreadyInstalled: boolean;
  asset: LightpandaAssetKey;
}

function lightpandaInstallDir(version: string): string {
  return join(cdpCacheRoot(), `lightpanda-${version}`);
}

export function installedLightpandaPath(version = PINNED_LIGHTPANDA.version): string | undefined {
  const bin = join(lightpandaInstallDir(version), 'lightpanda');
  return existsSync(bin) ? bin : undefined;
}

/**
 * Download + verify + install the pinned Lightpanda binary. Idempotent: an
 * existing verified install is returned as-is unless `force` re-fetches.
 */
export async function fetchLightpanda(opts: { force?: boolean; onProgress?: (received: number) => void } = {}): Promise<LightpandaFetchResult> {
  const asset = lightpandaAssetKey(); // throws on win32/unsupported with the gap named
  const { version } = PINNED_LIGHTPANDA;
  const { url, sha256: expectedSha } = PINNED_LIGHTPANDA.assets[asset];
  const dir = lightpandaInstallDir(version);
  const bin = join(dir, 'lightpanda');
  const marker = join(dir, 'INSTALLATION_COMPLETE');

  if (!opts.force && existsSync(bin) && existsSync(marker)) {
    return { path: bin, version, bytes: statSync(bin).size, sha256: expectedSha, alreadyInstalled: true, asset };
  }

  mkdirSync(join(cdpCacheRoot(), 'downloads'), { recursive: true });
  const dlPath = join(cdpCacheRoot(), 'downloads', `lightpanda-${version}-${asset}`);
  try {
    const { bytes, sha256 } = await downloadAndHash(url, dlPath, opts.onProgress);
    if (sha256 !== expectedSha) {
      rmSync(dlPath, { force: true });
      throw new Error(
        `checksum MISMATCH for lightpanda ${version} (${asset}): got ${sha256}, expected ${expectedSha}. ` +
        'The download was deleted — do not use this artifact.',
      );
    }
    // Verified only now: move it into place as the install.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    renameSync(dlPath, bin);
    chmodSync(bin, 0o755);
    writeFileSync(marker, JSON.stringify({ version, asset, sha256, fetchedAt: new Date().toISOString() }, null, 2) + '\n');
    return { path: bin, version, bytes, sha256, alreadyInstalled: false, asset };
  } finally {
    // A stale (unverified or unpacked) download never lingers once the
    // install exists; on failure the zip-equivalent stays for manual checks
    // only when the install did not materialize.
    if (existsSync(bin)) rmSync(dlPath, { force: true });
  }
}

/** Marker content readback for the Lightpanda install (status surface). */
export function lightpandaInstallInfo(): { version: string; asset: string; fetchedAt: string } | undefined {
  try {
    const marker = join(lightpandaInstallDir(PINNED_LIGHTPANDA.version), 'INSTALLATION_COMPLETE');
    if (!existsSync(marker)) return undefined;
    return JSON.parse(readFileSync(marker, 'utf8')) as { version: string; asset: string; fetchedAt: string };
  } catch {
    return undefined;
  }
}
