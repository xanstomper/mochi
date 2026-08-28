// Summary Engine (master rebuild Phases 9 & 10).
//
// RAW EVENTS → CLASSIFICATION → IMPORTANCE → DEDUPE → SummaryDocument.
//
// The summary is NOT a concatenation of recent text. It is a structured
// document assembled from the structured event stream, in which every number
// is derived from actual events (Phase 39: never fabricate). Sections with no
// data are omitted entirely — never rendered as empty headers.
//
// Priority model (Phase 10): P0 critical … P4 low value. Visual weight in the
// renderer comes from this tag, so important information stands out because
// everything else is quieter.

import type { MochiEvent } from '../types.js';

export type Priority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
export type EventCategory = 'change' | 'verification' | 'failure' | 'reasoning' | 'reference' | 'noise';

export interface ClassifiedEvent {
  event: MochiEvent;
  category: EventCategory;
  priority: Priority;
}

export interface SummaryMetric {
  label: string;
  value: string;
}

export interface SummaryItem {
  text: string;
  priority: Priority;
  /** Optional structured payload for the renderer (file paths etc.). */
  detail?: string;
}

export interface SummaryDocument {
  status: 'complete' | 'failed' | 'partial';
  overview: string;
  /** Only metrics with real data appear; never a fabricated zero. */
  metrics: SummaryMetric[];
  whatChanged: SummaryItem[];
  verification: SummaryItem[];
  failures: SummaryItem[];
  warnings: SummaryItem[];
  references: SummaryItem[];
  next: SummaryItem[];
  /** Sections actually populated (renderer iterates this, skips the rest). */
  populatedSections: string[];
}

const CATEGORY_PRIORITY: Record<EventCategory, Priority> = {
  failure: 'P0',
  change: 'P1',
  verification: 'P1',
  reasoning: 'P3',
  reference: 'P2',
  noise: 'P4',
};

/** Classify one event into a category + priority. Pure and total. */
export function classify(event: MochiEvent): ClassifiedEvent {
  let category: EventCategory = 'noise';
  switch (event.type) {
    case 'file:changed':
    case 'diff:generated':
      category = 'change';
      break;
    case 'command:completed':
      category = 'verification';
      break;
    case 'command:failed':
    case 'task:failed':
      category = 'failure';
      break;
    case 'error':
      category = 'failure';
      break;
    case 'warning':
      category = 'failure'; // warnings grouped with failure-adjacent, priority lower
      break;
    case 'agent:reasoning':
      category = 'reasoning';
      break;
    case 'tool:completed':
    case 'tool:failed':
    case 'search:completed':
      category = 'reference';
      break;
    case 'task:completed':
    case 'task:started':
      category = 'verification';
      break;
    default:
      category = 'noise';
  }
  let priority = CATEGORY_PRIORITY[category];
  // Severity refinement: an explicit critical/error severity escalates.
  const sev = (event as { severity?: string }).severity;
  if (sev === 'critical' && priority !== 'P0') priority = 'P0';
  if (category === 'failure' && event.type === 'warning') priority = 'P2';
  return { event, category, priority };
}

/** Collapse repeated identical work (Phase 9 dedupe). Only events with a
 *  meaningful identity dedupe: tool completions per tool name, file changes
 *  per (path, operation). Everything else passes through untouched — in
 *  particular distinct commands must NEVER collapse into each other. */
export function dedupe(events: ClassifiedEvent[]): ClassifiedEvent[] {
  const seenTools = new Set<string>();
  const seenFiles = new Set<string>();
  const out: ClassifiedEvent[] = [];
  for (const e of events) {
    const ev = e.event as { tool?: string };
    if ((e.event.type === 'tool:completed' || e.event.type === 'tool:failed') && ev.tool) {
      if (seenTools.has(ev.tool)) continue;
      seenTools.add(ev.tool);
      out.push(e);
      continue;
    }
    if (e.event.type === 'file:changed') {
      const key = `${e.event.operation}:${e.event.path}`;
      if (seenFiles.has(key)) continue;
      seenFiles.add(key);
      out.push(e);
      continue;
    }
    out.push(e);
  }
  return out;
}

/** Build the structured summary from the event stream. Every metric is derived
 *  from real events; absent data omits the field (never fabricates). */
export function summarize(events: readonly MochiEvent[], opts: { goal?: string } = {}): SummaryDocument {
  const classified = dedupe(events.map(classify));
  const doc: SummaryDocument = {
    status: 'complete',
    overview: '',
    metrics: [],
    whatChanged: [],
    verification: [],
    failures: [],
    warnings: [],
    references: [],
    next: [],
    populatedSections: [],
  };

  // ── Derive metrics + sections in one pass ──
  const changedFiles = new Set<string>();
  const fileOps = new Map<string, string>(); // path -> last operation
  let checksPassed = 0;
  let checksFailed = 0;
  let toolCalls = 0;
  let duplicateFailures = 0;
  const failureTexts: string[] = [];
  const warningTexts: string[] = [];
  const verificationItems: SummaryItem[] = [];
  const referenceItems: SummaryItem[] = [];
  let firstTs: number | undefined;
  let lastTs: number | undefined;

  for (const { event, category, priority } of classified) {
    const ts = (event as { timestamp?: number }).timestamp;
    if (ts) { firstTs ??= ts; lastTs = ts; }

    if (event.type === 'file:changed') {
      changedFiles.add(event.path);
      fileOps.set(event.path, event.operation);
      doc.whatChanged.push({ text: `${event.operation}: ${event.path}`, priority, detail: event.path });
    } else if (event.type === 'diff:generated') {
      changedFiles.add(event.path);
      doc.whatChanged.push({ text: `${event.path} (+${event.additions}/-${event.deletions})`, priority, detail: event.path });
    } else if (event.type === 'command:completed') {
      if (event.exitCode === 0) {
        checksPassed++;
        verificationItems.push({ text: `✓ ${event.command}`, priority, detail: `${event.durationMs}ms` });
      } else {
        checksFailed++;
        verificationItems.push({ text: `✗ ${event.command} (exit ${event.exitCode})`, priority: 'P0' });
      }
    } else if (event.type === 'command:failed') {
      checksFailed++;
      verificationItems.push({ text: `✗ ${event.command}`, priority: 'P0', detail: event.error.slice(0, 200) });
      failureTexts.push(`${event.command} failed: ${event.error.slice(0, 160)}`);
    } else if (event.type === 'tool:completed') {
      toolCalls++;
      referenceItems.push({ text: `${event.tool}: ${(event.result.output || '').slice(0, 120).split('\n')[0]}`, priority });
    } else if (event.type === 'tool:failed') {
      duplicateFailures++;
      failureTexts.push(`${event.tool} failed: ${event.error.slice(0, 160)}`);
    } else if (event.type === 'task:failed') {
      failureTexts.push(event.reason.slice(0, 200));
    } else if (event.type === 'error') {
      failureTexts.push(event.error.slice(0, 200));
    }
  }
  // Warnings carry no numeric metric — they are surfaced as a section only.
  for (const { event, priority } of classified) {
    if (event.type === 'warning') warningTexts.push((event as unknown as { message?: string }).message ?? 'warning');
    void priority;
  }

  // ── Metrics: only with real data ──
  if (changedFiles.size) doc.metrics.push({ label: 'FILES', value: `${changedFiles.size} changed` });
  if (checksPassed || checksFailed) doc.metrics.push({ label: 'CHECKS', value: `${checksPassed} passed${checksFailed ? `, ${checksFailed} failed` : ''}` });
  if (toolCalls) doc.metrics.push({ label: 'TOOLS', value: `${toolCalls} calls` });
  if (firstTs && lastTs && lastTs >= firstTs) {
    const secs = Math.max(0, Math.round((lastTs - firstTs) / 100) / 10);
    if (secs > 0) doc.metrics.push({ label: 'DURATION', value: `${secs}s` });
  }

  doc.verification = verificationItems;
  doc.references = referenceItems;
  doc.failures = failureTexts.map((t) => ({ text: t, priority: 'P0' as Priority }));
  doc.warnings = warningTexts.map((t) => ({ text: t, priority: 'P2' as Priority }));

  // ── Status: honest, from evidence ──
  if (failureTexts.length > 0 || checksFailed > 0) doc.status = checksPassed > 0 ? 'partial' : 'failed';
  else if (classified.some((c) => c.event.type === 'task:completed')) doc.status = 'complete';
  else doc.status = 'partial';

  // ── Overview: one factual sentence ──
  const parts: string[] = [];
  if (opts.goal) parts.push(`Goal: ${opts.goal}.`);
  if (changedFiles.size) parts.push(`Modified ${changedFiles.size} file${changedFiles.size === 1 ? '' : 's'}.`);
  if (checksPassed || checksFailed) parts.push(`Verification: ${checksPassed} passed${checksFailed ? `, ${checksFailed} failed` : ''}.`);
  if (failureTexts.length) parts.push(`${failureTexts.length} failure${failureTexts.length === 1 ? '' : 's'} recorded.`);
  doc.overview = parts.join(' ') || 'No substantive activity recorded.';

  // ── Populated sections (renderer renders only these) ──
  if (doc.overview) doc.populatedSections.push('overview');
  if (doc.metrics.length) doc.populatedSections.push('metrics');
  if (doc.whatChanged.length) doc.populatedSections.push('whatChanged');
  if (doc.verification.length) doc.populatedSections.push('verification');
  if (doc.failures.length) doc.populatedSections.push('failures');
  if (doc.warnings.length) doc.populatedSections.push('warnings');
  if (doc.references.length) doc.populatedSections.push('references');
  if (doc.next.length) doc.populatedSections.push('next');
  return doc;
}