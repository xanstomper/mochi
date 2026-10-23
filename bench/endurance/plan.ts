// The scripted "model" for the endurance factory.
//
// A deterministic plan executor behind the fake OpenAI wire. It derives the
// next action PURELY from the conversation it is shown (tool calls issued +
// tool results observed), never from a private step counter. That is what
// makes it resume-safe: after a SIGKILL, the fresh agent re-walks from step
// one, the run journal replays completed side effects, the replayed results
// reappear in history, and this router simply advances past them again —
// the harness, not the model, is what gets measured.
import { FAQ_CONTENT, SOLUTION_FILES, TASK_TITLE } from './fixture.js';
import type { FakeScriptResponse } from '../../src/testutil/fake-openai.js';

export interface PlanState {
  parentTurns: number;
  childTurns: number;
  auxTurns: number;
  promptTokens: number;
  completionTokens: number;
  /** parent turn number at which each stage's check first printed OK. */
  stagePassedAtTurn: Record<number, number>;
  anomalies: string[];
  /** Router-side memory of facts observed in raw tool results. Summaries
   *  (digest/checkpoint) merge this in: the harness's checkpoint harvest
   *  provably drops some evidence classes (read results, display-tool
   *  results), and a summarizer asked to summarize a session it lived
   *  through would carry them. See MILEAGE.md finding F-2. */
  seenReads: string[];
  seenDisplayOk: boolean;
  reconChildFailed: boolean;
  catalogCollectRunningStreak: number;
  orphanChildAbandoned: boolean;
  /** Debug trail of router decisions (kept bounded; dumped on failure). */
  branchLog: string[];
}

export function newPlanState(): PlanState {
  return {
    parentTurns: 0,
    childTurns: 0,
    auxTurns: 0,
    promptTokens: 0,
    completionTokens: 0,
    stagePassedAtTurn: {},
    anomalies: [],
    seenReads: [],
    seenDisplayOk: false,
    reconChildFailed: false,
    catalogCollectRunningStreak: 0,
    orphanChildAbandoned: false,
    branchLog: [],
  };
}

export interface PlanHooks {
  onChildRequest?: (kind: 'recon' | 'catalog') => void;
}

interface Call {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p: any) => (typeof p === 'string' ? p : p?.text ?? p?.content ?? '')).join('\n');
  }
  return content == null ? '' : String(content);
}

/** Reconstruct the (tool call -> result) history from a request body. */
function historyOf(body: any): { calls: Call[]; allText: string } {
  const msgs: any[] = Array.isArray(body?.messages) ? body.messages : [];
  const results = new Map<string, string>();
  for (const m of msgs) {
    if (m?.role === 'tool' && m?.tool_call_id) results.set(String(m.tool_call_id), textOf(m.content));
  }
  const calls: Call[] = [];
  for (const m of msgs) {
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc?.function?.arguments ?? '{}'); } catch { /* keep {} */ }
        calls.push({
          id: String(tc?.id ?? ''),
          name: String(tc?.function?.name ?? ''),
          args,
          result: results.get(String(tc?.id ?? '')),
        });
      }
    }
  }
  const allText = msgs.map((m) => textOf(m?.content)).join('\n');
  return { calls, allText };
}

const usage = (body: any, content: string) => ({
  promptTokens: Math.max(1, Math.ceil(JSON.stringify(body).length / 4)),
  completionTokens: Math.max(1, Math.ceil(content.length / 4)),
});

let callSeq = 0;
function toolCall(name: string, args: Record<string, unknown>, note: string): FakeScriptResponse {
  callSeq += 1;
  return {
    content: note,
    toolCalls: [{ id: `plan-${callSeq}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    finishReason: 'tool_calls',
  };
}

const WRITE_OK = (r?: string) => r !== undefined && !/error|failed/i.test(r.slice(0, 200));

interface Step {
  id: string;
  /** `allText` is every message's text in the current context — after a
   *  digest/compaction the raw tool results may be gone, and the summary
   *  lines the summarizer rendered ("Stage checks confirmed: STAGE_1_OK",
   *  "ledger-appended: stage-1-complete") are the model's durable memory.
   *  Steps for checks/ledgers accept that evidence; everything else keys
   *  off live tool results (and the run journal replays re-issued calls
   *  without re-executing them). */
  done: (c: Call[], allText: string) => boolean;
  emit: (c: Call[], allText: string) => FakeScriptResponse;
}

/** Does a rendered summary list line (`header: a, b, c.`) contain item? */
export function inSummaryList(allText: string, header: string, item: string): boolean {
  for (const m of allText.matchAll(new RegExp(`${header}: ([^\\n]+)`, 'g'))) {
    const items = m[1].split(',').map((s) => s.trim().replace(/\.$/, '').split(/\.\s+(?=[a-z][a-z-]*:)/)[0].trim());
    if (items.includes(item)) return true;
  }
  return false;
}

const hasCall = (c: Call[], name: string, pred: (call: Call) => boolean) => c.some((x) => x.name === name && pred(x));
const lastCall = (c: Call[], name: string, pred: (call: Call) => boolean) => [...c].reverse().find((x) => x.name === name && pred(x));

function readStep(path: string): Step {
  return {
    id: `read:${path}`,
    done: (c, allText) => hasCall(c, 'read', (x) => x.args.path === path && x.result !== undefined) || inSummaryList(allText, 'files-read', path),
    emit: () => toolCall('read', { path }, `Reading ${path} to map the current implementation.`),
  };
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function writeStep(path: string): Step {
  // Post-compaction, the harness's heuristic checkpoint summary lists
  // "- write /abs/<path>" for completed writes — that listing is evidence
  // the write landed, exactly what a real model would trust.
  const checkpointEvidence = new RegExp(`write:?\\s+\\S*${escapeRegExp(path)}`);
  return {
    id: `write:${path}`,
    done: (c, allText) => hasCall(c, 'write', (x) => x.args.path === path && WRITE_OK(x.result)) || checkpointEvidence.test(allText) || inSummaryList(allText, 'files-written', path),
    emit: () => toolCall('write', { path, content: SOLUTION_FILES[path] }, `Writing ${path}.`),
  };
}

function shellStep(id: string, command: string, okMarker?: string): Step {
  return {
    id,
    done: (c) => {
      const call = lastCall(c, 'shell', (x) => x.args.command === command);
      if (!call || call.result === undefined) return false;
      return okMarker ? call.result.includes(okMarker) : true;
    },
    emit: () => toolCall('shell', { command }, `Running: ${command}`),
  };
}

function stageSteps(stage: number, writes: string[]): Step[] {
  const checkCmd = `node tools/check-stage.mjs ${stage}`;
  // Idempotent marker append (the completion path — a careful operator
  // guards an append-only marker). The RAW probe append below it is the
  // exactly-once canary: deliberately unguarded, one per stage, so any
  // harness re-execution of a completed step shows up as a duplicate line.
  const ledgerCmd = `grep -qx 'stage-${stage}-complete' .endurance-ledger.log 2>/dev/null || printf 'stage-${stage}-complete\\n' >> .endurance-ledger.log`;
  const probeCmd = `printf 'probe-stage-${stage}\\n' >> .endurance-probe.log`;
  const check: Step = {
    id: `check:${stage}`,
    done: (c, allText) => {
      const call = lastCall(c, 'shell', (x) => x.args.command === checkCmd);
      if (call?.result?.includes(`STAGE_${stage}_OK`)) return true;
      // Post-digest: the raw result is gone; the summary line is the memory.
      return allText.includes(`STAGE_${stage}_OK`);
    },
    emit: () => toolCall('shell', { command: checkCmd }, `Running stage ${stage} check.`),
  };
  const ledger: Step = {
    id: `ledger:${stage}`,
    done: (c, allText) => {
      const call = lastCall(c, 'shell', (x) => x.args.command === ledgerCmd);
      if (call && call.result !== undefined) return true;
      return new RegExp(`ledger-appended:[^\\n]*stage-${stage}-complete`).test(allText);
    },
    emit: () => toolCall('shell', { command: ledgerCmd }, `Marking stage ${stage} complete in the ledger.`),
  };
  const probe: Step = {
    id: `probe:${stage}`,
    done: (c, allText) => hasCall(c, 'shell', (x) => x.args.command === probeCmd && x.result !== undefined)
      || new RegExp(`probes-appended:[^\\n]*probe-stage-${stage}\\b`).test(allText),
    emit: () => toolCall('shell', { command: probeCmd }, `Appending stage ${stage} telemetry probe.`),
  };
  return [...writes.map(writeStep), check, ledger, probe];
}

/**
 * Build the router. `chaos` enables the injected failures that target
 * CHILD traffic (the RECON child's provider is killed with HTTP 500s; the
 * CATALOG child's responses are slowed so the driver's SIGKILL lands
 * mid-flight). Parent traffic is never faulted by the router itself.
 */
export function createPlanRouter(opts: { killRecon: boolean; slowCatalog: boolean; state: PlanState; hooks?: PlanHooks }) {
  const { killRecon, slowCatalog, state } = opts;
  const hooks = opts.hooks ?? {};

  // A faithful summarizer: it can only carry what the excerpt it is GIVEN
  // contains. The excerpt renders tool calls as `write({"path":"..."...`
  // (JSON-escaped inside the request body) and tool results as plain text,
  // so completed work is extractable: file writes/reads, stage checks
  // (STAGE_N_OK literals), ledger appends, subagent outcomes, the backend
  // probe. The rendered lines then act as the model's durable memory after
  // the raw messages are digested away (exactly the channel a real model
  // has — the digest instructions literally demand "files touched and
  // their state, commands run and outcomes"). State is never smuggled
  // around the excerpt: if it isn't in the excerpt, it isn't in the summary.
  const summarisedState = (text: string): string => {
    const grab = (re: RegExp): string[] => {
      const out = new Set<string>();
      for (const m of text.matchAll(re)) out.add(m[1]);
      return [...out];
    };
    const mergeListLine = (header: string): string[] => {
      const out = new Set<string>();
      for (const m of text.matchAll(new RegExp(`${header}: ([^\\n"\\\\]+)`, 'g'))) {
        for (const item of m[1].split(',')) { const t = item.trim().replace(/\.$/, ''); if (t) out.add(t); }
      }
      return [...out];
    };
    const written = new Set([...grab(/write\(\{\\"path\\":\\"([^\\"]+)/g), ...mergeListLine('files-written')]);
    const read = new Set([...grab(/read\(\{\\"path\\":\\"([^\\"]+)/g), ...mergeListLine('files-read'), ...state.seenReads]);
    const passed: string[] = [];
    const ledgered: string[] = [];
    for (let s = 1; s <= 5; s++) {
      if (text.includes(`STAGE_${s}_OK`)) passed.push(`STAGE_${s}_OK`);
      if (text.includes(`stage-${s}-complete`)) ledgered.push(`stage-${s}-complete`);
    }
    // One fact per LINE, critical state first: summary consumers truncate
    // by lines/chars, and a single mega-line lets list items bleed into
    // each other when re-parsed.
    const lines: string[] = [];
    if (passed.length) lines.push(`Stage checks confirmed: ${passed.join(' ')}.`);
    if (ledgered.length) lines.push(`ledger-appended: ${ledgered.join(' ')}.`);
    if (text.includes('Store layout:') || text.includes('recon: done')) lines.push('recon: done.');
    else if (text.includes('injected chaos') || text.includes('recon: failed')) lines.push('recon: failed.');
    if (text.includes('display snapshot captured') || text.includes('display-snapshot: ok') || state.seenDisplayOk) lines.push('display-snapshot: ok.');
    if (text.includes('Importers of invoice-service') || text.includes('catalog: done')) lines.push('catalog: done.');
    else if (text.includes('ENDURANCE-CATALOG') || text.includes('catalog: spawned')) lines.push('catalog: spawned.');
    if (text.includes('ENDURANCE-CATALOG') || text.includes('catalog: spawned')) {
      const handle = /catalog-handle: (sub-[a-zA-Z0-9-]+)/.exec(text)?.[1] ?? /sub-[a-zA-Z0-9-]{6,}/.exec(text)?.[0];
      if (handle) lines.push(`catalog-handle: ${handle}.`);
    }
    const probed = [1, 2, 3, 4, 5].filter((s) => text.includes(`probe-stage-${s}`));
    if (probed.length) lines.push(`probes-appended: ${probed.map((s) => `probe-stage-${s}`).join(' ')}.`);
    if (written.size) lines.push(`files-written: ${[...written].join(', ')}.`);
    if (read.size) lines.push(`files-read: ${[...read].join(', ')}.`);
    return lines.join('\n');
  };

  const router = (body: any): FakeScriptResponse => {
    const text = JSON.stringify(body);

    // ── Auxiliary harness calls (checkpoint summary / digest) ────────────
    if (text.includes('You maintain a session checkpoint')) {
      state.auxTurns++;
      // State block FIRST: summary consumers render heads/floors, so the
      // durable facts must lead, not trail the prose.
      const faq = /discounts-faq/i.test(text) ? ' User mid-run steer: also add docs/discounts-faq.md (short FAQ, exactly 3 questions) in the final stage.' : '';
      const carried = summarisedState(text).replace(/\n/g, ' ');
      state.branchLog.push(`checkpoint→${carried.trim().slice(0, 200)}`);
      const content = [
        'Goal: Add end-to-end discount support to the Ledgerline codebase in five verified stages.',
        'Progress:' + (carried ? ' ' + carried : '') + faq + ' Stages are checked with node tools/check-stage.mjs N and marked in .endurance-ledger.log as they pass.',
        'Decisions: percent/fixed discount kinds; invoice discount capped at 50% of subtotal; tax on discounted subtotal.',
        'Next: Continue the current stage, run its check, append its ledger marker.',
      ].join('\n');
      const u = usage(body, content); state.promptTokens += u.promptTokens; state.completionTokens += u.completionTokens;
      return { content, finishReason: 'stop', ...u };
    }
    if (text.includes('Summarize this agent-work transcript into a compact digest')) {
      state.auxTurns++;
      const faq = /discounts-faq/i.test(text) ? '\nUser mid-run steer pending: add docs/discounts-faq.md (3-question FAQ) in the final stage.' : '';
      const carried = summarisedState(text);
      state.branchLog.push(`digest→${carried.replace(/\n/g, ' | ').trim().slice(0, 220)}`);
      const content = 'Digest:\n' + carried + faq + '\nTask: Ledgerline discounts in 5 stages; stage checks via node tools/check-stage.mjs N; rules: percent (0,100] / fixed cents; invoice discount capped at 50% of subtotal; tax on discounted subtotal; unknown code throws.';
      const u = usage(body, content); state.promptTokens += u.promptTokens; state.completionTokens += u.completionTokens;
      return { content, finishReason: 'stop', ...u };
    }

    // ── Child (subagent) traffic ──────────────────────────────────────────
    if (text.includes('Spawn preset:') && !text.includes(TASK_TITLE)) {
      state.childTurns++;
      const kind: 'recon' | 'catalog' = text.includes('ENDURANCE-RECON') ? 'recon' : 'catalog';
      hooks.onChildRequest?.(kind);
      if (kind === 'recon' && killRecon) {
        // Provider-kill: every model call for this child fails. The parent
        // must observe a failed child and recover on its own.
        return { error: { status: 500, message: 'injected chaos: provider unavailable for subagent' } };
      }
      const { calls } = historyOf(body);
      const delayMs = kind === 'catalog' && slowCatalog ? 1500 : kind === 'catalog' ? 250 : 0;
      if (calls.length === 0) {
        const path = kind === 'recon' ? 'src/store/memory-store.js' : 'src/services/invoice-service.js';
        const r = toolCall('read', { path }, `Mapping ${path} as requested.`);
        return { ...r, delayMs, ...usage(body, r.content ?? '') };
      }
      const summary = kind === 'recon'
        ? 'Store layout: src/store/memory-store.js provides createMemoryStore (Map-backed CRUD); src/store/store.js adds per-kind shared stores via storeFor(kind); src/store/index.js re-exports both. New stores should follow the same factory shape.'
        : 'Importers of invoice-service: src/api/invoices-api.js (createInvoicesApi) and src/services/index.js (barrel). Tests: tests/invoice.test.mjs constructs createInvoiceService directly.';
      const content = 'All done.\n\n```json\n' + JSON.stringify({ status: 'done', summary, findings: [], artifacts: [] }) + '\n```';
      const u = usage(body, content); state.promptTokens += u.promptTokens; state.completionTokens += u.completionTokens;
      return { content, finishReason: 'stop', delayMs, ...u };
    }

    // ── Any other tool-less auxiliary call (narrative, review, judge) ────
    if (!Array.isArray(body?.tools) || body.tools.length === 0) {
      state.auxTurns++;
      return { content: 'ok', finishReason: 'stop', ...usage(body, 'ok') };
    }

    // ── Parent main loop ──────────────────────────────────────────────────
    state.parentTurns++;
    const { calls, allText } = historyOf(body);
    // Router-side memory: record facts the moment raw results show them, so
    // summaries and step checks survive the harness's lossy harvests.
    for (const call of calls) {
      if (call.result === undefined) continue;
      if (call.name === 'read' && typeof call.args.path === 'string' && !state.seenReads.includes(call.args.path)) {
        state.seenReads.push(call.args.path);
      }
      if (call.name === 'display_snapshot' && !/E_BACKEND_DOWN|unavailable/i.test(call.result)) state.seenDisplayOk = true;
    }
    const readStepM = (p: string): Step => {
      const s = readStep(p);
      const orig = s.done;
      s.done = (c, t) => orig(c, t) || state.seenReads.includes(p);
      return s;
    };
    for (let s = 1; s <= 5; s++) {
      const chk = lastCall(calls, 'shell', (x) => x.args.command === `node tools/check-stage.mjs ${s}`);
      if (chk?.result?.includes(`STAGE_${s}_OK`) && !state.stagePassedAtTurn[s]) {
        state.stagePassedAtTurn[s] = state.parentTurns;
      }
    }
    // The steer counts as seen if the raw steer marker is in context OR the
    // faq requirement survived via a checkpoint/digest summary (post-resume
    // the original steer message is gone; its summary line is the evidence).
    const steerSeen = allText.includes('[mid-run steer]') || allText.includes('discounts-faq.md');

    const reconCall = lastCall(calls, 'subagent', (x) => String(x.args.prompt ?? '').includes('ENDURANCE-RECON'));
    const reconFailed = (!!reconCall && reconCall.result !== undefined &&
      /error|fail|unavailable|no result|exception/i.test(reconCall.result) && !reconCall.result.includes('createMemoryStore')) ||
      allText.includes('recon: failed');
    if (reconFailed) state.reconChildFailed = true;
    const reconDone = (!!reconCall && reconCall.result !== undefined) || allText.includes('recon: done') || allText.includes('recon: failed');

    const steps: Step[] = [
      readStepM('src/services/invoice-service.js'),
      readStepM('src/store/index.js'),
      {
        id: 'subagent:recon',
        done: () => reconDone,
        emit: () => toolCall('subagent', {
          prompt: 'ENDURANCE-RECON: Map the store layout of this repo (src/store/*): which factories exist, how stores are created and exported. Return a concise structured summary.',
          preset: 'researcher',
          timeoutMs: 40_000,
        }, 'Delegating a store-layout recon to a researcher subagent.'),
      },
      // Recovery / confirmation reads after the recon child reports.
      ...(reconFailed
        ? [readStepM('src/store/memory-store.js'), readStepM('src/domain/coupon.js')]
        : [readStepM('src/domain/coupon.js')]),
      ...stageSteps(1, ['src/discounts/discount.js', 'src/discounts/index.js']),
      ...stageSteps(2, ['src/store/discount-store.js', 'src/store/index.js']),
      {
        // Display backend probe after stage 2's writes (snapshot the new
        // store): done only when a snapshot call SUCCEEDED — under the
        // flake the first call errors E_BACKEND_DOWN and the plan retries.
        id: 'probe:display',
        done: (c, allText) => c.some((x) => x.name === 'display_snapshot' && x.result !== undefined && !/E_BACKEND_DOWN|unavailable/i.test(x.result)) || allText.includes('display-snapshot: ok') || state.seenDisplayOk,
        emit: () => toolCall('display_snapshot', { target: 'store-schema' }, 'Capturing a display snapshot of the store schema after writing the discount store.'),
      },
      ...stageSteps(3, ['src/services/invoice-service.js']),
      {
        id: 'subagent:catalog-spawn',
        done: (c, allText) => !!lastCall(c, 'subagent', (x) => String(x.args.prompt ?? '').includes('ENDURANCE-CATALOG') && x.result !== undefined) || allText.includes('catalog: spawned') || allText.includes('catalog: done'),
        emit: () => toolCall('subagent', {
          prompt: 'ENDURANCE-CATALOG: Catalogue which files import src/services/invoice-service.js and which tests construct createInvoiceService directly. Return a concise structured summary.',
          preset: 'researcher',
          background: true,
        }, 'Spawning a background researcher to catalogue invoice-service importers.'),
      },
      {
        id: 'subagent:catalog-collect',
        done: (c, allText) => {
          if (allText.includes('catalog: done')) return true;
          const spawn = lastCall(c, 'subagent', (x) => String(x.args.prompt ?? '').includes('ENDURANCE-CATALOG'));
          if (!spawn || spawn.result === undefined) return false;
          const collect = lastCall(c, 'collect_agent', (x) => x.result !== undefined);
          if (!collect) return false;
          if (/DONE|done|summary/i.test(collect.result ?? '')) return true;
          if (/FAILED|failed|error/i.test(collect.result ?? '')) return true;
          // Still RUNNING: tolerate a couple of polls, then cancel + move on
          // (post-SIGKILL orphan reconciliation path).
          return state.orphanChildAbandoned;
        },
        emit: (c, allText) => {
          const spawn = lastCall(c, 'subagent', (x) => String(x.args.prompt ?? '').includes('ENDURANCE-CATALOG'));
          const handle = /sub-[a-zA-Z0-9-]+/.exec(spawn?.result ?? '')?.[0]
            ?? /catalog-handle: (sub-[a-zA-Z0-9-]+)/.exec(allText)?.[1] ?? '';
          const priorCollects = c.filter((x) => x.name === 'collect_agent' && x.result !== undefined);
          const lastCollect = priorCollects[priorCollects.length - 1];
          if (lastCollect && /RUNNING/i.test(lastCollect.result ?? '')) {
            state.catalogCollectRunningStreak++;
            if (state.catalogCollectRunningStreak >= 2) {
              state.orphanChildAbandoned = true;
              state.anomalies.push('catalog child still RUNNING after resume; abandoned via cancel_agent');
              return toolCall('cancel_agent', { id: handle }, 'The background child appears orphaned; cancelling it and continuing without it.');
            }
          }
          return toolCall('collect_agent', { id: handle, waitMs: 8000 }, 'Collecting the background catalogue result.');
        },
      },
      ...stageSteps(4, ['src/api/discounts-api.js', 'src/api/index.js']),
      writeStep('docs/discounts.md'),
      {
        id: 'write:faq',
        done: (c) => !steerSeen || hasCall(c, 'write', (x) => x.args.path === 'docs/discounts-faq.md' && WRITE_OK(x.result)),
        emit: () => toolCall('write', { path: 'docs/discounts-faq.md', content: FAQ_CONTENT }, 'Adding the FAQ doc the user asked for mid-run.'),
      },
      shellStep('suite:final', 'node tools/run-tests.mjs', 'ALL TESTS PASS'),
      ...stageSteps(5, []),
      {
        id: 'write:faq-late',
        done: (c) => !steerSeen || hasCall(c, 'write', (x) => x.args.path === 'docs/discounts-faq.md' && WRITE_OK(x.result)),
        emit: () => toolCall('write', { path: 'docs/discounts-faq.md', content: FAQ_CONTENT }, 'Adding the FAQ doc the user asked for mid-run.'),
      },
    ];

    const evMarks = ['files-read:', 'files-written:', 'STAGE_1_OK', 'STAGE_2_OK', 'recon:', 'catalog:', 'ledger-appended:', 'display-snapshot:', 'probes-appended:'].map((m) => `${m}${allText.includes(m) ? '+' : '-'}`).join(' ');
    for (const step of steps) {
      if (!step.done(calls, allText)) {
        state.branchLog.push(`t${state.parentTurns}: ${step.id} [${evMarks}]`);
        if (state.branchLog.length > 300) state.branchLog.splice(0, state.branchLog.length - 300);
        const r = step.emit(calls, allText);
        const u = usage(body, r.content ?? '');
        state.promptTokens += u.promptTokens; state.completionTokens += u.completionTokens;
        return { ...r, ...u };
      }
    }

    state.branchLog.push(`t${state.parentTurns}: CLAIM`);
    const content = 'Discount support is implemented end to end: pure discount module (stage 1), discount store (stage 2), invoice integration with the 50% cap (stage 3), API handlers (stage 4), and documentation (stage 5). Every stage check printed STAGE_N_OK, each stage marker was appended to .endurance-ledger.log, and the full regression suite passes.';
    const u = usage(body, content); state.promptTokens += u.promptTokens; state.completionTokens += u.completionTokens;
    return { content, finishReason: 'stop', ...u };
  };

  return router;
}
