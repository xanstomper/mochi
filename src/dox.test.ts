// dox.ts: documentation index + ADR generator (spec section 4).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { indexDocs, queryDocs, nextAdrNumber, generateAdr } from './dox.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'mochi-dox-'));
  mkdirSync(resolve(dir, 'docs', 'architecture'), { recursive: true });
  mkdirSync(resolve(dir, 'docs', 'adr'), { recursive: true });
  writeFileSync(resolve(dir, 'docs', 'architecture', 'auth.md'), '# Authentication\n\nWe use JWT bearer tokens with refresh rotation for the API routes.\n\nThe auth service validates signatures and enforces a 15 minute expiry.\n');
  writeFileSync(resolve(dir, 'docs', 'architecture', 'db.md'), '# Database\n\nThe repository uses PostgreSQL for primary storage.\n');
  writeFileSync(resolve(dir, 'docs', 'architecture', 'specs.txt'), 'Ignored because .txt is included.\n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('indexDocs / queryDocs', () => {
  it('indexes md files into chunks with titles', () => {
    const chunks = indexDocs(resolve(dir, 'docs'), 500);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const auth = chunks.find((c) => c.title === 'Authentication') ?? chunks.find((c) => c.file.includes('auth'));
    // the file starts with '# ' so title should be captured
    expect(auth?.file).toContain('auth.md');
  });

  it('ranks a semantic query to the right file', () => {
    const hits = queryDocs(resolve(dir, 'docs'), 'JWT refresh');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].file).toContain('auth.md');
  });
});

describe('ADR generation', () => {
  it('numbers ADRs sequentially and writes structured files', () => {
    const adrDir = resolve(dir, 'docs', 'adr');
    writeFileSync(resolve(adrDir, '001-first.md'), '# 1. First\n');
    expect(nextAdrNumber(adrDir)).toBe(2);
    const rel = generateAdr(dir, {
      title: 'Use Postgres for primary storage',
      status: 'accepted',
      context: 'We need a transactional store for user data.',
      decision: 'Adopt PostgreSQL 16 with the community driver.',
      tradeoffs: ['MySQL (weaker JSON support)', 'MongoDB (no joins)'],
      consequences: 'Adds a DB migration step to deploy.',
    });
    expect(rel).toMatch(/docs\/adr\/002-use-postgres-for-primary-storage\.md/);
    const body = readFileSync(resolve(dir, rel), 'utf8');
    expect(body).toMatch(/# 2\. Use Postgres for primary storage/);
    expect(body).toContain('Status: accepted');
    expect(body).toContain('Adopt PostgreSQL 16');
    expect(body).toContain('MySQL');
  });
});