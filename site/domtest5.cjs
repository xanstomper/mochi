
const { JSDOM } = require('jsdom');
JSDOM.fromURL('http://127.0.0.1:8935/index.html', { resources: 'usable', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) {
    w.IntersectionObserver = class { constructor(cb){this.cb=cb} observe(el){ this.cb([{isIntersecting:true,target:el}],this) } unobserve(){} disconnect(){} };
    w.matchMedia = () => ({ matches:false, addListener(){}, removeListener(){} });
    const orig = w.console.error.bind(w.console);
    w.console.error = (...a) => { w.__errs = w.__errs || []; w.__errs.push(a.map(x => String(x && x.message || x).slice(0,200)).join(' | ')); orig(...a); };
  }})
  .then(dom => {
    const w = dom.window;
    setTimeout(() => {
      console.log('CONSOLE ERRORS:', (w.__errs||[]).slice(0,5));
      console.log('root html len:', (w.document.getElementById('root').innerHTML||'').length);
      process.exit(0);
    }, 3500);
  }).catch(e => { console.log('LOAD FAIL:', e.message); process.exit(1); });
