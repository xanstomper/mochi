// Execution modes (spec 12-E / 13-C): switch harness behavior per mode.
//
// normal    — default reactive loop (System 1)
// spec      — TDD lifecycle: SPEC.md -> test scaffold -> implement -> verify 100%
// security  — vulnerability scanning + secret/CVE checks (read-only bias)
// codemod   — mass AST refactors across many files (structuring bias)
// chaos     — fault injection in integration tests (latency, errors)
//
// A mode adjusts: the config (safety mode, planMode), an appended instruction
// block injected into the agent prompt, and which tool groups are emphasized.
import type { MochiConfig } from './types.js';

export type AgentMode = 'normal' | 'spec' | 'security' | 'codemod' | 'chaos';

export interface ModeSpec {
  id: AgentMode;
  label: string;
  description: string;
  /** Instruction block appended to the agent's system prompt. */
  instruction: string;
  /** Safety mode to enforce (auto, ask...). undefined = leave unchanged. */
  safetyMode?: 'safe' | 'ask' | 'auto';
  planMode?: boolean;
  /** Tool names to prioritize when this mode is active. */
  preferredTools?: string[];
}

const MODES: Record<AgentMode, ModeSpec> = {
  normal: {
    id: 'normal',
    label: 'Normal',
    description: 'Default autonomous loop (System 1 direct dispatch).',
    instruction: 'Work directly and reactively: read what you need, make small changes, verify, finish.',
  },
  spec: {
    id: 'spec',
    label: 'Spec-Driven',
    description: 'TDD: SPEC -> tests -> implementation -> 100% green.',
    safetyMode: 'auto',
    planMode: false,
    preferredTools: ['write', 'edit', 'patch', 'shell'],
    instruction:
      'SPEC MODE: follow a strict TDD lifecycle. 1) Write/refresh SPEC.md or RFC.md stating the contract. 2) Scaffold the test assertions for the expected behavior FIRST. 3) Implement the minimal code to make them pass. 4) Run the relevant test suite and report the pass count. Do not claim done until the suite is green.',
  },
  security: {
    id: 'security',
    label: 'Security',
    description: 'Read-only audit: OWASP/secret/dependency scanning bias.',
    preferredTools: ['read', 'glob', 'search', 'grep', 'sql_codebase_query'],
    instruction:
      'SECURITY MODE: audit, do not modify by default. Scan statically for injection, auth bypasses, XSS/CSRF, SSRF, hardcoded secrets (sk-, AKIA, ghp_, bearer) and vulnerable dependency patterns. Report as [HIGH]/[MEDIUM] file:line — remediation. Never echo a secret value; ask before opening a PR.',
  },
  codemod: {
    id: 'codemod',
    label: 'Codemod',
    description: 'Mass AST refactor across many files.',
    safetyMode: 'auto',
    planMode: true,
    preferredTools: ['replace_symbol', 'regex_replace', 'glob', 'read', 'patch'],
    instruction:
      'CODEMOD MODE: plan a wide mechanical refactor (rename API, migrate module system, change imports) before editing. Enumerate every file via glob + read, then apply the transformation consistently across all of them with regex_replace / replace_symbol / patch. Run the test suite afterwards; a codemod that breaks tests is not done.',
  },
  chaos: {
    id: 'chaos',
    label: 'Chaos',
    description: 'Fault injection to verify resilience (read/test bias).',
    preferredTools: ['shell', 'read', 'glob', 'search'],
    instruction:
      'CHAOS MODE: verify resilience. Inject simulated faults into integration tests: latency, transient DB disconnects, malformed payloads, dropped connections. Report whether error boundaries recover. Do not modify production paths unless fixing a real resilience hole is requested.',
  },
};

export const MODE_IDS = Object.keys(MODES) as AgentMode[];

export function modeSpec(mode: AgentMode): ModeSpec {
  return MODES[mode] ?? MODES.normal;
}

export function isMode(s: string): s is AgentMode {
  return s in MODES;
}

/** Apply a mode to a config, returning the modified copy (pure). */
export function applyMode(config: MochiConfig, mode: AgentMode): MochiConfig {
  const spec = modeSpec(mode);
  const next = { ...config, mode, planMode: spec.planMode ?? config.planMode };
  if (spec.safetyMode) {
    next.safety = { ...config.safety, mode: spec.safetyMode };
  }
  return next;
}

/** Render the instruction block for injection into the agent system prompt. */
export function modeInstruction(mode: AgentMode): string {
  const spec = modeSpec(mode);
  if (mode === 'normal') return '';
  return `\n---\nACTIVE MODE: ${spec.label.toUpperCase()}\n${spec.instruction}`;
}

/** Format a /mode menu for the TUI (reuses the multi-choice renderer ideas). */
export function formatModes(current: AgentMode): string {
  const lines = ['Modes:'];
  for (const m of MODE_IDS) {
    const mark = m === current ? ' *' : '  ';
    lines.push(`${mark} ${m.padEnd(8)} ${MODES[m].label} — ${MODES[m].description}`);
  }
  return lines.join('\n');
}