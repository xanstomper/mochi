// Agent-authored dynamic tools ("build your own toolbox") — the tool-side
// counterpart to skill-manager (which stores reusable INSTRUCTIONS; this
// stores reusable EXECUTABLES).
//
// Model (mirrors Hermes' extensibility but project-native):
//   - The agent authors a tool via the `tool_factory` tool: a manifest
//     `.mochi/tools/<slug>/tool.json` declaring name, description, parameters,
//     permission, and a shell command.
//   - Commands run through `sh -c` with MOCHI_TOOL_ARGS (JSON), the tool name
//     and the tool dir in env; stdout is the tool's output. Same trust domain
//     as the `shell` tool (the agent can already run arbitrary commands).
//   - Authored tools are hot-loaded into the live toolset: buildTools() merges
//     them in, and the agent loop re-scans each iteration so a tool created
//     mid-task is callable + advertised immediately (same pattern as MCP).
//   - remove() archives into `.mochi/tools/.archive/` — never hard-deletes.
//   - Authored tools can NEVER shadow a built-in tool name or alias.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { safeSlug } from '../skill-manager.js';
import type { Tool, ToolContext } from './types.js';
import type { ToolDefinition } from '../types.js';

// ─── Paths ───────────────────────────────────────────────────────────────

export function toolsRoot(projectDir: string): string {
  return join(projectDir, '.mochi', 'tools');
}
export function toolsArchiveRoot(projectDir: string): string {
  return join(projectDir, '.mochi', 'tools', '.archive');
}

// ─── Manifest ────────────────────────────────────────────────────────────

export interface AuthoredToolManifest {
  name: string;
  description: string;
  /** Shell command. Receives args as JSON in $MOCHI_TOOL_ARGS. */
  command: string;
  parameters?: Array<{ name: string; type?: 'string' | 'number' | 'integer' | 'boolean' | 'array'; description?: string; required?: boolean }>;
  /** Permission gate: read | write | admin. Defaults to 'write' (commands can mutate). */
  permission?: string;
  /** Execution timeout in ms. Default 30s, hard cap 120s. */
  timeoutMs?: number;
}

const NAME_RE = /^[a-z][a-z0-9_]*$/; // function-call-safe names (LLMs emit these)
const MAX_PARAMS = 12;
const VALID_PERMISSIONS = new Set(['read', 'write', 'admin']);
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 100_000;

/** Local reserved list (buildTools re-checks against the full registry +
 *  aliases, which cannot be imported here without a circular import). */
export const RESERVED_TOOL_NAMES = new Set([
  'tool_factory', 'skill', 'skill_manage', 'shell', 'read', 'write', 'edit',
  'patch', 'delete', 'glob', 'search', 'outline', 'inspect', 'git', 'todo',
  'memory', 'think', 'subagent', 'bg_task', 'fetch', 'web_search', 'web_crawl',
  'chameleon', 'blast_radius', 'session_recall', 'compile_prompt', 'perf',
]);

export function validateManifest(m: AuthoredToolManifest): string | null {
  if (!m || typeof m !== 'object') return 'manifest must be an object';
  if (typeof m.name !== 'string' || !m.name.trim()) return 'name is required';
  if (!NAME_RE.test(m.name)) return "name must match ^[a-z][a-z0-9_]*$ (tool names are called as functions)";
  if (m.name.length > 64) return 'name exceeds 64 chars';
  if (RESERVED_TOOL_NAMES.has(m.name)) return `'${m.name}' is a built-in tool — authored tools cannot shadow built-ins`;
  if (typeof m.description !== 'string' || m.description.trim().length < 8) return 'description is required (min 8 chars — the model picks tools by description)';
  if (typeof m.command !== 'string' || !m.command.trim()) return 'command is required';
  if (m.permission !== undefined && !VALID_PERMISSIONS.has(m.permission)) return `permission must be one of: ${[...VALID_PERMISSIONS].join(', ')}`;
  const params = m.parameters ?? [];
  if (!Array.isArray(params)) return 'parameters must be an array';
  if (params.length > MAX_PARAMS) return `too many parameters (max ${MAX_PARAMS})`;
  const VALID_PARAM_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array']);
  const seen = new Set<string>();
  for (const p of params) {
    if (!p || typeof p.name !== 'string' || !NAME_RE.test(p.name)) return `bad parameter name: ${JSON.stringify(p?.name)}`;
    if (seen.has(p.name)) return `duplicate parameter: ${p.name}`;
    seen.add(p.name);
    if (p.type !== undefined && !VALID_PARAM_TYPES.has(p.type)) return `parameter '${p.name}': type must be one of string|number|integer|boolean|array`;
  }
  return null;
}

// ─── Storage ─────────────────────────────────────────────────────────────

function manifestPath(projectDir: string, name: string): string {
  return join(toolsRoot(projectDir), safeSlug(name), 'tool.json');
}

export interface WriteResult {
  ok: boolean;
  path?: string;
  error?: string;
  archived?: boolean;
}

export function writeAuthoredTool(projectDir: string, m: AuthoredToolManifest): WriteResult {
  try {
    const err = validateManifest(m);
    if (err) return { ok: false, error: err };
    const dir = join(toolsRoot(projectDir), safeSlug(m.name));
    mkdirSync(dir, { recursive: true });
    const target = join(dir, 'tool.json');
    writeFileSync(target, JSON.stringify(m, null, 2) + '\n', 'utf8');
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function readAuthoredManifest(projectDir: string, name: string): AuthoredToolManifest | null {
  try {
    const raw = readFileSync(manifestPath(projectDir, name), 'utf8');
    return JSON.parse(raw) as AuthoredToolManifest;
  } catch {
    return null;
  }
}

export function removeAuthoredTool(projectDir: string, name: string): WriteResult {
  const dir = join(toolsRoot(projectDir), safeSlug(name));
  if (!existsSync(join(dir, 'tool.json'))) return { ok: false, error: `No authored tool named '${name}'` };
  try {
    const arc = join(toolsArchiveRoot(projectDir), safeSlug(name), 'tool.json');
    mkdirSync(dirname(arc), { recursive: true });
    renameSync(join(dir, 'tool.json'), arc);
    return { ok: true, path: arc, archived: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function listAuthoredTools(projectDir: string): AuthoredToolManifest[] {
  const root = toolsRoot(projectDir);
  if (!existsSync(root)) return [];
  const out: AuthoredToolManifest[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    try {
      const m = JSON.parse(readFileSync(join(root, e.name, 'tool.json'), 'utf8')) as AuthoredToolManifest;
      if (!validateManifest(m)) out.push(m);
    } catch { /* skip malformed */ }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

// ─── Execution ───────────────────────────────────────────────────────────

/** Run an authored manifest's command with the given args. Exported for the
 *  `test` action (verify a tool works before relying on it). */
export function runAuthoredCommand(m: AuthoredToolManifest, args: Record<string, unknown>, projectDir: string): Promise<{ output: string; error?: string; durationMs: number }> {
  const started = Date.now();
  const timeoutMs = Math.min(Math.max(1_000, m.timeoutMs ?? DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS);
  // Ergonomics: declared parameters (in order) are ALSO exposed as positional
  // args ($1, $2, ...) and MOCHI_TOOL_PARAM_<NAME> env vars, so commands can be
  // written the way models naturally write them (`grep -r TODO "$1"`) instead
  // of forcing every author to parse MOCHI_TOOL_ARGS JSON.
  const argMap = (args ?? {}) as Record<string, unknown>;
  const positional: string[] = [];
  const paramEnv: Record<string, string> = {};
  for (const p of m.parameters ?? []) {
    const v = argMap[p.name];
    if (v !== undefined && v !== null) {
      positional.push(String(v));
      paramEnv[`MOCHI_TOOL_PARAM_${p.name.toUpperCase()}`] = String(v);
    }
  }
  return new Promise((resolve) => {
    const child = execFile('sh', ['-c', m.command, 'sh', ...positional], {
      cwd: projectDir,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        ...paramEnv,
        MOCHI_TOOL_NAME: m.name,
        MOCHI_TOOL_ARGS: JSON.stringify(args ?? {}),
        MOCHI_TOOL_DIR: join(toolsRoot(projectDir), safeSlug(m.name)),
      },
    }, (error, stdout, stderr) => {
      let out = stdout.toString();
      if (out.length > MAX_OUTPUT_CHARS) out = out.slice(0, MAX_OUTPUT_CHARS) + `\n[... truncated at ${MAX_OUTPUT_CHARS} chars ...]`;
      if (error) {
        const errTail = stderr.toString().slice(-2_000).trim();
        const timedOut = (error as { killed?: boolean }).killed === true;
        resolve({
          output: out,
          error: timedOut
            ? `command timed out after ${timeoutMs}ms`
            : `exit failed: ${errTail || error.message}`,
          durationMs: Date.now() - started,
        });
        return;
      }
      resolve({ output: out.trim() === '' ? '(no output)' : out, durationMs: Date.now() - started });
    });
    child.on('error', () => { /* handled in callback via error arg */ });
  });
}

function manifestToTool(m: AuthoredToolManifest, projectDir: string): Tool {
  const def: ToolDefinition = {
    name: m.name,
    description: `[authored tool] ${m.description}`,
    parameters: (m.parameters ?? []).map((p) => ({
      name: p.name,
      type: p.type ?? 'string',
      description: p.description ?? '',
      required: p.required ?? false,
    })),
    permission: (m.permission as ToolDefinition['permission']) ?? 'write',
  };
  return {
    def,
    async execute(args, _ctx: ToolContext) {
      const r = await runAuthoredCommand(m, args, projectDir);
      if (r.error) return `ERROR: ${r.error}\n${r.output}`.trim();
      return r.output;
    },
  };
}

// ─── Hot-loading (buildTools + per-iteration refresh) ────────────────────

/** Load every valid authored tool as a Tool. Invalid/malformed ones are
 *  skipped (never crash the toolset over one bad manifest). */
export function loadAuthoredTools(projectDir: string): Map<string, Tool> {
  const out = new Map<string, Tool>();
  for (const m of listAuthoredTools(projectDir)) out.set(m.name, manifestToTool(m, projectDir));
  return out;
}

/** Module-level per-project fingerprint of the authored-tool tree so the
 *  loop can cheaply detect "did the agent author/patch/remove a tool since
 *  last iteration". */
const fingerprints = new Map<string, string>();
/** Names THIS module added to a given toolset (so refresh only reverts its own). */
const addedByProject = new Map<string, Set<string>>();

function fingerprint(projectDir: string): string {
  const root = toolsRoot(projectDir);
  if (!existsSync(root)) return '';
  const parts: string[] = [];
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const f = join(root, e.name, 'tool.json');
      if (!existsSync(f)) continue;
      const st = statSync(f);
      parts.push(`${e.name}:${st.mtimeMs}:${st.size}`);
    }
  } catch { return ''; }
  return parts.sort().join('|');
}

/** Re-scan the authored-tool tree; merge changes into `tools`. Returns true
 *  when the toolset's DEF SET changed (caller should rebuild toolDefs).
 *  Built-in names and aliases are always skipped (built-ins win). */
export function refreshAuthoredTools(tools: Map<string, Tool>, projectDir: string, isReserved: (name: string) => boolean): boolean {
  const fp = fingerprint(projectDir);
  if (fp === fingerprints.get(projectDir)) return false;
  fingerprints.set(projectDir, fp);
  const mine = addedByProject.get(projectDir) ?? new Set<string>();
  const fresh = loadAuthoredTools(projectDir);
  let changed = false;
  // Remove previously-added authored tools that no longer exist / turned invalid.
  for (const name of mine) {
    if (!fresh.has(name) && tools.get(name)) {
      tools.delete(name);
      mine.delete(name);
      changed = true;
    }
  }
  // Add/update authored tools (skip reserved collisions).
  for (const [name, tool] of fresh) {
    if (isReserved(name)) continue;
    const existing = tools.get(name);
    if (existing && !mine.has(name)) continue; // never overwrite a built-in/profile tool
    if (existing?.def.description === tool.def.description && existing && mine.has(name)) continue; // unchanged
    tools.set(name, tool);
    mine.add(name);
    changed = true;
  }
  addedByProject.set(projectDir, mine);
  return changed;
}

// ─── The tool ────────────────────────────────────────────────────────────

export const toolFactoryTool: Tool = {
  def: {
    name: 'tool_factory',
    description:
      'Create, test, list, inspect, or remove your own reusable TOOLS — executable shell-backed helpers stored as ' +
      '.mochi/tools/<name>/tool.json and hot-loaded into your toolset (callable by name immediately, this session and ' +
      'every future session in this project). Use whenever you solve a problem with a non-trivial command pipeline or ' +
      'repeat a multi-command workflow: capture it once as a tool instead of re-deriving it. ' +
      'Commands receive arguments as JSON in $MOCHI_TOOL_ARGS (plus MOCHI_TOOL_NAME/MOCHI_TOOL_DIR env) and their stdout ' +
      'becomes the tool output. Example command: `python3 scripts/lint_scope.py "$MOCHI_TOOL_ARGS"`. ' +
      'Actions: create (name+description+command, parameters JSON array optional, permission, timeoutMs); ' +
      'test (name + args — run it right now to verify before relying on it); list; show (name); remove (name — archived).',
    parameters: [
      { name: 'action', type: 'string', description: 'create | test | list | show | remove', required: true },
      { name: 'name', type: 'string', description: 'Tool name: lowercase a-z + digits + underscores, must start with a letter (e.g. db_row_count)', required: false },
      { name: 'description', type: 'string', description: 'What it does + when to use it (the model chooses tools by description — make it specific)', required: false },
      { name: 'command', type: 'string', description: 'Shell command; args arrive as JSON string in $MOCHI_TOOL_ARGS', required: false },
      { name: 'parameters', type: 'string', description: 'JSON array of parameter defs: [{"name":"table","type":"string","description":"...","required":true}]', required: false },
      { name: 'permission', type: 'string', description: 'read | write | admin (default write)', required: false },
      { name: 'timeout_ms', type: 'number', description: 'Execution timeout in ms (default 30000, max 120000)', required: false },
      { name: 'args', type: 'string', description: 'JSON object of sample args (test action)', required: false },
    ],
    permission: 'write',
  },
  async execute(args, ctx) {
    const action = String(args.action ?? '').toLowerCase();
    const projectDir = ctx.workspace.dir || ctx.cwd;
    const name = String(args.name ?? '').trim();

    if (action === 'list') {
      const tools = listAuthoredTools(projectDir);
      if (!tools.length) return '(no authored tools yet — create one with action="create")';
      return tools.map((m) => `${m.name}: ${m.description} [params: ${(m.parameters ?? []).map((p) => p.name).join(', ') || 'none'}]`).join('\n');
    }

    if (!name) return JSON.stringify({ ok: false, error: 'name is required for this action' });

    if (action === 'create') {
      let params: AuthoredToolManifest['parameters'];
      const rawParams = args.parameters;
      if (rawParams !== undefined) {
        try {
          const parsed = typeof rawParams === 'string' ? JSON.parse(rawParams) : rawParams;
          if (!Array.isArray(parsed)) return JSON.stringify({ ok: false, error: 'parameters must be a JSON array' });
          params = parsed;
        } catch (e) {
          return JSON.stringify({ ok: false, error: `parameters is not valid JSON: ${e instanceof Error ? e.message : e}` });
        }
      }
      const r = writeAuthoredTool(projectDir, {
        name,
        description: String(args.description ?? ''),
        command: String(args.command ?? ''),
        parameters: params,
        permission: args.permission !== undefined ? String(args.permission) : undefined,
        timeoutMs: args.timeout_ms !== undefined ? Number(args.timeout_ms) : undefined,
      });
      if (!r.ok) return JSON.stringify(r);
      // Verify-by-default: the create response tells the agent to test it.
      return `Created tool '${name}' at ${r.path}. It is callable NOW (hot-loaded) — run action="test" with sample args to verify it works before relying on it.`;
    }

    if (action === 'test') {
      const m = readAuthoredManifest(projectDir, name);
      if (!m) return JSON.stringify({ ok: false, error: `No authored tool named '${name}'` });
      let sample: Record<string, unknown> = {};
      if (args.args !== undefined) {
        try {
          sample = typeof args.args === 'string' ? JSON.parse(args.args) : args.args;
        } catch (e) {
          return JSON.stringify({ ok: false, error: `args is not valid JSON: ${e instanceof Error ? e.message : e}` });
        }
      }
      const r = await runAuthoredCommand(m, sample, projectDir);
      return JSON.stringify({ ok: !r.error, durationMs: r.durationMs, output: r.output.slice(0, 4_000), error: r.error });
    }

    if (action === 'show') {
      const m = readAuthoredManifest(projectDir, name);
      if (!m) return JSON.stringify({ ok: false, error: `No authored tool named '${name}'` });
      return JSON.stringify(m, null, 2);
    }

    if (action === 'remove') {
      const r = removeAuthoredTool(projectDir, name);
      return r.ok ? `Removed tool '${name}' (recoverable in .mochi/tools/.archive).` : JSON.stringify(r);
    }

    return JSON.stringify({ ok: false, error: `Unknown action '${action}'. Use create, test, list, show, or remove.` });
  },
};
