import { spawn } from 'node:child_process';
import type { Tool } from './types.js';

const MAX_OUTPUT = 256_000;

export const shellTool: Tool = {
  def: {
    name: 'shell',
    description: 'Run a shell command. Returns stdout, stderr, and exit code. Output is truncated if too long.',
    parameters: [
      { name: 'command', type: 'string', description: 'Shell command', required: true },
      { name: 'cwd', type: 'string', description: 'Working directory (defaults to current)', required: false },
      { name: 'timeout', type: 'integer', description: 'Timeout in seconds', required: false },
      { name: 'description', type: 'string', description: 'Short description of what this command does', required: false },
    ],
    permission: 'shell',
    dangerous: true,
  },
  async execute(args, ctx) {
    const command = String(args.command ?? '');
    if (!command) throw new Error('No command provided');

    const cwd = args.cwd ? String(args.cwd) : ctx.cwd;
    const timeoutMs = ((args.timeout ? Number(args.timeout) : ctx.config.safety.commandTimeoutSeconds) ?? 120) * 1000;

    const env: NodeJS.ProcessEnv = { ...process.env };
    env.AI_AGENT = 'mochi';
    env.MOCHI_AGENT = 'true';
    env.MOCHI_CWD = ctx.cwd;
    if (ctx.workspace) {
      env.MOCHI_WORKSPACE = ctx.workspace.dir;
      env.MOCHI_AGENT_ID = ctx.agentId;
    }

    return new Promise((resolve, reject) => {
      const child = spawn('sh', ['-c', command], { cwd, env, stdio: 'pipe' });
      let stdout = '';
      let stderr = '';
      const killed = { value: false };

      const timer = setTimeout(() => {
        killed.value = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000);
      }, timeoutMs);

      ctx.abortSignal?.addEventListener('abort', () => {
        killed.value = true;
        child.kill('SIGTERM');
      });

      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
        if (stdout.length > MAX_OUTPUT) {
          stdout = stdout.slice(0, MAX_OUTPUT) + '\n... [truncated]';
          child.stdout?.destroy();
        }
      });

      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
        if (stderr.length > MAX_OUTPUT) {
          stderr = stderr.slice(0, MAX_OUTPUT) + '\n... [truncated]';
          child.stderr?.destroy();
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        const out = [
          `exit_code: ${code}`,
          `stdout:\n${stdout || '(empty)'}`,
          `stderr:\n${stderr || '(empty)'}`,
        ].join('\n');
        if (killed.value) {
          resolve(out + '\n[command timed out or was cancelled]');
        } else {
          resolve(out);
        }
      });
    });
  },
};
