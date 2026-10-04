// Graceful provider degradation, part 1: give the loop a clean, honest
// status line instead of raw error dumps when providers circuit-break.
// The message shape comes from real traces:
//   "Model request failed: The operation was aborted."
//   "Provider freeinference is cooling down after failures. Try again shortly."
// Parsed into {kind, provider, retryAfterMs, headline} for the TUI.

export interface ProviderFailure {
  /** transient: cooldown/network, worth an auto-retry. fatal: everything else. */
  kind: 'transient' | 'fatal';
  provider?: string;
  retryAfterMs?: number;
  /** One clean line for the status area / transcript. */
  headline: string;
}

const RETRY_IN_RE = /(?:retry|again) in ~?(\d+(?:\.\d+)?)\s*(ms|s|m)/i;

export function describeProviderFailure(err: unknown): ProviderFailure {
  const raw = err instanceof Error ? err.message : String(err);
  const msg = raw.replace(/\s+/g, ' ').trim();

  // Capability-gate cooldown: "Provider X is cooling down after failures.
  // Try again in ~2.1s. (lastError)" — the trailing parenthetical is the raw
  // last error, so anchor the retry parse BEFORE it.
  const cool = /provider ([\w.-]+) is cooling down/i.exec(msg);
  if (cool) {
    const tail = msg.slice(cool.index + cool[0].length);
    const retry = RETRY_IN_RE.exec(tail.split('(')[0]);
    let retryAfterMs: number | undefined;
    if (retry) {
      const n = Number(retry[1]);
      retryAfterMs = retry[2].toLowerCase() === 'ms' ? n : retry[2].toLowerCase() === 'm' ? n * 60_000 : n * 1000;
    }
    return {
      kind: 'transient',
      provider: cool[1],
      retryAfterMs,
      headline: `provider ${cool[1]} busy — retrying${retryAfterMs ? ` in ${Math.round(retryAfterMs / 100) / 10}s` : ''}`,
    };
  }

  // Transport-level aborts / network churn: transient by nature.
  if (/operation was aborted|econnreset|econnrefused|etimedout|fetch failed|socket hang up|network/i.test(msg)) {
    return { kind: 'transient', headline: 'network hiccup — will retry' };
  }

  // 429/5xx surfaced as ProviderError text.
  if (/\b429\b|rate.?limit|\b5\d\d\b|overloaded/i.test(msg)) {
    return { kind: 'transient', headline: 'provider rate-limited — backing off' };
  }

  // Auth/bad request: failover chain already exhausted; do not spin.
  const auth = /\b40[13]\b|unauthorized|invalid api key|forbidden/i.test(msg);
  return {
    kind: 'fatal',
    headline: auth ? 'model auth failed — check API key/config' : `model error: ${msg.slice(0, 120)}`,
  };
}
