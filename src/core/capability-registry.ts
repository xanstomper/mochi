// Capability Registry for Mochi VNext
// Central repository for all native, MCP, ACP, Subagent, and Skill capabilities.

import type { Capability, CapabilityContext, CapabilityExecutionRequest, CapabilityExecutionResponse } from './capability.js';
import type { ToolDefinition } from '../types.js';

export class CapabilityRegistry {
  private capabilities = new Map<string, Capability>();
  private domainMap = new Map<string, Set<string>>();

  register(cap: Capability): void {
    this.capabilities.set(cap.name, cap);
    const domain = cap.domain ?? 'core';
    if (!this.domainMap.has(domain)) {
      this.domainMap.set(domain, new Set());
    }
    this.domainMap.get(domain)!.add(cap.name);
  }

  unregister(name: string): boolean {
    const cap = this.capabilities.get(name);
    if (!cap) return false;
    this.capabilities.delete(name);
    const domain = cap.domain ?? 'core';
    this.domainMap.get(domain)?.delete(name);
    return true;
  }

  get(name: string): Capability | undefined {
    return this.capabilities.get(name);
  }

  has(name: string): boolean {
    return this.capabilities.has(name);
  }

  list(): Capability[] {
    return [...this.capabilities.values()];
  }

  getDomains(): string[] {
    return [...this.domainMap.keys()];
  }

  getByDomain(domain: string): Capability[] {
    const names = this.domainMap.get(domain);
    if (!names) return [];
    return [...names].map((n) => this.capabilities.get(n)!).filter(Boolean);
  }

  getSchemas(activeDomains?: string[]): ToolDefinition[] {
    return [...this.capabilities.values()]
      .filter((c) => {
        if (!activeDomains || activeDomains.length === 0) return true;
        const domain = c.domain ?? 'core';
        return activeDomains.includes(domain) || domain === 'core';
      })
      .map((c) => c.schema);
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    context: CapabilityContext,
    callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  ): Promise<CapabilityExecutionResponse> {
    const cap = this.capabilities.get(name);
    if (!cap) {
      return {
        callId,
        name,
        output: '',
        error: `Unknown capability or tool: "${name}"`,
        durationMs: 0,
        truncated: false,
        rawTokensEstimate: 0,
      };
    }

    const req: CapabilityExecutionRequest = {
      callId,
      name,
      args,
      context,
    };

    const start = performance.now();
    try {
      const res = await cap.execute(req);
      const durationMs = Math.round(performance.now() - start);
      return {
        ...res,
        durationMs,
      };
    } catch (err) {
      const durationMs = Math.round(performance.now() - start);
      return {
        callId,
        name,
        output: '',
        error: err instanceof Error ? err.message : String(err),
        durationMs,
        truncated: false,
        rawTokensEstimate: 0,
      };
    }
  }
}

import type { Tool } from '../tools/types.js';
import { ALL_TOOLS, validateArgs } from '../tools/index.js';

const READ_ONLY_TOOLS = new Set([
  'read', 'search', 'glob', 'inspect', 'git', 'fetch', 'diff', 'tree',
  'get_function', 'find_callers', 'type_hierarchy', 'verify', 'perf_audit',
  'deepwiki', 'clipboard', 'sql_codebase', 'analyze_code', 'memory',
  'web_search', 'get_diagnostics', 'git_blame', 'git_history', 'system_info',
  'find_references', 'find_definitions', 'db_inspect', 'think',
]);

export function toolToCapability(tool: Tool): Capability {
  const isReadOnly = READ_ONLY_TOOLS.has(tool.def.name);
  return {
    id: `native:${tool.def.name}`,
    name: tool.def.name,
    kind: 'native',
    description: tool.def.description,
    schema: tool.def,
    isReadOnly,
    domain: isReadOnly ? 'inspect' : 'mutate',
    execute: async (req: CapabilityExecutionRequest): Promise<CapabilityExecutionResponse> => {
      const validation = validateArgs(tool, req.args);
      if (validation) {
        return {
          callId: req.callId,
          name: tool.def.name,
          output: '',
          error: validation,
          durationMs: 0,
          truncated: false,
          rawTokensEstimate: 0,
        };
      }

      // Permission gate
      const perm = tool.def.permission;
      if (perm && req.context.config.permissions) {
        if (!req.context.config.permissions[perm]) {
          return {
            callId: req.callId,
            name: tool.def.name,
            output: '',
            error: `Permission denied for tool ${tool.def.name} (${perm})`,
            durationMs: 0,
            truncated: false,
            rawTokensEstimate: 0,
          };
        }
      }

      req.context.events.emit({
        type: 'tool:called',
        tool: tool.def.name,
        args: req.args,
        agentId: req.context.agentId,
      });

      const start = performance.now();
      try {
        const output = await tool.execute(req.args, req.context as any);
        const durationMs = Math.round(performance.now() - start);
        return {
          callId: req.callId,
          name: tool.def.name,
          output,
          durationMs,
          truncated: false,
          rawTokensEstimate: Math.ceil(output.length / 4),
        };
      } catch (err) {
        const durationMs = Math.round(performance.now() - start);
        return {
          callId: req.callId,
          name: tool.def.name,
          output: '',
          error: err instanceof Error ? err.message : String(err),
          durationMs,
          truncated: false,
          rawTokensEstimate: 0,
        };
      }
    },
  };
}

export function createDefaultCapabilityRegistry(config: any, allowed?: string[]): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  for (const tool of ALL_TOOLS) {
    if (!allowed || allowed.includes(tool.def.name) || tool.def.name === 'todo' || tool.def.name === 'skill' || tool.def.name === 'subagent') {
      registry.register(toolToCapability(tool));
    }
  }
  return registry;
}
