import { describe, it, expect } from 'vitest';
import { buildDigestInput, lineSalience, type DigestMessageLike } from './digest-input.js';

// The legacy digest/checkpoint input builder, kept here as the regression
// oracle: per-message head slice (400 chars) + total head cut.
function legacyInput(messages: readonly DigestMessageLike[], budgetChars: number): string {
  return messages
    .map((m) => `${m.role}: ${(typeof m.content === 'string' ? m.content : '').slice(0, 400)}`)
    .join('\n')
    .slice(0, budgetChars);
}

const filler = (i: number): DigestMessageLike => ({
  role: 'tool',
  name: 'shell',
  content: `step ${i} ok\n${'routine output line, nothing notable here, moving on with the task at hand.\n'.repeat(6)}exit 0`,
});

function buriedHistory(): DigestMessageLike[] {
  const msgs: DigestMessageLike[] = [];
  for (let i = 0; i < 18; i++) msgs.push(filler(i));
  msgs.push({
    role: 'assistant',
    content: `${'Investigating the layout engine and its constraints in some depth before touching anything. '.repeat(8)}DECISION: we will use the Rust tokenizer for counting because the TS fallback diverged.`,
  });
  for (let i = 18; i < 34; i++) msgs.push(filler(i));
  msgs.push({
    role: 'tool',
    name: 'shell',
    content: `${'compiling module after module, all quiet so far, no diagnostics worth keeping.\n'.repeat(10)}src/parser.ts:142: error TS2345: Argument of type 'string' is not assignable to parameter of type 'Token'.\n${'trailing build noise continues for a while after the failure line above.\n'.repeat(4)}`,
  });
  for (let i = 34; i < 40; i++) msgs.push(filler(i));
  return msgs;
}

describe('buildDigestInput (salience-ranked digest input)', () => {
  it('keeps a buried decision and a buried error that the legacy builder loses', () => {
    const msgs = buriedHistory();
    const legacy = legacyInput(msgs, 12_000);
    // Oracle check: the legacy algorithm genuinely loses both facts on this
    // fixture — if this ever flips, the fixture stopped testing the gap.
    expect(legacy.includes('DECISION: we will use the Rust tokenizer')).toBe(false);
    expect(legacy.includes('error TS2345')).toBe(false);

    const out = buildDigestInput(msgs, 12_000);
    expect(out.includes('DECISION: we will use the Rust tokenizer')).toBe(true);
    expect(out.includes('error TS2345')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(12_000);
  });

  it('keeps salient lines from deep inside a single long message', () => {
    const long = {
      role: 'tool',
      name: 'shell',
      content: `${'x'.repeat(300)}\n${'noise line without signal\n'.repeat(40)}src/deep/file.ts:9: error TS2304: Cannot find name 'missingThing'.\n${'more noise\n'.repeat(10)}`,
    } as DigestMessageLike;
    const out = buildDigestInput([long], 2_000);
    expect(out).toContain("error TS2304: Cannot find name 'missingThing'");
    expect(out.length).toBeLessThanOrEqual(2_000);
  });

  it('preserves chronological order and represents every message', () => {
    const msgs: DigestMessageLike[] = [];
    for (let i = 0; i < 12; i++) {
      msgs.push({ role: i % 2 ? 'assistant' : 'user', content: `MARKER-${i} ${'padding text '.repeat(10)}` });
    }
    const out = buildDigestInput(msgs, 12_000);
    let last = -1;
    for (let i = 0; i < 12; i++) {
      const at = out.indexOf(`MARKER-${i}`);
      expect(at).toBeGreaterThan(last);
      last = at;
    }
  });

  it('respects a tiny budget with many messages', () => {
    const msgs = buriedHistory();
    const out = buildDigestInput(msgs, 600);
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out.length).toBeGreaterThan(0);
  });

  it('renders assistant tool calls so the summarizer sees actions, not just prose', () => {
    const msgs: DigestMessageLike[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'edit', arguments: '{"path":"src/parser.ts"}' } }],
      },
    ];
    const out = buildDigestInput(msgs, 2_000);
    expect(out).toContain('edit(');
    expect(out).toContain('src/parser.ts');
  });

  it('returns empty string for empty input', () => {
    expect(buildDigestInput([], 12_000)).toBe('');
    expect(buildDigestInput(buriedHistory(), 0)).toBe('');
  });
});

describe('lineSalience', () => {
  it('scores errors, decisions and paths above boilerplate', () => {
    expect(lineSalience('src/a/b.ts:1: error TS1005: bad')).toBeGreaterThan(0);
    expect(lineSalience('DECISION: use the port, not the fallback')).toBeGreaterThan(0);
    expect(lineSalience('routine output line, nothing notable')).toBe(0);
  });
});
