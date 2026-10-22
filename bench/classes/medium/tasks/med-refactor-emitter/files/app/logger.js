// Collects 'log' event messages into an array.
function makeLogger(bus) {
  const lines = [];
  bus.on('log', (msg) => { lines.push(String(msg)); });
  return { lines };
}
module.exports = { makeLogger };
