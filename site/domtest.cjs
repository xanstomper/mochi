
const { JSDOM } = require('jsdom');
const fs = require('fs');
const dom = new JSDOM('<!DOCTYPE html><body><div id="root"></div></body>', { url: 'https://xanstomper.github.io/mochi/', pretendToBeVisual: true, runScripts: 'outside-only' });
const w = dom.window;
w.IntersectionObserver = class { constructor(cb){this.cb=cb} observe(){} unobserve(){} disconnect(){} };
w.requestAnimationFrame = cb => setTimeout(()=>cb(performance.now()),16);
w.matchMedia = w.matchMedia || (() => ({ matches:false, addListener(){}, removeListener(){} }));
const bundle = fs.readFileSync('../docs/assets/index-ChZiQznL.js','utf8') + '\n' + fs.readFileSync('../docs/assets/anim-YM0WM9Hu.js','utf8');
// module chunk order: anim is imported by index; concatenating breaks module scoping — instead run each as module via w.eval? jsdom outside-only eval works.
try { w.eval(bundle); } catch(e) { console.log('EVAL ERROR:', e.message, (e.stack||'').split('\n')[1]); process.exit(1); }
setTimeout(() => {
  const root = w.document.getElementById('root');
  console.log('root children:', root.children.length);
  console.log('has hero:', !!w.document.querySelector('.hero'));
  console.log('has h1:', (w.document.querySelector('h1')||{}).textContent);
  console.log('feat cards:', w.document.querySelectorAll('.feat-card').length);
}, 300);
