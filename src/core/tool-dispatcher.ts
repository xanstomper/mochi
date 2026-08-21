// Concurrent & Safe Tool Dispatcher for Mochi VNext
// Executes independent read-only inspection tools in parallel via Promise.allSettled
// and runs mutating tools sequentially with instant diagnostic feedback.

import type { CapabilityRegistry } from './capability-registry.js';
import type { CapabilityContext, CapabilityExecutionResponse } from './capability.js';
import { diagnoseFile, renderDiagnostics } from '../diagnostics.js';
import { resolve } from 'node:path';

export interface ToolCallSpec {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export class ToolDispatcher {
  constructor(private registry: CapabilityRegistry) {}

  /**
   * Dispatch a batch of tool calls emitted by the model in a single turn.
   * Read-only inspection tools run concurrently; mutating tools run sequentially.
   */
  async dispatchBatch(
    calls: ToolCallSpec[],
    context: CapabilityContext
  ): Promise<CapabilityExecutionResponse[]> {
    if (!calls.length) return [];

    const readOnlyCalls: ToolCallSpec[] = [];
    const mutatingCalls: ToolCallSpec[] = [];

    for (const call of calls) {
      const cap = this.registry.get(call.name);
      if (cap && cap.isReadOnly) {
        readOnlyCalls.push(call);
      } else {
        mutatingCalls.push(call);
      }
    }

    // 1. Execute all read-only inspection tools concurrently
    const readPromises = readOnlyCalls.map(async (c) => {
      return this.registry.execute(c.name, c.arguments, context, c.id);
    });

    const readSettled = await Promise.allSettled(readPromises);
    const readResults: CapabilityExecutionResponse[] = readSettled.map((s, idx) => {
      if (s.status === 'fulfilled') return s.value;
      return {
        callId: readOnlyCalls[idx].id,
        name: readOnlyCalls[idx].name,
        output: '',
        error: s.reason instanceof Error ? s.reason.message : String(s.reason),
        durationMs: 0,
        truncated: false,
        rawTokensEstimate: 0,
      };
    });

    // 2. Execute mutating tools sequentially with instant LSP diagnostics
    const mutatingResults: CapabilityExecutionResponse[] = [];
    for (const c of mutatingCalls) {
      const res = await this.registry.execute(c.name, c.arguments, context, c.id);

      // Instant post-edit diagnostic collection
      let diagNote = '';
      if (['write', 'edit', 'patch'].includes(c.name) && !res.error) {
        const targetPath = String(c.arguments.path ?? '');
        if (targetPath && /\.(ts|tsx|js|jsx|mts|cts|py)$/.test(targetPath)) {
          try {
            const diags = await diagnoseFile(resolve(context.cwd, targetPath), context.cwd);
            if (!diags.ok && (diags.errors.length > 0 || diags.warnings.length > 0)) {
              diagNote = renderDiagnostics([diags]);
            }
          } catch {}
        }
      }

      const enhancedResult: CapabilityExecutionResponse = {
        ...res,
        output: res.output + (diagNote ? `\n${diagNote}` : ''),
      };

      mutatingResults.push(enhancedResult);

      // Halt execution on fatal permission or write failure
      if (res.error && res.error.includes('Permission denied')) {
        break;
      }
    }

    // Return all responses in original tool call sequence
    const resultMap = new Map<string, CapabilityExecutionResponse>();
    for (const r of [...readResults, ...mutatingResults]) {
      resultMap.set(r.callId, r);
    }

    return calls.map((c) => resultMap.get(c.id) ?? {
      callId: c.id,
      name: c.name,
      output: '',
      error: 'Tool execution skipped due to prior failure.',
      durationMs: 0,
      truncated: false,
      rawTokensEstimate: 0,
    });
  }
}
