// Frozen-task fixture: the speculative-execution gate from the agent loop
// (src/agent/loop.ts as of 0c6db59^, the parent of the parse-gate refactor),
// extracted from its inline form around streamed tool-call argument deltas.
// While a tool call streams in, the loop accumulates its JSON arguments in a
// buffer; on each delta it may speculatively execute the call if it is
// read-only. The parent logic: if this call was already executed, skip; then
// JSON.parse the WHOLE accumulated buffer (incrementing the parse counter)
// and swallow any parse failure; only once parsing succeeds, check whether
// the call is read-only (with arguments). So for a long streamed MUTATING
// call, every delta is a full re-parse of a growing buffer whose result is
// then thrown away — O(n^2) parse churn on the hot path. (The parseAttempts
// counter is this fixture's observability harness for that churn.)
function createSpecGate(isReadOnly) {
  const gate = {
    parseAttempts: 0,
    /**
     * Consider one streamed delta. `name`/`argsBuffer` are the call's tool
     * name and accumulated argument text so far; `alreadyExecuted` marks a
     * call that already fired. Returns the parsed args when the call should
     * speculatively execute NOW, else null.
     */
    consider(name, argsBuffer, alreadyExecuted) {
      if (alreadyExecuted) return null;
      let args = null;
      try {
        gate.parseAttempts++;
        args = JSON.parse(argsBuffer);
      } catch {
        return null; // incomplete JSON — wait for more deltas
      }
      if (args === null || typeof args !== 'object') return null;
      return isReadOnly(name, args) ? args : null;
    },
  };
  return gate;
}

module.exports = { createSpecGate };
