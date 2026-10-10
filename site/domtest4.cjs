
const { JSDOM } = require('jsdom');
JSDOM.fromURL('http://127.0.0.1:8935/index.html', { resources: 'usable', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) {
    w.IntersectionObserver = class { constructor(cb){this.cb=cb} observe(el){ this.cb([{isIntersecting:true,target:el}],this) } unobserve(){} disconnect(){} };
    w.matchMedia = () => ({ matches:false, addListener(){}, removeListener(){} });
  }})
  .then(dom => {
    const w = dom.window;
    const errors = [];
    w.addEventListener('error', e => errors.push(e.message));
    setTimeout(() => {
      const root = w.document.getElementById('root');
      console.log('ERRORS:', errors.length ? errors : 'none');
      console.log('root children:', root.children.length);
      console.log('hero:', !!w.document.querySelector('.hero'));
      console.log('h1:', (w.document.querySelector('h1')||{textContent:null}).textContent);
      console.log('feat cards:', w.document.querySelectorAll('.feat-card').length);
      console.log('nav:', (w.document.querySelector('nav')||{textContent:'(none)'}).textContent);
      process.exit(0);
    }, 3500);
  }).catch(e => { console.log('LOAD FAIL:', e.message); process.exit(1); });
