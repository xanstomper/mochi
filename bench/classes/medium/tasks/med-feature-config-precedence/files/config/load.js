const defaults = require('./defaults.js');

// loadConfig({ env, file }): merge defaults < file < environment.
// (Currently a stub: returns the defaults untouched.)
function loadConfig({ env = {}, file = null } = {}) {
  return { ...defaults };
}
module.exports = { loadConfig };
