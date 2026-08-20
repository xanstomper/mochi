import type { Tool } from './types.js';

const MAX_BYTES = 64 * 1024;

export const fetchTool: Tool = {
  def: {
    name: 'fetch',
    description: 'Fetch a URL and return the response body (text). Supports GET and POST. Output is truncated at 64 KB.',
    parameters: [
      { name: 'url', type: 'string', description: 'URL to fetch', required: true },
      { name: 'method', type: 'string', description: 'HTTP method (GET, POST, PUT, DELETE). Defaults to GET.', required: false },
      { name: 'headers', type: 'string', description: 'JSON object of request headers, e.g. {"Authorization":"Bearer token"}', required: false },
      { name: 'body', type: 'string', description: 'Request body (for POST/PUT)', required: false },
    ],
    permission: 'network',
  },
  async execute(args) {
    const url = String(args.url ?? '');
    if (!url) throw new Error('url is required');
    const method = String(args.method ?? 'GET').toUpperCase();
    let headers: Record<string, string> = {};
    if (args.headers) {
      try {
        headers = JSON.parse(String(args.headers));
      } catch {
        throw new Error('headers must be a valid JSON object');
      }
    }
    const body = args.body ? String(args.body) : undefined;
    const init: RequestInit = { method, headers, body };
    const res = await fetch(url, init);
    const status = `HTTP ${res.status} ${res.statusText}`;
    const rawText = await res.text();
    const text = rawText.length > MAX_BYTES ? rawText.slice(0, MAX_BYTES) + '\n... [truncated]' : rawText;
    const contentType = res.headers.get('content-type') ?? '';
    return `${status}\nContent-Type: ${contentType}\n\n${text}`;
  },
};
