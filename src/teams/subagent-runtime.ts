// Multi-agent runtime support: the structured child-result contract, the
// on-disk child-run store (durability across parent restarts), review-fleet
// aggregation, and small git helpers for worktree children.
//
// The Agent loop owns the live machinery (spawn/collect/cancel); everything
// here is pure or file/git IO so it can be unit-tested without a model.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MochiConfig } from '../types.js';
import type { Workspace } from '../workspace.js';
import type { SpawnAccess } from './presets.js';

export type ChildFindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type ChildVerdict = 'approve' | 'request-changes' | 'comment';
export type ChildOutcomeStatus = 'done' | 'partial' | 'blocked' | 'failed';
export type ChildRunStatus = 'queued' | 'running' | ChildOutcomeStatus | 'cancelled';

export interface ChildFinding {
  severity: ChildFindingSeverity;
  message: string;
  file?: string;
  line?: number;
}

/** The structured result every background/fleet child returns to its parent.
 *  The parent context receives a digest of this; the full record persists. */
export interface ChildRunResult {
  status: ChildOutcomeStatus;
  summary: string;
  findings: ChildFinding[];
  verdict?: ChildVerdict;
  artifacts: string[];
  usage: { tokens: number; toolCalls: number; durationMs: number };
}

export interface ChildWorktreeInfo {
  id: string;
  branch: string;
  path: string;
  baseSha: string;
}

/** Provenance for ONE mid-run steer delivered (or attempted) against a
 *  child run (B21). The steer's raw text is NEVER persisted — only its
 *  sha256, its length, and a REDACTED preview (the run journal's rule:
 *  persisted guidance passes through security.redact()). `deliveredAt` is
 *  stamped by the child itself at the turn boundary where the steer was
 *  actually injected into its context; an event with neither deliveredAt
 *  nor `undelivered` is still in flight. Finalize reconciles: a steer that
 *  never landed gets `undelivered: true` — a steer is never silently
 *  dropped, it is delivered or loudly marked. */
export interface ChildSteerEvent {
  /** When the steer was issued (unix ms). */
  at: number;
  /** Who issued it: the steering agent's id, or 'user' for a human. */
  from: string;
  /** sha256 hex of the exact steer text. */
  hash: string;
  /** Length of the steer text in characters. */
  chars: number;
  /** Redacted preview of the steer text (<= 160 chars). */
  preview: string;
  /** When the child injected the steer into its context (unix ms). */
  deliveredAt?: number;
  /** True when the run ended before the steer could be delivered. */
  undelivered?: boolean;
}

/** Persisted child-run state: `.mochi/state/subagents/<id>.json`. Written at
 *  spawn, on start, and at completion, so a RESTARTED parent process can
 *  still collect a finished child's result from disk. */
export interface ChildRunRecord {
  id: string;
  parentAgentId: string;
  role: string;
  preset?: string;
  promptPreview: string;
  status: ChildRunStatus;
  access: SpawnAccess | 'shared';
  cwd: string;
  worktree?: ChildWorktreeInfo;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: ChildRunResult;
  error?: string;
  /** `git status` + `git diff --stat` of a worktree child's changes. */
  diffSummary?: string;
  /** True once the parent applied (squash-merged) the worktree branch. */
  applied?: boolean;
  /** B21: true once at least one mid-run steer was DELIVERED into this
   *  child's context. Attribution must weight a steered run's outcome
   *  differently from an unsteered one — the success is partly the
   *  steer's, so the flag rides the record (and the trajectory export). */
  steered?: boolean;
  /** B21: every steer issued against this run, in issue order, with
   *  delivery provenance (see ChildSteerEvent). */
  steers?: ChildSteerEvent[];
}

/** System-prompt contract injected for structured (async/fleet) children:
 *  the child's FINAL message must end with a fenced JSON block the parent
 *  can aggregate deterministically. parseChildResult also understands the
 *  legacy <result> footer, so sync spawns keep working unchanged. */
export const STRUCTURED_RESULT_CONTRACT = `[Output contract] End your FINAL message with a fenced JSON block exactly like:
\`\`\`json
{"status":"done","summary":"one-paragraph outcome","findings":[{"severity":"high","file":"src/x.ts","line":88,"message":"what is wrong / noteworthy"}],"verdict":"approve","artifacts":["paths/you/created-or-changed"]}
\`\`\`
Rules: status is one of done|partial|blocked. findings may be [] when there is nothing to report. Include "verdict" ONLY for review tasks: "approve", "request-changes", or "comment". artifacts lists files you created or modified (or []). Do not put anything after the JSON block.`;

const SEVERITIES: ChildFindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

export function normalizeSeverity(raw: unknown): ChildFindingSeverity {
  const s = String(raw ?? '').toLowerCase();
  return (SEVERITIES as string[]).includes(s) ? (s as ChildFindingSeverity) : 'info';
}

export function normalizeVerdict(raw: unknown): ChildVerdict | undefined {
  const s = String(raw ?? '').toLowerCase().replace(/_/g, '-');
  if (['approve', 'approved', 'lgtm', 'accept'].includes(s)) return 'approve';
  if (['request-changes', 'request changes', 'changes-requested', 'reject', 'rejected', 'block'].includes(s)) return 'request-changes';
  if (['comment', 'comments', 'note'].includes(s)) return 'comment';
  return undefined;
}

export interface ChildFallback {
  success: boolean;
  filesModified: string[];
  tokensUsed: number;
  toolCalls: number;
  durationMs: number;
}

/** Parse a child's final summary into the structured contract. Order:
 *  (1) fenced JSON block (structured contract), (2) legacy <result> footer,
 *  (3) plain fallback from the run outcome. Never throws. */
export function parseChildResult(summary: string, fb: ChildFallback): ChildRunResult {
  const usage = { tokens: fb.tokensUsed, toolCalls: fb.toolCalls, durationMs: fb.durationMs };
  const text = summary ?? '';

  const jsonMatch = /```json\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  let lastJson: string | undefined;
  while ((m = jsonMatch.exec(text)) !== null) lastJson = m[1];
  if (lastJson) {
    try {
      const parsed = JSON.parse(lastJson) as Record<string, unknown>;
      const findings: ChildFinding[] = Array.isArray(parsed.findings)
        ? parsed.findings
            .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
            .map((f) => ({
              severity: normalizeSeverity(f.severity),
              message: String(f.message ?? '').slice(0, 500),
              ...(typeof f.file === 'string' && f.file ? { file: f.file } : {}),
              ...(typeof f.line === 'number' && Number.isFinite(f.line) ? { line: f.line } : {}),
            }))
            .filter((f) => f.message.length > 0)
        : [];
      let status = String(parsed.status ?? '').toLowerCase();
      if (!['done', 'partial', 'blocked'].includes(status)) status = fb.success ? 'done' : 'failed';
      // The harness outcome is ground truth: a child the harness failed
      // cannot claim a clean "done".
      if (!fb.success && status === 'done') status = 'partial';
      if (!fb.success && status === 'blocked') status = 'failed';
      const artifacts = Array.isArray(parsed.artifacts)
        ? parsed.artifacts.map(String).filter(Boolean)
        : [];
      return {
        status: status as ChildOutcomeStatus,
        summary: String(parsed.summary ?? '').slice(0, 4000) || text.slice(0, 1000),
        findings,
        verdict: normalizeVerdict(parsed.verdict),
        artifacts: artifacts.length ? artifacts : fb.filesModified,
        usage,
      };
    } catch { /* fall through to the legacy footer */ }
  }

  const legacy = text.match(/<result>\s*STATUS:\s*(\S+)\s*FILES:\s*([^\n]*)\s*RESULT:\s*([\s\S]*?)<\/result>/i);
  if (legacy) {
    const rawStatus = legacy[1].toLowerCase();
    let status: ChildOutcomeStatus = rawStatus === 'done' ? 'done' : rawStatus === 'blocked' ? 'blocked' : 'partial';
    if (!fb.success && status === 'done') status = 'partial';
    const files = legacy[2].trim().toLowerCase() === 'none'
      ? []
      : legacy[2].split(',').map((s) => s.trim()).filter(Boolean);
    return {
      status,
      summary: legacy[3].trim().slice(0, 4000),
      findings: [],
      artifacts: files.length ? files : fb.filesModified,
      usage,
    };
  }

  return {
    status: fb.success ? 'done' : 'failed',
    summary: text.trim().slice(0, 4000),
    findings: [],
    artifacts: fb.filesModified,
    usage,
  };
}

/** On-disk store for child-run records (durability across parent restarts). */
export class ChildRunStore {
  constructor(private readonly workspace: Workspace) {}

  private rel(id: string): string {
    return `state/subagents/${id}.json`;
  }

  save(record: ChildRunRecord): void {
    try {
      this.workspace.writeJson(this.rel(record.id), record);
    } catch { /* persistence must never break a run */ }
  }

  load(id: string): ChildRunRecord | undefined {
    const rec = this.workspace.readJson<ChildRunRecord | undefined>(this.rel(id), undefined);
    return rec && typeof rec === 'object' && rec.id === id ? rec : undefined;
  }

  list(): ChildRunRecord[] {
    const dir = resolve(this.workspace.stateDir, 'subagents');
    if (!existsSync(dir)) return [];
    const out: ChildRunRecord[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const rec = this.load(file.slice(0, -'.json'.length));
      if (rec) out.push(rec);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }
}

const SEVERITY_RANK: Record<ChildFindingSeverity, number> = {
  critical: 0, high: 1, medium: 2, low: 3, info: 4,
};

function findingKey(f: ChildFinding): string {
  const msg = f.message.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  // Line bucketing: two reviewers of the SAME lens-free diff often cite the
  // same defect a few lines apart (88 vs 91) and the aggregate double-reports
  // it. Bucket the line to the nearest multiple of 5 when a file is given —
  // same file + same message + nearby line merges (exact-line findings in
  // files-less messages are unaffected).
  let lineBucket: ChildFinding['line'];
  if (f.file && typeof f.line === 'number') lineBucket = Math.round(f.line / 5);
  return `${f.file ?? ''}|${lineBucket ?? f.line ?? ''}|${msg.slice(0, 80)}`;
}

export interface AggregatedReview {
  verdict: ChildVerdict;
  findings: ChildFinding[];
  /** How many duplicate findings were merged away. */
  duplicatesMerged: number;
  /** Lenses whose reviewer produced no result — non-empty demotes the
   *  verdict to at most comment (a partial review is never an approve). */
  failedLenses: string[];
  summaries: { lens: string; status: ChildOutcomeStatus; summary: string }[];
}

/** Merge N reviewer results over the SAME diff: dedupe findings that point
 *  at the same file+line+issue, sort by severity, and merge verdicts —
 *  any request-changes wins; approve requires every reviewer to approve
 *  AND no reviewer to have failed. */
export function aggregateReviews(
  results: { lens: string; result: ChildRunResult }[],
  opts?: { failedLenses?: string[] },
): AggregatedReview {
  const byKey = new Map<string, ChildFinding>();
  let duplicatesMerged = 0;
  for (const { result } of results) {
    for (const f of result.findings) {
      const key = findingKey(f);
      const existing = byKey.get(key);
      if (existing) {
        duplicatesMerged++;
        // Keep the more severe rating of the duplicates.
        if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[existing.severity]) {
          byKey.set(key, { ...f });
        }
      } else {
        byKey.set(key, { ...f });
      }
    }
  }
  const findings = [...byKey.values()].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
  const verdicts = results.map((r) => r.result.verdict);
  // A crashed reviewer is not a pass: lenses that produced no result are
  // passed in via failedLenses and demote the verdict to comment — a partial
  // review must never read as APPROVE (mirrors parseChildResult's rule that
  // the harness outcome is ground truth).
  const failedLenses = opts?.failedLenses ?? [];
  const verdict: ChildVerdict = verdicts.includes('request-changes')
    ? 'request-changes'
    : failedLenses.length === 0 && verdicts.length > 0 && verdicts.every((v) => v === 'approve')
      ? 'approve'
      : 'comment';
  return {
    verdict,
    findings,
    duplicatesMerged,
    failedLenses,
    summaries: results.map((r) => ({
      lens: r.lens,
      status: r.result.status,
      summary: r.result.summary,
    })),
  };
}

/** One-line steer provenance for digests: how many steers were issued,
 *  how many actually landed, and who sent them. Empty when unsteered. */
export function formatSteerLine(record: ChildRunRecord): string {
  const steers = record.steers ?? [];
  if (!steers.length) return '';
  const delivered = steers.filter((s) => s.deliveredAt !== undefined).length;
  const lost = steers.filter((s) => s.undelivered).length;
  const froms = [...new Set(steers.map((s) => s.from))].join(', ');
  return `Steered: ${delivered}/${steers.length} steer(s) delivered (from ${froms})${lost ? ` · ${lost} NOT delivered` : ''} — this run's outcome was partly directed mid-run; weight attribution accordingly.`;
}

/** Compact digest of one child run for the parent's context. The full
 *  transcript lives in the child's own session/trace records; this is the
 *  fold-back summary the parent model actually reads. */
export function formatChildDigest(record: ChildRunRecord): string {
  const who = `Subagent ${record.id} (${record.preset ?? record.role})`;
  if (record.status === 'queued') {
    return `${who} — QUEUED (waiting for a free concurrency slot). Collect later with collect_agent {id: "${record.id}"}.`;
  }
  if (record.status === 'running') {
    const secs = record.startedAt ? Math.max(0, Math.round((Date.now() - record.startedAt) / 1000)) : 0;
    const steerLine = formatSteerLine(record);
    return `${who} — still RUNNING (${secs}s elapsed). Keep working; collect later with collect_agent {id: "${record.id}"}.${steerLine ? `\n${steerLine}` : ''}`;
  }
  if (record.status === 'cancelled') {
    return `${who} — CANCELLED${record.error ? `: ${record.error}` : ''}.`;
  }
  const r = record.result;
  if (!r) {
    return `${who} — ${record.status.toUpperCase()}${record.error ? `: ${record.error}` : ''}.`;
  }
  const secs = (r.usage.durationMs / 1000).toFixed(1);
  const lines: string[] = [
    `${who} — ${r.status.toUpperCase()} in ${secs}s · ${r.usage.tokens.toLocaleString()} tokens · ${r.usage.toolCalls} tool calls`,
    `Summary: ${r.summary}`,
  ];
  const steerLine = formatSteerLine(record);
  if (steerLine) lines.push(steerLine);
  if (r.verdict) lines.push(`Verdict: ${r.verdict}`);
  if (r.findings.length) {
    lines.push(`Findings (${r.findings.length}):`);
    for (const f of r.findings.slice(0, 20)) {
      const loc = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ''} —` : '';
      lines.push(`- [${f.severity}]${loc} ${f.message}`);
    }
    if (r.findings.length > 20) lines.push(`- …and ${r.findings.length - 20} more (full record: .mochi/state/subagents/${record.id}.json)`);
  }
  if (r.artifacts.length) lines.push(`Artifacts: ${r.artifacts.join(', ')}`);
  if (record.worktree) {
    lines.push(
      record.applied
        ? `Worktree ${record.worktree.branch} was APPLIED (squash-merged) into this tree.`
        : `Worktree: branch ${record.worktree.branch} at ${record.worktree.path} — NOT applied to your tree. Diff: ${record.diffSummary ?? 'n/a'}. Apply with collect_agent {id: "${record.id}", apply: true}; discard with cancel_agent {id: "${record.id}"}.`,
    );
  }
  return lines.join('\n');
}

/** Format the aggregated multi-reviewer report for the parent. */
export function formatFleetReport(
  agg: AggregatedReview,
  meta: { target: string; reviewers: number },
): string {
  const lines: string[] = [
    `Review fleet over ${meta.target}: ${meta.reviewers} reviewer(s) · verdict: ${agg.verdict.toUpperCase()} · ${agg.findings.length} unique finding(s)${agg.duplicatesMerged ? ` (${agg.duplicatesMerged} duplicate(s) merged)` : ''}${agg.failedLenses.length ? ` · ⚠ ${agg.failedLenses.length} lens(es) FAILED, no result: ${agg.failedLenses.join(', ')} — this is a PARTIAL review` : ''}`,
  ];
  for (const s of agg.summaries) {
    lines.push(`- [${s.lens}] ${s.status}: ${s.summary.slice(0, 300)}`);
  }
  if (agg.findings.length) {
    lines.push('Findings:');
    for (const f of agg.findings.slice(0, 30)) {
      const loc = f.file ? ` ${f.file}${f.line ? `:${f.line}` : ''} —` : '';
      lines.push(`- [${f.severity}]${loc} ${f.message}`);
    }
  }
  return lines.join('\n');
}

/** Delegation-depth rule: an agent at `depth` may spawn children only while
 *  depth < maxDepth (children land at depth+1). */
export function canSpawnAtDepth(depth: number, maxDepth: number): boolean {
  return depth < maxDepth;
}

export function resolveMaxSubagentDepth(config: MochiConfig): number {
  const d = config.safety?.maxSubagentDepth;
  return typeof d === 'number' && Number.isFinite(d) ? Math.max(0, Math.floor(d)) : 2;
}

export function resolveMaxConcurrentSubagents(config: MochiConfig): number {
  const c = config.safety?.maxConcurrentSubagents ?? config.safety?.maxConcurrentAgents;
  return typeof c === 'number' && Number.isFinite(c) ? Math.max(1, Math.floor(c)) : 4;
}

// ---------------------------------------------------------------------------
// Git helpers for worktree children + review fleets (best-effort, never throw
// into a run: failures degrade to explanatory strings).

export function gitOut(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(' ')}: ${(stderr as string) || err.message}`));
      else resolvePromise((stdout as string).trim());
    });
  });
}

/** True when `cwd` is inside a git working tree. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    return (await gitOut(cwd, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch {
    return false;
  }
}

/** The workspace state dir (`.mochi`) is harness state, not a deliverable:
 *  a child's own run writes memory/session files under `<cwd>/.mochi`, and
 *  committing those into its branch makes the parent's squash-merge collide
 *  with the parent's own untracked `.mochi` files ("untracked working tree
 *  files would be overwritten"). Worktree commits and diff summaries
 *  therefore exclude it. */
export const WORKTREE_EXCLUDE_PATHSPECS = [':(exclude).mochi', ':(exclude).mochi/**'];

/** Commit every change inside a worktree onto its branch so the branch —
 *  not just the checkout — carries the child's work (required before a
 *  squash-merge can see it). Returns true when a commit was created. */
export async function commitWorktreeChanges(wtPath: string, message: string): Promise<boolean> {
  const status = await gitOut(wtPath, ['status', '--porcelain']).catch(() => '');
  if (!status) return false;
  await gitOut(wtPath, ['add', '-A', '--', '.', ...WORKTREE_EXCLUDE_PATHSPECS]);
  const staged = await gitOut(wtPath, ['diff', '--cached', '--name-only']).catch(() => '');
  if (!staged) return false; // only harness state changed — nothing to carry
  await gitOut(wtPath, [
    '-c', 'user.name=mochi-subagent', '-c', 'user.email=mochi-subagent@localhost',
    'commit', '-m', message,
  ]);
  return true;
}

/** Human diff summary for a worktree child: changed-file list + --stat
 *  against the base commit the worktree was branched from. */
export async function summarizeWorktreeDiff(wtPath: string, baseSha: string): Promise<string> {
  const names = await gitOut(wtPath, ['diff', '--name-only', baseSha, '--', '.', ...WORKTREE_EXCLUDE_PATHSPECS]).catch(() => '');
  const stat = await gitOut(wtPath, ['diff', '--stat', baseSha, '--', '.', ...WORKTREE_EXCLUDE_PATHSPECS]).catch(() => '');
  const files = names ? names.split('\n').filter(Boolean) : [];
  if (!files.length) return 'no file changes';
  const statTail = stat ? stat.split('\n').slice(-1)[0]?.trim() : '';
  return `${files.length} file(s): ${files.slice(0, 10).join(', ')}${files.length > 10 ? ', …' : ''}${statTail ? ` · ${statTail}` : ''}`;
}

/** Diff text for a review fleet: `target` is 'working' (vs HEAD, including
 *  untracked file names) or a ref/range passed to `git diff`. Capped so a
 *  huge diff cannot blow the reviewers' contexts. */
export async function captureReviewDiff(
  cwd: string,
  target: string,
  capChars = 80_000,
): Promise<{ label: string; diff: string }> {
  let label: string;
  let diff: string;
  if (!target || target === 'working') {
    label = 'working tree vs HEAD';
    diff = await gitOut(cwd, ['diff', 'HEAD']).catch(() => '');
    const untracked = await gitOut(cwd, ['ls-files', '--others', '--exclude-standard']).catch(() => '');
    if (untracked) {
      const files = untracked.split('\n').filter(Boolean).slice(0, 50);
      diff += `\n\n[Untracked files]\n${files.join('\n')}`;
      // A filename list is not reviewable: new files (tests, modules) carry
      // the change under review, yet reviewers only got names. Inline a
      // capped content snippet per file so a fleet review of a mostly-new
      // change has something to judge.
      let snippetBudget = 20_000;
      const snippets: string[] = [];
      for (const f of files) {
        if (snippetBudget <= 0) break;
        const body = await readFile(resolve(cwd, f), 'utf8')
          .then((r) => r.slice(0, 4_000))
          .catch(() => '');
        if (!body) continue;
        const piece = `\n[Untracked file: ${f}]\n${body}${body.length >= 4_000 ? '\n… [truncated]' : ''}`;
        snippets.push(piece);
        snippetBudget -= piece.length;
      }
      if (snippets.length) diff += snippets.join('');
    }
  } else {
    label = target;
    diff = await gitOut(cwd, ['diff', target]).catch(() => '');
  }
  if (diff.length > capChars) {
    diff = `${diff.slice(0, capChars)}\n\n[diff truncated at ${capChars} chars — review the remainder with the diff/read tools]`;
  }
  return { label, diff: diff || '(no diff — nothing changed)' };
}
