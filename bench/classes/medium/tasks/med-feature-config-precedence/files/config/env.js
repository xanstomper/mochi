// Helpers for APP_-prefixed environment lookups.
function envKey(key) {
  return `APP_${key.toUpperCase()}`;
}
function readEnv(env, key) {
  const v = env[envKey(key)];
  return v === undefined ? undefined : String(v);
}
module.exports = { envKey, readEnv };
