// D2 torture-transcript metric: compaction evidence-survival, measured —
// not claimed. One harness, run identically BEFORE and AFTER the D2 change
// (at the base commit a9b9de9c it reports the "before" numbers; after the
// change it enforces zero silent drops).
//
// What it does:
//   1. Builds ONE torture transcript through the REAL ContextEngine surface
//      (addMessage → compact → buildPacket). No fake provider is needed at
//      all: Mochi's compaction is deterministic — compact() summarizes and
//      probes without a model call — so every leg here runs through the real
//      existing compaction code path, not a hand-written fixture.
//   2. The transcript exercises all three D2 legs:
//        - oversized outputs (250KB shell result, 300KB file read) whose
//          load-bearing evidence sits buried mid-content;
//        - protected-head members (root goal, plan state/next action, two
//          open TODOs, a skill name in play);
//        - a post-compaction follow-up that can only be answered from the
//          spilled evidence.
//   3. Measures, per evidence item, whether it is REACHABLE after compaction:
//      present verbatim in the post-compaction context, or retrievable
//      through a pointer that actually resolves (spill-store key or the
//      MCH-66 output archive). An item that is neither is a SILENT DROP.
//   4. Prints one JSON verdict line prefixed `D2_METRIC` for the campaign
//      report: reachable/total before vs after, silent drops, broken
//      pointers (markers present but unresolvable), and the re-injection
//      budget spent vs cap (cap reports 0 / "absent" before the hook exists).
//
// Reachability is measured on TWO surfaces and both are reported:
//   - seam:  the messages compact() itself left behind (getMessages());
//   - packet: what the next model step would actually see (buildPacket(),
//     which additionally re-renders todos/next-action from engine state in
//     the trailing state prompt — reported for completeness, headline is the
//     seam, because the seam is the surface this change owns).

import { describe, it, expect } from 'vitest';
import { ContextEngine } from './context.js';
import { recallArchivedOutput } from './tools/output-archive.js';
import type { MochiConfig, ChatMessage } from './types.js';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

function makeConfig(dir: string): MochiConfig {
  return {
    model: { provider: 'openai', model: 'fake-model' },
    safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 10, maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 4000 },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false, projectDir: '.mochi', configDir: resolve(dir, '.config/mochi'),
    quiet: true, verbose: false, debug: false,
  } as unknown as MochiConfig;
}

// ── The torture transcript ───────────────────────────────────────────────────

const GOAL = 'Fix the 503 retry storm in the auth service so retries back off exponentially and never drop telemetry events';

interface EvidenceItem {
  id: string;
  /** Distinctive needle that identifies the evidence. */
  needle: string;
  /** Which D2 leg it exercises. */
  leg: 'oversized' | 'protected-head' | 'control';
  /** What the evidence is, for the report. */
  what: string;
}

const EVIDENCE: EvidenceItem[] = [
  { id: 'E01', needle: 'BUG-7734', leg: 'oversized', what: 'failing assertion buried at ~60% depth of a 250KB shell (test-run) output' },
  { id: 'E02', needle: 'src/auth/retry.test.ts:88', leg: 'oversized', what: 'file:line of that failing assertion, same oversized output' },
  { id: 'E03', needle: 'RATE_LIMIT_BACKOFF_MS', leg: 'oversized', what: 'constant buried at ~40% depth of a 300KB file-read result' },
  { id: 'E04', needle: 'retry-queue depth metrics', leg: 'control', what: 'user constraint on the fix (distinct content, probed by the C7 probe)' },
  { id: 'E05', needle: 'back off exponentially', leg: 'protected-head', what: 'root goal (session snapshot)' },
  { id: 'E06', needle: 'migrate-staging-backoff', leg: 'protected-head', what: 'current plan state (next action)' },
  { id: 'E07', needle: 'regression test for the 503 retry loop', leg: 'protected-head', what: 'open TODO 1' },
  { id: 'E08', needle: 'recall of spilled outputs in finish summary', leg: 'protected-head', what: 'open TODO 2' },
  { id: 'E09', needle: 'test-driven-development', leg: 'protected-head', what: 'skill name loaded in play this session' },
  { id: 'E10', needle: 'exponential backoff with jitter', leg: 'control', what: 'decision the ledger must carry' },
  { id: 'E11', needle: 'TS2345', leg: 'control', what: 'known error in a small tool output' },
  { id: 'E12', needle: 'src/auth/backoff.ts', leg: 'control', what: 'file edited this session' },
];

/** A ~230KB shell output with the failing assertion buried at ~60% depth.
 *  Plausible shape: a long test run, then the failure, then cleanup noise. */
function oversizedShellOutput(): string {
  const lines: string[] = [];
  for (let i = 0; i < 1600; i++) lines.push(`ok ${i} - auth unit subset passes quietly, no diagnostics`);
  lines.push('running retry integration suite (staging profile)...');
  for (let i = 0; i < 900; i++) lines.push(`ok ${1600 + i} - retry integration case ${i} passed`);
  // The evidence, buried mid-content:
  lines.push('AssertionError: BUG-7734 expected retry count 3 got 5 at src/auth/retry.test.ts:88');
  lines.push('  at runRetrySuite (src/auth/retry.test.ts:88:11)');
  lines.push('  tests: 2500 passed, 1 failed, 0 skipped — suite exited with the failure above');
  for (let i = 0; i < 1200; i++) lines.push(`cleanup ${i}: closing fixture connections, flushing buffers, all quiet`);
  return lines.join('\n');
}

/** A ~310KB file-read result with a load-bearing constant at ~40% depth,
 *  and NO error markers (so it takes the fold path, not the condense path). */
function oversizedReadOutput(): string {
  const lines: string[] = [];
  lines.push('// src/auth/backoff.ts — current working copy, first 400 lines follow');
  for (let i = 0; i < 1800; i++) lines.push(`export const BACKOFF_UNUSED_${i} = ${i} * 1000; // padding region before the evidence`);
  lines.push('export const RATE_LIMIT_BACKOFF_MS = 45000; // D2 evidence: the staging backoff constant');
  for (let i = 0; i < 1800; i++) lines.push(`export const BACKOFF_TAIL_${i} = ${i} * 2000; // padding region after the evidence`);
  return lines.join('\n');
}

function buildTortureTranscript(dir: string): ContextEngine {
  const ctx = new ContextEngine(makeConfig(dir), dir);
  ctx.setGoal(GOAL);

  // Torture guard: the oversized leg must actually be oversized (above the
  // 200K spill threshold) — if a future edit shrinks these, fail loudly
  // instead of silently measuring the wrong thing.
  if (oversizedShellOutput().length <= 200_000) throw new Error('shell output no longer oversized');
  if (oversizedReadOutput().length <= 200_000) throw new Error('read output no longer oversized');

  // Protected-head inputs that live OUTSIDE the message history:
  // open TODOs (2 open + 1 done, on disk like the real todo tool writes them).
  mkdirSync(resolve(dir, '.mochi', 'state'), { recursive: true });
  writeFileSync(resolve(dir, '.mochi', 'state', 'todo.json'), JSON.stringify([
    { order: 1, status: 'done', title: 'Reproduce the 503 storm locally', notes: 'reproduced with staging profile' },
    { order: 2, status: 'in_progress', title: 'Add regression test for the 503 retry loop' },
    { order: 3, status: 'pending', title: 'Wire recall of spilled outputs in finish summary' },
  ]), 'utf8');
  // Current plan state.
  ctx.updateState({ nextAction: 'Run the backoff migration on staging (migrate-staging-backoff)' });

  // The transcript itself, shaped like a real long task. The constraint is
  // its own user message (how users actually state it) so the existing C7
  // probe gets its normal shot at it.
  ctx.addMessage({ role: 'user', content: GOAL });
  ctx.addMessage({ role: 'user', content: 'Constraint: the fix must also add retry-queue depth metrics, not just backoff.' });
  ctx.addMessage({ role: 'assistant', content: 'Reading the backoff module first.', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{"path":"src/auth/backoff.ts"}' } }] });
  ctx.addMessage({ role: 'tool', tool_call_id: 't1', name: 'read', content: oversizedReadOutput() });
  ctx.addMessage({ role: 'assistant', content: 'Now the staging test run.', tool_calls: [{ id: 't2', type: 'function', function: { name: 'shell', arguments: '{"command":"npm test -- profile=staging"}' } }] });
  ctx.addMessage({ role: 'tool', tool_call_id: 't2', name: 'shell', content: oversizedShellOutput() });
  ctx.addMessage({ role: 'assistant', content: 'I decided to use exponential backoff with jitter for 503s.' });
  ctx.addMessage({ role: 'assistant', content: 'Loading the workflow skill before I edit.', tool_calls: [{ id: 't3', type: 'function', function: { name: 'skill', arguments: '{"name":"test-driven-development"}' } }] });
  // Realistic skill load: the tool returns the skill BODY (up to 20K chars),
  // not a one-liner — a small stub would get a free ride in compact()'s
  // <500-char session-facts carry, which is luck, not a protected head.
  ctx.addMessage({ role: 'tool', tool_call_id: 't3', name: 'skill', content: '# test-driven-development\nEnforce RED-GREEN-REFACTOR: write the failing test first, watch it fail for the expected reason, then make it pass with the smallest change, then refactor. Pin regressions with a test named after the bug. Never claim green without watching the suite run. When a test fails unexpectedly, reproduce it in isolation before touching production code, and only then generalize the fix. Prefer one assertion per test and minimal fixtures; keep setup in helpers so failures read as behavior, not plumbing. Run the full suite before declaring done and paste the real output into the summary.' });
  ctx.addMessage({ role: 'assistant', content: 'Applying the backoff change.', tool_calls: [{ id: 't4', type: 'function', function: { name: 'edit', arguments: '{"path":"src/auth/backoff.ts"}' } }] });
  ctx.addMessage({ role: 'tool', tool_call_id: 't4', name: 'edit', content: 'updated src/auth/backoff.ts' });
  ctx.addMessage({ role: 'assistant', content: 'Typechecking the payment module touched earlier.', tool_calls: [{ id: 't5', type: 'function', function: { name: 'shell', arguments: '{"command":"npx tsc --noEmit"}' } }] });
  ctx.addMessage({ role: 'tool', tool_call_id: 't5', name: 'shell', content: 'src/payment.ts:88: error TS2345: Argument of type string is not assignable to parameter of type Charge.' });
  ctx.addMessage({ role: 'assistant', content: 'Noted the payment typecheck failure; the auth fix is unaffected.' });
  // Filler rounds to force the cut deep past every evidence-bearing message.
  for (let i = 0; i < 14; i++) {
    ctx.addMessage({ role: 'user', content: `Continuing — progress check ${i}.` });
    ctx.addMessage({ role: 'assistant', content: `Working through step ${i} of the retry rework.` });
  }
  return ctx;
}

// The follow-up must NOT quote the needles themselves (that would make the
// question leak the evidence back into the packet) — it references the
// evidence the way a real reviewer would, by location and role.
const FOLLOWUP = 'Quote the exact failing assertion from the staging test run you showed me earlier, and the backoff constant value you read from the file while investigating.';

// ── Reachability measurement (identical logic in both trees) ────────────────

const ARCHIVE_ID_RE = /\bout-[a-z0-9]+-[a-z0-9]+\b/g;
// Spill-store keys only exist after the D2 change; resolved via a guarded
// dynamic import so this harness also runs at the base commit.
type SpillModule = typeof import('./summary/spill-store.js');
let spillMod: SpillModule | null = null;
async function spill(): Promise<SpillModule | null> {
  if (spillMod !== null) return spillMod;
  try { spillMod = (await import('./summary/spill-store.js')) as SpillModule; } catch { spillMod = null; }
  return spillMod;
}

function renderMessages(msgs: readonly ChatMessage[]): string {
  return msgs
    .map((m) => {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      const calls = m.tool_calls?.map((tc) => `${tc.function.name}(${tc.function.arguments ?? ''})`).join(' ') ?? '';
      return `${c}${calls ? ' ' + calls : ''}`;
    })
    .join('\n');
}

interface Reachability {
  reachable: boolean;
  via: string;
  /** A pointer (spill key / archive id) named in the post-compaction context that does NOT resolve. */
  brokenPointer: boolean;
}

async function evidenceReachable(needle: string, surfaceText: string, dir: string): Promise<Reachability> {
  const norm = surfaceText.toLowerCase();
  const n = needle.toLowerCase();
  if (norm.includes(n)) return { reachable: true, via: 'in-context', brokenPointer: false };
  // Existing retrieval path: MCH-66 archive ids named in the surviving context.
  for (const id of new Set(surfaceText.match(ARCHIVE_ID_RE) ?? [])) {
    const hit = recallArchivedOutput(dir, id);
    if (!hit) continue;
    if (hit.text.toLowerCase().includes(n)) return { reachable: true, via: `archive:${id}`, brokenPointer: false };
  }
  // D2 retrieval path: content-addressed spill keys named in the context.
  const mod = await spill();
  if (mod) {
    let broken = false;
    for (const key of mod.scanSpillRefs(surfaceText)) {
      const hit = mod.retrieveSpilled(dir, key);
      if (!hit) { broken = true; continue; }
      if (hit.text.toLowerCase().includes(n)) return { reachable: true, via: `spill:${key}`, brokenPointer: false };
    }
    return { reachable: false, via: 'none', brokenPointer: broken };
  }
  return { reachable: false, via: 'none', brokenPointer: false };
}

interface SurfaceVerdict {
  reachable: number;
  total: number;
  silentDrops: EvidenceItem[];
  brokenPointers: number;
  detail: Array<{ id: string; via: string; reachable: boolean }>;
}

async function measureSurface(surfaceText: string, dir: string): Promise<SurfaceVerdict> {
  const detail: SurfaceVerdict['detail'] = [];
  const silentDrops: EvidenceItem[] = [];
  let brokenPointers = 0;
  let reachable = 0;
  for (const e of EVIDENCE) {
    const r = await evidenceReachable(e.needle, surfaceText, dir);
    detail.push({ id: e.id, via: r.via, reachable: r.reachable });
    if (r.reachable) reachable++;
    else silentDrops.push(e);
    if (r.brokenPointer) brokenPointers++;
  }
  return { reachable, total: EVIDENCE.length, silentDrops, brokenPointers, detail };
}

// ── The measurement ──────────────────────────────────────────────────────────

describe('D2 torture transcript: compaction evidence survival (measured)', () => {
  it('compacts the torture transcript and reports the evidence-survival verdict', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-d2-torture-'));
    try {
      const ctx = buildTortureTranscript(dir);

      const pre = ctx.getMessages().length;
      await ctx.compact();

      // The seam: exactly what compact() left behind.
      const seamText = renderMessages(ctx.getMessages());
      const seam = await measureSurface(seamText, dir);

      // The packet: what the next model step would actually see, including
      // the post-compaction follow-up that needs the spilled evidence.
      ctx.addMessage({ role: 'user', content: FOLLOWUP });
      const packet = ctx.buildPacket([], undefined as never, undefined as never);
      const packetText = renderMessages(packet.messages);
      const packetSurface = await measureSurface(packetText, dir);

      // Re-injection budget accounting (0 / absent before the D2 hook).
      const anyCtx = ctx as unknown as { lastReinjection?: { budgetChars: number; spentChars: number; truncated: boolean; keys: string[] } };
      const reinjection = anyCtx.lastReinjection ?? null;

      const verdict = {
        base: 'a9b9de9c',
        compactionRan: ctx.getMessages().length < pre,
        seam: {
          reachable: seam.reachable,
          total: seam.total,
          reachableRate: Number((seam.reachable / seam.total).toFixed(4)),
          silentDropCount: seam.silentDrops.length,
          silentDrops: seam.silentDrops.map((e) => e.id),
          brokenPointerCount: seam.brokenPointers,
          detail: seam.detail,
        },
        packet: {
          reachable: packetSurface.reachable,
          total: packetSurface.total,
          reachableRate: Number((packetSurface.reachable / packetSurface.total).toFixed(4)),
          silentDropCount: packetSurface.silentDrops.length,
          silentDrops: packetSurface.silentDrops.map((e) => e.id),
          brokenPointerCount: packetSurface.brokenPointers,
          detail: packetSurface.detail,
        },
        reinjection: reinjection
          ? { present: true, budgetChars: reinjection.budgetChars, spentChars: reinjection.spentChars, truncated: reinjection.truncated, keys: reinjection.keys }
          : { present: false, budgetChars: 0, spentChars: 0, truncated: false, keys: [] as string[] },
        legNote: 'all legs through the real ContextEngine (addMessage/compact/buildPacket); no provider, no hand-written fixture',
      };

      console.log('D2_METRIC ' + JSON.stringify(verdict, null, 2));

      // Post-compaction sanity: compaction must actually have cut.
      expect(verdict.compactionRan).toBe(true);

      // Enforce the D2 contract ONLY where the D2 store exists (after the
      // change). At the base commit this harness only reports.
      const mod = await spill();
      if (mod) {
        expect(seam.silentDrops.map((e) => e.id), `seam silent drops`).toEqual([]);
        expect(seam.brokenPointers, 'seam broken pointers').toBe(0);
        expect(seam.reachable).toBe(seam.total);
        // Every elision marker produced must resolve (no broken pointers).
        for (const key of mod.scanSpillRefs(seamText)) {
          expect(mod.retrieveSpilled(dir, key), `spill key ${key} must resolve`).toBeTruthy();
        }
        // Re-injection must be bounded and must have spent within its cap.
        expect(reinjection).toBeTruthy();
        expect(reinjection!.spentChars).toBeLessThanOrEqual(reinjection!.budgetChars);
        expect(reinjection!.budgetChars).toBeGreaterThan(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
