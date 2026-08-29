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
import { bgTaskTool } from './bg-task.js';
import { outlineTool } from './outline.js';
import { mergeConflictTool } from './merge-conflict.js';
import { codeSimilarityTool } from './code-similarity.js';
import { securityAuditTool } from './security-audit.js';
import { skillManageTool } from '../skill-manager.js';
import { astSliceTool } from './ast-slice.js';
import { compilePromptTool } from './compile-prompt.js';
import { toolFactoryTool, refreshAuthoredTools, RESERVED_TOOL_NAMES, loadAuthoredTools } from './tool-factory.js';

import { timerTool } from './timer.js';
import { envTool } from './env.js';
import { lintTool } from './lint.js';
import { formatTool } from './format.js';
import { benchmarkTool } from './benchmark.js';
import { notesTool } from './notes.js';
import { tuiBuilderTool } from './tui-builder.js';
import { mcpManageTool } from './mcp-manage.js';
import { markdownTool } from './markdown.js';
import { colorTool } from './color.js';

export const ALL_TOOLS: Tool[] = [
  readTool, writeTool, editTool, deleteTool, shellTool, searchTool, globTool, outlineTool, astSliceTool,
  compilePromptTool,
  gitTool, inspectTool, memoryTool, sessionRecallTool, todoTool, skillTool, subagentTool, patchTool,
  bgTaskTool, fetchTool, diffTool, treeTool, regexReplaceTool, deepwikiTool, clipboardTool, sqlCodebaseTool,
  searchReplaceMultiTool, analyzeCodeTool, verifyTool, perfTool,
  webSearchTool, getDiagnosticsTool, mkdirTool, moveFileTool, copyFileTool,
  gitBlameTool, gitHistoryTool, systemInfoTool, findReferencesTool, findDefinitionsTool,
  dbInspectTool, createPrTool, thinkTool, webCrawlTool, renameSymbolTool, replTool,
  blastRadiusTool, mergeConflictTool, codeSimilarityTool, securityAuditTool,
  ...symbolTools, replaceSymbolTool, chameleonTool,
  skillManageTool,
  // New tools
  timerTool, envTool, lintTool, formatTool, benchmarkTool,
  notesTool, tuiBuilderTool, mcpManageTool, markdownTool, colorTool,
  toolFactoryTool,
];

/**
 * Core tools that are ALWAYS included regardless of model tier. These are the
 * essential tools every agent needs. Extra/advanced tools are only sent to
 * models with sufficient context to handle them without degenerating.
 */
const CORE_TOOL_NAMES = new Set([
  'read', 'write', 'edit', 'patch', 'replace_symbol', 'delete', 'shell', 'search', 'glob', 'outline', 'ast_slice',
  'compile_prompt',
  'git', 'inspect', 'todo', 'skill', 'subagent', 'bg_task', 'fetch', 'web_search', 'web_crawl', 'think', 'chameleon', 'blast_radius', 'session_recall'
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
  const m = (config?.model?.model ?? '').toLowerCase();
  // DeepSeek v4 Flash is powerful enough for all tools, do not penalize it
  return m.includes('nano') || m.includes('tiny') || m.includes('lite');
}

export function buildTools(config: MochiConfig, allowed?: string[]): Map<string, Tool> {
  const map = new Map<string, Tool>();
  const weak = isWeakModel(config);
  const projectDir = config?.projectDir || process.cwd();
  // Agent-authored tools (tool_factory) merge in alongside built-ins first so
  // built-ins always win name collisions. They bypass tier/role gates on purpose:
  // anything the agent authored is by definition useful to the agent.
  for (const [name, tool] of loadAuthoredToolsSafe(projectDir)) {
    if (!RESERVED_TOOL_NAMES.has(name)) map.set(name, tool);
  }
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
      name === 'memory' ||
      name === 'skill_manage' ||
      name === 'tool_factory';
    if (allowed && !allowed.includes(name) && !alwaysInclude) continue;
    // For weak models, only include core tools to keep tool schema lean.
    if (weak && !CORE_TOOL_NAMES.has(name) && !alwaysInclude) continue;
    map.set(name, tool);
  }
  return map;
}

/** Load authored tools without ever failing toolset construction. */
function loadAuthoredToolsSafe(projectDir: string): Map<string, Tool> {
  try {
    return loadAuthoredTools(projectDir);
  } catch {
    return new Map<string, Tool>();
  }
}

export const TOOL_ALIASES: Record<string, string> = {
  // Shell / command execution
  run_command: 'shell',
  execute_command: 'shell',
  bash: 'shell',
  terminal: 'shell',
  sh: 'shell',
  exec: 'shell',
  cmd: 'shell',
  run_shell: 'shell',

  // File reading
  read_file: 'read',
  view_file: 'read',
  readFile: 'read',
  viewFile: 'read',
  cat: 'read',

  // File writing / creation
  write_to_file: 'write',
  writeFile: 'write',
  writeToFile: 'write',
  create_file: 'write',
  new_file: 'write',

  // File editing
  edit_file: 'edit',
  editFile: 'edit',
  replace_file_content: 'edit',
  str_replace: 'edit',
  modify_file: 'edit',

  // Patching & conflicts
  apply_patch: 'patch',
  patch_file: 'patch',
  patchFile: 'patch',
  merge_conflicts: 'resolve_conflicts',
  resolve_conflict: 'resolve_conflicts',
  fix_conflicts: 'resolve_conflicts',
  resolve_merge_conflicts: 'resolve_conflicts',

  // File searching & listing
  find_files: 'glob',
  file_search: 'glob',
  list_dir: 'glob',
  find_by_name: 'glob',
  list_files: 'glob',
  listFiles: 'glob',
  dir: 'glob',

  // Content searching & outlines
  grep: 'search',
  search_files: 'search',
  grep_search: 'search',
  ripgrep: 'search',
  grepSearch: 'search',
  skeleton: 'outline',
  symbols_outline: 'outline',
  get_outline: 'outline',
  code_outline: 'outline',
  file_outline: 'outline',
  find_similar_code: 'code_similarity',
  detect_duplicates: 'code_similarity',
  clone_search: 'code_similarity',
  similar_code: 'code_similarity',
  security: 'security_audit',
  audit: 'security_audit',
  vuln_scan: 'security_audit',
  scan_security: 'security_audit',

  // Deletion
  delete_file: 'delete',
  remove_file: 'delete',
  unlink: 'delete',
  deleteFile: 'delete',

  // Subagents & delegation
  invoke_subagent: 'subagent',
  agent_delegate: 'subagent',
  spawn_agent: 'subagent',
  invokeSubagent: 'subagent',

  // Background tasks
  manage_task: 'bg_task',
  background_task: 'bg_task',
  task_manager: 'bg_task',
  manageTask: 'bg_task',

  // Memory & session recall
  session_search: 'session_recall',
  search_history: 'session_recall',
  history_search: 'session_recall',

  // Web & network
  fetch_url: 'fetch',
  web_fetch: 'fetch',
  read_url_content: 'fetch',
  search_web: 'web_search',
  google_search: 'web_search',

  // AST & Code Slicing
  slice_symbol: 'ast_slice',
  slice_code: 'ast_slice',
  symbol_slice: 'ast_slice',
  astSlice: 'ast_slice',
};

export function normalizeToolArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const norm: Record<string, unknown> = { ...args };

  // 1. Path normalization
  if (norm.path === undefined) {
    norm.path = norm.file_path ?? norm.filePath ?? norm.filename ?? norm.file ?? norm.TargetFile ?? norm.target_file ?? norm.AbsolutePath ?? norm.absolute_path ?? norm.target;
  }

  // 2. Command normalization
  if (norm.command === undefined) {
    norm.command = norm.cmd ?? norm.CommandLine ?? norm.command_line ?? norm.script ?? norm.exec;
  }

  // 3. Content normalization
  if (norm.content === undefined) {
    norm.content = norm.file_text ?? norm.CodeContent ?? norm.code_content ?? norm.text ?? norm.body ?? norm.Code;
  }

  // 4. Edit oldText / newText normalization
  if (norm.oldText === undefined) {
    norm.oldText = norm.old_text ?? norm.old_string ?? norm.oldString ?? norm.TargetContent ?? norm.target_content ?? norm.search ?? norm.find;
  }
  if (norm.newText === undefined) {
    norm.newText = norm.new_text ?? norm.new_string ?? norm.newString ?? norm.ReplacementContent ?? norm.replacement_content ?? norm.replace;
  }

  // 5. Query / Pattern normalization
  if (norm.pattern === undefined) {
    norm.pattern = norm.Pattern ?? norm.glob ?? norm.glob_pattern ?? norm.query ?? norm.Query ?? norm.search_pattern;
  }
  if (norm.query === undefined && (toolName === 'search' || toolName === 'web_search')) {
    norm.query = norm.Query ?? norm.pattern ?? norm.Pattern ?? norm.term ?? norm.search_term;
  }

  // 6. Subagent / Prompt normalization
  if (norm.prompt === undefined) {
    norm.prompt = norm.Prompt ?? norm.instructions ?? norm.instruction ?? norm.task ?? norm.description ?? norm.Description;
  }
  if (norm.role === undefined && norm.Role !== undefined) {
    norm.role = norm.Role;
  }

  // 7. Background task action / taskId normalization
  if (norm.task_id === undefined) {
    norm.task_id = norm.taskId ?? norm.TaskId ?? norm.id ?? norm.taskID;
  }
  if (norm.action === undefined) {
    norm.action = norm.Action ?? norm.operation ?? norm.op;
  }

  // 8. Symbol name normalization
  if (norm.symbol === undefined) {
    norm.symbol = norm.symbol_name ?? norm.symbolName ?? norm.name ?? norm.targetSymbol;
  }

  return norm;
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
  rawName: string,
  rawArgs: Record<string, unknown>,
  ctx: ToolContext,
  tools: Map<string, Tool>,
): Promise<{ output: string; error?: string; durationMs: number }> {
  const name = TOOL_ALIASES[rawName] || rawName;
  const tool = tools.get(name);
  if (!tool) return { output: '', error: `Unknown tool: ${rawName}`, durationMs: 0 };

  const args = normalizeToolArgs(name, rawArgs);
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
