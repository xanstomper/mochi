// B24 user-correction capture: a correction-shaped mid-task steer must
// become a structured, redacted, promotable lesson candidate — not just
// transcript text. Mirrors feedback-redact.test.ts's HOME-override pattern;
// the secret is built by concatenation so no literal secret exists here.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const home = mkdtempSync(resolve(tmpdir(), 'mochi-corrections-home-'));
const priorHome = process.env.HOME;
const priorProfile = process.env.USERPROFILE;
process.env.HOME = home;
process.env.USERPROFILE = home;
const correctionsPath = resolve(home, '.mochi', 'corrections.jsonl');
const corr = await import('./corrections.js');
const { loadLessons } = await import('../lessons.js');

afterAll(() => {
  process.env.HOME = priorHome;
  if (priorProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = priorProfile;
  rmSync(home, { recursive: true, force: true });
});

const SECRET = 'sk-ant-' + 'api03-' + 'B'.repeat(20);

describe('detectCorrection', () => {
  it('splits "don\'t use sed — use the edit tool instead"', () => {
    const d = corr.detectCorrection("no, don't use sed — use the edit tool instead");
    expect(d).not.toBeNull();
    expect(d!.whatTheyWanted.toLowerCase()).toContain('edit tool');
    expect(d!.signature.startsWith("don't use")).toBe(true);
  });

  it('"use X instead of Y" puts X in wanted and Y in wrong', () => {
    const d = corr.detectCorrection('use the edit tool instead of sed');
    expect(d).not.toBeNull();
    expect(d!.whatTheyWanted.toLowerCase()).toContain('edit tool');
    expect(d!.whatWasWrong.toLowerCase()).toBe('sed');
  });

  it('"that\'s wrong, actually …" splits at the pivot', () => {
    const d = corr.detectCorrection("that's wrong, actually run the tests before committing");
    expect(d).not.toBeNull();
    expect(d!.whatWasWrong.toLowerCase()).toContain('wrong');
    expect(d!.whatTheyWanted.toLowerCase()).toContain('run the tests');
  });

  it('plain guidance and status messages are NOT corrections', () => {
    expect(corr.detectCorrection("also add a README when you're done")).toBeNull();
    expect(corr.detectCorrection('the tests live in the tests folder')).toBeNull();
    expect(corr.detectCorrection('looks good, keep going')).toBeNull();
    expect(corr.detectCorrection('')).toBeNull();
  });
});

describe('captureCorrection', () => {
  it('a simulated correction produces a structured, redacted record', () => {
    const rec = corr.captureCorrection(`no, don't print my key ${SECRET} in the logs — write it to the vault instead`, { session: 's-corr' });
    expect(rec).not.toBeNull();
    expect(rec!.session).toBe('s-corr');
    expect(rec!.whatTheyWanted.length).toBeGreaterThan(0);
    const onDisk = readFileSync(correctionsPath, 'utf8');
    expect(onDisk).not.toContain(SECRET);
    expect(onDisk).toContain('[secret-redacted]');
    const loaded = corr.loadCorrections().filter((r) => r.session === 's-corr');
    expect(loaded).toHaveLength(1);
    expect(loaded[0].whatTheyWanted).not.toContain(SECRET);
  });

  it('a non-correction writes nothing', () => {
    const before = existsSync(correctionsPath) ? readFileSync(correctionsPath, 'utf8') : '';
    expect(corr.captureCorrection('please also update the changelog', { session: 's-corr' })).toBeNull();
    const after = readFileSync(correctionsPath, 'utf8');
    expect(after).toBe(before);
  });
});

describe('promotion to lessons', () => {
  it('promotes into the workspace lessons store once (dedupe on re-promote)', () => {
    const ws = mkdtempSync(resolve(tmpdir(), 'mochi-corrections-ws-'));
    try {
      const rec = corr.captureCorrection("don't use sed — use the edit tool instead", { session: 's-promo' });
      expect(rec).not.toBeNull();
      corr.promoteCorrectionToLesson(ws, rec!);
      corr.promoteCorrectionToLesson(ws, rec!);
      const lessons = loadLessons(ws).filter((l) => l.kind === 'user-correction');
      expect(lessons).toHaveLength(1);
      expect(lessons[0].lesson).toContain('User correction:');
      expect(lessons[0].lesson.toLowerCase()).toContain('edit tool');
    } finally { rmSync(ws, { recursive: true, force: true }); }
  });

  it('digest surfaces the wanted behavior', () => {
    corr.captureCorrection('never commit without running the tests', { session: 's-digest' });
    const digest = corr.correctionsDigest();
    expect(digest).toContain('USER CORRECTIONS');
    expect(digest.toLowerCase()).toContain('running the tests');
  });
});
