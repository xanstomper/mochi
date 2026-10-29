/**
 * P1 slice 2: the mid-run digest splice must not silently drop
 * mission-critical facts. verifyDigestText probes the digest against
 * facts extracted from the replaced slice and re-includes anything
 * missing, so the spliced digest always answers for the facts it
 * replaced.
 */
import { describe, expect, it } from 'vitest';
import { verifyDigestText } from './verified-compaction.js';

const OLD = [
  { role: 'user', content: 'Fix the login timeout bug in src/auth/login.ts. You must never modify the billing module.' },
  { role: 'assistant', content: 'Decision: cache the session token and retry the login request once on timeout.' },
  { role: 'assistant', content: 'Check failed: npm test. WRONG: login times out after 30 seconds instead of 5.' },
  { role: 'assistant', content: '', tool_calls: [{ function: { name: 'edit', arguments: '{"path":"src/auth/login.ts"}' } }] },
];

describe('digest fidelity', () => {
  it('a digest that drops facts gets them re-included verbatim', () => {
    const digest = 'Work in progress on the login timeout fix.';
    const r = verifyDigestText(OLD, digest);
    expect(r.facts.length).toBeGreaterThan(0);
    expect(r.initial.passed).toBe(false);
    expect(r.final.passed).toBe(true);
    expect(r.text).toContain('RETENTION RECOVERY');
    expect(r.escalations).toEqual(['re-include']);
  });

  it('a digest that keeps everything needs no recovery', () => {
    const digest = [
      'Fix the login timeout bug in src/auth/login.ts. You must never modify the billing module.',
      'Decision: cache the session token and retry the login request once on timeout.',
      'Check failed: npm test. WRONG: login times out after 30 seconds instead of 5.',
    ].join('\n');
    const r = verifyDigestText(OLD, digest);
    expect(r.initial.passed).toBe(true);
    expect(r.text).toBe(digest);
    expect(r.escalations).toEqual([]);
  });

  it('an empty slice passes through unchanged', () => {
    const r = verifyDigestText([], 'nothing to replace');
    expect(r.text).toBe('nothing to replace');
    expect(r.facts).toEqual([]);
    expect(r.initial.passed).toBe(true);
  });
});
