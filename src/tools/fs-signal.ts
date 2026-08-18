// A tiny process-wide mutation fence used to invalidate derived caches (so far
// the `search` result cache) the moment a file changes. This is the "good
// dedup that never causes complications" mechanism: caches dedup repeated
// payload work, and the generation fence guarantees no cached result survives a
// real filesystem write.
//
// We deliberately keep it in its own module so the mutation tools (write/edit/
// delete) and the readers (search) can share one monotonic counter without any
// import cycles.
//
// A monotonic 32-bit counter is enough: a single agent run bumps it a handful
// of times per write, and it will not wrap before the process exits.

let generation = 0;

/** Current mutation generation. Reads before a read-only tool run. */
export function mutationGeneration(): number {
  return generation;
}

/** Bump the generation. Call after any filesystem mutation (write/edit/delete). */
export function markMutation(): void {
  generation++;
}