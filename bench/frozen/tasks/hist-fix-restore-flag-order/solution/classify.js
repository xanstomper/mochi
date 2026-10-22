// Canned solution: the command-risk classifier from src/security/security.ts
// as of 0ab0cc3 (fix(security): git restore staged-detection — flag order no
// longer flips the verdict). Same extraction conventions as the fixture:
// types stripped, CommonJS export, native accelerator omitted (see fixture
// header). Only the two git-restore patterns and their comment differ.

// Danger patterns — destructive, irreversible, or external side-effectful.
const DESTRUCTIVE = [
  /\brm\s+(-[a-z]*r[a-z]*)?\s+/i, /\brmdir\b/i, /\brm\s+-rf\b/i,
  /\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f[a-z]*|checkout\s+--\s+\.|rebase|cherry-pick)(?![\w.])/i,
  // Silent-discard class (audit round 2): these destroy uncommitted work or
  // saved state with no gate when classified 'low' in safe mode.
  // git restore: default mode discards WORKTREE changes; --staged/-S alone is
  // index-only (worktree preserved) and stays low. Flag order must not matter
  // (--source=HEAD before vs after --staged used to flip the verdict), so the
  // staged exception scans the whole command segment, and any --worktree/-W
  // makes it destructive regardless.
  /\bgit\s+restore\b(?![^|;&]*(?:--staged\b|\s-S\b))/i,   // worktree mode (no --staged/-S anywhere)
  /\bgit\s+restore\b[^|;&]*(--worktree\b|\s-W\b)/i,       // explicit worktree restore (even with --staged)
  /\bgit\s+checkout\b[^|;&]*\s--\s/i,              // path-limited checkout discards that path
  /\bgit\s+stash\s+(drop|clear)\b/i,               // permanently drops saved work
  /\bfind\b[^|;&]*\s-delete\b/i,                   // find's bulk-delete mutation form
  /-exec(dir)?\s+rm\b/i,                           // find -exec rm: delete via the exec escape hatch (no \b: ' -' has no word boundary)
  /\bforce[- ]?(push)?\b/i, /\bterraform\s+(apply|destroy|force)\b/i,
  /\bkubectl\s+(delete|drain|replace|apply)\b/i,
  /\bdrop\s+(database|table|schema)\b/i, /\btruncate\b/i,
  /\bdd\s+of=/, /\bmkfs\b/, /\bformat\s+[a-z]:/i,
  /\bshutdown\b|\breboot\b|\bpoweroff\b/i,
  /\bkill\s+-9\b/, /(^|\s)echo\s+[^|]*>\s*\/dev\/(sd|nvme|disk)/i,
  /\bsudo\b/i,
];
// Patterns that touch the network or fetch remote state/install deps.
const NETWORK = [
  /\bnpm\s+(install|i|publish|add)\b/i, /\bpnpm\s+(add|install|publish)\b/i,
  /\byarn\s+add\b/i, /\bbun\s+(add|install)\b/i,
  /\bpip\s+install\b/i, /\bpip3? install\b/i, /\buv\s+add\b/i, /\bpoetry\s+add\b/i,
  /\bgo\s+get\b/i, /\bcargo\s+(install|publish)\b/i,
  /\bgit\s+(clone|fetch)\b/i, /\bcurl\b|\bwget\b/i,
  /docker\s+(pull|push|build)\b/i,
];

/** Classify a shell command by its side-effect risk (Horus's classifier). */
function classifyCommand(cmd) {
  const c = cmd.trim();
  if (!c) return 'low';
  if (DESTRUCTIVE.some((r) => r.test(c))) return 'destructive';
  if (NETWORK.some((r) => r.test(c))) return 'network';
  return 'low';
}

module.exports = { classifyCommand, DESTRUCTIVE, NETWORK };
