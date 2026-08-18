import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { RetrievalEngine } from './retrieval.js';

describe('RetrievalEngine', () => {
  it('finds definitions, references, and imports', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-retrieval-'));
    mkdirSync(resolve(dir, 'src'), { recursive: true });
    writeFileSync(resolve(dir, 'src/session.ts'), 'export interface SessionManager {}\nexport function validateSession() {}\n');
    writeFileSync(resolve(dir, 'src/middleware.ts'), 'import { SessionManager } from "./session.js";\nexport function auth() { return new SessionManager(); }\n');
    writeFileSync(resolve(dir, 'src/session.test.ts'), 'import { validateSession } from "./session.js";\nvalidateSession();\n');

    const engine = new RetrievalEngine(dir);
    const result = await engine.inspect('SessionManager');
    expect(result.files).toContain('src/session.ts');
    expect(result.symbols.map((s) => s.name)).toContain('SessionManager');
    expect(result.references.some((r) => r.file === 'src/middleware.ts')).toBe(true);
    expect(result.imports.some((i) => i.imports.some((imp) => imp.includes('session')))).toBe(true);
    expect(result.summary).toContain('SessionManager');
  });

  it('returns a minimal empty result for unrelated queries', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-retrieval-'));
    writeFileSync(resolve(dir, 'a.ts'), 'export const x = 1;\n');
    const engine = new RetrievalEngine(dir);
    const result = await engine.inspect('unrelated');
    expect(result.files).toEqual([]);
    expect(result.symbols).toEqual([]);
  });
});
