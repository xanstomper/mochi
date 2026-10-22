/**
 * Deterministic task scaffold builder.
 *
 * Builds a structured pre-flight brief for an engineering task with NO model
 * calls: template invariants / boundary conditions / hazard mitigations
 * selected by the regex task classifier and the detected repo, an execution
 * checklist whose commands come from the repo's own build/test scripts, plus
 * two genuinely grounded sections — real symbols looked up in the codegraph
 * and failure traps extracted from prior run autopsies. Earlier versions
 * dressed this up as a "dense synthetic dataset" produced by "cellular MoE
 * expansion"; the expert objects were pure bookkeeping whose only observable
 * effect was a cell count in the header, so that layer was removed.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { classifyTask, TaskDomain } from './task-classifier.js';
import { detectRepo } from '../repo/repo.js';
import { querySymbolGraphSync, hasSqlite } from '../repo/codegraph.js';

export interface TaskScaffold {
  objective: string;
  domain: TaskDomain;
  difficultyScore: number;
  invariants: string[];
  failureModes: { hazard: string; mitigation: string; severity: 'high' | 'medium' | 'low' }[];
  boundaryConditions: string[];
  executionDag: { step: number; action: string; validation: string }[];
  domainMatrix: Record<string, string>;
  rawScaffoldText: string;
}

/**
 * Builds the deterministic scaffold for a task: classify it, detect the repo,
 * ground it in codegraph symbols and autopsy traps, and render the brief.
 */
export function buildTaskScaffold(task: string, cwd?: string): TaskScaffold {
  const root = cwd ?? process.cwd();
  const repo = detectRepo(root);
  const classification = classifyTask(task);

  // Extract real symbols matching task keywords from AST codegraph if available
  const foundSymbols: string[] = [];
  if (hasSqlite()) {
    try {
      const words = task
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .split(/\W+/)
        .filter((w) => w.length >= 4 && !['implement', 'create', 'update', 'refactor', 'function', 'class', 'method'].includes(w.toLowerCase()));
      for (const word of words.slice(0, 3)) {
        const res = querySymbolGraphSync(root, `SELECT file, name, line, kind FROM symbols WHERE name LIKE '%${word.replace(/['"]/g, '')}%' LIMIT 3`);
        if (!res || !('rows' in res) || !Array.isArray(res.rows)) continue;
        for (const row of res.rows as Array<{ file?: unknown; name?: unknown; line?: unknown; kind?: unknown }>) {
          if (row?.file && row?.name) {
            foundSymbols.push(`${row.file}:${row.line ?? 1} (${row.kind ?? 'symbol'} ${row.name})`);
          }
        }
      }
    } catch {
      /* continue */
    }
  }

  // Template invariants selected by classified domain and repo language
  const invariants: string[] = [
    'Byte-level idempotency: operations must produce identical state when executed multiple times.',
    'Surgical locality: touch only strictly required symbols to preserve adjacent system stability.',
    'Zero-data-loss: destructive operations require explicit pre-mutation backups or transactional rollback.',
    'Verification parity: success is gated on automated test pass and static type conformance.',
  ];

  if (repo.language === 'ts' || repo.language === 'typescript') {
    invariants.push('Strict typing: zero implicit any, handle all nullish branches explicitly.');
  } else if (repo.language === 'rust' || repo.language === 'rs') {
    invariants.push('Memory safety: zero out-of-bounds access, use-after-free, or unbounded heap growth.');
    invariants.push('Rust ownership: satisfy borrow checker without superfluous clones.');
  } else if (repo.language === 'go') {
    invariants.push('Go error hygiene: explicitly check and wrap all returned err != nil.');
  }

  if (classification.domain === 'systems_programming') {
    invariants.push('Concurrency hygiene: prevent deadlocks via strict lock ordering and non-blocking channels.');
  } else if (classification.domain === 'database_infra') {
    invariants.push('ACID guarantee: multi-table updates wrapped in atomic transactions.');
    invariants.push('Index coverage: all search predicates backed by b-tree or hash indexes.');
  } else if (classification.domain === 'security_audit') {
    invariants.push('Zero-trust input sanitization: escape all user-controlled strings at parser boundaries.');
    invariants.push('Constant-time comparisons for cryptographic signatures and authentication tokens.');
  }

  // Check for prior failed attempts in autopsies to prevent repeating traps
  const autopsyDir = resolve(root, '.mochi/autopsies');
  const priorTraps: string[] = [];
  if (existsSync(autopsyDir)) {
    try {
      const files = readdirSync(autopsyDir).filter((f) => f.endsWith('.json')).slice(-3);
      for (const f of files) {
        const raw = JSON.parse(readFileSync(join(autopsyDir, f), 'utf8'));
        if (raw?.attempts && Array.isArray(raw.attempts)) {
          for (const att of raw.attempts) {
            if (att.outcome === 'still_failing' || att.statusAfter === 'refuted') {
              priorTraps.push(`${att.hypothesisText || att.action} (Evidence: ${String(att.evidence).slice(0, 80)})`);
            }
          }
        }
      }
    } catch {
      /* continue */
    }
  }

  // Template failure modes and mitigations
  const failureModes: TaskScaffold['failureModes'] = [
    {
      hazard: 'Unchecked null/undefined propagation causing unhandled rejection or panic',
      mitigation: 'Enforce strict schema validation and nullish coalescing operators at entry boundaries',
      severity: 'high',
    },
    {
      hazard: 'State divergence during asynchronous retry loops',
      mitigation: 'Implement exponential backoff with jitter and idempotency keys',
      severity: 'medium',
    },
    {
      hazard: 'Memory accumulation in unbounded event listener or cache maps',
      mitigation: 'Use WeakMap/LRU cache structures with strict size caps and eviction hooks',
      severity: 'high',
    },
  ];

  const boundaryConditions: string[] = [
    'Empty input (0 bytes / empty collection) handled gracefully without panic',
    'Maximum throughput boundary: rate limiters throttle cleanly with standard 429 status',
    'Malformed or truncated payloads rejected with structured diagnostics',
    'Unicode / multi-byte character strings preserved without offset corruption',
  ];

  const buildCmd = repo.typecheckCommand ?? repo.buildCommand ?? 'typecheck';
  const testCmd = repo.testCommand ?? 'automated test suite';

  const executionDag: TaskScaffold['executionDag'] = [
    {
      step: 1,
      action: foundSymbols.length > 0
        ? `Inspect existing AST contracts for: ${foundSymbols.slice(0, 3).join(', ')}`
        : 'Inspect existing symbol definitions and AST contracts in workspace',
      validation: 'Verify target file existence, line numbers, and export signatures',
    },
    {
      step: 2,
      action: 'Derive atomic implementation following domain invariants',
      validation: `Run \`${buildCmd}\` and verify zero lint or type errors`,
    },
    {
      step: 3,
      action: `Execute automated verification with \`${testCmd}\``,
      validation: 'All assertions pass with 100% exit code 0 confirmation',
    },
  ];

  const domainMatrix: Record<string, string> = {
    Domain: classification.domain,
    Difficulty: `${classification.difficulty}/10`,
    Strategy: classification.recommendedStrategy,
    Language: repo.language ?? 'unknown',
    TestRunner: repo.testCommand ?? 'unknown',
  };

  const rawLines = [
    `# TASK SCAFFOLD (deterministic brief — template invariants + repo/codegraph grounding; no model calls, no generated dataset)`,
    `Objective: ${task}`,
    `Domain: ${classification.domain} (Difficulty: ${classification.difficulty}/10 | Language: ${repo.language ?? 'generic'})`,
    '',
    `## 1. System Invariants`,
    ...invariants.map((inv, i) => `  ${i + 1}. [INV-${i + 1}] ${inv}`),
    '',
    `## 2. Boundary Conditions`,
    ...boundaryConditions.map((bc, i) => `  ${i + 1}. [BOUND-${i + 1}] ${bc}`),
    '',
    `## 3. Hazard Mitigation Matrix`,
    ...failureModes.map((fm) => `  • Hazard: ${fm.hazard}\n    Mitigation: ${fm.mitigation} (${fm.severity.toUpperCase()} risk)`),
  ];

  if (priorTraps.length > 0) {
    rawLines.push('', '## Known Failure Traps (From Autopsy)');
    priorTraps.forEach((trap, i) => rawLines.push(`  ${i + 1}. [TRAP-${i + 1}] ${trap}`));
  }

  if (foundSymbols.length > 0) {
    rawLines.push('', '## Grounded AST Symbols');
    foundSymbols.slice(0, 4).forEach((sym, i) => rawLines.push(`  • Symbol ${i + 1}: ${sym}`));
  }

  rawLines.push(
    '',
    `## 4. Execution DAG`,
    ...executionDag.map((dag) => `  Step ${dag.step}: ${dag.action} -> Verify: ${dag.validation}`),
  );

  return {
    objective: task,
    domain: classification.domain,
    difficultyScore: classification.difficulty,
    invariants,
    failureModes,
    boundaryConditions,
    executionDag,
    domainMatrix,
    rawScaffoldText: rawLines.join('\n'),
  };
}
