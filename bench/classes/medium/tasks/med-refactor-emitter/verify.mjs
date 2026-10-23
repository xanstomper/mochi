// Class fixture verifier for med-refactor-emitter. Runs with cwd = the task workdir.
// Exit 0 = pass, 1 = fail. Node builtins only; deterministic; no network.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fail = (msg) => { console.log(`FAIL: ${msg}`); process.exit(1); };
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) fail(`${label}: expected ${e}, got ${a}`);
};
const { Bus } = require('./events/bus.js');
const { makeCounter } = require('./app/counter.js');
const { makeLogger } = require('./app/logger.js');

// Order + error isolation + results of successes only.
const bus = new Bus();
const order = [];
bus.on('go', () => { order.push('a'); return 1; });
bus.on('go', () => { order.push('b'); throw new Error('bad listener'); });
bus.on('go', () => { order.push('c'); return 3; });
eq(bus.emit('go'), [1, 3], 'emit returns successful results only');
eq(order, ['a', 'b', 'c'], 'all listeners ran in order despite the throw');
eq(bus.errors.length, 1, 'one error recorded');
eq(bus.errors[0].event, 'go', 'error carries the event');
eq(bus.errors[0].error.message, 'bad listener', 'error carries the exception');

// off() removes exactly one registration.
const bus2 = new Bus();
let hits = 0;
const fn = () => { hits += 1; };
bus2.on('x', fn); bus2.on('x', fn);
bus2.off('x', fn);
bus2.emit('x');
eq(hits, 1, 'off removed exactly one of two registrations');
bus2.off('x', fn);
bus2.emit('x');
eq(hits, 1, 'second off removed the last registration');

// once() fires exactly once, even when it throws.
const bus3 = new Bus();
let onceHits = 0;
bus3.once('y', () => { onceHits += 1; throw new Error('once boom'); });
bus3.emit('y'); bus3.emit('y');
eq(onceHits, 1, 'once listener fired exactly once despite throwing');
eq(bus3.errors.length, 1, 'once error still recorded');

// Consumers still work unchanged.
const bus4 = new Bus();
const counter = makeCounter(bus4);
const logger = makeLogger(bus4);
bus4.emit('tick'); bus4.emit('tick'); bus4.emit('log', 'hello');
eq(counter.value(), 2, 'counter consumer');
eq(logger.lines, ['hello'], 'logger consumer');
console.log('PASS: bus contract holds, consumers intact');
