// Shared HTTP-error formatter for model providers. Providers (OpenAI-compatible,
// Anthropic, Gemini) previously dumped raw upstream bodies into the error
// message -- for a 401/404 that could be a multi-KB HTML page, which is
// unreadable in the TUI and gives the user no idea how to fix it. This helper
// normalizes any non-OK response into a short, actionable line with the status
// code and a human hint, parsing a JSON body when present and stripping HTML.

const STATUS_HINTS: Record<number, string> = {
  400: 'The request was malformed (bad model, tool schema, or message).',
  401: 'Unauthorized: check the API key in your provider config.',
  403: 'Forbidden: the key lacks permission for this model.',
  404: 'Not found: verify the endpoint URL and the model id are correct.',
  408: 'The provider timed out; retry.',
  429: 'Rate limited by the provider; wait and retry.',
  500: 'Provider server error; retry, it may be transient.',
  503: 'Provider is unavailable; retry shortly.',
};

function plainFromJson(text: string): string {
  try {
    const parsed = JSON.parse(text);
    // Common shapes: {error: "..."} or {error: {message: "..."}}.
    const err = parsed?.error;
    if (typeof err === 'string') return err;
    if (err && typeof err.message === 'string') return err.message;
    if (Array.isArray(err)) return err.map((e) => e?.message).filter(Boolean).join('; ');
    if (typeof parsed?.message === 'string') return parsed.message;
    return text;
  } catch {
    return text;
  }
}

/** Collapse HTML into visible text and shrink whitespace/collapse. */
export function stripHtml(text: string): string {
  return text
    .replace(/<script[\s\S]*?<\/script[^>]*>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * An error carrying HTTP metadata so the retry layer can decide whether (and
 * how long) to back off. `status` and `retryAfter` are set when the source was
 * an HTTP response; for thrown/network errors we can infer retryability from the
 * message.
 */
export class ProviderError extends Error {
  readonly status?: number;
  readonly retryAfter?: number; // seconds the server asked us to wait
  readonly retryable: boolean;

  constructor(message: string, opts: { status?: number; retryAfter?: number; retryable?: boolean; cause?: unknown } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = opts.status;
    this.retryAfter = opts.retryAfter;
    this.retryable = opts.retryable ?? defaultRetryable(opts.status, message);
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

function defaultRetryable(status: number | undefined, message: string): boolean {
  if (status !== undefined) return RETRYABLE_STATUS.has(status);
  return /429|rate.?limit|insufficient_quota|too many requests|throttl|server error|temporar|overloaded|503|502|504/i.test(message);
}

// We retry only transient conditions: rate limits, 5xx, timeouts, and transport
// errors. 400/401/403/404 are permanent and must surface immediately.
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Parse an RFC7231 Retry-After header: seconds or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v);
  const asMs = Date.parse(v);
  if (Number.isFinite(asMs)) return Math.max(0, Math.ceil((asMs - Date.now()) / 1000));
  return undefined;
}

/**
 * Build a short, actionable model-request error from a non-OK response.
 * Reveals the JSON `error.message` when available, otherwise strips HTML, and
 * attaches a one-line fix hint for well-known status codes.
 */
export function describeModelError(status: number, body: string, model: string, provider: string, retryAfter?: number): ProviderError {
  let detail = plainFromJson(body);
  if (!detail || detail.includes('<')) detail = stripHtml(detail);
  detail = (detail || '(no detail)').slice(0, 240);
  const hint = STATUS_HINTS[status];
  const message =
    `${provider} request failed (${status}) for model "${model}".` +
    (hint ? ` ${hint}` : '') +
    `\n${detail}`;
  return new ProviderError(message.trim(), { status, retryAfter });
}