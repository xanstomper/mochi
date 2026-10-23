// Counts 'tick' events on the bus.
function makeCounter(bus) {
  let n = 0;
  bus.on('tick', () => { n += 1; });
  return { value: () => n };
}
module.exports = { makeCounter };
