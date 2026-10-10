import type { Tool } from './types.js';
import { clipToolOutput } from './output-budget.js';

const MAX_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

// SSRF guard: block loopback, link-local (cloud metadata), and RFC1918
// private-range hosts unless the caller explicitly opts in via allowPrivate.
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  // IPv6
  if (host.includes(':')) {
    if (host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true;
    // IPv4-mapped ::ffff:a.b.c.d
    const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateHost(mapped[1]);
    return false;
  }
  // IPv4
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const o = m.slice(1).map(Number);
    if (o.some((n) => !Number.isInteger(n) || n > 255)) return false;
    if (o[0] === 127 || o[0] === 10 || o[0] === 0) return true;
    if (o[0] === 169 && o[1] === 254) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    return false;
  }
  return false;
}

function assertPublicUrl(rawUrl: string, allowPrivate: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`blocked protocol ${parsed.protocol} — only http/https allowed`);
  }
  if (!allowPrivate && isPrivateHost(parsed.hostname)) {
    throw new Error(`blocked request to private/loopback host '${parsed.hostname}' (SSRF guard); pass allow_private=true to override`);
  }
  return parsed;
}

export const fetchTool: Tool = {
  def: {
    name: 'fetch',
    description: 'Fetch a URL and return the response body (text). Supports GET and POST. Output is truncated at 64 KB. Requests to private/loopback hosts are blocked by default.',
    parameters: [
      { name: 'url', type: 'string', description: 'URL to fetch', required: true },
      { name: 'method', type: 'string', description: 'HTTP method (GET, POST, PUT, DELETE). Defaults to GET.', required: false },
      { name: 'headers', type: 'string', description: 'JSON object of request headers, e.g. {"Authorization":"Bearer token"}', required: false },
      { name: 'body', type: 'string', description: 'Request body (for POST/PUT)', required: false },
      { name: 'allow_private', type: 'boolean', description: 'Allow fetching private/loopback hosts (127.0.0.1, 10.x, 192.168.x, 169.254.x, ::1, localhost). Default false.', required: false },
    ],
    permission: 'network',
  },
  async execute(args) {
    const url = String(args.url ?? '');
    if (!url) throw new Error('url is required');
    const allowPrivate = args.allow_private === true || args.allow_private === 'true';
    const safeUrl = assertPublicUrl(url, allowPrivate);
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
    const init: RequestInit = { method, headers, body, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
    const res = await fetch(safeUrl, init);
    const status = `HTTP ${res.status} ${res.statusText}`;
    const rawText = await res.text();
    // 64KB stream guard stays; below that the shared budget applies
    // (head+tail clip) so fetched pages don't eat the context budget either.
    const text = rawText.length > MAX_BYTES ? rawText.slice(0, MAX_BYTES) + '\n... [truncated]' : rawText;
    const contentType = res.headers.get('content-type') ?? '';
    return clipToolOutput(`${status}\nContent-Type: ${contentType}\n\n${text}`);
  },
};
