// Unified memory search (P1.5): one fused search over all four stores, and
// the loop's substantive success-fact writer.
//
// The ranking fixtures are constructed deliberately:
//  - (a) a paraphrase whose stored text shares NO keyword tokens with the
//    query (the old keyword ranker scores it exactly 0 and selectRelevant's
//    0.2 floor would drop it) but whose character trigrams overlap heavily —
//    only the semantic ranker can find it.
//  - (b) a keyword-stuffed candidate that the order-blind token ranker ranks
//    #1 (every query token present, buried in a long unrelated salad) while
//    the trigram ranker ranks a coherent candidate higher — reciprocal-rank
//    fusion must side with the candidate BOTH rankers like.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  rankCandidates,
  searchMemory,
  ngramSimilarity,
  buildRunSuccessFact,
  recordRunSuccessFact,
  type UnifiedCandidate,
} from './unified-search.js';
import { scoreEntry } from './relevance.js';
import { addFact, loadFacts } from './memory-store.js';
import { MemoryStore } from './memory.js';
import { recordProjectMemory } from './project-memory.js';
import { recordLesson } from '../lessons.js';

let dir: string;
let savedMemoryFile: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'mochi-unified-'));
  savedMemoryFile = process.env['MOCHI_MEMORY_FILE'];
  process.env['MOCHI_MEMORY_FILE'] = resolve(dir, 'memory.jsonl');
});

afterEach(() => {
  if (savedMemoryFile === undefined) delete process.env['MOCHI_MEMORY_FILE'];
  else process.env['MOCHI_MEMORY_FILE'] = savedMemoryFile;
  rmSync(dir, { recursive: true, force: true });
});

const PARAPHRASE_QUERY = 'why did the docker build rerun after i edited the package lock file';
const PARAPHRASE_FACT = 'The deployment pipeline rebuilds the container image whenever the lockfile changes';

describe('unified search — semantic ranker finds what keyword search cannot (a)', () => {
  it('ranks a zero-keyword-overlap paraphrase first via trigram similarity', () => {
    // The old ranker is blind to this pair: scoreEntry is exactly 0, far
    // below the 0.2 floor selectRelevant used to apply.
    expect(scoreEntry(PARAPHRASE_QUERY, PARAPHRASE_FACT, PARAPHRASE_FACT)).toBe(0);

    const candidates: UnifiedCandidate[] = [
      { source: 'global', title: '', text: PARAPHRASE_FACT, kind: 'fact' },
      { source: 'workspace', title: 'decision: Kitchen rota', text: 'The office kitchen coffee machine is descaled every Friday afternoon', kind: 'decision' },
      { source: 'project', title: '', text: 'Quarterly budget reviews happen in the second week of the quarter' },
    ];
    const hits = rankCandidates(PARAPHRASE_QUERY, candidates);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].text).toBe(PARAPHRASE_FACT);
    expect(hits[0].source).toBe('global');
    expect(hits[0].keywordScore).toBe(0);
    expect(hits[0].semanticScore).toBeGreaterThan(0.2);
    // Every other hit scored strictly below the paraphrase.
    for (const h of hits.slice(1)) expect(h.score).toBeLessThan(hits[0].score);
  });

  it('searchMemory reaches across the global store, workspace store and lessons in one call', () => {
    const stateDir = resolve(dir, '.mochi');
    addFact(PARAPHRASE_FACT, 'fact', 'session');
    const ws = new MemoryStore(stateDir);
    ws.addDecision('Release process', 'Releases are cut from the main branch on Tuesdays after the freeze.');
    recordLesson(stateDir, {
      id: 'l1',
      signature: 'ECONNREFUSED 5432',
      kind: 'TEST_FAILURE',
      lesson: 'Start the local postgres service before running the integration tests',
    });

    const hits = searchMemory(PARAPHRASE_QUERY, { stateDir, projectDir: dir });
    const global = hits.find((h) => h.source === 'global');
    expect(global?.text).toBe(PARAPHRASE_FACT);
    expect(global?.keywordScore).toBe(0);

    const lessonHits = searchMemory('postgres connection refused when running tests', { stateDir, projectDir: dir });
    expect(lessonHits.some((h) => h.source === 'lessons' && h.text.includes('postgres service'))).toBe(true);
  });
});

describe('unified search — reciprocal-rank fusion (b)', () => {
  const QUERY = 'postgres connection pool exhaustion during deploys';
  const COHERENT: UnifiedCandidate = {
    source: 'workspace',
    title: 'postgres connection pool limits',
    text: 'The postgres connection pool is capped at 25 connections; exhaustion during deploys surfaces as 503 errors.',
    kind: 'decision',
  };
  // Every query token present (title + tail) so the order-blind token ranker
  // scores it a perfect 1.0 — but the tokens sit in a long unrelated salad,
  // so the order-sensitive trigram ranker ranks it well below the coherent
  // candidate.
  const SALAD_WORDS = 'zebra quantum harvest moonlight lantern velvet cactus orchestra pendulum glacier banjo kettle saffron meadow compass tundra walnut mercury jester hollow beacon sorrel tempest harbor willow copper saddle nectar fjord garnet marble cedar onyx prairie anchor breeze canyon domino ember falcon island juniper karma lagoon magnet obsidian quartz rocket umbra xenon yellow zephyr cinder dolphin granite ivory jungle'.split(' ');
  const STUFFED: UnifiedCandidate = {
    source: 'workspace',
    title: 'deploys during exhaustion pool connection postgres',
    text: `${SALAD_WORDS.join(' ')} ${SALAD_WORDS.join(' ')} ${SALAD_WORDS.join(' ')} postgres connection pool exhaustion during deploys`,
    kind: 'decision',
  };
  const FILLER_A: UnifiedCandidate = {
    source: 'project',
    title: '',
    text: 'During deploys the pipeline drains connections, waits for in-flight requests, swaps the container, and runs smoke checks.',
  };
  const FILLER_B: UnifiedCandidate = {
    source: 'global',
    title: '',
    text: 'Postgres shared buffers and work_mem were raised last quarter; the database host also runs a nightly vacuum and analyze job.',
    kind: 'fact',
  };

  it('a candidate both rankers like beats a keyword-stuffed candidate only one likes', () => {
    const hits = rankCandidates(QUERY, [STUFFED, FILLER_A, COHERENT, FILLER_B]);
    const coherent = hits.find((h) => h.text === COHERENT.text)!;
    const stuffed = hits.find((h) => h.title === STUFFED.title)!;
    // The premise: the keyword ranker alone prefers the stuffed candidate…
    expect(stuffed.keywordScore).toBeGreaterThan(coherent.keywordScore);
    // …the trigram ranker alone prefers the coherent one…
    expect(coherent.semanticScore).toBeGreaterThan(stuffed.semanticScore);
    // …and fusion sides with the candidate both rankers rate.
    expect(hits[0].text).toBe(COHERENT.text);
    expect(hits.indexOf(stuffed)).toBeGreaterThan(hits.indexOf(coherent));
  });
});

describe('run success facts', () => {
  it('builds a bounded one-line fact with title, files and verification outcome', () => {
    const statement = buildRunSuccessFact({
      kind: 'fix',
      taskTitle: 'Fix the bug in math.js: add() returns the wrong result',
      summary: 'Fixed add() to return a + b; the repro script now passes.\n\nExtra detail that must not leak in.',
      filesChanged: ['math.js'],
      verification: 'passed',
    });
    expect(statement).toBe(
      'Completed fix task "Fix the bug in math.js: add() returns the wrong result": Fixed add() to return a + b; the repro script now passes. Changed: math.js. Verification: passed.',
    );
    expect(statement).not.toContain('\n');
  });

  it('records one fact per outcome and dedupes near-identical re-runs (d, unit level)', () => {
    const input = {
      kind: 'fix',
      taskTitle: 'Fix the bug in math.js: add() returns the wrong result',
      summary: 'Fixed add() to return a + b; the repro script now passes.',
      filesChanged: ['math.js'],
      verification: 'passed' as const,
    };
    const first = recordRunSuccessFact(input);
    expect(first).not.toBeNull();
    expect(first?.category).toBe('history');
    expect(first?.source).toBe('run');
    expect(first?.statement).toContain('math.js');
    expect(first?.statement).toContain('Verification: passed');

    // Near-identical re-run (one word different in the summary): the trigram
    // dedupe must refuse to stack a second copy.
    const rerun = recordRunSuccessFact({ ...input, summary: 'Fixed add() to return a + b; the repro script now passes cleanly.' });
    expect(rerun).toBeNull();
    expect(loadFacts().filter((f) => f.category === 'history')).toHaveLength(1);

    // A genuinely different run on the same file still records.
    const other = recordRunSuccessFact({
      kind: 'implement',
      taskTitle: 'Add a subtract function to math.js',
      summary: 'Added subtract() to math.js and exported it.',
      filesChanged: ['math.js'],
      verification: 'passed',
    });
    expect(other).not.toBeNull();
    expect(loadFacts().filter((f) => f.category === 'history')).toHaveLength(2);
  });

  it('ngramSimilarity separates re-runs from different runs', () => {
    const a = buildRunSuccessFact({
      kind: 'fix', taskTitle: 'Fix the bug in math.js: add() returns the wrong result',
      summary: 'Fixed add() to return a + b; the repro script now passes.', filesChanged: ['math.js'], verification: 'passed',
    });
    const b = buildRunSuccessFact({
      kind: 'fix', taskTitle: 'Fix the bug in math.js: add() returns the wrong result',
      summary: 'Fixed add() to return a + b; the repro script now passes cleanly.', filesChanged: ['math.js'], verification: 'passed',
    });
    expect(ngramSimilarity(a, b)).toBeGreaterThan(0.85);
  });
});
