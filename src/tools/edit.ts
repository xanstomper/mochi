import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { Tool } from './types.js';
import { markMutation } from './fs-signal.js';
import { validateFileSyntax, type ASTDiagnosticResult } from '../core/ast-guard.js';
import { atomicWriteFileSync } from '../core/atomic-fs.js';
import {
  applyEdit,
  findRelaxedUnique,
  normalizeRelaxedLine,
  type ApplyEditResult,
  type EditStrategy,
} from './edit-apply.js';

// Re-exported for backwards compatibility (the relaxed matcher lives in
// edit-apply.ts now, alongside the rest of the strategy ladder).
export { findRelaxedUnique, normalizeRelaxedLine };

/** Trim leading/trailing blank lines and common indent — shared with
 *  security/edit-review.ts so a per-hunk preview computes the SAME new
 *  content the edit tool will write when args.trim is set. */
export function trimIndent(text: string): string {
  const lines = text.split('\n');
  if (lines[0]?.trim() === '') lines.shift();
  if (lines[lines.length - 1]?.trim() === '') lines.pop();
  const indent = lines.reduce((min, line) => {
    const m = line.match(/^(\s*)/);
    if (line.trim() === '') return min;
    return Math.min(min, m ? m[1].length : 0);
  }, Infinity);
  if (indent === Infinity || indent === 0) return text;
  return lines.map((l) => l.slice(indent)).join('\n');
}

/**
 * Strips line numbers like '   1 | ', '1 | ', '12: ', '  12: ' that models
 * frequently copy directly from the `read` tool output into oldText/newText.
 */
export function stripLineNumberGutter(text: string): string {
  const lines = text.split('\n');
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return text;
  const isNumbered = nonEmpty.every((l) => /^\s*\d+\s*[|:]\s?/.test(l));
  if (!isNumbered) return text;
  return lines.map((l) => l.replace(/^\s*\d+\s*[|:]\s?/, '')).join('\n');
}

const STRATEGY_NOTES: Record<EditStrategy, string> = {
  exact: 'exact match',
  normalized: 'fuzzy match (whitespace differences were tolerated)',
  relaxed: 'fuzzy match (whitespace/quote/semicolon differences were tolerated)',
  anchored: 'fuzzy match (anchored: block located via its first/last lines; drifted lines inside were replaced)',
};

/** Render a failed application as an actionable report: which strategies
 *  were tried, where the ambiguous sites / closest regions are, and what
 *  diverged first — enough for the model to repair oldText in one retry. */
export function formatApplyFailure(rawPath: string, res: Extract<ApplyEditResult, { ok: false }>): string {
  const tried = res.attempts.map((a) => a.strategy).join(', ');
  const lines: string[] = [];
  if (res.failureKind === 'ambiguous') {
    const siteLines = res.sites.map((s) => s.startLine);
    lines.push(`oldText matches ${res.sites.length} locations in ${rawPath} (at lines ${siteLines.join(', ')}); include more surrounding context so it is unique`);
    for (const s of res.sites) {
      lines.push(`  candidate lines ${s.startLine}–${s.endLine}: ${s.preview}`);
    }
    if (res.note && res.note !== 'verbatim') lines.push(`  note: ${res.note}`);
    lines.push(`strategies tried: ${tried}. Retry with oldText extended by unique surrounding lines from ONE candidate site.`);
    return lines.join('\n');
  }
  lines.push(`oldText not found in ${rawPath} — no unique match (strategies tried: ${tried})`);
  const detail = res.attempts.filter((a) => a.detail).map((a) => `${a.strategy}: ${a.detail}`);
  if (detail.length) lines.push(`  ${detail.join('; ')}`);
  if (res.nearMisses.length) {
    lines.push('Closest regions in the current file:');
    res.nearMisses.forEach((mm, i) => {
      lines.push(`  ${i + 1}. lines ${mm.startLine}–${mm.endLine} (similarity ${mm.similarity.toFixed(2)}): ${mm.preview}`);
      if (mm.divergence) {
        lines.push(`     first difference at needle line ${mm.divergence.needleLine}:`);
        lines.push(`       you sent: ${mm.divergence.expected}`);
        lines.push(`       file has: ${mm.divergence.actual}`);
      }
    });
    lines.push('Retry with oldText copied exactly from one of these regions (re-read the file if unsure).');
  } else {
    lines.push('No region in the file resembles oldText. Re-read the file and copy oldText exactly.');
  }
  return lines.join('\n');
}

/** Diagnostics present in the pre-edit file (by message), so an edit is only
 *  ever reverted for errors it INTRODUCED — never for pre-existing breakage. */
function preExistingErrorKeys(diag: ASTDiagnosticResult): Set<string> {
  return new Set(diag.errors.filter((e) => e.severity === 'error').map((e) => e.message));
}

export const editTool: Tool = {
  def: {
    name: 'edit',
    description: 'Replace a block of text in a file with new text. Matching is multi-strategy (exact → whitespace-normalized → relaxed → anchored on the block\'s first/last lines) and always requires a unique site. The result is syntax-checked; an edit that introduces syntax errors is reverted and reported. Prefer small, targeted patches.',
    parameters: [
      { name: 'path', type: 'string', description: 'Relative or absolute file path', required: true },
      { name: 'oldText', type: 'string', description: 'Text to replace (copied from the file; surrounding context lines make it unique)', required: true },
      { name: 'newText', type: 'string', description: 'Replacement text', required: true },
      { name: 'trim', type: 'boolean', description: 'Trim leading/trailing blank lines and common indent from newText', required: false },
    ],
    permission: 'write',
  },
  async execute(args, ctx) {
    const rawPath = String(args.path ?? '');
    let oldText = String(args.oldText ?? '').replace(/\r\n/g, '\n');
    let newText = String(args.newText ?? '');
    if (args.trim) newText = trimIndent(newText);
    const fullPath = rawPath === '~' ? homedir() : rawPath.startsWith('~/') ? resolve(homedir(), rawPath.slice(2)) : resolve(ctx.cwd, rawPath);
    if (!existsSync(fullPath)) throw new Error(`File not found: ${rawPath}`);
    if (oldText.trim() === '') throw new Error('oldText must not be empty');
    const content = readFileSync(fullPath, 'utf8');
    const original = content;

    const emitFail = (failureKind: 'not-found' | 'ambiguous' | 'no-change', attempts: number, nearMisses: number) => {
      try {
        ctx.events.emit({ type: 'edit:failed', path: fullPath, failureKind, attempts, nearMisses, agentId: ctx.agentId });
      } catch { /* telemetry must never break the tool */ }
    };

    // Strategy ladder over candidate needle forms: as-sent first, then the
    // line-number-gutter-stripped form when oldText was copied from `read`
    // output (adoption requires the stripped form to actually apply — the
    // same gate the legacy pipeline used).
    const strippedOld = stripLineNumberGutter(oldText);
    const candidates: Array<{ needle: string; replacement: string }> = [{ needle: oldText, replacement: newText }];
    if (strippedOld !== oldText) {
      candidates.push({ needle: strippedOld, replacement: stripLineNumberGutter(newText) });
    }

    let applied: Extract<ApplyEditResult, { ok: true }> | null = null;
    let failure: Extract<ApplyEditResult, { ok: false }> | null = null;
    let replacement = newText;
    let totalAttempts = 0;
    for (const cand of candidates) {
      const res = applyEdit(content, cand.needle);
      totalAttempts += res.attempts.length;
      if (res.ok) {
        applied = res;
        replacement = cand.replacement;
        break;
      }
      failure ??= res;
    }

    if (!applied) {
      const f = failure!;
      emitFail(f.failureKind, totalAttempts, f.nearMisses.length);
      throw new Error(formatApplyFailure(rawPath, f));
    }

    const newContent = content.slice(0, applied.start) + replacement + content.slice(applied.end);
    if (newContent === original) {
      emitFail('no-change', totalAttempts, 0);
      throw new Error(`oldText was found but replacement did not change ${rawPath}`);
    }

    // Post-edit integrity: validate BEFORE writing. An edit that introduces
    // NEW syntax errors (severity 'error' diagnostics absent from the
    // pre-edit file) is auto-reverted — the file on disk never carries the
    // broken state. Pre-existing errors and warning-severity findings
    // (e.g. unresolved relative imports for a module created later) do not
    // block the edit; they are reported, as before.
    const post = validateFileSyntax(fullPath, newContent);
    const newErrors = post.errors.filter((e) => e.severity === 'error');
    let integrity: 'passed' | 'pre-existing-errors' = 'passed';
    let integrityNote = '';
    if (!post.valid && newErrors.length > 0) {
      const pre = validateFileSyntax(fullPath, original);
      const preKeys = preExistingErrorKeys(pre);
      const introduced = newErrors.filter((e) => !preKeys.has(e.message));
      if (introduced.length > 0) {
        try {
          ctx.events.emit({ type: 'edit:reverted', path: fullPath, strategy: applied.strategy, errors: introduced.map((e) => e.message).join('; ').slice(0, 500), agentId: ctx.agentId });
        } catch { /* telemetry must never break the tool */ }
        const summary = introduced.map((e) => `Line ${e.line}: ${e.message}`).join('; ');
        throw new Error(`Edit to ${rawPath} (${STRATEGY_NOTES[applied.strategy]}) introduced syntax errors and was REVERTED — the file is unchanged:\n  ${summary}\nFix newText and retry.`);
      }
      integrity = 'pre-existing-errors';
      integrityNote = `\nNote: this file has pre-existing syntax errors not introduced by this edit: ${post.summary ?? newErrors.map((e) => e.message).join('; ')}`;
    } else if (!post.valid) {
      integrityNote = `\n⚠️ [AST Syntax Alert]: ${post.summary ?? 'see diagnostics'}`;
    }

    atomicWriteFileSync(fullPath, newContent);
    ctx.events.emit({ type: 'file:changed', path: fullPath, operation: 'edit', agentId: ctx.agentId });
    markMutation();
    try {
      ctx.events.emit({ type: 'edit:applied', path: fullPath, strategy: applied.strategy, attempts: totalAttempts, integrity, agentId: ctx.agentId });
    } catch { /* telemetry must never break the tool */ }

    let out = `Edited ${rawPath} (${STRATEGY_NOTES[applied.strategy]}; strategy: ${applied.strategy}; syntax check: ${integrity === 'passed' ? 'passed' : 'pre-existing errors only'})`;
    if (applied.strategy === 'anchored' && applied.similarity !== undefined) {
      out += `\nAnchored match similarity ${applied.similarity.toFixed(2)} — the replaced region was located via its first/last lines; verify the drifted middle lines were replaced as intended.`;
    }
    out += integrityNote;
    return out;
  },
};
