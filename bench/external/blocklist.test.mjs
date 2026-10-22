#!/usr/bin/env node
// Tests for blocklist.mjs — plain node:test, no dependencies.
//   node --test bench/external/blocklist.test.mjs
// Covers the contract the ingestion pipeline relies on:
//   - matches by instance_id
//   - matches by (repo, base_commit) pair and by base_commit alone
//   - repo name ALONE does not block (SWE-bench train split shares eval repos)
//   - clean items pass
//   - filterRecords drops blocked items and LOGS every single drop
//   - the shipped seed file loads, names the expected datasets, and honestly
//     reports seed-only coverage (no fabricated instance IDs)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBlocklist, expandBlocklistData, extractIds, loadBlocklist, DEFAULT_BLOCKLIST_PATH } from './blocklist.mjs';

function expandedBlocklist() {
  const data = {
    datasets: [{ id: 'synthetic-eval', name: 'Synthetic', split: 'test', instance_ids: [], base_commits: [], repos: ['acme/widgets'] }],
    extra_blocked: { instance_ids: [], base_commits: [], repo_commit_pairs: [] },
  };
  // Simulate `expand` from a downloaded dataset file.
  expandBlocklistData(data, [
    { instance_id: 'acme__widgets-101', repo: 'acme/widgets', base_commit: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555' },
    { instance_id: 'acme__widgets-202', repo: 'acme/widgets', base_commit: 'ffff6666gggg7777hhhh8888iiii9999jjjj0000'.replace(/[g-j]/g, 'a') },
  ], 'synthetic-eval');
  return createBlocklist(data);
}

test('matches by instance_id', () => {
  const bl = expandedBlocklist();
  const hit = bl.isBlocked({ instanceId: 'acme__widgets-101' });
  assert.equal(hit.blocked, true);
  assert.equal(hit.reason, 'instance_id');
  assert.equal(hit.dataset, 'synthetic-eval');
  // Raw dataset-shaped records work too.
  assert.equal(bl.isBlocked({ instance_id: 'acme__widgets-202' }).blocked, true);
});

test('matches by repo+commit pair and by base_commit alone', () => {
  const bl = expandedBlocklist();
  const byCommit = bl.isBlocked({ repo: 'acme/widgets', baseCommit: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555' });
  assert.equal(byCommit.blocked, true);
  // An unknown instance_id on a blocked base commit still blocks (SHA is unique).
  const renamed = bl.isBlocked({ instance_id: 'some__other-999', repo: 'acme/widgets', base_commit: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555' });
  assert.equal(renamed.blocked, true);
});

test('repo alone does NOT block; clean items pass', () => {
  const bl = expandedBlocklist();
  // Same repo, different (train-split) commit → must pass, or SWE-bench train is unusable.
  assert.equal(bl.isBlocked({ instanceId: 'acme__widgets-7', repo: 'acme/widgets', baseCommit: '0000111122223333444455556666777788889999' }), false);
  assert.equal(bl.isBlocked({ repo: 'acme/widgets' }), false);
  assert.equal(bl.isBlocked({ instanceId: 'other__repo-1', repo: 'other/repo', baseCommit: '1234' }), false);
  assert.equal(bl.isBlocked({}), false);
});

test('filterRecords drops blocked items and logs every drop', () => {
  const bl = expandedBlocklist();
  const logs = [];
  const records = [
    { instance_id: 'acme__widgets-101', repo: 'acme/widgets', base_commit: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555', payload: 1 },
    { instance_id: 'clean__one-1', repo: 'clean/one', base_commit: '9999', payload: 2 },
    { instance_id: 'clean__one-2', repo: 'acme/widgets', base_commit: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555', payload: 3 }, // blocked via commit
    { instance_id: 'clean__two-1', repo: 'clean/two', base_commit: '8888', payload: 4 },
  ];
  const { kept, dropped } = bl.filterRecords(records, { source: 'unit-test', logger: (e) => logs.push(e) });
  assert.deepEqual(kept.map((r) => r.payload), [2, 4]);
  assert.equal(dropped.length, 2);
  assert.equal(logs.length, 2, 'every drop must be logged');
  assert.equal(logs[0].source, 'unit-test');
  assert.ok(logs.every((l) => l.reason && l.matched && l.at));
});

test('seed blocklist file loads with the expected datasets and honest coverage', () => {
  const bl = loadBlocklist(DEFAULT_BLOCKLIST_PATH);
  const ids = bl.coverage().map((c) => c.id);
  for (const expected of ['swe-bench-verified', 'swe-bench-lite', 'swe-bench-pro-public', 'swe-bench-multilingual', 'terminal-bench-2.0']) {
    assert.ok(ids.includes(expected), `seed must name ${expected}`);
  }
  // Honesty invariant: the seed must not pretend to have instance coverage it
  // does not have, and must never block a random clean record.
  assert.equal(bl.isBlocked({ instanceId: 'definitely__not-an-eval-instance-1', repo: 'nobody/nothing', baseCommit: 'deadbeef' }), false);
  const verified = bl.coverage().find((c) => c.id === 'swe-bench-verified');
  assert.equal(verified.expected_count, 500);
  assert.ok(verified.repos_listed >= 12, 'Verified repo names are public knowledge and should be listed');
});

test('extractIds tolerates the shapes ingestion actually sees', () => {
  assert.deepEqual(extractIds({ instance_id: ' a__b-1 ', repo: 'https://github.com/Acme/Widgets.git', base_commit: 'ABC' }),
    { instanceId: 'a__b-1', repo: 'acme/widgets', baseCommit: 'abc' });
  assert.equal(extractIds({ task_id: 'tb-task-1' }).instanceId, 'tb-task-1');
  assert.deepEqual(extractIds(null), { instanceId: '', repo: '', baseCommit: '' });
});
