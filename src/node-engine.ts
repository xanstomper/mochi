// Startup engine preflight (P3 gun 4).
//
// `package.json` declares `"engines": { "node": ">=22.0.0" }`, but npm only
// *warns* about engines (and only with the right npm settings) — nothing stops
// a Node 18/20 binary from booting Mochi. On those engines Mochi fails weirdly
// MID-RUN instead of failing fast: the dist auto-rebuild spawns `tsc` under the
// old binary (hangs/fails mid-command), `node:sqlite` is missing so sessions
// silently fall back to JSON, and other Node 22+ surface degrades unevenly.
// Reproduced on Node 20.20.2: `mochi config list` and `mochi usage` hang until
// SIGKILL (exit 124) after a failed background rebuild.
//
// So the CLI runs this check as the FIRST action of `main()`: one precise
// message naming the floor and the found version (never a stack trace from
// mid-flight), then a non-zero exit. Fail-closed on unparseable versions —
// an unknown engine gets the same refusal as a known-old one.

export const MIN_NODE_MAJOR = 22;

/** True when the runtime is Node < 22 — the floor package.json declares. */
export function nodeEngineProblem(version: string = process.versions.node): string | null {
  const raw = String(version ?? '').trim();
  const major = Number.parseInt(raw.replace(/^v/i, '').split('.')[0] ?? '', 10);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    return (
      `mochi: Node ${MIN_NODE_MAJOR}+ is required, found ${raw || '<unknown>'}. ` +
      `Mochi fails mid-run on older engines (node:sqlite, the dist auto-rebuild, ` +
      `and other Node ${MIN_NODE_MAJOR}+ APIs). ` +
      `Install Node ${MIN_NODE_MAJOR} or newer (nvm install ${MIN_NODE_MAJOR}, or https://nodejs.org) and re-run.`
    );
  }
  return null;
}
