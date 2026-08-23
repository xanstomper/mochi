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
import { replaceSymbolTool } from './replace-symbol.js';
import { chameleonTool } from './chameleon.js';
import { todoTool } from './todo.js';
import { skillTool } from './skill.js';
import { subagentTool } from './subagent.js';
import { patchTool } from './patch.js';
import { fetchTool } from './fetch.js';
import { diffTool } from './diff.js';
import { treeTool } from './tree.js';
import { regexReplaceTool } from './regex-replace.js';
import { deepwikiTool } from './deepwiki.js';
import { clipboardTool } from './clipboard.js';
import { sqlCodebaseTool } from '../codebase-sql.js';
import { performance } from 'node:perf_hooks';
import { searchReplaceMultiTool } from './search-replace-multi.js';
import { analyzeCodeTool } from './analyze-code.js';
import { verifyTool } from './verify.js';
import { perfTool } from './perf-tool.js';
import { webSearchTool } from './web-search.js';
import { webCrawlTool } from './web-crawl.js';
import { getDiagnosticsTool } from './diagnostics-tool.js';
import { mkdirTool, moveFileTool, copyFileTool } from './file-ops.js';
import { gitBlameTool, gitHistoryTool } from './git-blame.js';
import { systemInfoTool } from './system-info.js';
import { findReferencesTool, findDefinitionsTool } from './find-references.js';
import { dbInspectTool } from './db-inspect.js';
import { createPrTool } from './create-pr.js';
import { thinkTool } from './think.js';
import { renameSymbolTool } from './rename-symbol.js';
import { replTool } from './repl.js';
import { blastRadiusTool } from './blast-radius.js';
import { sessionRecallTool } from './session-recall.js';

export const ALL_TOOLS: Tool[] = [
  readTool, writeTool, editTool, deleteTool, shellTool, searchTool, globTool,
  gitTool, inspectTool, memoryTool, sessionRecallTool, todoTool, skillTool, subagentTool, patchTool,
  fetchTool, diffTool, treeTool, regexReplaceTool, deepwikiTool, clipboardTool, sqlCodebaseTool,
  searchReplaceMultiTool, analyzeCodeTool, verifyTool, perfTool,
  webSearchTool, getDiagnosticsTool, mkdirTool, moveFileTool, copyFileTool,
  gitBlameTool, gitHistoryTool, systemInfoTool, findReferencesTool, findDefinitionsTool,
  dbInspectTool, createPrTool, thinkTool, webCrawlTool, renameSymbolTool, replTool,
  blastRadiusTool,
  ...symbolTools, replaceSymbolTool, chameleonTool,
];

/**
 * Core tools that are ALWAYS included regardless of model tier. These are the
 * essential tools every agent needs. Extra/advanced tools are only sent to
 * models with sufficient context to handle them without degenerating.
 */
const CORE_TOOL_NAMES = new Set([
  'read', 'write', 'edit', 'delete', 'shell', 'search', 'glob',
  'git', 'inspect', 'todo', 'skill', 'subagent', 'fetch', 'web_search', 'web_crawl', 'think', 'chameleon', 'blast_radius', 'session_recall'
]);

/** Extended tools included only when the model is not a known weak/free tier. */
const EXTENDED_TOOL_NAMES = new Set([
  'regex_replace', 'deepwiki', 'clipboard', 'sql_codebase_query',
  'search_replace_multi', 'analyze_code', 'perf',
  'web_search', 'get_diagnostics', 'create_directory', 'move_file', 'copy_file',
  'git_blame', 'git_history', 'system_info', 'find_references', 'find_definitions',
  'db_inspect', 'create_pr', 'type_hierarchy', 'chameleon', 'rename_symbol', 'repl',
]);

/** Detect whether a model name implies a weak/free-tier model that struggles
 *  with large tool schemas (>20 tools). These models degenerate into repetition
 *  loops when overwhelmed with too many tool definitions. */
export function isWeakModel(config: MochiConfig): boolean {
  const m = (config.model.model ?? '').toLowerCase();
  // DeepSeek v4 Flash is powerful enough for all tools, do not penalize it
  return m.includes('nano') || m.includes('tiny') || m.includes('lite');
}

export function buildTools(config: MochiConfig, allowed?: string[]): Map<string, Tool> {
  const map = new Map<string, Tool>();
  const weak = isWeakModel(config);
  for (const tool of ALL_TOOLS) {
    const name = tool.def.name;
    // Always-include tools bypass filtering so all agents have memory, execution, and reasoning tools.
    const alwaysInclude =
      name === 'todo' ||
      name === 'skill' ||
      name === 'subagent' ||
      name === 'chameleon' ||
      name === 'blast_radius' ||
      name === 'think' ||
      name === 'session_recall' ||
      name === 'memory';
    if (allowed && !allowed.includes(name) && !alwaysInclude) continue;
    // For weak models, only include core tools to keep tool schema lean.
    if (weak && !CORE_TOOL_NAMES.has(name) && !alwaysInclude) continue;
    map.set(name, tool);
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
    return { output, durationMs };
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    const error = err instanceof Error ? err.message : String(err);
    ctx.events.emit({ type: 'tool:failed', tool: name, error, agentId: ctx.agentId });
    return { output: '', error, durationMs };
  }
}
