// Canned solution: the speculative-execution gate with parse gating, ported
// from src/agent/loop.ts as of 0c6db59 (refactor(loop): skip speculative
// execution parse attempts for mutating or incomplete calls). The fix's
// maybeSpeculativelyExecute checks, in order: already-executed, a NAME-ONLY
// read-only check (no args — a mutating call never gets its buffer parsed),
// and a cheap completeness test (the trimmed buffer must end with '}') —
// only then is JSON.parse attempted, with the final with-args read-only
// check deciding execution.
function createSpecGate(isReadOnly) {
  const gate = {
    parseAttempts: 0,
    consider(name, argsBuffer, alreadyExecuted) {
      if (alreadyExecuted) return null;
      // Name-only pre-check: never burn parse attempts on a call that could
      // not execute speculatively whatever its arguments say. (The fixture's
      // isReadOnly answers the name-only question when called with no args —
      // argument-dependent tools like fetch default to their safe case.)
      if (!isReadOnly(name)) return null;
      // Cheap completeness gate: streamed argument JSON is complete only
      // when the accumulated buffer ends with '}'.
      if (!argsBuffer.trimEnd().endsWith('}')) return null;
      let args = null;
      try {
        gate.parseAttempts++;
        args = JSON.parse(argsBuffer);
      } catch {
        return null; // malformed despite the brace — wait / give up quietly
      }
      if (args === null || typeof args !== 'object') return null;
      return isReadOnly(name, args) ? args : null;
    },
  };
  return gate;
}

module.exports = { createSpecGate };
