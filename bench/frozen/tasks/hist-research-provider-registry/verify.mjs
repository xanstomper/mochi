// Frozen verifier for hist-research-provider-registry.
// Ground truth read directly from the fixture file (src/model/providers.ts,
// verbatim from git commit 953ae4f): 41 provider entries
// (grep -c "{ id: '" = 41, including the double-quoted entries),
// antigravity defaultModel 'gemini-3.8-flash', and ollama as the provider
// on baseUrl port 11434.
// Runs with cwd = the task workdir. Exit 0 = pass, 1 = fail.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const p = join(process.cwd(), 'answer.txt');
if (!existsSync(p)) {
  console.log('FAIL: answer.txt not found in the workdir');
  process.exit(1);
}
const text = readFileSync(p, 'utf8');
const get = (key) => {
  const m = new RegExp(`^${key}=(.+)$`, 'm').exec(text);
  return m ? m[1].trim() : null;
};
const fails = [];
if (get('PROVIDERS') !== '41') fails.push(`PROVIDERS=${get('PROVIDERS')}, want 41`);
if (get('ANTIGRAVITY_DEFAULT_MODEL') !== 'gemini-3.8-flash') fails.push(`ANTIGRAVITY_DEFAULT_MODEL=${get('ANTIGRAVITY_DEFAULT_MODEL')}, want gemini-3.8-flash`);
if (get('LOCAL_11434_PROVIDER') !== 'ollama') fails.push(`LOCAL_11434_PROVIDER=${get('LOCAL_11434_PROVIDER')}, want ollama`);

if (fails.length === 0) {
  console.log('PASS: provider registry facts correct (41 providers, antigravity default gemini-3.8-flash, port 11434 = ollama)');
  process.exit(0);
}
console.log(`FAIL: ${fails.join('; ')}`);
process.exit(1);
