// MCH-49: repo-map tests. Real codegraph over a temp repo with real imports.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoMap, repoMapText, taskRepoMap, taskRepoMapText, TASK_REPO_MAP_MAX_CHARS } from './repo-map.js';
import { getFunctionSynapse, ensureLanguage } from './codegraph.js';

let dir = '';

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('repo-map (MCH-49)', () => {
  it('ranks a hub file above isolated files via real codegraph edges', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mochi-rm-'));
    // hub.ts defines the hub function; a/b/c each CALL it cross-file.
    writeFileSync(join(dir, 'hub.ts'), 'export function hub(): number { return 1; }\n');
    writeFileSync(join(dir, 'a.ts'), 'import { hub } from "./hub.js";\nexport function a() { return hub(); }\n');
    writeFileSync(join(dir, 'b.ts'), 'import { hub } from "./hub.js";\nexport function b() { return hub(); }\n');
    writeFileSync(join(dir, 'c.ts'), 'import { hub } from "./hub.js";\nexport function c() { return hub(); }\n');
    // Grammar must load before the tree-sitter indexer produces rows; any
    // codegraph query then builds/warms the in-memory index for cwd.
    await ensureLanguage('typescript');
    await getFunctionSynapse(dir, 'hub');

    const map = repoMap(dir);
    expect(map.length).toBeGreaterThan(0);
    const files = map.map((e) => e.file);
    // hub must appear in the map (direct or via rank flow)
    expect(files.some((f) => f.includes('hub.ts'))).toBe(true);
    const hubRank = map.find((e) => e.file.includes('hub.ts'))!.rank;
    const aRank = map.find((e) => e.file.includes('a.ts'))?.rank ?? -1;
    expect(hubRank).toBeGreaterThanOrEqual(aRank);
    // normalized: top rank is 1.0
    expect(map[0].rank).toBe(1);
  });

  it('degrades to empty gracefully without a valid index', () => {
    const empty = repoMap('/tmp/definitely-not-a-mochi-repo-' + Date.now());
    expect(Array.isArray(empty)).toBe(true);
  });

  it('repoMapText returns undefined for empty map, text for populated', () => {
    expect(repoMapText('/tmp/definitely-not-a-mochi-repo-' + Date.now())).toBeUndefined();
    if (dir) {
      const text = repoMapText(dir);
      expect(text).toContain('REPO MAP');
    }
  });
});

// P1.2: task-conditioned map. Fixture shape: src/core/engine.ts is the
// GLOBAL hub (three files call runEngine, so it wins global PageRank),
// while src/auth/session.ts is a low-traffic feature file (one caller).
// A session-auth task must rank the feature files above the hub.
describe('task-conditioned repo-map (P1.2)', () => {
  let dir2 = '';
  const TASK = 'Add expiry handling to session tokens in the auth session manager';

  afterAll(() => {
    if (dir2) rmSync(dir2, { recursive: true, force: true });
  });

  it('builds the hub-vs-feature fixture', async () => {
    const { mkdirSync } = await import('node:fs');
    dir2 = mkdtempSync(join(tmpdir(), 'mochi-rm-task-'));
    for (const sub of ['src/core', 'src/cli', 'src/daemon', 'src/auth', 'src/util']) {
      mkdirSync(join(dir2, sub), { recursive: true });
    }
    writeFileSync(join(dir2, 'src/core/engine.ts'),
      'export function runEngine(): number { return 42; }\nexport function engineStatus(): string { return "ok"; }\n');
    writeFileSync(join(dir2, 'src/cli/main.ts'),
      'import { runEngine } from "../core/engine.js";\nexport function main() { return runEngine(); }\n');
    writeFileSync(join(dir2, 'src/cli/help.ts'),
      'import { runEngine } from "../core/engine.js";\nexport function showHelp() { return runEngine(); }\n');
    writeFileSync(join(dir2, 'src/daemon/server.ts'),
      'import { runEngine } from "../core/engine.js";\nexport function startServer() { return runEngine(); }\n');
    writeFileSync(join(dir2, 'src/util/format.ts'),
      'export function formatDate(d: Date): string { return d.toISOString(); }\n');
    writeFileSync(join(dir2, 'src/auth/session.ts'), [
      'export class SessionManager {',
      '  createSessionToken(userId: string): string { return `tok-${userId}`; }',
      '}',
      'export function verifySessionToken(token: string): boolean { return token.length > 3; }',
      'export function sessionExpiry(token: string): number { return 3600; }',
      '',
    ].join('\n'));
    writeFileSync(join(dir2, 'src/auth/login.ts'),
      'import { SessionManager } from "./session.js";\nexport function loginUser(id: string) { const sm = new SessionManager(); return sm.createSessionToken(id); }\n');
    await ensureLanguage('typescript');
    await getFunctionSynapse(dir2, 'runEngine');
    expect(dir2).not.toBe('');
  });

  it('sanity: the global map ranks the hub first', () => {
    const global = repoMap(dir2);
    expect(global.length).toBeGreaterThan(0);
    expect(global[0].file).toContain('engine.ts');
  });

  it('ranks the task-relevant feature file above the global hub', () => {
    const entries = taskRepoMap(dir2, { task: TASK, kind: 'implement' });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].file).toContain('session.ts');
    const sessionIdx = entries.findIndex((e) => e.file.includes('session.ts'));
    const engineIdx = entries.findIndex((e) => e.file.includes('engine.ts'));
    expect(sessionIdx).toBeGreaterThanOrEqual(0);
    expect(engineIdx).toBeGreaterThan(sessionIdx);
    // normalized combined score: top entry is 1.0
    expect(entries[0].score).toBe(1);
    expect(entries[0].lexical).toBeGreaterThan(0);
  });

  it('neighbourhood boost lifts the feature caller above the hub', () => {
    const entries = taskRepoMap(dir2, { task: TASK, kind: 'implement' });
    const loginIdx = entries.findIndex((e) => e.file.includes('login.ts'));
    const engineIdx = entries.findIndex((e) => e.file.includes('engine.ts'));
    expect(loginIdx).toBeGreaterThanOrEqual(0);
    expect(engineIdx).toBeGreaterThan(loginIdx);
  });

  it('attaches symbol signatures from the codegraph', () => {
    const entries = taskRepoMap(dir2, { task: TASK, kind: 'implement' });
    const session = entries.find((e) => e.file.includes('session.ts'))!;
    expect(session.symbols.length).toBeGreaterThan(0);
    const names = session.symbols.map((s) => s.name);
    expect(names).toContain('SessionManager');
    for (const s of session.symbols) expect(s.signature.length).toBeGreaterThan(0);
    expect(session.symbols.some((s) => s.signature.includes('SessionManager'))).toBe(true);
    const text = taskRepoMapText(dir2, { task: TASK, kind: 'implement' })!;
    expect(text).toContain('task-conditioned');
    expect(text).toContain('SessionManager');
  });

  it('respects the hard char budget', () => {
    const text = taskRepoMapText(dir2, { task: TASK, maxChars: 300 })!;
    expect(text).toContain('REPO MAP');
    expect(text.length).toBeLessThanOrEqual(300);
    const full = taskRepoMapText(dir2, { task: TASK })!;
    expect(full.length).toBeLessThanOrEqual(TASK_REPO_MAP_MAX_CHARS);
  });

  it('falls back to the global ranking (with signatures) when the task has no usable terms', () => {
    const entries = taskRepoMap(dir2, { task: 'the a an of' });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].file).toContain('engine.ts');
    expect(entries[0].symbols.length).toBeGreaterThan(0);
    const text = taskRepoMapText(dir2, { task: 'the a an of' })!;
    expect(text).toContain('structural importance');
  });

  it('degrades to undefined with an empty/unavailable graph', () => {
    const nowhere = '/tmp/definitely-not-a-mochi-repo-' + Date.now();
    expect(taskRepoMap(nowhere, { task: TASK })).toEqual([]);
    expect(taskRepoMapText(nowhere, { task: TASK })).toBeUndefined();
  });
});
