import { describe, it, expect } from 'vitest';
import { getHostEnvironmentProfile, formatEnvironmentBlock, resetEnvironmentProfileCache } from './env-profiler.js';

describe('Host Environment Profiler', () => {
  it('detects available runtime binaries on the system', () => {
    resetEnvironmentProfileCache();
    const profile = getHostEnvironmentProfile(true);
    expect(profile).toBeDefined();
    expect(profile.availableRuntimes).toContain('node');
    expect(profile.runtimes['node'].available).toBe(true);
    expect(profile.runtimes['node'].version).toBeDefined();
  });

  it('formats a concise markdown block for the context engine', () => {
    const block = formatEnvironmentBlock({
      runtimes: { node: { name: 'node', available: true } },
      buildTools: { npm: { name: 'npm', available: true } },
      linters: { tsc: { name: 'tsc', available: true } },
      availableRuntimes: ['node'],
      availableBuildTools: ['npm'],
      availableLinters: ['tsc'],
      timestamp: Date.now(),
    });

    expect(block).toContain('Host Environment Capabilities');
    expect(block).toContain('- **Runtimes**: node');
    expect(block).toContain('- **Build Systems**: npm');
    expect(block).toContain('- **Linters/Formatters**: tsc');
  });

  it('handles empty environments cleanly', () => {
    const block = formatEnvironmentBlock({
      runtimes: {},
      buildTools: {},
      linters: {},
      availableRuntimes: [],
      availableBuildTools: [],
      availableLinters: [],
      timestamp: Date.now(),
    });
    expect(block).toBe('');
  });
});
