// Frozen-task fixture: the plan-mode batch veto from src/agent/loop.ts as
// of 0792f0f^ (the parent of the plan-mode network-read allowlist), reduced
// to the pure batch decision: given the model's tool calls for one turn and
// the config, decide which calls execute, which are vetoed, and whether the
// veto counter ticks for this batch. The surrounding loop mechanics
// (reminder text, tool_result synthesis) are not modeled.
//
// Plan mode semantics at this revision: read-only calls execute; EVERY
// mutating call in the batch is vetoed; the veto counter ticks once per
// batch that contained a refused call. A codebase-aware agent usually needs
// to READ a local dev server / internal API to answer, but a mutating fetch
// (POST etc.) is vetoed exactly like a file write — there is no way to
// declare "reads of THIS host are exploration, not mutation".
const { isFetchMutationRequest } = require('./fetch-methods.js');

// Excerpt of TOOL_ALIASES (src/tools/index.ts): raw model-emitted names are
// canonicalized BEFORE any classification, so alias spellings of a tool get
// exactly the canonical tool's treatment.
const TOOL_ALIASES = {
  bash: 'shell', run_command: 'shell', exec: 'shell',
  read_file: 'read', view_file: 'read',
  write_to_file: 'write', create_file: 'write',
  edit_file: 'edit',
  fetch_url: 'fetch', web_fetch: 'fetch', read_url_content: 'fetch',
};
const canonicalName = (raw) => TOOL_ALIASES[raw] ?? raw;

// Tools whose every call is a read (the loop's static read set, excerpted
// to the tools this fixture exercises).
const STATIC_READS = new Set(['read', 'search', 'glob', 'inspect', 'think']);

/** True when a call mutates: anything not a static read, and a fetch whose
 *  method mutates remote state. */
function isMutatingCall(call) {
  const name = canonicalName(call.name);
  if (name === 'fetch') return isFetchMutationRequest('fetch', call.arguments);
  return !STATIC_READS.has(name);
}

/**
 * Decide a plan-mode batch.
 * calls: [{ id, name, arguments }] (names may be raw/aliased).
 * config: the mochi config object (safety lives under config.safety).
 * Returns { runIds, vetoedIds, vetoCounted }: runIds and vetoedIds preserve
 * batch order; every call id lands in exactly one of them; vetoCounted is
 * true iff at least one call was actually refused this batch.
 */
function decidePlanBatch(calls, config) {
  const runIds = [];
  const vetoedIds = [];
  for (const call of calls) {
    if (isMutatingCall(call)) vetoedIds.push(call.id);
    else runIds.push(call.id);
  }
  return { runIds, vetoedIds, vetoCounted: vetoedIds.length > 0 };
}

module.exports = { decidePlanBatch, isMutatingCall, canonicalName };
