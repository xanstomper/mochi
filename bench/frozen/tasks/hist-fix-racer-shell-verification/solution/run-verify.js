// Canned solution: verification commands run through a real shell, ported
// from src/core/branch-racer.ts as of bbcaa62 (fix(branch-racer): run
// verification through the shell). The fix routes the command string through
// the central shell executor (runShellString in src/exec.ts) verbatim; this
// standalone module reproduces that contract with child_process shell
// execution: the string is interpreted by the shell, so env assignments,
// quoted arguments, and && chains all work; the promise never rejects on a
// non-zero exit — pass/fail comes from the exit code alone.
const { spawn } = require('node:child_process');

function runVerificationCommand(cmd, cwd) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, { cwd, shell: true });
    let settled = false;
    child.on('error', () => {
      if (!settled) { settled = true; resolvePromise({ passed: false, code: 1 }); }
    });
    child.on('close', (code) => {
      if (!settled) { settled = true; resolvePromise({ passed: code === 0, code: code ?? 1 }); }
    });
  });
}

module.exports = { runVerificationCommand };
