// Frozen verifier for hist-research-roles-registry.
// Ground truth read directly from the fixture file (src/teams/roles.ts,
// verbatim from git commit 953ae4f): 20 role entries (counted three ways —
// top-level record keys, `role: '<id>'` lines, listRoles surface), the
// coder profile lists 53 tools (element-by-element count of its tools
// array), and 8 roles carry defaultModel 'reasoning' (grep -c
// "defaultModel: 'reasoning'" = 8).
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
if (get('ROLES') !== '20') fails.push(`ROLES=${get('ROLES')}, want 20`);
if (get('CODER_TOOLS') !== '53') fails.push(`CODER_TOOLS=${get('CODER_TOOLS')}, want 53`);
if (get('REASONING_MODEL_ROLES') !== '8') fails.push(`REASONING_MODEL_ROLES=${get('REASONING_MODEL_ROLES')}, want 8`);

if (fails.length === 0) {
  console.log('PASS: role registry facts correct (20 roles, coder has 53 tools, 8 roles default to the reasoning model)');
  process.exit(0);
}
console.log(`FAIL: ${fails.join('; ')}`);
