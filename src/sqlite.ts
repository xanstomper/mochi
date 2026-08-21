// SQLite driver adapter: prefer node:sqlite (Node >= 22.5), fall back to
// bun:sqlite in bun-compiled binaries. bun lacks node:sqlite but ships
// bun:sqlite with a compatible Database surface: exec/prepare where
// statements expose get/all/run (bun names the class `Database`). This keeps
// sessions, the code graph, and FTS search alive in dist/mochi-bin instead
// of silently degrading to MISS.

export interface Stmt {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

export interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
  close(): void;
}

type DbCtor = new (path: string) => SqliteDb;
export type SqliteSource = '' | 'node:sqlite' | 'bun:sqlite';

let theCtor: DbCtor | null = null;
let theSource: SqliteSource = '';

async function detect(): Promise<{ ctor: DbCtor | null; source: SqliteSource }> {
  // 1) node:sqlite (Node >= 22.5). Static import specifier so bundlers keep
  //    it external; wrapped so a missing builtin just rejects.
  try {
    const mod = (await import('node:sqlite')) as { DatabaseSync?: DbCtor };
    if (mod.DatabaseSync) {
      const probe = new mod.DatabaseSync(':memory:');
      probe.exec('SELECT 1');
      probe.close?.();
      return { ctor: mod.DatabaseSync, source: 'node:sqlite' };
    }
  } catch {
    // fall through
  }
  // 2) bun:sqlite (bun runtime + compiled binary). Export is `Database`.
  try {
    // @ts-ignore - bun:sqlite only exists under bun; unknown to tsc
    const mod = (await import('bun:sqlite')) as { Database?: DbCtor; DatabaseSync?: DbCtor };
    const Ctor = mod.DatabaseSync ?? mod.Database;
    if (Ctor) {
      const probe = new Ctor(':memory:');
      probe.exec('SELECT 1');
      probe.close?.();
      return { ctor: Ctor, source: 'bun:sqlite' };
    }
  } catch {
    // fall through
  }
  return { ctor: null, source: '' };
}

let ready: Promise<void> | null = null;

function ensureReady(): Promise<void> {
  if (!ready) {
    ready = detect().then(({ ctor, source }) => {
      theCtor = ctor;
      theSource = source;
    });
  }
  return ready;
}

// Kick off detection eagerly so the common case resolves before first use.
void ensureReady();

export async function sqliteDriverAsync(): Promise<DbCtor | null> {
  await ensureReady();
  return theCtor;
}

// Sync detection cache. Tried in order at first sync use (not just module
// load): node:sqlite via createRequire (plain node + vitest), then a flag set
// by the async bun detector.
import { createRequire } from 'node:module';
process.removeAllListeners?.('warning');

let syncProbed = false;

function syncProbe(): void {
  if (syncProbed || theCtor) return;
  syncProbed = true;
  try {
    const req = createRequire(import.meta.url);
    const mod = req('node:sqlite') as { DatabaseSync?: DbCtor } & { Database?: DbCtor };
    const Ctor = mod.DatabaseSync ?? mod.Database;
    if (Ctor) {
      const probe = new Ctor(':memory:');
      probe.exec('SELECT 1');
      probe.close?.();
      theCtor = Ctor;
      theSource = 'node:sqlite';
    }
  } catch {
    // not under plain node; async detection handles bun
  }
}

export function sqliteSource(): SqliteSource {
  syncProbe();
  return theSource;
}

/** Sync probe: true when a driver is usable. The result is cached: driver
 *  availability is fixed for the process lifetime, and re-opening a probe
 *  database per call made the check itself flaky under load (many open DBs
 *  from parallel codegraph tests made the probe throw → false negatives). */
let cachedAvailable: boolean | null = null;

export function hasSqlite(): boolean {
  if (cachedAvailable !== null) return cachedAvailable;
  syncProbe();
  if (!theCtor) {
   
    cachedAvailable = false;
    return false;
  }
  try {
    const probe = new theCtor(':memory:');
    probe.exec('SELECT 1');
    probe.close?.();
    cachedAvailable = true;
  } catch {
    cachedAvailable = false;
  }
  return cachedAvailable;
}

/** Open a database file. Throws when no driver is available. Re-probes on a
 *  miss: under bundlers/vitest workers the module instance that gated a call
 *  may not be the one that ran detection, so a null ctor must retry instead
 *  of failing forever. */
export function openDb(path: string): SqliteDb {
  if (!theCtor) {
    syncProbed = false; // allow one retry
    syncProbe();
  }
  if (!theCtor) throw new Error('No SQLite driver available (need Node >= 22.5 or the bun binary)');
  return new theCtor(path);
}