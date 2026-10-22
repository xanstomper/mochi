// Code Mode spike: harness tests — the comparison must produce numbers for
// both modes on the same tasks, both modes must actually complete the work,
// and the protocol shapes (turns, token direction, control task) must hold.
import { describe, it, expect } from 'vitest';
import { approxTokens } from '../context.js';
import { ALL_TOOLS_MAP } from '../tools/index.js';
import { CODEMODE_TOOLS } from './interpreter.js';
import { renderCodeModeApiDoc, runComparison, serializeDirectSchemas } from './harness.js';

describe('code-mode API doc vs JSON schemas', () => {
  it('the API doc is smaller than the JSON schemas for the same tools', () => {
    const defs = CODEMODE_TOOLS.map((n) => ALL_TOOLS_MAP.get(n)!.def);
    const schemaTokens = approxTokens(serializeDirectSchemas(defs));
    const docTokens = approxTokens(renderCodeModeApiDoc(defs));
    expect(schemaTokens).toBeGreaterThan(0);
    expect(docTokens).toBeLessThan(schemaTokens);
  });
});

describe('code-mode comparison harness', () => {
  it('produces numbers for both modes; both complete every fixture task', async () => {
    const rows = await runComparison(undefined, 1);
    expect(rows.length).toBe(6);
    for (const row of rows) {
      expect(row.direct.ok, `${row.taskId} direct: ${row.direct.detail}`).toBe(true);
      expect(row.codemode.ok, `${row.taskId} codemode: ${row.codemode.detail}`).toBe(true);
      expect(row.direct.inputTokens).toBeGreaterThan(0);
      expect(row.codemode.inputTokens).toBeGreaterThan(0);
      // Code mode is always exactly 2 model turns in this protocol
      // (program turn + wrap-up turn), direct needs one turn per step plus
      // the wrap-up.
      expect(row.codemode.turns).toBe(2);
      expect(row.direct.turns).toBeGreaterThan(row.codemode.turns);
    }
    // Aggregate: code mode spends far fewer billed input tokens.
    const dIn = rows.reduce((s, r) => s + r.direct.inputTokens, 0);
    const cIn = rows.reduce((s, r) => s + r.codemode.inputTokens, 0);
    expect(cIn).toBeLessThan(dIn);
    // The wide-aggregate task trades MANY cheap local calls for round trips:
    // 62 bridge calls vs 3 direct calls, still 2 turns.
    const t5 = rows.find((r) => r.taskId === 't5')!;
    expect(t5.codemode.toolCalls).toBeGreaterThan(t5.direct.toolCalls * 10);
    expect(t5.totalTokenDeltaPct).toBeLessThan(-50);
    // Control task: the saving is smallest where there is least to save —
    // one round trip each way leaves mostly the schema-vs-doc delta.
    const t6 = rows.find((r) => r.taskId === 't6')!;
    expect(t6.totalTokenDeltaPct).toBeGreaterThan(t5.totalTokenDeltaPct);
  }, 180_000);
});
