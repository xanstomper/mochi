const defaults = require('./defaults.js');
const { readEnv } = require('./env.js');

function coerce(key, raw, defaultValue) {
  if (typeof defaultValue === 'number') {
    const n = Number(raw);
    if (Number.isNaN(n)) throw new Error(`invalid value for config key "${key}": ${JSON.stringify(raw)} is not a number`);
    return n;
  }
  if (typeof defaultValue === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new Error(`invalid value for config key "${key}": ${JSON.stringify(raw)} is not a boolean ('true' or 'false')`);
  }
  return String(raw);
}

// loadConfig({ env, file }): merge defaults < file < environment.
// Only keys present in defaults are configurable.
function loadConfig({ env = {}, file = null } = {}) {
  const out = { ...defaults };
  if (file) {
    for (const key of Object.keys(defaults)) {
      if (Object.prototype.hasOwnProperty.call(file, key)) out[key] = file[key];
    }
  }
  for (const key of Object.keys(defaults)) {
    const raw = readEnv(env, key);
    if (raw !== undefined) out[key] = coerce(key, raw, defaults[key]);
  }
  return out;
}
module.exports = { loadConfig };
