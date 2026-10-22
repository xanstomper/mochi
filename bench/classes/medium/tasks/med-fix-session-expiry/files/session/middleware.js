const { TTL_MS } = require('./config.js');

// Absolute expiry: a session is valid only within TTL_MS of its creation.
function isAuthenticated(store, id) {
  const s = store.get(id);
  if (!s) return false;
  return store.now() - s.createdAt < TTL_MS;
}
module.exports = { isAuthenticated };
