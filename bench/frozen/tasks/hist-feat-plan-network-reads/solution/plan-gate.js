// Canned solution: the plan-mode network-read allowlist, ported from
// src/agent/loop.ts as of 0792f0f (feat(agent): plan-mode network-read
// allowlist — declared dev hosts only, exact-host match), with semantics
// pinned by 61ad39e and 850fab4. An operator declaring a host in
// safety.planModeNetworkReads asserts those endpoints are side-effect-free;
// a mutating fetch to a DECLARED host executes in plan mode like a read.
// Matching is EXACT hostname (URL.hostname — the port is not part of it),
// case-insensitive, no substring/suffix matching (a suffix of a declared
// host must NOT extend trust), no subdomain extension, and an unparseable
// URL fails closed. Only actual refusals count toward the plan-mode veto
// counter — an exempt call never counts.
const { isFetchMutationRequest } = require('./fetch-methods.js');

const TOOL_ALIASES = {
  bash: 'shell', run_command: 'shell', exec: 'shell',
  read_file: 'read', view_file: 'read',
  write_to_file: 'write', create_file: 'write',
  edit_file: 'edit',
  fetch_url: 'fetch', web_fetch: 'fetch', read_url_content: 'fetch',
};
const canonicalName = (raw) => TOOL_ALIASES[raw] ?? raw;

const STATIC_READS = new Set(['read', 'search', 'glob', 'inspect', 'think']);

function isMutatingCall(call) {
  const name = canonicalName(call.name);
  if (name === 'fetch') return isFetchMutationRequest('fetch', call.arguments);
  return !STATIC_READS.has(name);
}

/** True when a call is a plan-mode network read: a fetch whose METHOD
 *  mutates (so it would otherwise be vetoed) aimed at a host the operator
 *  DECLARED side-effect-free in safety.planModeNetworkReads. */
function isPlanNetworkRead(call, config) {
  if (canonicalName(call.name) !== 'fetch') return false;
  const declared = (config?.safety?.planModeNetworkReads ?? [])
    .map((h) => String(h).toLowerCase());
  if (declared.length === 0) return false;
  if (!isFetchMutationRequest('fetch', call.arguments)) return false;
  let host;
  try {
    host = new URL(String(call.arguments?.url ?? '')).hostname.toLowerCase();
  } catch {
    return false; // malformed URL never earns the exemption (fail closed)
  }
  return declared.includes(host);
}

function decidePlanBatch(calls, config) {
  const runIds = [];
  const vetoedIds = [];
  for (const call of calls) {
    const runs = !isMutatingCall(call) || isPlanNetworkRead(call, config);
    if (runs) runIds.push(call.id);
    else vetoedIds.push(call.id);
  }
  // The veto counts only calls actually REFUSED — an exempted network read
  // executes, so it must never tick the counter.
  return { runIds, vetoedIds, vetoCounted: vetoedIds.length > 0 };
}

module.exports = { decidePlanBatch, isMutatingCall, isPlanNetworkRead, canonicalName };
