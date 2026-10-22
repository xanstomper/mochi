// Frozen-task fixture: the command-risk classifier from src/security/security.ts
// as of 0ab0cc3^ (the parent of the git-restore flag-order fix) — the
// DESTRUCTIVE / NETWORK pattern lists and classifyCommand, verbatim except:
// TypeScript types stripped, export converted to CommonJS, and the native
// accelerator call (nativeClassifyCommand) omitted — this standalone fixture
// has no native core, which is exactly the case the TS reference path handles
// on its own (a native verdict could only agree with or be stricter than the
// TS lists for the commands this fixture classifies).

// Danger patterns — destructive, irreversible, or external side-effectful.
const DESTRUCTIVE = [
  /\brm\s+(-[a-z]*r[a-z]*)?\s+/i, /\brmdir\b/i, /\brm\s+-rf\b/i,
  /\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f[a-z]*|checkout\s+--\s+\.|rebase|cherry-pick)(?![\w.])/i,
  // Silent-discard class (audit round 2): these destroy uncommitted work or
  // saved state with no gate when classified 'low' in safe mode.
  /\bgit\s+restore\b(?!\s+--staged\b)/i,           // default mode discards worktree changes
  /\bgit\s+restore\b[^|;&]*(--worktree\b|\s+-W\b)/i, // explicit worktree restore (even with --staged)
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
