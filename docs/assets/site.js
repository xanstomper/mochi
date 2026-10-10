// shared chrome: header, footer, scroll reveal, bench bar animation
(function(){
  var path = location.pathname.replace(/\/index\.html$/,'/').replace(/\.html$/,'/');
  var pages = [
    ['index.html','Home','/'],
    ['docs.html','Docs','docs.html'],
    ['benchmarks.html','Benchmarks','benchmarks.html'],
    ['changelog.html','Changelog','changelog.html']
  ];
  var REPO='https://github.com/xanstomper/mochi';

  // mark (two stacked planes = harness layers: Rust core under TS front)
  var mark='<svg class="mark" viewBox="0 0 24 24" fill="none"><rect x="2.5" y="12.5" width="19" height="7" rx="2.5" fill="#A9C97E"/><rect x="2.5" y="4.5" width="19" height="7" rx="2.5" stroke="#A9C97E" stroke-opacity=".45" stroke-width="1.6"/></svg>';

  var nav=pages.map(function(p){
    var active=(path==='/'&&p[2]==='/')||(p[2]!=='/'&&path.indexOf('/'+p[2].replace('.html',''))>-1&&p[2]!=='/');
    var homeActive=(path==='/'||path==='/mochi/'||path==='/mochi')&&p[2]==='/';
    var cur=(p[2]==='/'?homeActive:active)?' aria-current="page"':'';
    var href=p[2]==='/'?(path.indexOf('/mochi')>-1?'/mochi/':'/'):p[2];
    return '<a href="'+href+'"'+cur+'>'+p[1]+'</a>';
  }).join('');

  var header=document.createElement('header');
  header.className='site';
  header.innerHTML='<div class="wrap">'
    +'<a class="wordmark" href="'+(path.indexOf('/mochi')>-1?'/mochi/':'/')+'">'+mark+'mochi</a>'
    +'<nav>'+nav+'</nav>'
    +'<span class="spacer"></span>'
    +'<a class="gh" href="'+REPO+'" target="_blank" rel="noopener">'
    +'<svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>'
    +'xanstomper/mochi</a></div>';
  document.body.insertBefore(header,document.body.firstChild);

  var footer=document.createElement('footer');
  footer.className='site';
  footer.innerHTML='<div class="wrap"><div class="cols">'
    +'<div><a class="wordmark" href="'+(path.indexOf('/mochi')>-1?'/mochi/':'/')+'" style="font-size:15px">'+mark+'mochi</a>'
    +'<p>Minimal Orchestrative Coding Harness Intelligence — a minimal, fast, autonomous coding agent for the terminal, built on a zero-dependency Rust core.</p></div>'
    +'<div><h6>Product</h6><a href="index.html#features">Features</a><a href="index.html#roles">Agent roles</a><a href="benchmarks.html">Benchmarks</a><a href="docs.html#install">Install</a></div>'
    +'<div><h6>Documentation</h6><a href="docs.html#architecture">Architecture</a><a href="docs.html#tools">Tools</a><a href="docs.html#cli">CLI reference</a><a href="docs.html#daemon">Daemon</a></div>'
    +'<div><h6>Project</h6><a href="'+REPO+'" target="_blank" rel="noopener">GitHub</a><a href="'+REPO+'/blob/main/CHANGELOG.md" target="_blank" rel="noopener">Changelog (repo)</a><a href="benchmarks.html">Performance</a></div>'
    +'</div><div class="legal"><span>© 2026 mochi — open source.</span><span>Rust core · TypeScript frontend · zero runtime dependencies</span></div></div>';
  document.body.appendChild(footer);

  // scroll reveal
  var io=new IntersectionObserver(function(es){
    es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target);}});
  },{threshold:.1,rootMargin:'0px 0px -30px 0px'});
  document.querySelectorAll('.rv').forEach(function(el){io.observe(el);});

  // benchmark bars
  var bio=new IntersectionObserver(function(es){
    es.forEach(function(e){
      if(!e.isIntersecting)return;
      var rows=e.target.querySelectorAll('.row'),max=0;
      rows.forEach(function(r){max=Math.max(max,+r.dataset.v);});
      rows.forEach(function(r,i){
        var v=+r.dataset.v,f=r.querySelector('.f'),val=r.querySelector('.v');
        setTimeout(function(){
          f.style.width=Math.max(2,(v/max)*100)+'%';
          var txt=r.dataset.fmt==='ms'&&v<100?v.toFixed(1)+' ms':(v<10?v.toFixed(v<1?2:1):Math.round(v).toLocaleString())+(r.dataset.fmt==='ms'?' ms':' MB');
          val.innerHTML=txt+(r.querySelector('.first')?'<i>1st</i>':'');
        },100+i*80);
      });
      bio.unobserve(e.target);
    });
  },{threshold:.25});
  document.querySelectorAll('.bench').forEach(function(el){bio.observe(el);});
})();
