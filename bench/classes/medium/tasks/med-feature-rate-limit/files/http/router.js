const { dataHandler, healthHandler } = require('./handler.js');

const ROUTES = {
  'GET /api/data': dataHandler,
  'GET /health': healthHandler,
};

// createRouter({ now }): dispatch(method, path) -> { status, headers, body }
function createRouter({ now = Date.now } = {}) {
  return {
    dispatch(method, path) {
      const handler = ROUTES[`${method} ${path}`];
      if (!handler) return { status: 404, headers: {}, body: { error: 'not found' } };
      return handler();
    },
  };
}
module.exports = { createRouter };
