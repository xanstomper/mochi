/**
 * DOX — Documentation Operations eXchange (Cognitive Framework 2.0)
 * 
 * AGENTS.md hierarchy protocol that treats documentation as a binding work contract.
 * Phase 1: Read Before Editing (Load contract hierarchy)
 * Phase 2: Update After Editing (Closeout audit)
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, relative, join } from 'node:path';

export interface DoxContract {
  constraints: string[];
  applicableDocs: string[];
  scope: string;
}

/**
 * Finds all AGENTS.md / CLAUDE.md / MOCHI.md files from repo root down to target file.
 */
export function findDoxChain(cwd: string, targetPath: string): string[] {
  const fullTarget = resolve(cwd, targetPath);
  const chain: string[] = [];
  let curr = existsSync(fullTarget) && !fullTarget.endsWith('/') ? dirname(fullTarget) : fullTarget;
  const root = resolve(cwd);

  const checkedDirs = new Set<string>();
  while (curr.startsWith(root) && !checkedDirs.has(curr)) {
    checkedDirs.add(curr);
    for (const name of ['AGENTS.md', 'MOCHI.md', 'CLAUDE.md']) {
      const p = join(curr, name);
      if (existsSync(p) && !chain.includes(p)) {
        chain.unshift(p); // Root-most first
      }
    }
    if (curr === root) break;
    curr = dirname(curr);
  }

  return chain;
}

/**
 * Reads and extracts operational constraints from applicable DOX hierarchy.
 */
export function loadDoxContract(cwd: string, targetPath = '.'): DoxContract {
  const chain = findDoxChain(cwd, targetPath);
  const constraints: string[] = [];
  const applicableDocs: string[] = [];

  for (const doc of chain) {
    try {
      const content = readFileSync(doc, 'utf8');
      applicableDocs.push(relative(cwd, doc));
      
      // Extract rules, constraints, bullet points with MUST/SHOULD/NEVER
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (/^[-*]\s+.*\b(must|never|always|do not|require|prohibited|critical)\b/i.test(trimmed)) {
          constraints.push(trimmed.replace(/^[-*]\s+/, ''));
        }
      }
    } catch {
      /* continue */
    }
  }

  return {
    constraints,
    applicableDocs,
    scope: targetPath,
  };
}

/**
 * Phase 2 closeout check to audit if modified files need documentation sync.
 */
export function auditDoxCloseout(cwd: string, mutatedFiles: string[]): { needsUpdate: boolean; summary: string } {
  if (mutatedFiles.length === 0) {
    return { needsUpdate: false, summary: 'No files modified.' };
  }

  const docFiles = mutatedFiles.filter((f) => f.endsWith('.md') || f.includes('docs/'));
  const codeFiles = mutatedFiles.filter((f) => !f.endsWith('.md') && !f.includes('docs/'));

  if (codeFiles.length > 0 && docFiles.length === 0) {
    return {
      needsUpdate: true,
      summary: `Code changed in ${codeFiles.length} file(s). Verify if architectural contracts in AGENTS.md or docs require sync.`,
    };
  }

  return {
    needsUpdate: false,
    summary: `DOX verified: documentation changes present alongside code updates.`,
  };
}
