// Fast lane (src/core/fastlane.ts + fastlane-stats.ts): the entry decision
// must be provably conservative (entered only on positive evidence of
// shortness), the exit predicate must trip on every not-short signal, and
// the stats store must make the false-short rate a real number.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Workspace } from '../workspace.js';
import { CHAT_TOOL_NAMES } from '../tools/index.js';
import {
  decideFastLane, fastLaneEscalationReason, fastLaneToolNames, referencedFilesFor,
  resolveFastLaneEnabled, FASTLANE_LIMITS, FASTLANE_CHAT_TOOLS,
  type FastLaneSignals, type FastLaneRunState,
} from './fastlane.js';
import {
  loadFastLaneStats, recordFastLaneEntry, recordFastLaneEscalation,
  recordFastLaneOutcome, falseShortRate,
} from './fastlane-stats.js';

function signals(over: Partial<FastLaneSignals> = {}): FastLaneSignals {
  return {
    kind: 'fix',
    complexity: 'simple',
    complexityScore: 2,
    referencedFiles: ['math.js'],
    textChars: 60,
    acceptanceCriteria: 0,
    chameleonDifficulty: 5,
    repoFiles: 12,
    role: 'coder',
    simpleScript: false,
    trivialWrite: false,
    ...over,
  };
}

function runState(over: Partial<FastLaneRunState> = {}): FastLaneRunState {
  return {
    filesEdited: 1, filesRead: 1, toolErrors: 0,
    consecutiveVerifyFailures: 0, loadToolsCalls: 0, iteration: 3,
    ...over,
  };
}

describe('resolveFastLaneEnabled', () => {
  it('defaults on; config and env each disable', () => {
    expect(resolveFastLaneEnabled(undefined, {})).toBe(true);
    expect(resolveFastLaneEnabled({}, {})).toBe(true);
    expect(resolveFastLaneEnabled({ enabled: true }, {})).toBe(true);
    expect(resolveFastLaneEnabled({ enabled: false }, {})).toBe(false);
    expect(resolveFastLaneEnabled(undefined, { MOCHI_FASTLANE: '0' })).toBe(false);
    expect(resolveFastLaneEnabled({ enabled: true }, { MOCHI_FASTLANE: '0' })).toBe(false);
  });
});

describe('decideFastLane', () => {
  it('admits a proven-short one-file fix', () => {
    const d = decideFastLane(signals(), true);
    expect(d.eligible).toBe(true);
    expect(d.reasons.join(' ')).toContain('math.js');
  });

  it('admits chat and document shapes', () => {
    expect(decideFastLane(signals({ kind: 'chat', referencedFiles: ['a.md'] }), true).eligible).toBe(true);
    expect(decideFastLane(signals({ kind: 'document', referencedFiles: ['README.md'] }), true).eligible).toBe(true);
  });

  it('vetoes when disabled, and says so', () => {
    const d = decideFastLane(signals(), false);
    expect(d.eligible).toBe(false);
    expect(d.reasons.join(' ')).toContain('disabled');
  });

  it('vetoes complex outright and standard only above the benign-signals ceiling', () => {
    // A plainly-worded one-file fix scores exactly 3 on the real scorer
    // (mutate-existing +2, multi-sentence +1) and lands in 'standard' —
    // it must still enter. Substance (score 4+) must not.
    expect(decideFastLane(signals({ complexity: 'standard', complexityScore: 3 }), true).eligible).toBe(true);
    expect(decideFastLane(signals({ complexity: 'standard', complexityScore: 4 }), true).eligible).toBe(false);
    expect(decideFastLane(signals({ complexity: 'complex', complexityScore: 6 }), true).eligible).toBe(false);
  });

  it('vetoes kinds the lane does not serve', () => {
    for (const kind of ['research', 'plan', 'refactor', 'unknown'] as const) {
      expect(decideFastLane(signals({ kind }), true).eligible).toBe(false);
    }
  });

  it('vetoes multi-file scope, long specs, and multi-criteria deliverables', () => {
    expect(decideFastLane(signals({ referencedFiles: ['a.js', 'b.js', 'c.js'] }), true).eligible).toBe(false);
    expect(decideFastLane(signals({ textChars: FASTLANE_LIMITS.maxTextChars + 1 }), true).eligible).toBe(false);
    expect(decideFastLane(signals({ acceptanceCriteria: 2 }), true).eligible).toBe(false);
  });

  it('vetoes deep-work vocabulary and specialist roles', () => {
    expect(decideFastLane(signals({ chameleonDifficulty: 9 }), true).eligible).toBe(false);
    expect(decideFastLane(signals({ role: 'security' }), true).eligible).toBe(false);
    expect(decideFastLane(signals({ role: 'architect' }), true).eligible).toBe(false);
  });

  it('vetoes a scopeless mutation task when the repo is big or unknown', () => {
    expect(decideFastLane(signals({ referencedFiles: [], repoFiles: 5_000 }), true).eligible).toBe(false);
    expect(decideFastLane(signals({ referencedFiles: [], repoFiles: null }), true).eligible).toBe(false);
    // …but admits it in a provably small repo, and for self-contained shapes.
    expect(decideFastLane(signals({ referencedFiles: [], repoFiles: 40 }), true).eligible).toBe(true);
    expect(decideFastLane(signals({ referencedFiles: [], repoFiles: null, simpleScript: true }), true).eligible).toBe(true);
    expect(decideFastLane(signals({ referencedFiles: [], repoFiles: null, trivialWrite: true }), true).eligible).toBe(true);
  });

  it('referencedFilesFor merges fileScope and paths named in text', () => {
    const files = referencedFilesFor({
      title: 'Fix the bug in src/math.js',
      description: 'Also check helpers/util.py please. Version 18.2 is unrelated.',
      fileScope: ['src/math.js', 'extra.ts'],
    });
    expect(files).toContain('src/math.js');
    expect(files).toContain('helpers/util.py');
    expect(files).toContain('extra.ts');
    expect(files).not.toContain('18.2');
    expect(new Set(files).size).toBe(files.length);
  });
});

describe('fastLaneToolNames', () => {
  it('coding set is small, carries the escape hatch, and excludes heavy machinery', () => {
    const names = fastLaneToolNames('fix');
    expect(names.length).toBeLessThanOrEqual(13);
    for (const n of ['read', 'edit', 'shell', 'verify', 'load_tools']) expect(names).toContain(n);
    for (const n of ['browser', 'subagent', 'chameleon', 'security_audit', 'codebase_map', 'computer']) {
      expect(names).not.toContain(n);
    }
  });

  it('chat set matches the standard chat tier exactly', () => {
    expect([...fastLaneToolNames('chat')].sort()).toEqual([...CHAT_TOOL_NAMES].sort());
    expect([...FASTLANE_CHAT_TOOLS].sort()).toEqual([...CHAT_TOOL_NAMES].sort());
  });
});

describe('fastLaneEscalationReason', () => {
  it('stays in the lane on a healthy short run', () => {
    expect(fastLaneEscalationReason(runState())).toBeNull();
    expect(fastLaneEscalationReason(runState({ filesEdited: 3, filesRead: 8, iteration: 9 }))).toBeNull();
  });

  it('trips on every not-short signal', () => {
    expect(fastLaneEscalationReason(runState({ consecutiveVerifyFailures: 2 }))).toBe('verify-failures');
    expect(fastLaneEscalationReason(runState({ filesEdited: 4 }))).toBe('files-edited');
    expect(fastLaneEscalationReason(runState({ toolErrors: 4 }))).toBe('tool-errors');
    expect(fastLaneEscalationReason(runState({ loadToolsCalls: 2 }))).toBe('load-tools');
    expect(fastLaneEscalationReason(runState({ filesRead: 9 }))).toBe('files-read');
    expect(fastLaneEscalationReason(runState({ iteration: FASTLANE_LIMITS.maxIterations - FASTLANE_LIMITS.turnBudgetGrace }))).toBe('turn-budget');
  });

  it('failure evidence outranks scope and budget evidence', () => {
    expect(fastLaneEscalationReason(runState({
      consecutiveVerifyFailures: 2, filesEdited: 9, iteration: 99,
    }))).toBe('verify-failures');
    expect(fastLaneEscalationReason(runState({
      filesEdited: 9, iteration: 99,
    }))).toBe('files-edited');
  });
});

describe('fastlane stats store', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function ws(): Workspace {
    dir = mkdtempSync(resolve(tmpdir(), 'mochi-fastlane-stats-'));
    const w = new Workspace(dir, '.mochi');
    w.ensure();
    return w;
  }

  it('persists entries, escalations by reason, and outcomes across reloads', () => {
    const w = ws();
    recordFastLaneEntry(w, 'fix');
    recordFastLaneEntry(w, 'fix');
    recordFastLaneEntry(w, 'chat');
    recordFastLaneEscalation(w, 'files-edited');
    recordFastLaneOutcome(w, 'completed-in-lane');
    recordFastLaneOutcome(w, 'completed-in-lane');
    recordFastLaneOutcome(w, 'completed-after-escalation');
    const s = loadFastLaneStats(w);
    expect(s.entries).toBe(3);
    expect(s.entriesByKind).toEqual({ fix: 2, chat: 1 });
    expect(s.escalations).toBe(1);
    expect(s.escalationsByReason['files-edited']).toBe(1);
    expect(s.completedInLane).toBe(2);
    expect(s.completedAfterEscalation).toBe(1);
  });

  it('falseShortRate is escalations/entries, and null before any entry', () => {
    const w = ws();
    expect(falseShortRate(loadFastLaneStats(w))).toBeNull();
    recordFastLaneEntry(w, 'fix');
    recordFastLaneEntry(w, 'fix');
    recordFastLaneEntry(w, 'fix');
    recordFastLaneEntry(w, 'fix');
    recordFastLaneEscalation(w, 'turn-budget');
    expect(falseShortRate(loadFastLaneStats(w))).toBeCloseTo(0.25);
  });
});
