// Interactive user-facing menus as testable units (onboard-flow / tools-menu
// pattern): ask_question option menus + approval allow/deny menus with all TUI
// effects injected, so scripted tests drive every path — single pick, custom
// text, multi-select rounds, skips, empty answers. app.ts stays a dispatcher.
import { T } from './view.js';
import type { LineKind } from './state.js';
import type {
  UserPromptRequest,
  UserPromptResponse,
  UserPromptAnswer,
} from '../tools/user-prompt.js';
import type {
  ApprovalRequest,
  ApprovalDecisionEx,
} from '../security/approval.js';

export interface PromptMenuDeps {
  openMenu: (title: string, items: string[]) => Promise<number>;
  ask: (question: string) => Promise<string>;
  push: (kind: LineKind, text: string) => void;
  scheduleRender: () => void;
  setMenuSelected: (i: number) => void;
}

/** Interactive ask_question resolver (Claude Code / opencode parity): one
 *  menu per question — arrow keys + Enter to pick, Esc skips, "type my own"
 *  drops to free text, multi-select loops single picks until Done. */
export async function tuiPromptUser(
  deps: PromptMenuDeps,
  req: UserPromptRequest,
): Promise<UserPromptResponse> {
  const { openMenu, ask, push, scheduleRender, setMenuSelected } = deps;
  const answers: UserPromptAnswer[] = [];
  for (const q of req.questions) {
    const title = q.header ? `${q.header}: ${q.question}` : q.question;
    push('system', `? ${title}`);
    const picked: string[] = [];
    let custom = '';
    let skipped = false;
    if (!q.multiSelect) {
      const items = [
        ...q.options.map((o) => `${T.bold}${o.label}${T.reset}${o.recommended ? ` ${T.lime}(recommended)${T.reset}` : ''}${o.description ? `${T.grayDark} — ${o.description}${T.reset}` : ''}`),
        `${T.cyan}✎ Type my own answer…${T.reset}`,
      ];
      setMenuSelected(0);
      const idx = await openMenu(title, items);
      if (idx < 0 || idx >= items.length) {
        skipped = true;
      } else if (idx === items.length - 1) {
        custom = (await ask('Your answer (Enter to send, Esc to skip):')).trim();
        if (!custom) skipped = true;
      } else {
        picked.push(q.options[idx].label);
      }
    } else {
      for (;;) {
        const items = [
          ...q.options.map((o) => `${picked.includes(o.label) ? `${T.lime}●${T.reset}` : `${T.grayDark}○${T.reset}`} ${T.bold}${o.label}${T.reset}${o.description ? `${T.grayDark} — ${o.description}${T.reset}` : ''}`),
          `${T.lime}✓ Done — use selected${picked.length ? ` (${picked.length})` : ''}${T.reset}`,
          `${T.cyan}✎ Type my own answer…${T.reset}`,
        ];
        setMenuSelected(0);
        const idx = await openMenu(picked.length ? `${title} (${picked.length} selected)` : title, items);
        if (idx < 0 || idx >= items.length) break;
        if (idx === items.length - 1) {
          const t = (await ask('Your answer (Enter to send, empty keeps picking):')).trim();
          if (t) { custom = t; break; }
          continue;
        }
        if (idx === items.length - 2) break;
        const label = q.options[idx].label;
        if (!picked.includes(label)) picked.push(label);
      }
      if (picked.length === 0 && !custom) skipped = true;
    }
    if (skipped) push('system', '◇ question skipped — the agent proceeds with its best judgment');
    else push('system', `◇ you chose: ${[...picked, ...(custom ? [`"${custom}"`] : [])].join(', ')}`);
    answers.push({
      question: q.question,
      header: q.header,
      selected: picked,
      ...(custom ? { freeText: custom } : {}),
      ...(skipped ? { skipped: true } : {}),
    });
    scheduleRender();
  }
  return { answers };
}

/** Per-hunk diff preview for the transcript: colored +/− rows, bounded. */
const HUNK_PREVIEW_MAX_ROWS = 60;

export function renderDiffPreview(diff: string): string[] {
  const out: string[] = [];
  for (const l of diff.split('\n')) {
    const color = l.startsWith('+') ? T.lime
      : l.startsWith('-') ? T.error
      : (l.startsWith('diff ') || l.startsWith('*** ') || l.startsWith('@@')) ? T.grayDark
      : '';
    out.push(color ? `${color}${l}${T.reset}` : l);
  }
  if (out.length > HUNK_PREVIEW_MAX_ROWS) {
    const rest = out.length - HUNK_PREVIEW_MAX_ROWS;
    return [...out.slice(0, HUNK_PREVIEW_MAX_ROWS), `${T.grayDark}… +${rest} more diff rows${T.reset}`];
  }
  return out;
}

/** One-line summary of a hunk's shape: `+3 −1` (adds, removals). */
export function hunkSummary(hunk: string): string {
  let adds = 0;
  let dels = 0;
  for (const l of hunk.split('\n')) {
    if (l.startsWith('+')) adds++;
    else if (l.startsWith('-')) dels++;
  }
  return `+${adds} −${dels}`;
}

/** Interactive approval gate (Claude Code parity): allow once / allow always
 *  this session / deny. Esc denies.
 *  W3-4: when the request carries a per-hunk edit review with >= 2 hunks,
 *  the menu becomes a hunk review — each hunk toggles accept/reject, then
 *  apply-accepted / apply-all / deny. Single-hunk edits keep the plain menu
 *  (one hunk to accept = the edit itself); the diff preview is shown either
 *  way. */
export async function tuiRequestApproval(
  deps: PromptMenuDeps,
  req: ApprovalRequest,
): Promise<ApprovalDecisionEx> {
  const { openMenu, push, scheduleRender, setMenuSelected } = deps;
  const risk = req.risk && req.risk !== 'low' ? ` ${T.warning ?? T.orange ?? ''}[risk: ${req.risk}]${T.reset}` : '';
  push('system', `? ${T.bold}${req.tool}${T.reset} wants to run: ${req.summary}${risk}`);
  const review = req.edit;
  if (review) {
    push('system', `  reviewing ${review.path} — ${review.hunks.length} hunk${review.hunks.length === 1 ? '' : 's'} proposed`);
    for (const row of renderDiffPreview(review.diff)) push('system', row);
  }
  if (review && review.hunks.length >= 2) {
    const accepted = new Set<number>(review.hunks.map((_, i) => i));
    for (;;) {
      const items = [
        ...review.hunks.map((h, i) => `${accepted.has(i) ? `${T.lime}✓` : `${T.error}✗`}${T.reset} hunk ${i + 1}/${review.hunks.length} ${T.grayDark}(${hunkSummary(h)})${T.reset} — ${accepted.has(i) ? 'accept' : 'reject'}`),
        `${T.lime}✓ Apply accepted (${accepted.size}/${review.hunks.length})${T.reset}`,
        `${T.cyan}✓ Apply all — allow always this session${T.reset}`,
        `${T.error}✗ Deny all${T.reset}${T.grayDark} (Esc)${T.reset}`,
      ];
      setMenuSelected(0);
      const idx = await openMenu(`Review ${review.path} — pick hunks, then apply`, items);
      if (idx < 0 || idx === items.length - 1) break; // Esc / Deny
      if (idx === items.length - 2) {
        push('system', `◇ allowed always this session: all ${review.hunks.length} hunks of ${review.path}`);
        scheduleRender();
        return 'allow-always';
      }
      if (idx === items.length - 3) {
        if (accepted.size === 0) {
          push('system', '◇ no hunks accepted — toggle at least one hunk, or deny');
          continue;
        }
        const picked = [...accepted].sort((a, b) => a - b);
        push('system', `◇ applying ${picked.length}/${review.hunks.length} hunks to ${review.path}`);
        scheduleRender();
        return { decision: 'allow-once', acceptedHunks: picked };
      }
      // A hunk row: toggle its acceptance and re-open the menu.
      if (accepted.has(idx)) accepted.delete(idx);
      else accepted.add(idx);
    }
    push('system', `◇ denied: ${req.summary} — the agent works around it`);
    scheduleRender();
    return 'deny';
  }
  const items = [
    `${T.lime}Allow once${T.reset}${T.grayDark} — run it this time${T.reset}`,
    `${T.cyan}Allow always${T.reset}${T.grayDark} — remember for this session${T.reset}`,
    `${T.error}Deny${T.reset}${T.grayDark} — skip it (Esc)${T.reset}`,
  ];
  setMenuSelected(0);
  const idx = await openMenu(`Allow ${req.tool}? (${req.policy})`, items);
  if (idx === 0) {
    push('system', `◇ allowed once: ${req.summary}`);
    scheduleRender();
    return 'allow-once';
  }
  if (idx === 1) {
    push('system', `◇ allowed always this session: ${req.summary}`);
    scheduleRender();
    return 'allow-always';
  }
  push('system', `◇ denied: ${req.summary} — the agent works around it`);
  scheduleRender();
  return 'deny';
}
