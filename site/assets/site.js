// shared chrome: header, footer, bg blobs, reveal, bench bars — React flavor via site.js keep-it-simple DOM (same as before, pastel-tuned)
(function(){
  var path=location.pathname.replace(/\/index\.html$/,'/').replace(/\.html$/,'/');
  var inSub=path.indexOf('/mochi')>-1;
  var REPO='https://github.com/xanstomper/mochi';
  var pages=[['/',(inSub?'/mochi/':'/'),'Home'],['docs.html','docs.html','Docs'],['benchmarks.html','benchmarks.html','Benchmarks'],['changelog.html','changelog.html','Changelog'],['source.html','source.html','Source']];

  // mascot mini (nav-size) — same artwork as React <Mochi>, dependency-free
  var mark='<svg class="mascot-nav" viewBox="0 0 96 96" fill="none">'
    +'<path d="M48 12 C70 12 84 28 84 50 C84 72 70 86 48 86 C26 86 12 72 12 50 C12 28 26 12 48 12 Z" fill="#FDF0E4" stroke="#8A6F5B" stroke-width="3.4"/>'
    +'<ellipse cx="34" cy="44" rx="4" ry="5" fill="#5E4B3C"/><ellipse cx="62" cy="44" rx="4" ry="5" fill="#5E4B3C"/>'
    +'<ellipse cx="24" cy="54" rx="6" ry="3.6" fill="#F2A7B8" opacity=".6"/><ellipse cx="72" cy="54" rx="6" ry="3.6" fill="#F2A7B8" opacity=".6"/>'
    +'<path d="M42 55 Q48 62 54 55" stroke="#5E4B3C" stroke-width="3" stroke-linecap="round" fill="none"/>'
    +'<path d="M48 12 C50 6 56 3 62 5 C61 11 55 14 48 12 Z" fill="#A9C97E" stroke="#8A6F5B" stroke-width="2.4"/>'
    +'</svg>';

  var root=inSub?'/mochi/':'/';
  var nav=pages.map(function(p){
    var cur=(p[0]==='/'? (path==='/'||path==='/mochi/') : path.indexOf('/'+p[1].replace('.html',''))>-1&&p[1]!=='docs.html'?false:false)||false;
    // simpler: compute active explicitly
    var active;
    if(p[1]==='/') active=(path==='/'||path==='/mochi/'||path==='/mochi');
    else if(p[1]==='docs.html') active=/docs(\.html|\/)?$/.test(location.pathname);
    else if(p[1]==='source.html') active=/source(\.html|\/)?$/.test(location.pathname);
    else if(p[1]==='benchmarks.html') active=/benchmarks(\.html|\/)?$/.test(location.pathname);
    else active=/changelog(\.html|\/)?$/.test(location.pathname);
    return '<a href="'+p[1]+'"'+(active?' aria-current="page"':'')+'>'+p[2]+'</a>';
  }).join('');

  var header=document.createElement('header');
  header.className='site';
  header.innerHTML='<div class="wrap">'
    +'<a class="wordmark" href="'+root+'">'+mark+'mochi</a>'
    +'<nav>'+nav+'</nav>'
    +'<span class="spacer"></span>'
    +'<a class="gh" href="'+REPO+'" target="_blank" rel="noopener">'
    +'<svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>'
    +'xanstomper/mochi</a></div>';
  document.body.insertBefore(header,document.body.firstChild);

  // ambient blobs
  var bg=document.createElement('div');
  bg.className='bgfx';bg.innerHTML='<i></i><i></i><i></i>';
  document.body.insertBefore(bg,document.body.firstChild);

  var footer=document.createElement('footer');
  footer.className='site';
  footer.innerHTML='<div class="wrap"><div class="cols">'
    +'<div><a class="wordmark" href="'+root+'" style="font-size:15px">'+mark+'mochi</a>'
    +'<p>Mochi — the terminal coding agent — a minimal, fast, autonomous coding agent for the terminal, built on a zero-dependency Rust core.</p></div>'
    +'<div><h6>Product</h6><a href="index.html#features">Features</a><a href="index.html#roles">Agent roles</a><a href="benchmarks.html">Benchmarks</a><a href="docs.html#install">Install</a></div>'
    +'<div><h6>Documentation</h6><a href="docs.html#architecture">Architecture</a><a href="docs.html#tools">Tools</a><a href="docs.html#cli">CLI reference</a><a href="docs.html#daemon">Daemon</a></div>'
    +'<div><h6>Project</h6><a href="'+REPO+'" target="_blank" rel="noopener">GitHub</a><a href="'+REPO+'/blob/main/CHANGELOG.md" target="_blank" rel="noopener">Changelog (repo)</a><a href="benchmarks.html">Performance</a><a href="source.html">Source</a></div>'
    +'</div><div class="legal"><span>© 2026 mochi — open source.</span><span>Rust core · TypeScript frontend · zero runtime dependencies</span></div></div>';
  document.body.appendChild(footer);

})();
