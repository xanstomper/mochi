// MCH-66: output-archive + recall_output tool tests.
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveToolOutput, recallArchivedOutput, listArchivedOutputs, archivedOutputCount, clearArchivedOutputs } from './tools/output-archive.js';
import { recallOutputTool } from './tools/recall-output.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mochi-archive-'));
  mkdirSync(join(dir, '.mochi'), { recursive: true });
});

afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('archive skips short outputs', () => {
  expect(archiveToolOutput(dir, 'read', 'short')).toBe(null);
});

test('archive + recall round trip', () => {
  const big = 'x'.repeat(2000) + 'NEEDLE-XYZ';
  const id = archiveToolOutput(dir, 'shell', big);
  expect(id).not.toBe(null);
  const hit = recallArchivedOutput(dir, id!);
  expect(hit).not.toBe(null);
  expect(hit!.text.endsWith('NEEDLE-XYZ')).toBe(true);
  expect(hit!.tool).toBe('shell');
});

test('recall by id prefix', () => {
  const id = archiveToolOutput(dir, 'read', 'y'.repeat(1500));
  const hit = recallArchivedOutput(dir, id!.slice(0, 12));
  expect(hit).not.toBe(null);
});

test('list and count', () => {
  expect(archivedOutputCount(dir)).toBeGreaterThanOrEqual(2);
  const entries = listArchivedOutputs(dir, 20);
  expect(entries.length).toBeGreaterThanOrEqual(2);
});

test('ring buffer bounded', () => {
  clearArchivedOutputs(dir);
  for (let i = 0; i < 210; i++) archiveToolOutput(dir, 'tool' + i, 'z'.repeat(1000 + i));
  expect(archivedOutputCount(dir)).toBe(200);
});

test('recall_output tool get + list + miss', async () => {
  const ctx = { workspace: { dir } } as any;
  const id = archiveToolOutput(dir, 'shell', 'full-content-marker'.padEnd(1200, '.'));
  const got = await recallOutputTool.execute({ id }, ctx);
  expect(got).toContain('full-content-marker');
  const listed = await recallOutputTool.execute({ action: 'list' }, ctx);
  expect(listed).toContain('archived tool output');
  const miss = await recallOutputTool.execute({ id: 'nope-123' }, ctx);
  expect(miss).toContain('No archived output matching');
});
