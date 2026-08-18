import type { MochiConfig, ToolDefinition } from '../types.js';
import type { ToolContext, Tool } from './types.js';
import { readTool } from './read.js';
import { writeTool } from './write.js';
import { editTool } from './edit.js';
import { deleteTool } from './delete.js';
import { shellTool } from './shell.js';
import { searchTool } from './search.js';
import { globTool } from './glob.js';
import { gitTool } from './git.js';
import { inspectTool } from './inspect.js';
import { memoryTool } from './memory.js';
import { symbolTools } from './symbol.js';
import { chameleonTool } from './chameleon.js';
import { todoTool } from './todo.js';

const ALL_TOOLS: Tool[] = [readTool, writeTool, editTool, deleteTool, shellTool, searchTool, globTool, gitTool, inspectTool, memoryTool, todoTool, ...symbolTools, chameleonTool];

export function buildTools(config: MochiConfig, allowed?: string[]): Map<string, Tool> {
  const map = new Map<string, Tool>();
  for (const tool of ALL_TOOLS) {
    if (!allowed || allowed.includes(tool.def.name) || tool.def.name === 'todo') {
      map.set(tool.def.name, tool);
    }
  }
  return map;
}

export function toolDescriptions(tools: Map<string, Tool>): string {
  const lines: string[] = [];
  for (const [name, tool] of tools) {
    lines.push(`## ${name}`);
    lines.push(tool.def.description);
    if (tool.def.dangerous) lines.push('**Requires approval.**');
    lines.push(`Parameters: ${tool.def.parameters.map((p) => `${p.name}: ${p.type}${p.required ? '' : '?'}`).join(', ')}`);
  }
  return lines.join('\n');
}

export function validateArgs(tool: Tool, args: Record<string, unknown>): string | undefined {
  for (const p of tool.def.parameters) {
    if (p.required && (args[p.name] === undefined || args[p.name] === null || args[p.name] === '')) {
      return `Missing required parameter: ${p.name}`;
    }
  }
  return undefined;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  tools: Map<string, Tool>,
): Promise<{ output: string; error?: string; durationMs: number }> {
  const tool = tools.get(name);
  if (!tool) return { output: '', error: `Unknown tool: ${name}`, durationMs: 0 };

  const validation = validateArgs(tool, args);
  if (validation) return { output: '', error: validation, durationMs: 0 };

  // Permission gate
  const perm = tool.def.permission;
  if (perm) {
    if (!ctx.config.permissions[perm]) {
      return { output: '', error: `Permission denied for tool ${name} (${perm})`, durationMs: 0 };
    }
    if (ctx.config.safety.mode === 'safe' && tool.def.dangerous) {
      return { output: '', error: `Tool ${name} requires safety mode ask/auto`, durationMs: 0 };
    }
  }

  ctx.events.emit({ type: 'tool:called', tool: name, args, agentId: ctx.agentId });
  const start = performance.now();
  try {
    const output = await tool.execute(args, ctx);
    const durationMs = Math.round(performance.now() - start);
    ctx.events.emit({ type: 'tool:completed', tool: name, result: { toolCallId: '', name, output, durationMs }, agentId: ctx.agentId });
    return { output, durationMs };
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    const error = err instanceof Error ? err.message : String(err);
    ctx.events.emit({ type: 'tool:failed', tool: name, error, agentId: ctx.agentId });
    return { output: '', error, durationMs };
  }
}
