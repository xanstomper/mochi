// Concurrent & Safe Tool Dispatcher for Mochi VNext
// Executes independent read-only inspection tools in parallel via Promise.allSettled
// and runs mutating tools sequentially with instant diagnostic feedback.
//
// Master rebuild (Phase 3/4/5): every call now passes through the
// ExecutionRegistry — identical requests inside the dedupe window execute ONCE,
// completed executions replay their cached result by executionId, and an
// already-aborted signal refuses to start any work.

import type { CapabilityRegistry } from './capability-registry.js';
import type { CapabilityContext, CapabilityExecutionResponse } from './capability.js';
import { diagnoseFile, renderDiagnostics } from '../diagnostics.js';
import { ExecutionRegistry } from './execution-registry.js';
import { resolve } from 'node:path';

export interface ToolCallSpec {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export class ToolDispatcher {
  private readonly executions: ExecutionRegistry;

  constructor(private registry: CapabilityRegistry, executionRegistry?: ExecutionRegistry) {
    this.executions = executionRegistry ?? new ExecutionRegistry();
  }

  /** Structured refusal for work that must not start (Phase 5). */
  private canceledResponse(call: ToolCallSpec, reason: string): CapabilityExecutionResponse {
    return {
      callId: call.id,
      name: call.name,
      output: '',
      error: `canceled: ${reason}`,
      durationMs: 0,
      truncated: false,
      rawTokensEstimate: 0,
      metadata: { canceled: true },
    };
  }

  /** Response for a call recognized as a duplicate of in-flight/recent work. */
  private duplicateResponse(call: ToolCallSpec, executionId: string, cached: unknown): CapabilityExecutionResponse {
    if (cached && typeof cached === 'object' && 'output' in (cached as Record<string, unknown>)) {
      const c = cached as CapabilityExecutionResponse;
      return { ...c, callId: call.id, metadata: { ...c.metadata, duplicate: true, executionId } };
    }
    return {
      callId: call.id,
      name: call.name,
      output: `[duplicate suppressed] identical ${call.name} request already dispatched (execution ${executionId}).`,
      durationMs: 0,
      truncated: false,
      rawTokensEstimate: 0,
      metadata: { duplicate: true, executionId },
    };
  }

  /**
   * Dispatch a batch of tool calls emitted by the model in a single turn.
   * Read-only inspection tools run concurrently; mutating tools run sequentially.
   * Duplicate suppression + idempotent replay are enforced BEFORE any side
   * effect, and an aborted signal refuses to start or continue work.
   */
  async dispatchBatch(
    calls: ToolCallSpec[],
    context: CapabilityContext
  ): Promise<CapabilityExecutionResponse[]> {
    if (!calls.length) return [];

    // Phase 5: refuse everything up front when cancellation already happened.
    if (context.abortSignal?.aborted) {
      return calls.map((c) => this.canceledResponse(c, 'abort signal already fired'));
    }

    // Register every call first: dedupe/replay decisions happen BEFORE any
    // side effect, and identical calls within one batch collapse to one run.
    const plan = calls.map((call) => {
      const rec = this.executions.register({
        toolName: call.name,
        args: call.arguments,
        executionId: call.id || undefined,
      });
      return { call, rec };
    });

    const results = new Map<string, CapabilityExecutionResponse>();
    const toRun: Array<{ call: ToolCallSpec; executionId: string }> = [];

    for (const { call, rec } of plan) {
      if (rec.duplicate) {
        results.set(call.id, this.duplicateResponse(call, rec.executionId, rec.result));
        continue;
      }
      toRun.push({ call, executionId: rec.executionId });
    }

    const readOnly = toRun.filter(({ call }) => {
      const cap = this.registry.get(call.name);
      return cap ? cap.isReadOnly : false;
    });
    const mutating = toRun.filter(({ call }) => {
      const cap = this.registry.get(call.name);
      return !cap || !cap.isReadOnly;
    });

    // 1. Execute all read-only inspection tools concurrently
    const readSettled = await Promise.allSettled(
      readOnly.map(async ({ call, executionId }) => {
        const res = await this.registry.execute(call.name, call.arguments, context, call.id);
        this.executions.markCompleted(executionId, res);
        return { call, res } as const;
      }),
    );
    readSettled.forEach((s, idx) => {
      const call = readOnly[idx].call;
      if (s.status === 'fulfilled') {
        results.set(call.id, s.value.res);
      } else {
        results.set(call.id, {
          callId: call.id,
          name: call.name,
          output: '',
          error: s.reason instanceof Error ? s.reason.message : String(s.reason),
          durationMs: 0,
          truncated: false,
          rawTokensEstimate: 0,
        });
      }
    });

    // 2. Execute mutating tools sequentially with instant LSP diagnostics,
    //    checking the abort signal before every side effect.
    for (const { call, executionId } of mutating) {
      if (context.abortSignal?.aborted) {
        this.executions.markCanceled(executionId);
        results.set(call.id, this.canceledResponse(call, 'abort signal fired mid-batch'));
        continue;
      }
      const res = await this.registry.execute(call.name, call.arguments, context, call.id);
      this.executions.markCompleted(executionId, res);

      // Instant post-edit diagnostic collection
      let diagNote = '';
      if (['write', 'edit', 'patch'].includes(call.name) && !res.error) {
        const targetPath = String(call.arguments.path ?? '');
        if (targetPath && /\.(ts|tsx|js|jsx|mts|cts|py)$/.test(targetPath)) {
          try {
            const diags = await diagnoseFile(resolve(context.cwd, targetPath), context.cwd);
            if (!diags.ok && (diags.errors.length > 0 || diags.warnings.length > 0)) {
              diagNote = renderDiagnostics([diags]);
            }
          } catch {}
        }
      }

      results.set(call.id, {
        ...res,
        output: res.output + (diagNote ? `\n${diagNote}` : ''),
      });

      // Halt execution on fatal permission or write failure
      if (res.error && res.error.includes('Permission denied')) {
        break;
      }
    }

    // Return all responses in original tool call sequence
    return calls.map((c) => results.get(c.id) ?? {
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
