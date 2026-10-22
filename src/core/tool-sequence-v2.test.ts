// D9: tool-sequence v2 store tests — enriched records (outcome, task kind,
// arg shapes, cost), backwards-compatible reader for v1 files, and
// outcome-aware pattern text.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadToolSeqs, saveToolSeq, loadToolSeqStore, saveToolSeqRecord,
  argShapeOf, toolPatternText, successfulRecords, type ToolSeqStoreV2,
} from './tool-sequence.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'mochi-tsv2-'));
  dirs.push(d);
  return d;
}
function writeStoreFile(dir: string, value: unknown): void {
  mkdirSync(join(dir, '.mochi'), { recursive: true });
  writeFileSync(join(dir, '.mochi', 'tool-seqs.json'), JSON.stringify(value));
}

describe('argShapeOf', () => {
  it('renders sorted keys + value types and never leaks values', () => {
    const shape = argShapeOf({ path: '/secret/place.ts', command: 'rm -rf everything' });
    expect(shape).toBe('{command:string,path:string}');
    expect(shape).not.toContain('secret');
    expect(shape).not.toContain('rm');
    expect(argShapeOf({ nested: { a: 1 }, list: [1, 2], n: 3, ok: true, nil: null }))
      .toBe('{list:array,n:number,nested:object,nil:null,ok:boolean}');
    expect(argShapeOf(null)).toBe('none');
    expect(argShapeOf('str')).toBe('string');
    expect(argShapeOf([1])).toBe('array');
    expect(argShapeOf({})).toBe('{}');
  });
});

describe('tool-sequence v2 store', () => {
  it('reads a v1 file ({seqs} only) with outcomes honestly unknown', () => {
    const dir = tempDir();
    writeStoreFile(dir, { seqs: [['read', 'grep', 'edit'], ['run', 'edit', 'run']] });
    const v2 = loadToolSeqStore(dir);
    expect(v2.version).toBe(2);
    expect(v2.seqs).toEqual([['read', 'grep', 'edit'], ['run', 'edit', 'run']]);
    expect(v2.records).toHaveLength(2);
    expect(v2.records.every((r) => r.outcome === 'unknown')).toBe(true);
    expect(loadToolSeqs(dir).seqs).toHaveLength(2); // legacy view intact
  });

  it('round-trips enriched records: outcome, verified, kind, cost, arg shapes', () => {
    const dir = tempDir();
    const store = loadToolSeqStore(dir);
    saveToolSeqRecord(dir, store, {
      tools: ['read', 'search', 'edit', 'shell'],
      outcome: 'success',
      verified: true,
      taskKind: 'fix',
      costUsd: 0.12,
      estimatedCostUsd: 0.01,
      argShapes: ['{path:string}', '{query:string}', '{path:string}', '{command:string}'],
      endedAt: 123,
    });
    saveToolSeqRecord(dir, store, { tools: ['read', 'edit', 'shell'], outcome: 'failure', verified: false, taskKind: 'fix' });
    const reloaded = loadToolSeqStore(dir);
    expect(reloaded.records).toHaveLength(2);
    expect(reloaded.records[0]).toMatchObject({
      outcome: 'success', verified: true, taskKind: 'fix', costUsd: 0.12, estimatedCostUsd: 0.01, endedAt: 123,
    });
    expect(reloaded.records[0].argShapes?.[3]).toBe('{command:string}');
    expect(reloaded.seqs[0]).toEqual(['read', 'search', 'edit', 'shell']); // legacy view follows records
    expect(successfulRecords(reloaded)).toHaveLength(1);
    expect(successfulRecords(reloaded, true)).toHaveLength(1);
    // On-disk format is explicitly versioned v2.
    const raw = JSON.parse(readFileSync(join(dir, '.mochi', 'tool-seqs.json'), 'utf8'));
    expect(raw.version).toBe(2);
    expect(Array.isArray(raw.records)).toBe(true);
  });

  it('a legacy saveToolSeq write does not downgrade or drop v2 records', () => {
    const dir = tempDir();
    const v2 = loadToolSeqStore(dir);
    saveToolSeqRecord(dir, v2, { tools: ['a', 'b', 'c'], outcome: 'success', verified: true, taskKind: 'test' });
    const legacy = loadToolSeqs(dir);
    saveToolSeq(dir, legacy, ['x', 'y', 'z']);
    const after = loadToolSeqStore(dir);
    expect(after.records.some((r) => r.verified === true && r.taskKind === 'test')).toBe(true);
    expect(after.seqs).toContainEqual(['x', 'y', 'z']);
  });

  it('toolPatternText filters to successful runs once outcomes exist', () => {
    const store: ToolSeqStoreV2 = {
      version: 2,
      seqs: [
        ['faila', 'failb', 'failc'], ['faila', 'failb', 'failc'],
        ['read', 'search', 'edit'], ['read', 'search', 'edit'], ['read', 'search', 'edit'],
      ],
      records: [
        { tools: ['faila', 'failb', 'failc'], outcome: 'failure' },
        { tools: ['faila', 'failb', 'failc'], outcome: 'failure' },
        { tools: ['read', 'search', 'edit'], outcome: 'success', verified: true },
        { tools: ['read', 'search', 'edit'], outcome: 'success', verified: true },
        { tools: ['read', 'search', 'edit'], outcome: 'success', verified: false },
      ],
    };
    const text = toolPatternText(store);
    expect(text).toContain('successful past tasks');
    expect(text).toContain('read -> search');
    expect(text).not.toContain('faila');
  });

  it('tolerates a corrupt v2 file like v1 did', () => {
    const dir = tempDir();
    writeStoreFile(dir, '{broken');
    expect(loadToolSeqStore(dir)).toEqual({ version: 2, seqs: [], records: [] });
  });
});
