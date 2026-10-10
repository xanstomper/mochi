import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type HookName =
  | 'before_goal'
  | 'after_goal'
  | 'before_task'
  | 'after_task'
  | 'before_agent'
  | 'after_agent'
  | 'before_tool'
  | 'after_tool'
  | 'before_edit'
  | 'after_edit'
  | 'before_shell'
  | 'after_shell'
  | 'before_verify'
  | 'after_verify'
  | 'on_error'
  | 'on_checkpoint'
  | 'on_rollback';

export interface HookConfig {
  [hook: string]: string | string[];
}

export interface HookResult {
  allowed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export class HookManager {
  private config: HookConfig = {};

  constructor(workspaceDir: string) {
    // MCH-37: hooks.json is read from BOTH the workspace (.mochi/) and the
    // project root — project-root wins (more specific). Same convention as
    // Claude Code's hooks (settings.json > project settings).
    const candidates = [
      resolve(workspaceDir, 'hooks.json'),
      resolve(process.cwd(), 'hooks.json'),
      resolve(process.cwd(), '.mochi', 'hooks.json'),
    ];
    for (const path of candidates) {
      if (!existsSync(path)) continue;
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (parsed && typeof parsed === 'object') this.config = { ...this.config, ...(parsed as HookConfig) };
      } catch {
        // malformed hook file: skip, never break the run
      }
    }
  }

  list(): HookName[] {
    return Object.keys(this.config) as HookName[];
  }

  enabled(name: HookName): boolean {
    return this.commandsFor(name).length > 0;
  }

  private commandsFor(name: HookName): string[] {
    const value = this.config[name];
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return [value];
    return [];
  }

  async runBefore(name: HookName, context: Record<string, string> = {}): Promise<HookResult> {
    const results: HookResult[] = [];
    for (const command of this.commandsFor(name)) {
      results.push(await this.run(command, context));
    }
    // A failing before hook vetoes the action.
    for (const r of results) {
      if (!r.allowed) return r;
    }
    return results[results.length - 1] ?? { allowed: true, exitCode: null, stdout: '', stderr: '' };
  }

  async runAfter(name: HookName, context: Record<string, string> = {}): Promise<HookResult[]> {
    const results: HookResult[] = [];
    for (const command of this.commandsFor(name)) {
      results.push(await this.run(command, context));
    }
    return results;
  }

  private async run(command: string, context: Record<string, string>): Promise<HookResult> {
    const env: NodeJS.ProcessEnv = { ...process.env, MOCHI_HOOK: '1' };
    for (const [k, v] of Object.entries(context)) env[`MOCHI_${k.toUpperCase()}`] = v;
    return new Promise((resolve) => {
      execFile('sh', ['-c', command], { env, timeout: 5000 }, (error, stdout, stderr) => {
        const exitCode = error ? ((error as any).code ?? 1) : 0;
        resolve({
          allowed: exitCode === 0,
          exitCode,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      });
    });
  }
}
