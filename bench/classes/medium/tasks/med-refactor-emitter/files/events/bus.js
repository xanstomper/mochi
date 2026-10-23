// A tiny event bus. Grew organically - see the task prompt for the
// behavioral contract this implementation must satisfy.
class Bus {
  constructor() {
    this.handlers = []; // [{ event, fn, once }]
    this.errors = [];
  }
  on(event, fn) {
    this.handlers.push({ event, fn, once: false });
    return this;
  }
  once(event, fn) {
    this.handlers.push({ event, fn, once: true });
    return this;
  }
  off(event, fn) {
    this.handlers = this.handlers.filter((h) => !(h.event === event && h.fn === fn));
    return this;
  }
  emit(event, ...args) {
    const results = [];
    for (const h of [...this.handlers]) {
      if (h.event !== event) continue;
      results.push(h.fn(...args));
      if (h.once) this.off(event, h.fn);
    }
    return results;
  }
}
module.exports = { Bus };
