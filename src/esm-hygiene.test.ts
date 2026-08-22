// ESM hygiene: this package is "type": "module". Bare require() calls compiled
// into dist/*.js throw "require is not defined" in real ESM contexts but are
// silently shimmed by vitest/tsx, which is exactly how a production-only bug
// (bundled skills returning 0 because bundledSkillsDir threw on require() and
// fell back to a CWD walk that missed) shipped once. These tests catch the
// class, not the instance.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundledSkillsDir } from './skills.js';

const srcDir = dirname(dirname(fileURLToPath(import.meta.url)));

function listTsFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      listTsFiles(p, acc);
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
      acc.push(p);
    }
  }
  return acc;
}

// Strip comments so commented-out require() mentions don't trip the scan.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

describe('ESM compatibility', () => {
  it('src has no bare require() calls (use static import or createRequire)', () => {
    const offenders: string[] = [];
    for (const f of listTsFiles(srcDir)) {
      if (f.endsWith('.test.ts')) continue; // vitest shims require; tests aren't shipped
      const body = stripComments(readFileSync(f, 'utf8'));
      const re = /\brequire\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(body))) {
        offenders.push(`${f.replace(srcDir + '/', '')}: ${body.slice(Math.max(0, m.index - 40), m.index + 30).replace(/\n/g, ' ')}`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('bundledSkillsDir is CWD-independent (module-relative, not cwd-relative)', () => {
    const prev = process.cwd();
    const scratch = resolve(tmpdir(), 'mochi-cwd-probe-' + Date.now());
    try {
      mkdirSync(scratch, { recursive: true });
      process.chdir(scratch);
      const d = bundledSkillsDir();
      expect(d, 'bundledSkillsDir must not depend on process.cwd()').toBeTruthy();
      expect(statSync(d).isDirectory()).toBe(true);
    } finally {
      process.chdir(prev);
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
