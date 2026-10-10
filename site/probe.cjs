
const { JSDOM } = require('jsdom');
JSDOM.fromURL('http://127.0.0.1:8935/probe.html', { resources: 'usable', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) {
    w.IntersectionObserver = class { constructor(cb){this.cb=cb} observe(){} unobserve(){} disconnect(){} };
    w.matchMedia = () => ({ matches:false, addListener(){}, removeListener(){} });
    w.__flag = [];
  }})
  .then(dom => {
    const w = dom.window;
    setTimeout(() => { console.log('flags:', JSON.stringify(w.__flag)); process.exit(0); }, 2500);
  });
