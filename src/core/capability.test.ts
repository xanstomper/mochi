import { describe, it, expect } from 'vitest';
import { CapabilityRegistry, toolToCapability, createDefaultCapabilityRegistry } from './capability-registry.js';
import type { Capability, CapabilityExecutionRequest } from './capability.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';

describe('CapabilityRegistry', () => {
  it('registers and looks up capabilities by name', () => {
    const registry = new CapabilityRegistry();
    const mockCap: Capability = {
      id: 'test:mock',
      name: 'mock_tool',
      kind: 'native',
      description: 'A mock tool',
      schema: { name: 'mock_tool', description: 'desc', parameters: [] },
      isReadOnly: true,
      domain: 'test',
      execute: async () => ({
        callId: '1',
        name: 'mock_tool',
        output: 'ok',
        durationMs: 5,
        truncated: false,
        rawTokensEstimate: 1,
      }),
    };

    registry.register(mockCap);
    expect(registry.has('mock_tool')).toBe(true);
    expect(registry.get('mock_tool')?.domain).toBe('test');
    expect(registry.getDomains()).toContain('test');
    expect(registry.getByDomain('test').length).toBe(1);
  });

  it('filters tool schemas by active domains', () => {
    const registry = new CapabilityRegistry();
    registry.register({
      id: 'test:core',
      name: 'read',
      kind: 'native',
      description: 'read',
      schema: { name: 'read', description: 'read', parameters: [] },
      isReadOnly: true,
      domain: 'core',
      execute: async () => ({ callId: '1', name: 'read', output: '', durationMs: 0, truncated: false, rawTokensEstimate: 0 }),
    });
    registry.register({
      id: 'test:db',
      name: 'db_query',
      kind: 'mcp',
      description: 'db',
      schema: { name: 'db_query', description: 'db', parameters: [] },
      isReadOnly: true,
      domain: 'db',
      execute: async () => ({ callId: '2', name: 'db_query', output: '', durationMs: 0, truncated: false, rawTokensEstimate: 0 }),
    });

    const coreOnly = registry.getSchemas(['core']);
    expect(coreOnly.some((s) => s.name === 'read')).toBe(true);
    expect(coreOnly.some((s) => s.name === 'db_query')).toBe(false);

    const withDb = registry.getSchemas(['core', 'db']);
    expect(withDb.some((s) => s.name === 'db_query')).toBe(true);
  });

  it('builds default capability registry with all native tools and resolves aliases', async () => {
    const reg = createDefaultCapabilityRegistry({});
    expect(reg.has('read')).toBe(true);
    expect(reg.has('view_file')).toBe(true);
    expect(reg.has('run_command')).toBe(true);
    expect(reg.get('run_command')?.name).toBe('shell');
    expect(reg.get('view_file')?.name).toBe('read');
    expect(reg.get('view_file')?.isReadOnly).toBe(true);
    expect(reg.get('write_to_file')?.isReadOnly).toBe(false);
  });
});
