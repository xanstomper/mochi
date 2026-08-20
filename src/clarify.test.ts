// clarify.ts: multi-choice interactive clarification resolution.
import { describe, it, expect } from 'vitest';
import { resolveChoice, renderMenu, askUserChoice, type ClarifyQuestion, type Choice } from './clarify.js';

const q: ClarifyQuestion = {
  title: 'Which auth strategy?',
  choices: [
    { id: 'jwt', label: 'JWT Bearer Tokens', recommended: true, hint: 'refresh rotation' },
    { id: 'session', label: 'Stateful Redis Sessions' },
    { id: 'oauth', label: 'OAuth2 / OpenID Connect' },
  ],
  defaultValue: 'jwt',
};

describe('renderMenu', () => {
  it('renders a numbered menu with recommended marker', () => {
    const out = renderMenu(q);
    expect(out).toContain('Which auth strategy?');
    expect(out).toContain('[1] JWT Bearer Tokens (recommended)');
    expect(out).toContain('[3] OAuth2 / OpenID Connect');
  });
});

describe('resolveChoice', () => {
  it('accepts a numeric index', () => {
    expect(resolveChoice(q, '2').choice?.id).toBe('session');
  });
  it('accepts a choice id', () => {
    expect(resolveChoice(q, 'oauth').choice?.id).toBe('oauth');
  });
  it('accepts a label prefix', () => {
    expect(resolveChoice(q, 'jwt').choice?.id).toBe('jwt');
    expect(resolveChoice(q, 'stateful').choice?.id).toBe('session');
  });
  it('falls back to the default on empty input', () => {
    const out = resolveChoice(q, '');
    expect(out.choice?.id).toBe('jwt');
    expect(out.usedDefault).toBe(true);
  });
  it('falls back to the first choice when no default given and input unmatched', () => {
    const noDefault: ClarifyQuestion = { title: 'x', choices: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }] };
    expect(resolveChoice(noDefault, 'zzz').choice?.id).toBe('a');
    expect(resolveChoice(noDefault, null).choice?.id).toBe('a');
  });
});

describe('askUserChoice', () => {
  it('drives an injected renderer and resolves the answer', async () => {
    let rendered = '';
    const out = await askUserChoice(q, {
      render: (qq) => { rendered = qq.title; return rendered; },
      receive: async () => '3',
    });
    expect(rendered).toBe('Which auth strategy?');
    expect(out.choice?.id).toBe('oauth');
  });
});