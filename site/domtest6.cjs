
const { JSDOM } = require('jsdom');
JSDOM.fromURL('http://127.0.0.1:8935/index.html', { resources: 'usable', runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) {
    w.IntersectionObserver = class { constructor(cb){this.cb=cb} observe(el){ this.cb([{isIntersecting:true,target:el}],this) } unobserve(){} disconnect(){} };
    w.matchMedia = () => ({ matches:false, addListener(){}, removeListener(){} });
    let orig = w.console.error.bind(w.console);
    w.console.error = (...a)=>{ (w.__e=w.__e||[]).push(a.map(x=>{try{return x&&x.stack?x.stack.split('\n').slice(0,3).join(' ~ '):String(x).slice(0,300)}catch(e){return '?'}}).join(' | ')); orig(...a); };
    w.console.warn = (...a)=>{ (w.__w=w.__w||[]).push(a.map(String).join(' ').slice(0,200)); };
  }})
  .then(dom => {
    const w = dom.window;
    setTimeout(() => {
      console.log('ERR:', JSON.stringify((w.__e||[]).slice(0,3), null, 1));
      console.log('WARN:', JSON.stringify((w.__w||[]).slice(0,3)));
      process.exit(0);
    }, 4000);
  });
