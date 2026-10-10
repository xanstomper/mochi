
const fs = require('fs');
// shim browser globals on globalThis before importing the ESM bundle
globalThis.window = globalThis;
globalThis.document = {
  createElement: () => ({ style:{}, setAttribute(){}, appendChild(){}, attachShadow(){return{appendChild(){}}} , classList:{add(){},remove(){}} }),
  createTextNode: () => ({}),
  querySelectorAll: () => [],
  querySelector: () => null,
  getElementById: () => null,
  body: { insertBefore(){}, appendChild(){}, firstChild:{}, style:{} },
  addEventListener(){}, removeEventListener(){},
  head: { appendChild(){} },
};
globalThis.location = { pathname: '/', href: 'https://xanstomper.github.io/mochi/' };
globalThis.navigator = { userAgent: 'node' };
globalThis.matchMedia = () => ({ matches:false, addListener(){}, removeListener(){} });
globalThis.MutationObserver = class { constructor(){} observe(){} disconnect(){} };
globalThis.IntersectionObserver = class { constructor(){} observe(){} unobserve(){} disconnect(){} };
globalThis.requestAnimationFrame = cb => setTimeout(()=>cb(Date.now()),16);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.performance = { now: () => Date.now() };
(async () => {
  try {
    await import('../docs/assets/anim-YM0WM9Hu.js');
    await import('../docs/assets/index-ChZiQznL.js');
    console.log('IMPORT OK');
  } catch(e) { console.log('IMPORT ERROR:', e.message, (e.stack||'').split('\n').slice(1,3).join(' | ')); process.exit(1); }
})();
