import { computeSymbolBlastRadius } from '../codegraph.js';
import type { Tool } from './types.js';

export const blastRadiusTool: Tool = {
  def: {
    name: 'blast_radius',
    description:
      'Calculates the semantic dependency blast radius for a symbol before modifying it. Reports direct callers, call sites across all files, inheritance relations, and an architectural risk score to prevent regressions.',
    parameters: [
      {
        name: 'symbol',
        type: 'string',
        description: 'The function, class, interface, or variable name to analyze.',
        required: true,
      },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const symbol = String(args.symbol ?? '').trim();
    if (!symbol) throw new Error('symbol parameter is required');

    const report = await computeSymbolBlastRadius(ctx.cwd, symbol);
    const lines = [
      `# Blast Radius Analysis: ${report.symbol}`,
      `Risk Assessment: ${report.riskLevel} (${report.directCallers.length} call sites across ${report.affectedFiles.length} files)`,
      '',
    ];

    if (report.directCallers.length > 0) {
      lines.push('## Direct Callers:');
      report.directCallers.slice(0, 15).forEach((c) => {
        lines.push(`  • ${c.file}:${c.line} (inside ${c.caller})`);
      });
      if (report.directCallers.length > 15) {
        lines.push(`  ... and ${report.directCallers.length - 15} more call sites.`);
      }
      lines.push('');
    }

    if (report.affectedFiles.length > 0) {
      lines.push('## Affected Files:');
      report.affectedFiles.forEach((f) => lines.push(`  - ${f}`));
      lines.push('');
    }

    if (report.typeRelations.superTypes.length > 0 || report.typeRelations.subTypes.length > 0) {
      lines.push('## Type Hierarchy:');
      if (report.typeRelations.superTypes.length > 0) {
        lines.push(`  • Super-types: ${report.typeRelations.superTypes.join(', ')}`);
      }
      if (report.typeRelations.subTypes.length > 0) {
        lines.push(`  • Sub-types: ${report.typeRelations.subTypes.join(', ')}`);
      }
      lines.push('');
    }

    lines.push(`Recommendation: ${
      report.riskLevel === 'CRITICAL' || report.riskLevel === 'HIGH'
        ? 'High impact change. Verify all affected call sites and run the full test suite after editing.'
        : 'Low/Medium impact change. Standard test verification is sufficient.'
    }`);

    return lines.join('\n');
  },
};
