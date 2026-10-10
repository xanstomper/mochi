// shared chrome: header, footer, bg blobs, reveal, bench bars — React flavor via site.js keep-it-simple DOM (same as before, pastel-tuned)
(function(){
  var path=location.pathname.replace(/\/index\.html$/,'/').replace(/\.html$/,'/');
  var inSub=path.indexOf('/mochi')>-1;
  var REPO='https://github.com/xanstomper/mochi';
  var pages=[['/',(inSub?'/mochi/':'/'),'01/ Home'],['docs.html','docs.html','02/ Docs'],['benchmarks.html','benchmarks.html','02/ Benchmarks'],['changelog.html','changelog.html','04/ Changelog'],['source.html','source.html','05/ Source']];

  // determine active
  var cur = path;
  if (cur === '/' || cur === '/mochi/') cur = '/';
  
  var navHTML = '';
  pages.forEach(function(p) {
    var href = inSub ? '/mochi/' + p[1] : p[1];
    var active = (cur === '/' && p[0] === '/') || (cur !== '/' && p[1] === cur) ? ' active' : '';
    navHTML += '<a href="' + href + '" class="nav-link' + active + '">' + p[2] + '</a>';
  });

  var header = document.createElement('header');
  header.className = 'site';
  header.innerHTML = 
    '<a href="' + (inSub?'/mochi/':'/') + '" class="nav-brand">mochi<span class="leaf"></span></a>' +
    '<nav class="nav-links">' + navHTML + '</nav>' +
    '<a href="' + REPO + '" class="nav-cta" target="_blank" rel="noopener">' +
      '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>' +
      'xanstomper/mochi ↗</a>' +
    '<div class="nav-attribution">website designed by xanstomper</div>';
  // Dreamlike sky background on ALL pages
  var sky = document.createElement('div');
  sky.className = 'sky-bg';
  sky.innerHTML = '<div class="sky-glow sky-glow-1"></div><div class="sky-glow sky-glow-2"></div><div class="sky-glow sky-glow-3"></div><div class="sky-glow sky-glow-4"></div><div class="sky-clouds"><div class="sky-cloud c1"></div><div class="sky-cloud c2"></div><div class="sky-cloud c3"></div><div class="sky-cloud c4"></div><div class="sky-cloud c5"></div><div class="sky-cloud c6"></div></div>';
  document.body.insertBefore(sky, document.body.firstChild);

  // Decorative floating elements
  var deco = document.createElement('div');
  deco.className = 'deco-layer';
  deco.innerHTML = [
    '<div class="deco-star pink" style="top:12%;left:8%;animation-delay:0s"></div>',
    '<div class="deco-star cyan" style="top:22%;left:85%;animation-delay:1.2s"></div>',
    '<div class="deco-star purple" style="top:35%;left:15%;animation-delay:2.1s"></div>',
    '<div class="deco-star pink" style="top:55%;left:90%;animation-delay:.8s"></div>',
    '<div class="deco-star cyan" style="top:68%;left:5%;animation-delay:1.8s"></div>',
    '<div class="deco-star purple" style="top:78%;left:75%;animation-delay:.3s"></div>',
    '<div class="deco-star pink" style="top:8%;left:55%;animation-delay:2.5s"></div>',
    '<div class="deco-bubble b1"></div>',
    '<div class="deco-bubble b2"></div>',
    '<div class="deco-bubble b3"></div>',
    '<div class="deco-bubble b4"></div>',
    '<div class="deco-bubble b5"></div>',
    '<div class="deco-sprinkle pink" style="top:18%;left:30%"></div>',
    '<div class="deco-sprinkle yellow" style="top:42%;left:70%"></div>',
    '<div class="deco-sprinkle cyan" style="top:60%;left:20%"></div>',
    '<div class="deco-sprinkle purple" style="top:75%;left:55%"></div>',
    '<div class="deco-sprinkle pink" style="top:30%;left:92%"></div>',
    '<div class="deco-sprinkle yellow" style="top:85%;left:35%"></div>',
  ].join('');
  document.body.insertBefore(deco, document.body.firstChild);

  document.body.insertBefore(header, document.body.firstChild);

  // footer — hidden for now (React app handles it)
  // var footer = document.createElement('footer');
  // footer.className = 'site';
  // footer.innerHTML = '...';
  // document.body.appendChild(footer);

  // Remove old bgfx if present
  var bgfx = document.querySelector('.bgfx');
  if (bgfx) bgfx.remove();
})();
