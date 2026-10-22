// Hygiene: feedback entries persist a raw slice of an assistant answer (and
// free-text reasons) to ~/.mochi/feedback.jsonl, which is later injected
// into prompts. Secrets must be redacted at the write path — same posture
// as session-store transcripts and traces. Mirrors feedback.test.ts's
// HOME-override pattern; the secret is built by concatenation so no literal
// secret-shaped string exists in this file.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const home = mkdtempSync(resolve(tmpdir(), 'mochi-feedback-redact-home-'));
const priorHome = process.env.HOME;
const priorProfile = process.env.USERPROFILE;
process.env.HOME = home;
process.env.USERPROFILE = home;
const feedbackFile = resolve(home, '.mochi', 'feedback.jsonl');
const fb = await import('./feedback.js');

afterAll(() => {
  process.env.HOME = priorHome;
  if (priorProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = priorProfile;
  rmSync(home, { recursive: true, force: true });
});

const SECRET = 'sk-ant-' + 'api03-' + 'A'.repeat(20);

describe('feedback write-path redaction', () => {
  it('(f) stores secret-shaped snippets and reasons redacted', () => {
    fb.recordFeedback({
      ts: Date.now(), session: 's-redact', turn: 0, verdict: 'bad',
      snippet: `Here is your key: ${SECRET} — do not share it`,
      reason: `leaked ${SECRET} in the answer`,
    });
    const onDisk = readFileSync(feedbackFile, 'utf8');
    expect(onDisk).not.toContain(SECRET);
    expect(onDisk).toContain('[secret-redacted]');
    const entries = fb.loadAllFeedback().filter((e) => e.session === 's-redact');
    expect(entries).toHaveLength(1);
    expect(entries[0].snippet).toContain('[secret-redacted]');
    expect(entries[0].snippet).not.toContain(SECRET);
    expect(entries[0].reason).toContain('[secret-redacted]');
    // The prompt-injected digest must not carry the secret either.
    expect(fb.feedbackDigest()).not.toContain(SECRET);
  });

  it('leaves ordinary snippets untouched', () => {
    fb.recordFeedback({
      ts: Date.now(), session: 's-plain', turn: 1, verdict: 'good',
      snippet: 'Fixed the parser and added a regression test.',
    });
    const entries = fb.loadAllFeedback().filter((e) => e.session === 's-plain');
    expect(entries[0].snippet).toBe('Fixed the parser and added a regression test.');
  });
});
