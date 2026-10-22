// Shell completions (`mochi completion bash|zsh|fish`): static scripts generated
// from the canonical command table below. A coverage test greps cli.ts for
// every `first === '<cmd>'` literal and fails when a command lacks a completion
// entry, so the two can never drift apart silently.
export interface CompletionCommand {
  name: string;
  description: string;
  subcommands?: Array<{ name: string; description: string }>;
  aliases?: string[];
}

export const COMPLETION_COMMANDS: CompletionCommand[] = [
  { name: 'goal', description: 'Run a multi-step objective' },
  { name: 'team', description: 'Run specialists concurrently' },
  { name: 'plan', description: 'Plan only, no edits' },
  { name: 'tui', description: 'Open the interactive TUI' },
  {
    name: 'term', description: 'Open Mochi in its own terminal window',
    aliases: ['terminal', 'open'],
    subcommands: [],
  },
  {
    name: 'daemon', description: 'Persistent agent over localhost HTTP',
    subcommands: [
      { name: 'start', description: 'Start the daemon' },
      { name: 'status', description: 'Show daemon status' },
      { name: 'stop', description: 'Stop the daemon' },
      { name: 'restart', description: 'Restart on the same port' },
      { name: 'rotate', description: 'Rotate the bearer token' },
      { name: 'jobs', description: 'List workspace goals' },
      { name: 'send', description: 'Send a goal' },
      { name: 'approve', description: 'Approve a pending plan' },
      { name: 'resume', description: 'Resume a goal' },
      { name: 'cron', description: 'Scheduled jobs (add|list|remove)' },
    ],
  },
  {
    name: 'skills', description: 'Browse and manage skills',
    subcommands: [
      { name: 'list', description: 'List skills' },
      { name: 'search', description: 'Search skills' },
      { name: 'lint', description: 'Lint skill files (frontmatter, steps, quality)' },
      { name: 'suggest', description: 'Surface skill opportunities / promotion candidates' },
      { name: 'audit', description: 'Skill health report' },
      { name: 'repo', description: 'Shared skill registry' },
      { name: 'import', description: 'Import skills' },
      { name: 'pack', description: 'Bundle skills into a portable pack' },
      { name: 'unpack', description: 'Install a skill pack' },
    ],
  },
  { name: 'session', description: 'Session history (list|search)' },
  { name: 'trace', description: 'Replay a run trace (--export-trajectory: export a trajectory JSONL for distillation/SFT)' },
  { name: 'apply', description: 'Apply a unified diff atomically (all-or-nothing)' },
  { name: 'checkpoint', description: 'Named snapshots' },
  { name: 'rollback', description: 'Restore a checkpoint' },
  { name: 'resume', description: 'Resume a persisted goal' },
  { name: 'commit', description: 'Checkpoint commit' },
  { name: 'diff', description: 'Show pending changes' },
  { name: 'status', description: 'Repository status', aliases: ['changes'] },
  { name: 'review', description: 'Review the working-tree diff' },
  { name: 'fix', description: 'Fix a diagnosed issue' },
  { name: 'test', description: 'Run the test command' },
  { name: 'doctor', description: 'Diagnose workspace configuration' },
  { name: 'init', description: 'Create MOCHI.md' },
  { name: 'config', description: 'Show effective configuration' },
  { name: 'login', description: 'Authenticate a provider' },
  { name: 'bundle', description: 'Write a diagnostic bundle (transcript + diff + doctor)', aliases: ['export-bundle'] },
  { name: 'watch', description: 'Run the repo check command on every file change' },
  { name: 'serve', description: 'Foreground JSON API server for CI/tooling (localhost only)' },
  { name: 'update', description: 'Check GitHub releases for updates and upgrade Mochi', aliases: ['upgrade', 'self-update'] },
  {
    name: 'auth', description: 'Credential status across providers',
    subcommands: [
      { name: 'status', description: 'Show key sources (env/file/missing), --probe live-verifies' },
      { name: 'logout', description: 'Clear the stored key for a provider' },
      { name: 'reset', description: 'Clear the stored key for a provider (explicit reset)' },
      { name: 'export', description: 'Print the keyring as JSON (secrets to stdout — redirect to a file)' },
      { name: 'import', description: 'Restore keys from an export file (or stdin)' },
      { name: 'accounts', description: 'List named accounts per provider' },
      { name: 'switch', description: 'Switch the active account for a provider' },
      { name: 'account', description: 'Manage accounts (delete <provider> <account>)' },
    ],
  },
  { name: 'models', description: 'List models (--refresh live-diffs the endpoint against the table)' },
  { name: 'providers', description: 'List providers' },
  {
    name: 'pr', description: 'GitHub pull-request workflows (headless, CI-friendly)',
    subcommands: [
      { name: 'review', description: 'Review a PR via gh; --focus lens, --json, --post; exit 0/1/2' },
    ],
  },
  { name: 'model', description: 'Select model' },
  { name: 'reasoning', description: 'Set reasoning depth', aliases: ['depth'] },
  { name: 'fallback', description: 'Configure fallback model providers', aliases: ['fallbacks'] },
  { name: 'account', description: 'Switch or manage provider accounts', aliases: ['accounts'] },
  { name: 'switch', description: 'Quick-switch provider account' },
  { name: 'mode', description: 'Set execution mode' },
  { name: 'memory', description: 'Project memory' },
  { name: 'rules', description: 'Show MOCHI.md contract', aliases: ['rule'] },
  { name: 'profiles', description: 'List agent profiles' },
  {
    name: 'plugins', description: 'Manage plugins (add/remove/enable/disable/info)', aliases: ['plugin'],
    subcommands: [
      { name: 'list', description: 'List installed plugins' },
      { name: 'add', description: 'Install a plugin from a directory' },
      { name: 'remove', description: 'Remove a plugin' },
      { name: 'info', description: 'Show plugin manifest' },
      { name: 'enable', description: 'Enable a plugin' },
      { name: 'disable', description: 'Disable a plugin' },
      { name: 'validate', description: 'Validate a plugin directory' },
      { name: 'search', description: 'Search installed plugins' },
      { name: 'pack', description: 'Export a plugin to a portable directory' },
    ],
  },
  { name: 'hooks', description: 'List hooks' },
  {
    name: 'interop', description: 'Import config from other agents',
    subcommands: [{ name: 'claude', description: 'Import Claude Code hooks, agents, and commands' }],
  },
  {
    name: 'mcp', description: 'Search, add & manage MCP servers',
    subcommands: [
      { name: 'list', description: 'List built-in MCP servers' },
      { name: 'search', description: 'Search servers by keyword' },
      { name: 'add', description: 'Install a server into .mcp.json' },
      { name: 'remove', description: 'Remove a server from .mcp.json' },
      { name: 'test', description: 'Live connect-check configured servers' },
    ],
  },
  { name: 'acp', description: 'Agent Client Protocol server (--check verifies lifecycle)' },
  { name: 'mcp-serve', description: 'MCP stdio server for editors' },
  { name: 'perf', description: 'Performance diagnostics' },
  { name: 'onboard', description: 'Cozy first-run setup wizard', aliases: ['welcome'] },
  {
    name: 'setup', description: 'Setup wizard + editor installers',
    aliases: [],
    subcommands: [
      { name: 'vscode', description: 'Install VS Code extension' },
      { name: 'jetbrains', description: 'Install JetBrains plugin' },
      { name: 'editors', description: 'Install all editor extensions' },
    ],
  },
  { name: 'chameleon', description: 'Removed standalone — engine runs auto + via --enhance' },
  { name: 'self-train', description: 'Self-review loop (--schedule for nightly learning)', aliases: ['selftrain', 'train'] },
  { name: 'speculate', description: 'Speculative execution' },
  { name: 'usage', description: 'Token usage and cost' },
  { name: 'feedback', description: 'Rate mochi good/bad (feeds self-correction)' },
  { name: 'audit', description: 'Security audit', aliases: ['security'] },
  { name: 'docgen', description: 'Generate architecture docs' },
  {
    name: 'docs', description: 'Query project docs / write ADR',
    subcommands: [
      { name: 'query', description: 'Search docs by text' },
      { name: 'adr', description: 'Write an architecture decision record' },
    ],
  },
  { name: 'dashboard', description: 'Open dashboard', aliases: ['web'] },
  { name: 'discord', description: 'Discord gateway (run: live bot, status: config check)' },
  { name: 'telegram', description: 'Telegram gateway (run: live bot, status: config check)' },
  { name: 'slack', description: 'Slack gateway (run: polling, webhook: Events API, status: config check)', subcommands: [
      { name: 'run', description: 'Polling gateway' },
      { name: 'webhook', description: 'Events API HTTP webhook server' },
      { name: 'status', description: 'Config check' },
    ] },
  { name: 'bluebubbles', description: 'BlueBubbles (iMessage) gateway (run: live bot, status: config check)', aliases: ['bluebubble', 'imessage', 'bb'], subcommands: [
      { name: 'run', description: 'Polling gateway' },
      { name: 'status', description: 'Config check' },
    ] },
  { name: 'connectors', description: 'List configured gateways (discord/telegram/slack/bluebubbles)', aliases: ['gateways', 'channels', 'platforms'] },
  { name: 'ambient', description: 'Ambient agent mode' },
  { name: 'termix', description: 'Multi-agent broadcast' },
  { name: 'bg', description: 'Background tasks' },
  { name: 'workspace', description: 'Manage workspaces' },
  { name: 'import-skills', description: 'Import skills from a source' },
  { name: 'issue', description: 'Fetch issue + create fix branch (no auto-commit/push)' },
  { name: 'inspect', description: 'Inspect a target' },
  { name: 'check', description: 'Run checks' },
  { name: 'known-good', description: 'Mark a known-good state' },
  { name: 'gc', description: 'Prune old session/trace files (retention)', aliases: ['prune', 'retention'] },
  { name: 'selfheal', description: 'Run/list/resolve an open harness issue (--resolve <sig>, --resolved, --list, --status)', subcommands: [
    { name: 'list', description: 'Show open issues without repairing' },
    { name: 'status', description: 'Alias for --list' },
    { name: 'resolved', description: 'Show resolved issues too (--resolved flag)' },
    { name: 'resolve', description: 'Mark an issue resolved without spawning a repair agent (--resolve <sig>)' },
  ]},
  { name: 'use', description: 'Use a profile or preset' },
  { name: 'enhance', description: 'Removed standalone — use goal/team --enhance' },
  {
    name: 'completion', description: 'Print shell completion script',
    subcommands: [
      { name: 'bash', description: 'Bash completion script' },
      { name: 'zsh', description: 'Zsh completion script' },
      { name: 'fish', description: 'Fish completion script' },
    ],
  },
];

/** All names the completer offers (canonical + aliases, deduped). */
export function completionNames(): string[] {
  const out: string[] = [];
  for (const c of COMPLETION_COMMANDS) {
    out.push(c.name, ...(c.aliases ?? []));
  }
  return [...new Set(out)];
}

export function subcommandNames(cmd: string): string[] {
  const c = COMPLETION_COMMANDS.find((x) => x.name === cmd || x.aliases?.includes(cmd));
  return c?.subcommands?.map((s) => s.name) ?? [];
}

function bashEscape(s: string): string {
  return s.replace(/'/g, `'\\''`);
}

export function completionBash(): string {
  const names = completionNames().join(' ');
  const cases = COMPLETION_COMMANDS.filter((c) => c.subcommands?.length)
    .map((c) => `      ${[c.name, ...(c.aliases ?? [])].join('|')}) COMPREPLY=($(compgen -W "${c.subcommands!.map((s) => s.name).join(' ')}" -- "$cur")) ;;`)
    .join('\n');
  return `# mochi bash completion (generated by \`mochi completion bash\`)
_mochi_completions() {
  local cur prev
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=($(compgen -W '${names}' -- "$cur"))
    return 0
  fi
  case "$prev" in
${cases}
  esac
  return 0
}
complete -F _mochi_completions mochi
`;
}

export function completionZsh(): string {
  const cmds = COMPLETION_COMMANDS.map((c) => `    '${c.name}:${bashEscape(c.description)}'`).join('\n');
  const subs = COMPLETION_COMMANDS.filter((c) => c.subcommands?.length)
    .map((c) => `      (${[c.name, ...(c.aliases ?? [])].join('|')}) _describe 'command' "(${c.subcommands!.map((s) => `'${s.name}:${bashEscape(s.description)}'`).join(' ')})" ;;`)
    .join('\n');
  return `#compdef mochi
# mochi zsh completion (generated by \`mochi completion zsh\`)
_mochi() {
  local -a commands=(
${cmds}
  )
  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi
  case "$words[2]" in
${subs}
  esac
}
_mochi "$@"
`;
}

export function completionFish(): string {
  const cmds = COMPLETION_COMMANDS.map((c) => `complete -c mochi -f -n '__fish_use_subcommand' -a '${c.name}' -d '${bashEscape(c.description)}'`).join('\n');
  const subs = COMPLETION_COMMANDS.filter((c) => c.subcommands?.length)
    .map((c) => c.subcommands!.map((s) => `complete -c mochi -f -n '__fish_seen_subcommand_from ${[c.name, ...(c.aliases ?? [])].join(';')}' -a '${s.name}' -d '${bashEscape(s.description)}'`).join('\n'))
    .join('\n');
  const aliases = COMPLETION_COMMANDS.flatMap((c) => (c.aliases ?? []).map((a) => `complete -c mochi -f -n '__fish_use_subcommand' -a '${a}' -d 'alias: ${c.name}'`)).join('\n');
  return `# mochi fish completion (generated by \`mochi completion fish\`)
${cmds}
${aliases}
${subs}
`;
}

export function completionFor(shell: string): string {
  const s = shell.toLowerCase();
  if (s === 'bash') return completionBash();
  if (s === 'zsh') return completionZsh();
  if (s === 'fish') return completionFish();
  throw new Error(`Unknown shell "${shell}". Use bash|zsh|fish.`);
}
