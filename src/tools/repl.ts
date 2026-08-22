import { createContext, runInContext } from 'node:vm';
import { exec } from 'node:child_process';
import type { Tool } from './types.js';

let sharedJsContext: any = null;

function getSharedJsContext() {
  if (!sharedJsContext) {
    const sandbox = {
      console: {
        log: (...args: any[]) => sandbox.__logs.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')),
        error: (...args: any[]) => sandbox.__logs.push('[ERR] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')),
        warn: (...args: any[]) => sandbox.__logs.push('[WARN] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')),
      },
      __logs: [] as string[],
      Math,
      Date,
      JSON,
      Buffer,
      process: { env: { ...process.env } },
    };
    sharedJsContext = createContext(sandbox);
  }
  return sharedJsContext;
}

export const replTool: Tool = {
  def: {
    name: 'repl',
    description:
      'Evaluate code snippets interactively in a stateful runtime (JavaScript/Node.js, Python, or Shell). ' +
      'Ideal for testing expressions, inspecting algorithms, or calculating results without spawning heavy subprocesses.',
    parameters: [
      { name: 'code', type: 'string', description: 'The code to execute', required: true },
      {
        name: 'language',
        type: 'string',
        description: 'Runtime environment: "javascript" (or "js"/"ts"), "python" (or "py"), or "shell" (or "bash")',
        required: false,
      },
      { name: 'reset', type: 'boolean', description: 'Reset the persistent REPL environment before executing', required: false },
    ],
    permission: 'shell',
  },
  async execute(args, ctx) {
    const code = String(args.code ?? '').trim();
    if (!code) throw new Error('code is required');

    const lang = (String(args.language ?? 'javascript')).toLowerCase();
    const reset = Boolean(args.reset);

    if (lang === 'javascript' || lang === 'js' || lang === 'typescript' || lang === 'ts') {
      if (reset) sharedJsContext = null;
      const context = getSharedJsContext();
      context.__logs = [];
      try {
        const result = runInContext(code, context, { timeout: 5000 });
        const logs = context.__logs.join('\n');
        const formattedRes = result !== undefined ? (typeof result === 'object' ? JSON.stringify(result, null, 2) : String(result)) : '';
        const output = [logs, formattedRes ? `=> ${formattedRes}` : ''].filter(Boolean).join('\n');
        return output || '=> undefined';
      } catch (err) {
        const logs = context.__logs.join('\n');
        const errStr = err instanceof Error ? err.stack || err.message : String(err);
        return [logs, `[REPL ERROR]: ${errStr}`].filter(Boolean).join('\n');
      }
    }

    if (lang === 'python' || lang === 'py') {
      return new Promise<string>((resolve) => {
        const proc = exec('python3 -c ' + JSON.stringify(code), { cwd: ctx.cwd, timeout: 5000 }, (error, stdout, stderr) => {
          if (error) {
            resolve(`[PYTHON ERROR (exit ${error.code ?? 1})]:\n${stderr || error.message}`);
          } else {
            resolve((stdout + (stderr ? `\n[stderr]: ${stderr}` : '')).trim() || '=> Done (no output)');
          }
        });
      });
    }

    // Default to shell execution
    return new Promise<string>((resolve) => {
      exec(code, { cwd: ctx.cwd, timeout: 10000 }, (error, stdout, stderr) => {
        if (error) {
          resolve(`[SHELL ERROR (exit ${error.code ?? 1})]:\n${stderr || error.message}`);
        } else {
          resolve((stdout + (stderr ? `\n[stderr]: ${stderr}` : '')).trim() || '=> Done (no output)');
        }
      });
    });
  },
};
