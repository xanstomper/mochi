// Canned solution: arg-aware read-only classification, ported from
// src/core/capability-registry.ts + src/core/tool-dispatcher.ts as of
// e9eec54 (feat(core): arg-aware read-only classification — GET fetch
// rejoins the parallel read batch). The capability gains an optional
// isReadOnlyForArgs predicate that WINS over the static flag when present
// (and must fail closed); fetch supplies one — the complement of
// isFetchMutationRequest — and the dispatcher classifies each call by it.
// fetch-methods.js is unchanged (it pre-dates the fix).
const { isFetchMutationRequest } = require('./fetch-methods.js');

const READ_ONLY_TOOLS = new Set([
  'read', 'search', 'glob', 'inspect', 'git', 'diff', 'tree',
  'get_function', 'find_callers', 'type_hierarchy', 'verify', 'perf_audit',
  'deepwiki', 'clipboard', 'sql_codebase', 'analyze_code', 'memory',
  'web_search', 'get_diagnostics', 'git_blame', 'git_history', 'system_info',
  'find_references', 'find_definitions', 'db_inspect', 'think',
]);
// 'fetch' is deliberately ABSENT from READ_ONLY_TOOLS: its method arg
// selects POST/PUT/PATCH/DELETE, which mutate REMOTE state, and the static
// flag is arg-blind — mutating requests must not ride the concurrent
// read-only batch. The arg-blind static flag keeps fetch OUT of the static
// set, but toolToCapability supplies an isReadOnlyForArgs predicate so the
// dispatcher can admit the READ-ONLY calls (GET/HEAD fetch) into parallel
// execution while mutating ones still run sequentially.
const READ_ONLY_FOR_ARGS = {
  // fetch: GET/HEAD (incl. absent/non-mutating method args) are reads.
  fetch: (args) => !isFetchMutationRequest('fetch', args),
  // 'verify' deliberately has NO predicate: a command classifier is too
  // coarse — `npm run build` / `npm test` classify 'low' (not destructive,
  // not network) yet they write artifacts and execute arbitrary project
  // scripts. A curated read-only command allowlist would be the only sound
  // predicate, and the parallelism win for a tool that usually runs alone
  // does not justify that surface. verify gets no predicate — the static
  // flag alone decides its classification.
};

/** Build the capability descriptor for a tool name. */
function toolToCapability(name) {
  const isReadOnly = READ_ONLY_TOOLS.has(name);
  const readOnlyForArgs = READ_ONLY_FOR_ARGS[name];
  return {
    id: `native:${name}`,
    name,
    isReadOnly,
    isReadOnlyForArgs: readOnlyForArgs,
    domain: isReadOnly ? 'inspect' : 'mutate',
  };
}

/**
 * Dispatch a batch of calls: [{ id, name, arguments }].
 * Read-only calls run in one concurrent phase; everything else runs
 * sequentially afterwards. `executor(call)` performs a call and returns its
 * output (or a promise of it). Resolves to one { id, output } per call, in
 * input order.
 */
async function dispatchBatch(calls, executor) {
  const caps = new Map();
  const capOf = (name) => {
    if (!caps.has(name)) caps.set(name, toolToCapability(name));
    return caps.get(name);
  };
  // An arg-aware predicate (isReadOnlyForArgs) wins over the static flag
  // when present — GET fetch rejoins the concurrent read-only batch while
  // mutating siblings (POST fetch) stay sequential. Unparseable/odd args
  // fail closed (sequential).
  const isCallReadOnly = (call) => {
    const cap = capOf(call.name);
    if (!cap) return false;
    if (cap.isReadOnlyForArgs) {
      const args = call.arguments;
      if (!args || typeof args !== 'object') return false;
      return cap.isReadOnlyForArgs(args);
    }
    return cap.isReadOnly;
  };
  const readOnly = calls.filter((call) => isCallReadOnly(call));
  const mutating = calls.filter((call) => !isCallReadOnly(call));
  const outputs = new Map();
  // 1. Execute all read-only inspection tools concurrently.
  await Promise.allSettled(readOnly.map(async (call) => {
    outputs.set(call.id, await executor(call));
  }));
  // 2. Execute mutating calls strictly sequentially.
  for (const call of mutating) {
    outputs.set(call.id, await executor(call));
  }
  return calls.map((call) => ({ id: call.id, output: outputs.get(call.id) }));
}

module.exports = { READ_ONLY_TOOLS, READ_ONLY_FOR_ARGS, toolToCapability, dispatchBatch };
