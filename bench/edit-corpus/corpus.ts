#!/usr/bin/env tsx
// Edit-application fixture corpus — scores the `edit` tool black-box against
// a fixed set of drift/refusal/integrity scenarios.
//
// Usage:
//   ./node_modules/.bin/tsx bench/edit-corpus/corpus.ts --out results.json
//
// Each case seeds a file in a fresh temp dir, runs editTool.execute once,
// and classifies the outcome: 'applied' (returned success), 'refused'
// (threw, file unchanged), 'reverted' (threw AND file unchanged after a
// would-be write — for the baseline tool, a broken write classifies as
// 'applied' with fileChanged=true, which FAILS a 'reverted' expectation),
// 'written-broken' (returned success but the file no longer parses).
// A case passes when the classified outcome matches the expectation AND the
// content assertions hold. Run it before and after changing the edit tool
// and diff the two JSONs — that diff is the before/after proof.
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { writeFileSync as writeOut } from 'node:fs';
import { editTool } from '../../src/tools/edit.js';
import { validateFileSyntax } from '../../src/core/ast-guard.js';
import type { ToolContext } from '../../src/tools/types.js';

export interface CorpusCase {
  id: string;
  title: string;
  fileName: string;
  content: string;
  oldText: string;
  newText: string;
  expect: 'applied' | 'refused' | 'reverted';
  /** Final file must contain all of these (only checked when applied). */
  mustContain?: string[];
  /** Final file must contain none of these (only checked when applied). */
  mustNotContain?: string[];
  /** Exact final file content (only checked when applied). */
  finalEquals?: string;
}

function bigFileCase(): CorpusCase {
  // 3000-line file; a 40-line function around line 1500 whose middle line
  // drifted (renamed identifier). The legacy tolerant fuzzy stage silently
  // disables itself above 100k window*lines work units — a 40-line needle
  // over 3000 lines is ~118k, so the baseline has no path to apply this.
  const lines: string[] = [];
  for (let i = 0; i < 1480; i++) lines.push(`export const filler${i} = ${i};`);
  const fn: string[] = ['export function targetPipeline(input: number[]): number {'];
  for (let i = 0; i < 38; i++) fn.push(`  const step${i} = input[${i}] ?? 0;`);
  fn.push('  const total = step0 + step37;');
  fn.push('  return total;');
  fn.push('}');
  lines.push(...fn);
  for (let i = 0; i < 1480; i++) lines.push(`export const tail${i} = ${i};`);
  const oldFn = [...fn];
  oldFn[39] = '  const total = step0 + stepLast;'; // model remembers the old name
  return {
    id: 'big-file-beyond-tolerant-bound',
    title: '3000-line file, 40-line block, one drifted line (tolerant stage work-bound)',
    fileName: 'big.ts',
    content: lines.join('\n') + '\n',
    oldText: oldFn.join('\n'),
    newText: oldFn.join('\n').replace('stepLast', 'step37').replace('const total', 'const total: number'),
    expect: 'applied',
    mustContain: ['const total: number = step0 + step37;'],
    mustNotContain: ['stepLast'],
  };
}

export const CASES: CorpusCase[] = [
  {
    id: 'exact-basic',
    title: 'Clean exact match',
    fileName: 'a.ts',
    content: 'export const a = 1;\nexport const b = 2;\n',
    oldText: 'a = 1',
    newText: 'a = 42',
    expect: 'applied',
    mustContain: ['a = 42'],
  },
  {
    id: 'exact-dollar-patterns',
    title: 'newText containing $$ / $& replacement patterns stays verbatim',
    fileName: 'a.ts',
    content: 'const shell = "PID";\n',
    oldText: 'const shell = "PID";',
    newText: 'const shell = "$$:$&";',
    expect: 'applied',
    finalEquals: 'const shell = "$$:$&";\n',
  },
  {
    id: 'whitespace-indent-drift',
    title: 'Model re-indented the block',
    fileName: 'a.ts',
    content: 'function x() {\n    return 1;\n}\n',
    oldText: '  function x() {\n    return 1;\n  }',
    newText: 'function x() {\n  return 2;\n}',
    expect: 'applied',
    mustContain: ['return 2;'],
  },
  {
    id: 'tabs-vs-spaces',
    title: 'File uses tabs, model sent spaces',
    fileName: 'a.ts',
    content: 'if (ready) {\n\tstart();\n}\n',
    oldText: 'if (ready) {\n    start();\n}',
    newText: 'if (ready) {\n    startNow();\n}',
    expect: 'applied',
    mustContain: ['startNow();'],
  },
  {
    id: 'trailing-whitespace',
    title: 'File lines carry trailing spaces',
    fileName: 'a.ts',
    content: 'const a = 1;   \nconst b = 2;\t \n',
    oldText: 'const a = 1;\nconst b = 2;',
    newText: 'const a = 10;\nconst b = 20;',
    expect: 'applied',
    mustContain: ['const a = 10;', 'const b = 20;'],
  },
  {
    id: 'quote-style-drift',
    title: 'Single vs double quotes across a block',
    fileName: 'a.ts',
    content: 'const msg = "hello world";\nconst val = 100;\n',
    oldText: "const msg = 'hello world';\nconst val = 100;",
    newText: 'const msg = "goodbye world";\nconst val = 200;',
    expect: 'applied',
    mustContain: ['goodbye world', 'val = 200'],
  },
  {
    id: 'semicolon-drift',
    title: 'Model omitted trailing semicolons',
    fileName: 'a.ts',
    content: 'const msg = "hello world";\nconst val = 100;\n',
    oldText: "const msg = 'hello world'\nconst val = 100",
    newText: 'const msg = "goodbye world";\nconst val = 200;',
    expect: 'applied',
    mustContain: ['goodbye world'],
  },
  {
    id: 'stale-lines-in-block',
    title: 'Two middle lines rewritten since the model read the file; anchors intact',
    fileName: 'checkout.ts',
    content: [
      'export function checkout(cart: Cart): number {',
      '  const subtotal = cart.items.reduce(sumPrices, 0);',
      '  const total = applyDiscount(subtotal, cart.coupon);',
      '  return chargeCard(total, cart.payment);',
      '}',
      '',
    ].join('\n'),
    oldText: [
      'export function checkout(cart: Cart): number {',
      '  const subtotal = price * qty;',
      '  const total = subtotal - discount;',
      '  return chargeCard(total, cart.payment);',
      '}',
    ].join('\n'),
    newText: [
      'export function checkout(cart: Cart): number {',
      '  const subtotal = cart.items.reduce(sumPrices, 0);',
      '  const total = applyDiscount(subtotal, cart.coupon);',
      '  return chargeCard(total, cart.payment, { idempotent: true });',
      '}',
    ].join('\n'),
    expect: 'applied',
    mustContain: ['idempotent: true'],
    mustNotContain: ['price * qty'],
  },
  {
    id: 'inserted-line-drift',
    title: 'A log line was inserted inside the block since the model read it',
    fileName: 'checkout.ts',
    content: [
      'export function checkout(cart: Cart): number {',
      '  const subtotal = cart.items.reduce(sumPrices, 0);',
      "  log('checkout', cart.id);",
      '  const total = applyDiscount(subtotal, cart.coupon);',
      '  return chargeCard(total, cart.payment);',
      '}',
      '',
    ].join('\n'),
    oldText: [
      'export function checkout(cart: Cart): number {',
      '  const subtotal = cart.items.reduce(sumPrices, 0);',
      '  const total = applyDiscount(subtotal, cart.coupon);',
      '  return chargeCard(total, cart.payment);',
      '}',
    ].join('\n'),
    newText: [
      'export function checkout(cart: Cart): number {',
      '  const subtotal = cart.items.reduce(sumPrices, 0);',
      '  const total = applyDiscount(subtotal, cart.coupon);',
      '  return chargeCard(total, cart.payment, { idempotent: true });',
      '}',
    ].join('\n'),
    expect: 'applied',
    mustContain: ['idempotent: true'],
  },
  {
    id: 'deleted-line-drift',
    title: 'The model remembers a line the file no longer has',
    fileName: 'checkout.ts',
    content: [
      'export function checkout(cart: Cart): number {',
      '  const total = applyDiscount(subtotal, cart.coupon);',
      '  return chargeCard(total, cart.payment);',
      '}',
      '',
    ].join('\n'),
    oldText: [
      'export function checkout(cart: Cart): number {',
      '  const subtotal = cart.items.reduce(sumPrices, 0);',
      '  const total = applyDiscount(subtotal, cart.coupon);',
      '  return chargeCard(total, cart.payment);',
      '}',
    ].join('\n'),
    newText: [
      'export function checkout(cart: Cart): number {',
      '  const total = applyDiscount(subtotal, cart.coupon);',
      '  return chargeCard(total, cart.payment, { idempotent: true });',
      '}',
    ].join('\n'),
    expect: 'applied',
    mustContain: ['idempotent: true'],
  },
  {
    id: 'duplicated-snippet-refuse',
    title: 'oldText occurs twice verbatim — must refuse, never guess',
    fileName: 'a.ts',
    content: 'const v = 1;\nconst v = 2;\n',
    oldText: 'const v =',
    newText: 'const w =',
    expect: 'refused',
  },
  {
    id: 'duplicated-block-exact-wins',
    title: 'One copy matches exactly, the other only after normalization — exact site wins',
    fileName: 'a.ts',
    content: [
      'function first() {',
      '    return computeAlpha();',
      '}',
      'function second() {',
      '  return computeAlpha();',
      '}',
      '',
    ].join('\n'),
    oldText: 'function second() {\n  return computeAlpha();\n}',
    newText: 'function second() {\n  return computeBeta();\n}',
    expect: 'applied',
    mustContain: ['computeBeta();'],
    finalEquals: [
      'function first() {',
      '    return computeAlpha();',
      '}',
      'function second() {',
      '  return computeBeta();',
      '}',
      '',
    ].join('\n'),
  },
  {
    id: 'similar-wrong-site-refuse',
    title: 'Two similar functions; sent block is a garbled mix of both — must refuse',
    fileName: 'pricing.ts',
    content: [
      'export function priceRetail(item: Item): number {',
      '  const base = item.cost * 1.4;',
      '  const taxed = base * TAX_RATE;',
      '  return round2(taxed);',
      '}',
      'export function priceWholesale(item: Item): number {',
      '  const base = item.cost * 1.15;',
      '  const taxed = base * TAX_RATE;',
      '  return round2(taxed);',
      '}',
      '',
    ].join('\n'),
    oldText: [
      'export function priceWholesale(item: Item): number {',
      '  const base = item.cost * 1.4;',
      '  const taxed = base * TAX_RATE;',
      '  return round2(applyMemberDiscount(taxed));',
      '}',
    ].join('\n'),
    newText: [
      'export function priceWholesale(item: Item): number {',
      '  const base = item.cost * 1.15;',
      '  const taxed = base * TAX_RATE;',
      '  return round2(applyMemberDiscount(taxed));',
      '}',
    ].join('\n'),
    expect: 'refused',
  },
  {
    id: 'crlf-file',
    title: 'CRLF file, LF oldText',
    fileName: 'a.ts',
    content: 'export const a = 1;\r\nexport const b = 2;\r\n',
    oldText: 'export const a = 1;\nexport const b = 2;',
    newText: 'export const a = 10;\nexport const b = 20;',
    expect: 'applied',
    mustContain: ['a = 10', 'b = 20'],
  },
  {
    id: 'unicode-content',
    title: 'Unicode identifiers/emoji with whitespace drift',
    fileName: 'a.ts',
    content: 'const greet = (名前: string) => `こんにちは ${名前} 🎉`;\n  const x = 1;\n',
    oldText: 'const greet = (名前: string) => `こんにちは ${名前} 🎉`;\nconst x = 1;',
    newText: 'const greet = (名前: string) => `こんにちは ${名前} 🎉`;\nconst x = 2;',
    expect: 'applied',
    mustContain: ['const x = 2;'],
  },
  {
    id: 'gutter-copy',
    title: 'oldText pasted from read output with line-number gutters',
    fileName: 'main.py',
    content: 'import os\nimport sys\n\ndef main():\n    print("hello")\n',
    oldText: '   4 | def main():\n   5 |     print("hello")',
    newText: '   4 | def main():\n   5 |     print("world")',
    expect: 'applied',
    mustContain: ['print("world")'],
  },
  {
    id: 'syntax-break-revert',
    title: 'Edit drops a closing brace — broken code must not stay on disk',
    fileName: 'a.ts',
    content: 'export function ok(): number {\n  return 1;\n}\n',
    oldText: 'export function ok(): number {\n  return 1;\n}',
    newText: 'export function ok(): number {\n  return 2;',
    expect: 'reverted',
  },
  {
    id: 'syntax-break-preexisting',
    title: 'File already broken elsewhere; clean unrelated edit must still apply',
    fileName: 'a.ts',
    content: 'export function broken(: number {\n  return 1;\n}\nexport const target = 1;\n',
    oldText: 'export const target = 1;',
    newText: 'export const target = 2;',
    expect: 'applied',
    mustContain: ['target = 2'],
  },
  {
    id: 'json-valid-edit',
    title: 'Valid JSON edit applies',
    fileName: 'cfg.json',
    content: '{\n  "name": "mochi",\n  "version": 1\n}\n',
    oldText: '"version": 1',
    newText: '"version": 2',
    expect: 'applied',
    mustContain: ['"version": 2'],
  },
  {
    id: 'json-break-revert',
    title: 'Edit that corrupts JSON must not stay on disk',
    fileName: 'cfg.json',
    content: '{\n  "name": "mochi",\n  "version": 1\n}\n',
    oldText: '"name": "mochi",\n  "version": 1\n}',
    newText: '"name": "mochi",\n  "version": 1',
    expect: 'reverted',
  },
  {
    id: 'python-indent-break-revert',
    title: 'Edit that breaks Python indentation must not stay on disk',
    fileName: 'main.py',
    content: 'def main():\n    print("hello")\n    return 0\n',
    oldText: 'def main():\n    print("hello")\n    return 0',
    newText: 'def main():\n  print("hello")\n    return 0',
    expect: 'reverted',
  },
  {
    id: 'not-found-honest',
    title: 'oldText simply absent — must refuse',
    fileName: 'a.ts',
    content: 'export const present = true;\n',
    oldText: 'export const absent = computeSomethingEntirelyDifferent();',
    newText: 'export const absent = 0;',
    expect: 'refused',
  },
  {
    id: 'no-change-edit',
    title: 'oldText === newText — must refuse as a no-op',
    fileName: 'a.ts',
    content: 'const a = 1;\n',
    oldText: 'const a = 1;',
    newText: 'const a = 1;',
    expect: 'refused',
  },
  bigFileCase(),
];

export interface CaseResult {
  id: string;
  title: string;
  expect: string;
  outcome: 'applied' | 'refused' | 'written-broken';
  fileChanged: boolean;
  pass: boolean;
  strategyHint: string | null;
  nearMissInMessage: boolean;
  message: string;
}

export async function runCorpus(): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const c of CASES) {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-edit-corpus-'));
    const events: unknown[] = [];
    const ctx = {
      cwd: dir,
      workspace: {} as never,
      config: {} as never,
      events: { emit: (e: unknown) => { events.push(e); } } as never,
      agentId: 'corpus',
    } as ToolContext;
    try {
      writeFileSync(resolve(dir, c.fileName), c.content);
      let message = '';
      let threw = false;
      try {
        message = String(await editTool.execute({ path: c.fileName, oldText: c.oldText, newText: c.newText }, ctx));
      } catch (err) {
        threw = true;
        message = err instanceof Error ? err.message : String(err);
      }
      const final = readFileSync(resolve(dir, c.fileName), 'utf8');
      const fileChanged = final !== c.content;
      let outcome: CaseResult['outcome'];
      if (threw) outcome = 'refused';
      else if (!validateFileSyntax(c.fileName, final).valid && validateFileSyntax(c.fileName, c.content).valid) outcome = 'written-broken';
      else outcome = 'applied';

      let pass = false;
      if (c.expect === 'applied') {
        pass = outcome === 'applied'
          && (c.finalEquals === undefined || final === c.finalEquals)
          && (c.mustContain ?? []).every((s) => final.includes(s))
          && (c.mustNotContain ?? []).every((s) => !final.includes(s));
      } else if (c.expect === 'refused') {
        pass = outcome === 'refused' && !fileChanged;
      } else if (c.expect === 'reverted') {
        pass = threw && !fileChanged;
      }
      const strat = /strategy: (\w+)/.exec(message)?.[1]
        ?? (message.includes('fuzzy match') ? 'fuzzy(legacy)' : outcome === 'applied' ? 'exact(legacy)' : null);
      results.push({
        id: c.id,
        title: c.title,
        expect: c.expect,
        outcome,
        fileChanged,
        pass,
        strategyHint: strat,
        nearMissInMessage: /closest|near.?miss|first difference|lines? \d+/i.test(message),
        message: message.slice(0, 400),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outIdx = process.argv.indexOf('--out');
  const results = await runCorpus();
  const passed = results.filter((r) => r.pass).length;
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}  expect=${r.expect} outcome=${r.outcome} strategy=${r.strategyHint ?? '-'}`);
  }
  console.log(`\n${passed}/${results.length} cases passed`);
  if (outIdx >= 0 && process.argv[outIdx + 1]) {
    writeOut(process.argv[outIdx + 1], JSON.stringify({ passed, total: results.length, results }, null, 2), 'utf8');
  }
  process.exit(passed === results.length ? 0 : 1);
}
