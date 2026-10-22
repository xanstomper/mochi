// Canned solution: the dashboard token/CORS helpers from src/daemon/daemon.ts
// as of 55db719 (fix(daemon): stop leaking the bearer <redacted> via the
// dashboard, scope CORS to localhost). dashboardResponseToken,
// isLocalhostOrigin, and corsHeadersForOrigin are the fix's own helpers,
// verbatim apart from TypeScript types and the CommonJS export;
// corsAllowOrigin is kept as a thin adapter over corsHeadersForOrigin so the
// fixture's original surface still answers.

/** The dashboard HTML may embed the real bearer <redacted> ONLY when the request
 *  itself proved possession of it (tokenOk). An unauthenticated request must
 *  never receive the token. Returns '' when not proven. */
function dashboardResponseToken(_reqToken, tokenOk, realToken) {
  return tokenOk ? realToken : '';
}

const LOCALHOST_ORIGIN_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True only for http(s) origins on a loopback host (any local port, so
 *  local tools like Open WebUI on another port keep working). */
function isLocalhostOrigin(origin) {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return LOCALHOST_ORIGIN_HOSTNAMES.has(u.hostname);
  } catch {
    return false;
  }
}

/** CORS headers for a request: reflect the Origin ONLY when it is a
 *  localhost origin; otherwise no CORS grant at all. Never '*': with '*',
 *  any website could read authenticated API responses cross-origin. */
function corsHeadersForOrigin(origin) {
  if (!isLocalhostOrigin(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    vary: 'Origin',
  };
}

/** The access-control-allow-origin value for this Origin (fixture surface):
 *  the reflected origin for localhost origins, otherwise null (no grant). */
function corsAllowOrigin(origin) {
  const h = corsHeadersForOrigin(origin);
  return h['access-control-allow-origin'] ?? null;
}

module.exports = { dashboardResponseToken, isLocalhostOrigin, corsHeadersForOrigin, corsAllowOrigin };
