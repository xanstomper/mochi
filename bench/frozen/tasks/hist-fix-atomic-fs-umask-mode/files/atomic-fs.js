// Frozen-task fixture: src/core/atomic-fs.ts as of 3bdc1ea^ (the parent of
// the umask fix), with TypeScript types stripped and the export converted to
// CommonJS for the frozen workdir. Logic is otherwise verbatim.
const { writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync, lstatSync } = require('node:fs');
const { dirname, join, basename } = require('node:path');
const { randomBytes } = require('node:crypto');

/**
 * Write `content` to `filePath` atomically: create a hidden sibling temp file,
 * then rename it over the target. `rename` is atomic within a filesystem, so a
 * crash, SIGKILL, OOM, or power loss mid-write can never leave a half-written /
 * truncated file — a reader sees either the whole old file or the whole new one.
 *
 * Mochi's edit tools previously called `writeFileSync` directly, so killing the
 * process (or the agent's own parallel tool batch) while a file was being
 * rewritten could corrupt it. This mirrors how production editors save.
 *
 * Deliberately conservative so it is never WORSE than a plain write:
 *   - preserves the existing file's permission bits,
 *   - `opts.mode` (B29) forces the mode for the NEW file too — the tmp sibling
 *     is created with it BEFORE the content lands, so secrets (e.g. the
 *     daemon auth token) are never briefly world-readable in flight. With
 *     opts.mode set, the symlink fallback is skipped entirely: a symlinked
 *     target is REPLACED (rename over the link), not followed — no
 *     symlink-follow write, no mode leak; replace-don't-follow is the safe
 *     direction.
 *   - falls back to a direct write for symlinks (rename would replace the link
 *     itself, not its target),
 *   - falls back to a direct write if the rename fails for any reason.
 */
function atomicWriteFileSync(filePath, content, opts) {
  const dir = dirname(filePath);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
    /* fall through to the direct write below, which reports the real error */
  }

  let mode = opts?.mode;
  if (mode === undefined) {
    try {
      const st = lstatSync(filePath);
      if (st.isSymbolicLink()) {
        writeFileSync(filePath, content);
        return;
      }
      mode = st.mode & 0o777;
    } catch {
      /* target does not exist yet — default mode applies */
    }
  }

  const tmp = join(dir, `.${basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, content, mode !== undefined ? { mode } : undefined);
    renameSync(tmp, filePath);
  } catch {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    writeFileSync(filePath, content, mode !== undefined ? { mode } : undefined);
  }
}

module.exports = { atomicWriteFileSync };
