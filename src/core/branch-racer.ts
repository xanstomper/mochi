// Speculative Multi-Path Branch Racer for Mochi
// Concurrently trials alternative implementation patches in isolated ephemeral git worktrees,
// runs deterministic verification in parallel, and instantly promotes the winning patch.

import {existsSync, writeFileSync, mkdirSync} from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { WorktreeManager } from '../repo/worktree.js';
import { detectRepo } from '../repo/repo.js';
import { runShellString } from '../exec.js';
import { atomicWriteFileSync } from './atomic-fs.js';

export interface BranchTrialPatch {
  filePath: string;
  newContent: string;
}

export interface BranchCandidate {
  name: string;
  patches: BranchTrialPatch[];
  description?: string;
  /** Optional verifier score from speculative planning; higher wins among passing candidates. */
  score?: number;
}

export interface BranchRaceResult {
  winner?: {
    name: string;
    durationMs: number;
    testOutput: string;
  };
  candidatesEvaluated: {
    name: string;
    passed: boolean;
    durationMs: number;
    output: string;
  }[];
  appliedToPrimary: boolean;
  summary: string;
}

export interface BranchRaceOptions {
  /** Wall-clock budget for each candidate's verification command.
   *  Precedence: raceCandidates option > constructor option >
   *  MOCHI_BRANCH_RACE_TIMEOUT_MS env > DEFAULT_BRANCH_RACE_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Max candidates evaluated concurrently. Default 4. */
  maxConcurrency?: number;
}

export const DEFAULT_BRANCH_RACE_TIMEOUT_MS = 120_000;
export const DEFAULT_BRANCH_RACE_MAX_CONCURRENCY = 4;

function parsePositiveNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function resolveVerificationTimeoutMs(explicit?: number): number {
  return (
    parsePositiveNumber(explicit) ??
    parsePositiveNumber(process.env.MOCHI_BRANCH_RACE_TIMEOUT_MS) ??
    DEFAULT_BRANCH_RACE_TIMEOUT_MS
  );
}

function resolveMaxConcurrency(explicit?: number): number {
  const parsed = parsePositiveNumber(explicit);
  if (parsed === undefined) return DEFAULT_BRANCH_RACE_MAX_CONCURRENCY;
  return Math.max(1, Math.floor(parsed));
}

export class SpeculativeBranchRacer {
  private worktreeMgr: WorktreeManager;

  constructor(private primaryCwd: string, mochiDir?: string, private defaultOptions: BranchRaceOptions = {}) {
    this.worktreeMgr = new WorktreeManager(primaryCwd, mochiDir || resolve(primaryCwd, '.mochi'));
  }

  /**
   * Concurrently races multiple patch candidates across isolated worktrees.
   * Evaluates each with the verification command and promotes the passing branch.
   */
  async raceCandidates(
    candidates: BranchCandidate[],
    verificationCmd?: string,
    options?: BranchRaceOptions
  ): Promise<BranchRaceResult> {
    if (candidates.length === 0) {
      return {
        candidatesEvaluated: [],
        appliedToPrimary: false,
        summary: 'No candidates provided for speculative race.',
      };
    }

    const repo = detectRepo(this.primaryCwd);
    const testCmd = (verificationCmd || repo.testCommand)?.trim();
    if (!testCmd) {
      return {
        candidatesEvaluated: candidates.map(({ name }) => ({
          name, passed: false, durationMs: 0,
          output: 'Not run: no verification command configured.',
        })),
        appliedToPrimary: false,
        summary: 'Speculative candidates could not be verified: no verification command configured.',
      };
    }

    const timeoutMs = resolveVerificationTimeoutMs(options?.timeoutMs ?? this.defaultOptions.timeoutMs);
    const maxConcurrency = resolveMaxConcurrency(options?.maxConcurrency ?? this.defaultOptions.maxConcurrency);

    const evaluationResults: BranchRaceResult['candidatesEvaluated'] = [];
    const passing = new Map<number, { candidate: BranchCandidate; output: string; durationMs: number }>();

    const evaluateCandidate = async (candidate: BranchCandidate, idx: number): Promise<void> => {
        const branchLabel = `spec-trial-${idx}`;
        let worktreeInfo: { id: string; path: string; branch: string } | null = null;

        try {
          // 1. Provision ephemeral worktree
          try {
            worktreeInfo = await this.worktreeMgr.create(branchLabel);
          } catch {
            // If not in a git repo, skip worktree isolation and evaluate candidate directly if single candidate
            return;
          }

          const worktreePath = worktreeInfo.path;

          // 2. Apply candidate patches in worktree
          for (const patch of candidate.patches) {
            const target = resolve(worktreePath, patch.filePath);
            const rel = relative(worktreePath, target);
            if (isAbsolute(patch.filePath) || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
              throw new Error(`Patch path escapes worktree: ${patch.filePath}`);
            }
            const dir = dirname(target);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            writeFileSync(target, patch.newContent);
          }

          // 3. Run verification command
          const startTime = Date.now();
          let passed = false;
          let output = '';

          if (testCmd) {
            try {
              // Run through the central shell executor (src/exec.ts), NOT
              // `testCmd.split(' ')` + execFile: the old split broke quoted
              // arguments ("a b"), multi-word scripts, `&&` chains, env
              // assignments (NODE_ENV=test …) and flags with quoted values.
              // runShellString runs the string via a real shell, so all of
              // those work verbatim. Importing it is cycle-free: exec.ts
              // imports only Node builtins (no core/ or repo/ imports).
              // It never rejects on non-zero exit — pass/fail comes from
              // the result's code/timedOut/cancelled fields instead.
              const result = await runShellString(testCmd, {
                cwd: worktreePath,
                timeoutMs,
              });
              output = result.stdout + '\n' + result.stderr;
              passed = result.code === 0 && !result.timedOut && !result.cancelled;
              if (result.timedOut) {
                output += `\nVerification timed out after ${timeoutMs}ms.`;
              } else if (result.cancelled) {
                output += '\nVerification was cancelled.';
              } else if (result.code !== 0) {
                output += `\nVerification exited with code ${result.code}.`;
              }
            } catch (err: any) {
              output = err instanceof Error ? err.message : String(err);
              passed = false;
            }
          } else {
            passed = false;
            output = 'Not verified: no test command configured.';
          }

          const durationMs = Date.now() - startTime;

          evaluationResults[idx] = {
            name: candidate.name,
            passed,
            durationMs,
            output: output.slice(0, 2000),
          };

          if (passed) passing.set(idx, { candidate, output, durationMs });
        } catch (err) {
          evaluationResults[idx] = { name: candidate.name, passed: false, durationMs: 0, output: err instanceof Error ? err.message : String(err) };
        } finally {
          // Cleanup ephemeral worktree
          if (worktreeInfo) {
            try {
              await this.worktreeMgr.discard(worktreeInfo.id);
            } catch {}
          }
        }
    };

    // Run candidates in parallel worktrees, with bounded concurrency:
    // a small worker pool pulls candidate indexes in order. Results stay
    // indexed by candidate index (evaluationResults[idx] / passing by idx),
    // so candidate-order determinism is preserved regardless of which
    // candidate finishes first.
    let nextIdx = 0;
    const workerCount = Math.min(maxConcurrency, candidates.length);
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          const idx = nextIdx++;
          if (idx >= candidates.length) return;
          await evaluateCandidate(candidates[idx], idx);
        }
      })
    );


    const winning = [...passing.entries()]
      .map(([index, result]) => ({ ...result, index }))
      .sort((a, b) => (b.candidate.score ?? 0) - (a.candidate.score ?? 0) || a.index - b.index)[0];

    // Promote only a verified candidate, preserving deterministic ranking.
    let appliedToPrimary = false;
    if (winning) {
      for (const patch of winning.candidate.patches) {
        const primaryFile = resolve(this.primaryCwd, patch.filePath);
        const rel = relative(this.primaryCwd, primaryFile);
        if (isAbsolute(patch.filePath) || rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) continue;
        const dir = dirname(primaryFile);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        // Atomic write (temp sibling + rename) so a crash mid-promotion
        // can never leave a torn/half-written file in the primary tree.
        atomicWriteFileSync(primaryFile, patch.newContent);
      }
      appliedToPrimary = true;
    }

    const summary = winning
      ? `Speculative race winner: "${winning.candidate.name}" passed verification in ${winning.durationMs}ms and was promoted to workspace.`
      : `Speculative race: All ${candidates.length} candidate branches failed verification.`;

    return {
      winner: winning ? {
        name: winning.candidate.name,
        durationMs: winning.durationMs!,
        testOutput: winning.output!,
      } : undefined,
      candidatesEvaluated: evaluationResults,
      appliedToPrimary,
      summary,
    };
  }
}
