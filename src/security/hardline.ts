// Hardline safety floor: catastrophic shell commands that NO permission
// policy, flag, allow-always entry, or unattended mode may ever approve
// (Hermes' UNRECOVERABLE_BLOCKLIST parity). This sits BELOW yolo: the
// permission layer (permission.ts / the loop approval gate) decides what
// needs a human; this module decides what not even a human's standing
// "allow everything" may green-light, because these commands are
// unrecoverable by construction (wipe the root filesystem, brick the boot
// disk, kill the host).
//
// Pure and dependency-free so every shell chokepoint can call it cheaply:
// the agent shell tool (foreground AND background), exec.ts's
// runShellString (verify / hooks / cron / every other shell-string
// execution), and the loop's approval gate.
//
// Patterns are deliberately TIGHT and target-anchored: normal destructive-ish
// dev work must NOT match — `rm -rf node_modules`, `rm -rf ./dist`,
// `rm -rf /tmp/build-cache`, `dd if=img of=./disk.img`, `chmod -R 755 .`
// all pass. What matches is the same command aimed at the root filesystem,
// the user's home, a raw block device, or the host's own power state.

interface HardlineRule {
  label: string;
  test: (cmd: string) => boolean;
}

/** rm with recursive (and usually force) flags whose target is the root
 *  filesystem, a root glob, or the user's home. Scans each rm segment
 *  (split on shell separators) so `cd /tmp && rm -rf /` still matches while
 *  `rm -rf node_modules` (relative target) never does. */
function rmCatastrophic(cmd: string): boolean {
  for (const seg of cmd.split(/[|;&\n]+/)) {
    const m = seg.match(/\brm\b(.*)$/);
    if (!m) continue;
    const rest = m[1];
    // Must be recursive: -r / -R / --recursive in any flag cluster.
    if (!/(^|\s)-[a-zA-Z]*[rR][a-zA-Z]*(\s|$)/.test(rest) && !/--recursive\b/.test(rest)) continue;
    // Targets are the non-flag tokens. A target is catastrophic only when it
    // IS the root, a root glob, home, or a home glob — never a subpath like
    // /tmp/x or ~/project (deleting those is ordinary, if regrettable, work).
    const targets = rest
      .replace(/--no-preserve-root\b/g, ' ')
      .split(/\s+/)
      .map((t) => t.replace(/^["']|["']$/g, ''))
      .filter((t) => t && !t.startsWith('-'));
    for (const t of targets) {
      if (t === '/' || t === '/*' || t === '~' || t === '~/' || t === '~/*' ||
          t === '$HOME' || t === '$HOME/' || t === '$HOME/*' || t === '${HOME}' || t === '${HOME}/*') {
        return true;
      }
    }
  }
  return false;
}

const RULES: HardlineRule[] = [
  { label: 'rm-recursive-on-root-or-home', test: rmCatastrophic },
  // Filesystem creation on anything: mkfs has no legitimate agent use.
  { label: 'mkfs', test: (c) => /\bmkfs(\.[a-z0-9]+)?\b/.test(c) || /\bmke2fs\b/.test(c) },
  // dd writing to a raw block device (of=./disk.img or of=/dev/null pass).
  {
    label: 'dd-to-block-device',
    test: (c) => /\bdd\b[^|;&]*\bof=\/dev\/(sd[a-z]|hd[a-z]|nvme\d|mmcblk\d|vd[a-z]|xvd[a-z]|disk\d)/.test(c),
  },
  // Classic fork bomb `:(){ :|:& };:` and named variants `f(){ f|f& };f`.
  {
    label: 'fork-bomb',
    test: (c) =>
      /\(\s*\)\s*\{\s*[^}]*\|\s*[^}&]*&\s*\}/.test(c) && /:\s*\(\s*\)|(\w+)\s*\(\s*\)\s*\{\s*\1\b/.test(c),
  },
  // Host power state: shutdown / reboot / poweroff / halt, incl. systemctl
  // and init runlevel forms. (A file or test NAMED shutdown is not a shell
  // command and never reaches this matcher.)
  {
    label: 'host-poweroff',
    // Command POSITION only (start, or right after a shell separator, with
    // an optional sudo prefix): `echo shutdown > notes.txt` and
    // `grep reboot src/` mention the words as data and must not match.
    test: (c) => /(^|[|;&]|\n)\s*(sudo\s+)?(shutdown|reboot|poweroff|halt)\b/.test(c) ||
                 /\bsystemctl\s+(reboot|poweroff|halt|shutdown)\b/.test(c) ||
                 /\binit\s+[06]\b/.test(c),
  },
  // chmod -R 777 (world-writable, recursive) on the root filesystem.
  {
    label: 'chmod-recursive-777-root',
    test: (c) => /\bchmod\b[^|;&]*(-[a-zA-Z]*R[a-zA-Z]*|--recursive)[^|;&]*\b0?777\b[^|;&]*\s\/(\*|\s|$|;)/.test(c) ||
                 /\bchmod\b[^|;&]*\b0?777\b[^|;&]*(-[a-zA-Z]*R[a-zA-Z]*|--recursive)[^|;&]*\s\/(\*|\s|$|;)/.test(c),
  },
  // Overwriting the account databases: redirect, tee, dd of=, cp/mv target.
  {
    label: 'overwrite-etc-passwd-shadow',
    test: (c) => /(>>?\s*|tee\s+(?:-a\s+)?|of=|\bcp\b[^|;&]*\s|\bmv\b[^|;&]*\s)\/etc\/(passwd|shadow)\b/.test(c),
  },
];

/**
 * Return the hardline rule label when `command` is catastrophic and must be
 * refused under EVERY policy (including yolo/unattended), or null when the
 * command is not on the floor. Pure: no I/O, no state.
 */
export function matchHardline(command: string): string | null {
  const c = (command ?? '').trim();
  if (!c) return null;
  for (const rule of RULES) {
    if (rule.test(c)) return rule.label;
  }
  return null;
}
