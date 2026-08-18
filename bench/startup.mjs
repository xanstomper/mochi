import { execSync } from 'node:child_process';

const N = 20;
let total = 0;
for (let i = 0; i < N; i++) {
  const start = performance.now();
  execSync('node dist/cli.js --version', { cwd: '/home/jewboy420/mochi', stdio: 'ignore' });
  total += performance.now() - start;
}
console.log(`Average startup: ${(total / N).toFixed(2)}ms over ${N} runs`);
