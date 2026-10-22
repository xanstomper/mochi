// Shared fetch-method hazard classification, ported verbatim (types
// stripped) from src/tools/fetch-methods.ts as of e9eec54^. It pre-dates the
// frozen change and is identical in the starting state and the solution.
//
// 'fetch' is listed as read-only in several places. That classification only
// holds for GET/HEAD: fetch also issues POST/PUT/PATCH/DELETE, which mutate
// REMOTE state. All consumers must agree on which methods stay read-only, so
// the predicate lives in this leaf module — it imports nothing, so no import
// cycles are possible.

/** HTTP methods that change remote state when sent through the fetch tool. */
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** True when a tool call mutates remote state via the fetch tool's method
 *  argument. Coerces non-string values with String() exactly like fetch.ts
 *  does when building the request (`String(args.method ?? 'GET')`), so the
 *  predicate and the wire can never diverge: an array like ['POST'] coerces
 *  to 'POST' on the wire, so it must classify as mutating here too. An absent
 *  /nullish method is the GET default. */
function isFetchMutationRequest(tool, args) {
  if (tool !== 'fetch') return false;
  const raw = args?.method;
  if (raw == null) return false;
  const method = String(raw).trim().toUpperCase();
  return MUTATING_METHODS.has(method);
}

module.exports = { isFetchMutationRequest };
