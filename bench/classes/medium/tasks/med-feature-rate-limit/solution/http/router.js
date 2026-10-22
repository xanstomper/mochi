const { dataHandler, healthHandler } = require('./handler.js');
const { TokenBucket } = require('../limits/bucket.js');

const ROUTES = {
  'GET /api/data': dataHandler,
  'GET /health': healthHandler,
};

// createRouter({ now }): dispatch(method, path) -> { status, headers, body }
// Routes under /api/ are limited to a burst of 3, refilling 1/sec.
function createRouter({ now = Date.now } = {}) {
  const bucket = new TokenBucket({ capacity: 3, refillPerSec: 1, now });
  return {
    dispatch(method, path) {
      const handler = ROUTES[`${method} ${path}`];
      if (!handler) return { status: 404, headers: {}, body: { error: 'not found' } };
      if (path.startsWith('/api/') && !bucket.tryRemove(1)) {
        return {
          status: 429,
          headers: { 'retry-after': String(bucket.retryAfterSec()) },
          body: { error: 'rate limited' },
        };
      }
      return handler();
    },
  };
}
module.exports = { createRouter };
