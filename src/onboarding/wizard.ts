// Cozy one-time welcome + setup wizard.
// Two surfaces share one copy source:
//   - `welcomeFrame()` / `stepFrame()` are PURE (unit-tested, no I/O) and
//     render the same cozy copy the TUI splash and `mochi onboard` show.
//   - `runOnboardInteractive()` is the thin readline driver for headless
//     `mochi onboard` (no raw-mode TUI dependency, works over ssh).

import type { OnboardScan } from './detect.js';

export type OnboardStep = 'welcome' | 'providers' | 'models' | 'skills' | 'mcp' | 'editors' | 'done';


const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  pink: '\x1b[38;2;255;110;199m',
  violet: '\x1b[38;2;199;146;234m',
  cyan: '\x1b[38;2;86;212;221m',
  lime: '\x1b[38;2;163;230;53m',
  gray: '\x1b[38;2;150;150;165m',
};

export function welcomeFrame(version: string): string[] {
  return [
    ``,
    `${C.pink}${C.bold}  🍡 welcome home, builder — mochi ${version} is ready to cozy up${C.reset}`,
    `${C.gray}  your tiny autonomous coding companion. one quick setup and we're off.${C.reset}`,
    ``,
    `${C.violet}  ── what this does (60 seconds, one time only) ──${C.reset}`,
    `${C.cyan}   1.${C.reset} borrow API keys + providers you already use elsewhere`,
    `${C.cyan}   2.${C.reset} pick your favorite model for coding / fast / review`,
    `${C.cyan}   3.${C.reset} adopt skills, MCP servers & tools from your other agents`,
    `${C.cyan}   4.${C.reset} connect VS Code + JetBrains so mochi lives in your editor`,
    ``,
    `${C.dim}  nothing is overwritten without asking. run \`mochi onboard\` anytime to revisit.${C.reset}`,
    ``,
  ];
}

export function stepFrame(step: OnboardStep, scan: OnboardScan): string[] {
  switch (step) {
    case 'welcome':
      return welcomeFrame('v1');
    case 'providers': {
      const lines = [
        `${C.bold}${C.violet}─ providers & keys ─${C.reset}`,
        `${C.gray}  mochi found these on your machine (keys masked):${C.reset}`,
        ``,
      ];
      for (const p of scan.providers) {
        const mark = p.hasKey ? `${C.lime}●${C.reset}` : `${C.gray}○${C.reset}`;
        lines.push(`  ${mark} ${p.name.padEnd(16)} ${p.hasKey ? `${C.lime}${p.maskedKey}${C.reset} ${C.dim}(${p.keySource})${C.reset}` : `${C.dim}no key — paste one or skip${C.reset}`}`);
      }
      lines.push(``, `${C.dim}  tip: ` + '`mochi onboard` wires these into config.json + failover automatically.' + `${C.reset}`);
      return lines;
    }
    case 'models': {
      const lines = [
        `${C.bold}${C.violet}─ models ─${C.reset}`,
        `${C.gray}  one model per job. mochi auto-fails over when a provider cools down.${C.reset}`,
        ``,
      ];
      if (scan.models?.length) {
        lines.push(`${C.gray}  detected ${scan.models.length} model(s) configured across other agents:${C.reset}`);
        for (const m of scan.models.slice(0, 5)) {
          lines.push(`  ${C.lime}●${C.reset} ${m.agent.padEnd(12)} ${C.bold}${m.model}${C.reset}`);
        }
        lines.push(``);
      }
      lines.push(
        `  ${C.cyan}fast${C.reset}      quick edits + chat      ${C.dim}(default: flash-tier)${C.reset}`,
        `  ${C.cyan}coding${C.reset}    main implementation     ${C.dim}(default: same as fast)${C.reset}`,
        `  ${C.cyan}reasoning${C.reset} deep planning + review  ${C.dim}(raise via /reasoning)${C.reset}`,
        ``,
        `${C.dim}  change anytime: /model  or  mochi use <provider> [model]${C.reset}`,
      );
      return lines;
    }
    case 'skills': {
      const lines = [
        `${C.bold}${C.violet}─ skills from your other agents ─${C.reset}`,
        scan.skillSources.length
          ? `${C.gray}  found ${scan.totalSkills} skills across ${scan.skillSources.length} agents:${C.reset}`
          : `${C.gray}  no foreign skill trees found — mochi's built-ins still ship.${C.reset}`,
        ``,
      ];
      for (const s of scan.skillSources) {
        lines.push(`  ${C.lime}●${C.reset} ${s.agent.padEnd(12)} ${C.bold}${s.count}${C.reset} ${C.gray}${s.dir}${C.reset}`);
      }
      lines.push(``, `${C.dim}  import is namespaced + non-destructive (existing skills win unless --force).${C.reset}`);
      return lines;
    }
    case 'mcp': {
      const lines = [
        `${C.bold}${C.violet}─ MCP servers & tools ─${C.reset}`,
        scan.mcpSources.length
          ? `${C.gray}  found ${scan.totalMcpServers} servers across ${scan.mcpSources.length} configs:${C.reset}`
          : `${C.gray}  no foreign MCP configs found — 12 built-ins still available via /mcp.${C.reset}`,
        ``,
      ];
      for (const m of scan.mcpSources) {
        lines.push(`  ${C.cyan}●${C.reset} ${m.agent.padEnd(16)} ${C.dim}${m.file}${C.reset}`);
        lines.push(`    ${C.gray}${m.servers.slice(0, 6).join(', ')}${m.servers.length > 6 ? ` +${m.servers.length - 6} more` : ''}${C.reset}`);
      }
      return lines;
    }
    case 'editors': {
      return [
        `${C.bold}${C.violet}─ editors ─${C.reset}`,
        `${C.gray}  mochi speaks Agent Client Protocol (ACP) — native in editors:${C.reset}`,
        ``,
        `  ${C.cyan}VS Code${C.reset}    editors/vscode  → \`mochi acp\`  ${C.dim}(Cmd+Shift+P → Mochi: New Session)${C.reset}`,
        `  ${C.cyan}JetBrains${C.reset}   editors/jetbrains → \`mochi acp\`  ${C.dim}(Tools → Mochi chat)${C.reset}`,
        ``,
        `${C.dim}  install: see editors/vscode/README.md + editors/jetbrains/README.md${C.reset}`,
      ];
    }
    case 'done': {
      return [
        ``,
        `${C.lime}${C.bold}  🍡 you're all set — cozy coding ahead!${C.reset}`,
        `${C.gray}  try: ask mochi anything, /model to swap brains, /skills to browse, /mcp to add servers.${C.reset}`,
        `${C.gray}  this screen won't pop up again. revisit anytime with \`mochi onboard\` or \`/onboard\`.${C.reset}`,
        ``,
      ];
    }
  }
}

export interface OnboardChoices {
  importProviders: boolean;
  importSkills: boolean;
  importMcp: boolean;
  skillDirs: string[];
  mcpFiles: string[];
}

/** Sensible defaults: import everything detected (non-destructive). */
export function defaultChoices(scan: OnboardScan): OnboardChoices {
  return {
    importProviders: scan.providers.some((p) => p.hasKey),
    importSkills: scan.skillSources.length > 0,
    importMcp: scan.mcpSources.length > 0,
    skillDirs: scan.skillSources.map((s) => s.dir),
    mcpFiles: scan.mcpSources.map((m) => m.file),
  };
}
