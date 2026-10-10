// Pastel Lavender Background Engine — v6
// Injected by site.js on every page. Pure CSS/JS — no canvas, no WebGL.
// Layers: gradient base → blobs → dots → sparkles → waves

(function buildBackground() {
  // ── helpers ──────────────────────────────────────────────
  function rand(a, b) { return a + Math.random() * (b - a); }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  // ── container ────────────────────────────────────────────
  var bg = document.createElement('div');
  bg.className = 'bg-decor';
  bg.setAttribute('aria-hidden', 'true');

  // ── blobs ────────────────────────────────────────────────
  var blobColors = [
    'radial-gradient(circle, #E8E3FD 0%, transparent 70%)',
    'radial-gradient(circle, #FCE7F3 0%, transparent 70%)',
    'radial-gradient(circle, #F0EDFE 0%, transparent 70%)',
    'radial-gradient(circle, #DDD6FE 0%, transparent 70%)',
  ];
  var blobPositions = [
    { top: '-10%', right: '-5%', size: 500 },
    { top: '30%', left: '-8%', size: 400 },
    { top: '60%', right: '10%', size: 350 },
    { bottom: '5%', left: '20%', size: 300 },
    { top: '15%', left: '30%', size: 250 },
  ];
  blobPositions.forEach(function(pos, i) {
    var blob = document.createElement('div');
    blob.className = 'bg-blob';
    blob.style.background = blobColors[i % blobColors.length];
    blob.style.width = pos.size + 'px';
    blob.style.height = pos.size + 'px';
    if (pos.top) blob.style.top = pos.top;
    if (pos.bottom) blob.style.bottom = pos.bottom;
    if (pos.left) blob.style.left = pos.left;
    if (pos.right) blob.style.right = pos.right;
    blob.style.opacity = rand(.3, .5).toFixed(2);
    bg.appendChild(blob);
  });

  // ── dots ─────────────────────────────────────────────────
  for (var i = 0; i < 8; i++) {
    var dot = document.createElement('div');
    dot.className = 'bg-dot';
    var s = rand(6, 16).toFixed(0);
    dot.style.width = s + 'px';
    dot.style.height = s + 'px';
    dot.style.top = rand(5, 90).toFixed(1) + '%';
    dot.style.left = rand(2, 95).toFixed(1) + '%';
    dot.style.opacity = rand(.1, .25).toFixed(2);
    bg.appendChild(dot);
  }

  // ── sparkles ─────────────────────────────────────────────
  var sparkleColors = ['#8B75F6', '#C4B5FD', '#E8E3FD', '#A78BFA'];
  for (var j = 0; j < 10; j++) {
    var sp = document.createElement('div');
    sp.className = 'bg-sparkle';
    var sz = rand(10, 22).toFixed(0);
    sp.style.width = sz + 'px';
    sp.style.height = sz + 'px';
    sp.style.background = pick(sparkleColors);
    sp.style.top = rand(3, 92).toFixed(1) + '%';
    sp.style.left = rand(2, 96).toFixed(1) + '%';
    sp.style.animationDelay = rand(0, 3).toFixed(1) + 's';
    bg.appendChild(sp);
  }

  // ── waves ────────────────────────────────────────────────
  var wavePositions = [
    { top: '8%', right: '-3%', w: 450, h: 280 },
    { top: '45%', left: '-6%', w: 380, h: 320 },
    { bottom: '8%', right: '12%', w: 320, h: 260 },
  ];
  wavePositions.forEach(function(pos, i) {
    var wave = document.createElement('div');
    wave.className = 'bg-wave';
    wave.style.width = pos.w + 'px';
    wave.style.height = pos.h + 'px';
    if (pos.top) wave.style.top = pos.top;
    if (pos.bottom) wave.style.bottom = pos.bottom;
    if (pos.left) wave.style.left = pos.left;
    if (pos.right) wave.style.right = pos.right;
    wave.style.animationDelay = (i * 2) + 's';
    bg.appendChild(wave);
  });

  document.body.insertBefore(bg, document.body.firstChild);
})();
