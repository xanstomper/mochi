// Frozen-task fixture: candidate-verification command runner, extracted from
// src/core/branch-racer.ts as of bbcaa62^ (the parent of the shell-execution
// fix). The parent split the verification command on spaces and execFile'd
// the pieces — which breaks quoted arguments ("a b"), env assignments
// (NAME=value cmd …), flags with quoted values, and && chains: any real-world
// verification command was mangled before it ran. This module reproduces
// that observable behavior: runVerificationCommand(cmd, cwd) resolves
// { passed, code } and never rejects; passed is true iff the command exits 0.
const { execFile } = require('node:child_process');

function runVerificationCommand(cmd, cwd) {
  return new Promise((resolvePromise) => {
    const parts = cmd.split(' ');
    const bin = parts[0];
    const args = parts.slice(1);
    execFile(bin, args, { cwd }, (err) => {
      if (err) {
        const code = typeof err.code === 'number' ? err.code : 1;
        resolvePromise({ passed: false, code });
      } else {
        resolvePromise({ passed: true, code: 0 });
      }
    });
  });
}

module.exports = { runVerificationCommand };
