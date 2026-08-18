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
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build a short, actionable model-request error from a non-OK response.
 * Reveals the JSON `error.message` when available, otherwise strips HTML, and
 * attaches a one-line fix hint for well-known status codes.
 */
export function describeModelError(status: number, body: string, model: string, provider: string): Error {
  let detail = plainFromJson(body);
  if (!detail || detail.includes('<')) detail = stripHtml(detail);
  detail = (detail || '(no detail)').slice(0, 240);
  const hint = STATUS_HINTS[status];
  const message =
    `${provider} request failed (${status}) for model "${model}".` +
    (hint ? ` ${hint}` : '') +
    `\n${detail}`;
  return new Error(message.trim());
}