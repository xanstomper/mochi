import type { Tool } from './types.js';
import { platform, arch, totalmem, freemem, cpus } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function checkVersion(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 3_000 });
    return stdout.trim().split('\n')[0];
  } catch {
    return 'not installed';
  }
}

export const systemInfoTool: Tool = {
  def: {
    name: 'system_info',
    description: 'Inspect the system and developer runtime environment (OS, CPU, memory, toolchain versions like Node, Python, Rust, Go, Git, Docker).',
    parameters: [],
    permission: 'read',
  },
  async execute(_args, ctx) {
    const [nodeV, pyV, rustV, goV, gitV, dockerV] = await Promise.all([
      checkVersion('node', ['--version']),
      checkVersion('python3', ['--version']),
      checkVersion('rustc', ['--version']),
      checkVersion('go', ['version']),
      checkVersion('git', ['--version']),
      checkVersion('docker', ['--version']),
    ]);

    const totalGb = (totalmem() / (1024 * 1024 * 1024)).toFixed(1);
    const freeGb = (freemem() / (1024 * 1024 * 1024)).toFixed(1);
    const cpuInfo = cpus();

    return `# System & Runtime Environment
- **OS Platform:** ${platform()} (${arch()})
- **CPUs:** ${cpuInfo.length} cores (${cpuInfo[0]?.model || 'Generic'})
- **Memory:** ${freeGb} GB free / ${totalGb} GB total
- **Workspace:** ${ctx.cwd}

## Installed Toolchains:
- **Node.js:** ${nodeV}
- **Python:** ${pyV}
- **Rust:** ${rustV}
- **Go:** ${goV}
- **Git:** ${gitV}
- **Docker:** ${dockerV}
`;
  },
};
