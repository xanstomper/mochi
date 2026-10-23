// debounce(fn, wait, scheduler): trailing-edge debounce.
// scheduler = { setTimeout, clearTimeout } (injectable for tests).
// Each call resets the timer; fn runs once, wait ms after the LAST call,
// with the last call's arguments.
function debounce(fn, wait, scheduler = globalThis) {
  let timer = null;
  return function debounced(...args) {
    if (timer !== null) scheduler.clearTimeout(timer);
    timer = scheduler.setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
}
module.exports = { debounce };
