// A tiny event bus: per-event listener lists, error isolation, single-
// removal off(), and once() listeners that are consumed even on error.
class Bus {
  constructor() {
    this.byEvent = new Map(); // event -> [{ fn, once }]
    this.errors = [];
  }
  _list(event) {
    let list = this.byEvent.get(event);
    if (!list) { list = []; this.byEvent.set(event, list); }
    return list;
  }
  on(event, fn) {
    this._list(event).push({ fn, once: false });
    return this;
  }
  once(event, fn) {
    this._list(event).push({ fn, once: true });
    return this;
  }
  off(event, fn) {
    const list = this.byEvent.get(event);
    if (list) {
      const idx = list.findIndex((h) => h.fn === fn);
      if (idx !== -1) list.splice(idx, 1); // exactly one registration
    }
    return this;
  }
  emit(event, ...args) {
    const results = [];
    const list = this.byEvent.get(event);
    if (!list) return results;
    for (const h of [...list]) {
      try {
        results.push(h.fn(...args));
      } catch (error) {
        this.errors.push({ event, error });
      } finally {
        if (h.once) {
          const idx = list.indexOf(h);
          if (idx !== -1) list.splice(idx, 1);
        }
      }
    }
    return results;
  }
}
module.exports = { Bus };
