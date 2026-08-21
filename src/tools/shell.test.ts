import { describe, it, expect } from 'vitest';
import { desktopGuiReason, shellTool } from './shell.js';

describe('desktopGuiReason', () => {
  it('detects common desktop GUI app launches', () => {
    expect(desktopGuiReason('gnome-calculator')).toMatch(/gnome-calculator/i);
    expect(desktopGuiReason('kcalc &')).toMatch(/kcalc/i);
    expect(desktopGuiReason('firefox &')).toMatch(/firefox/i);
    expect(desktopGuiReason('sudo gnome-calculator')).toMatch(/gnome-calculator/i);
  });

  it('allows normal headless commands', () => {
    for (const cmd of [
      'node calculator.js',
      'python3 calculator.py',
      'npm test',
      'grep -r calc src',
      'echo hello',
      'git status',
      'ls',
    ]) {
      expect(desktopGuiReason(cmd), cmd).toBeNull();
    }
  });
});

describe('shellTool GUI guard', () => {
  it('refuses to launch a desktop GUI app with a guiding error', async () => {
    const err = await shellTool
      .execute({ command: 'gnome-calculator' }, { cwd: '/tmp', config: { safety: { mode: 'safe' } } })
      .then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/gnome-calculator/i);
    expect((err as Error).message).toMatch(/BUILD\/IMPLEMENT\/CODE/i);
  });
});