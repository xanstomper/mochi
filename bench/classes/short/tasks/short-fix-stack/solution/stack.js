// A minimal LIFO stack.
class Stack {
  constructor() { this.items = []; }
  push(v) { this.items.push(v); }
  pop() { return this.items.pop(); }
  peek() { return this.items[this.items.length - 1]; }
  get size() { return this.items.length; }
  isEmpty() { return this.items.length === 0; }
}
module.exports = { Stack };
