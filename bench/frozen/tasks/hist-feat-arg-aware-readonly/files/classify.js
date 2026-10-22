// Frozen-task fixture: the capability classification + batch partitioning
// core of src/core/capability-registry.ts and src/core/tool-dispatcher.ts as
// of e9eec54^ (the parent of the arg-aware read-only restructure), reduced to
// the classification mechanism: capability construction from a tool name, and
// the dispatcher's two-phase batch split. Tool execution itself is injected
// (the `executor` argument), so no real tools run here.
//
// The static READ_ONLY_TOOLS flag is arg-blind. 'fetch' is deliberately
// ABSENT from it: its method arg selects POST/PUT/PATCH/DELETE, which mutate
// REMOTE state, and mutating requests must not ride the concurrent read-only
// batch. The cost: EVERY fetch call — including plain GET/HEAD reads — pays
// the sequential-batch fee, serialized behind mutating siblings.

const READ_ONLY_TOOLS = new Set([
  'read', 'search', 'glob', 'inspect', 'git', 'diff', 'tree',
  'get_function', 'find_callers', 'type_hierarchy', 'verify', 'perf_audit',
  'deepwiki', 'clipboard', 'sql_codebase', 'analyze_code', 'memory',
  'web_search', 'get_diagnostics', 'git_blame', 'git_history', 'system_info',
  'find_references', 'find_definitions', 'db_inspect', 'think',
]);

/** Build the capability descriptor for a tool name. */
function toolToCapability(name) {
  const isReadOnly = READ_ONLY_TOOLS.has(name);
  return {
    id: `native:${name}`,
    name,
    isReadOnly,
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
  const readOnly = calls.filter((call) => {
    const cap = capOf(call.name);
    return cap ? cap.isReadOnly : false;
  });
  const mutating = calls.filter((call) => {
    const cap = capOf(call.name);
    return !cap || !cap.isReadOnly;
  });
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

module.exports = { READ_ONLY_TOOLS, toolToCapability, dispatchBatch };
