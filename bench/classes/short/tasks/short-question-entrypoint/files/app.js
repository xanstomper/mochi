const { formatDuration, formatBytes } = require('./util.js');

function run() {
  const started = Date.now();
  // ... the app's real work would happen here ...
  console.log(`boot took ${formatDuration(Date.now() - started)}`);
  console.log(`payload budget: ${formatBytes(2048)}`);
}

module.exports = { run };
