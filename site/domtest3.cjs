
const { JSDOM } = require('jsdom');
const fs = require('fs');
const dom = new JSDOM('<!DOCTYPE html><body><div id="root"></div></body>', { url: 'https://xanstomper.github.io/mochi/', pretendToBeVisual: true, runScripts: 'outside-only' });
const w = dom.window;
w.IntersectionObserver = class { constructor(cb){this.cb=cb} observe(el){ this.cb([{isIntersecting:true,target:el}]) } unobserve(){} disconnect(){} };
w.MutationObserver = class { observe(){} disconnect(){} };
w.matchMedia = () => ({ matches:false, addListener(){}, removeListener(){} });
w.onerror = (msg, src, line) => { console.log('WINDOW ERROR:', msg, 'line', line); };
process.on('uncaughtException', e => console.log('UNCAUGHT:', e.message));
(async () => {
  // import React chunk then home chunk as modules in jsdom context via eval with ESM? jsdom lacks ESM. Use node vm.SourceTextModule.
  const vm = require('vm');
  const animated = fs.readFileSync('../docs/assets/anim-YM0WM9Hu.js','utf8');
  const home = fs.readFileSync('../docs/assets/index-ChZiQznL.js','utf8');
  // rewrite import specifier to file URL of anim chunk
  const animURL = require('url').pathToFileURL(require.resolve('../docs/assets/anim-YM0WM9Hu.js')).href;
  const homeFixed = home.replace(/from"\.\/anim-[^"]+"/g, 'from "' + animURL + '"');
  const mod = new vm.SourceTextModule(homeFixed, { context: dom.getInternalVMContext(), identifier: 'home.jsx' });
  try {
    await mod.link(() => {});
    await mod.evaluate();
    setTimeout(() => {
      const root = w.document.getElementById('root');
      console.log('root children:', root.children.length);
      console.log('hero:', !!w.document.querySelector('.hero'));
      console.log('h1:', (w.document.querySelector('h1')||{textContent:null}).textContent);
      console.log('feat cards:', w.document.querySelectorAll('.feat-card').length);
      console.log('NAV:', (w.document.querySelector('nav')||{textContent:null}).textContent);
    }, 500);
  } catch(e) { console.log('MODULE ERROR:', e.message, (e.stack||'').split('\n').slice(1,4).join(' | ')); }
})();
