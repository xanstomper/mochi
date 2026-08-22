import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Tool } from './types.js';
import { detectRepo } from '../repo.js';

// Run project verification commands (test, build, typecheck, lint) with
// smart command injection and result summarization
export const verifyTool: Tool = {
  def: {
    name: 'verify',
    description:
      'Run a verification command (test, build, typecheck, lint) and return a structured summary. ' +
      'Automatically detects the appropriate command for the project type. Useful for checking ' +
      'that changes work correctly.',
    parameters: [
      { name: 'command', type: 'string', description: 'Verification command to run (e.g. "test", "build", "typecheck", "lint")', required: false },
      { name: 'target', type: 'string', description: 'Specific test file or path to target (e.g. "src/foo.test.ts")', required: false },
      { name: 'timeout', type: 'integer', description: 'Timeout in seconds (default: 120)', required: false },
    ],
    permission: 'shell',
    dangerous: true,
  },
  async execute(args, ctx) {
    const repo = detectRepo(ctx.cwd);
    const cmdType = String(args.command ?? 'test');
    const target = args.target ? String(args.target) : undefined;
    const timeout = (args.timeout ? Number(args.timeout) : 120) * 1000;

    // Determine the actual command to run based on project type
    let cmd: string;
    if (cmdType === 'auto' || !cmdType) {
      cmd = repo.testCommand || 'echo "No test command detected"';
    } else if (cmdType === 'test') {
      cmd = repo.testCommand || 'npm test -- --run';
    } else if (cmdType === 'build') {
      cmd = repo.buildCommand || 'npm run build';
    } else if (cmdType === 'typecheck') {
      cmd = repo.typecheckCommand || 'npx tsc --noEmit';
    } else if (cmdType === 'lint') {
      cmd = repo.lintCommand || 'npx eslint .';
    } else {
      cmd = cmdType;
    }

    // If a target is specified, try to incorporate it
    if (target && (cmdType === 'test' || cmd.includes('test'))) {
      cmd = `${cmd} ${target.includes('--') ? '' : '-- '}${target}`.trim();
    }

    return new Promise((resolve) => {
      const start = Date.now();
      const child = spawn('sh', ['-c', cmd], {
        cwd: ctx.cwd,
        env: { ...process.env, AI_AGENT: 'mochi' },
        stdio: 'pipe',
      });

      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(`VERIFICATION TIMEOUT after ${timeout / 1000}s\n${stdout}\n${stderr}`);
      }, timeout);

      child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
      child.stderr?.on('data', (chunk) => { stderr += String(chunk); });

      child.on('close', (code) => {
        clearTimeout(timer);
        const duration = Date.now() - start;
        const output = stdout + (stderr ? `\n[stderr]:\n${stderr}` : '');
        const truncated = output.slice(0, 8000);

        if (code === 0) {
          resolve(`[PASS] Verification PASSED (${Math.round(duration / 1000)}s)\n${truncated}`);
        } else {
          resolve(`[FAIL] Verification FAILED (exit ${code}, ${Math.round(duration / 1000)}s)\n${truncated}`);
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolve(`[ERR] Verification ERROR: ${err.message}`);
      });
    });
  },
};