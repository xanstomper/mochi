// Dreamlike Sky Background Engine
// Injected by site.js on every page. Pure CSS/JS — no canvas, no WebGL.
// Layers: gradient sky → aurora bands → glow orbs → star field → shooting stars →
//         floating bubbles → cloud horizon → grain → vignette

(function buildSky() {
  // ── helpers ──────────────────────────────────────────────
  function rand(a, b) { return a + Math.random() * (b - a); }
  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  // ── container ────────────────────────────────────────────
  var sky = document.createElement('div');
  sky.className = 'sky-bg';
  sky.setAttribute('aria-hidden', 'true');

  // ── 1. gradient base (CSS handles this) ─────────────────

  // ── 2. aurora bands ──────────────────────────────────────
  var aurora = document.createElement('div');
  aurora.className = 'sky-aurora';
  for (var i = 0; i < 3; i++) {
    var band = document.createElement('div');
    band.className = 'aurora-band ab-' + (i + 1);
    aurora.appendChild(band);
  }
  sky.appendChild(aurora);

  // ── 3. glow orbs ─────────────────────────────────────────
  var glowColors = [
    'rgba(236,72,153,.35)',   // pink
    'rgba(251,146,60,.3)',    // orange
    'rgba(139,92,246,.3)',    // purple
    'rgba(103,232,249,.2)',   // cyan
    'rgba(196,181,253,.25)',  // lavender
    'rgba(253,230,138,.2)',   // yellow
  ];
  for (var g = 0; g < 8; g++) {
    var orb = document.createElement('div');
    orb.className = 'sky-orb';
    var size = rand(200, 700);
    orb.style.cssText =
      'width:' + size + 'px;' +
      'height:' + size + 'px;' +
      'top:' + rand(-20, 80) + '%;' +
      'left:' + rand(-10, 90) + '%;' +
      'background:radial-gradient(circle,' + pick(glowColors) + ' 0%,transparent 70%);' +
      'animation-duration:' + rand(12, 25) + 's;' +
      'animation-delay:-' + rand(0, 20) + 's;';
    sky.appendChild(orb);
  }

  // ── 4. star field (3 depth layers) ───────────────────────
  var starContainer = document.createElement('div');
  starContainer.className = 'sky-stars';
  var starLayers = [
    { count: 60, size: [1, 2], cls: 'star-far' },
    { count: 40, size: [1.5, 2.5], cls: 'star-mid' },
    { count: 20, size: [2, 4], cls: 'star-near' },
  ];
  starLayers.forEach(function(layer) {
    for (var s = 0; s < layer.count; s++) {
      var star = document.createElement('div');
      star.className = 'sky-star ' + layer.cls;
      var sz = rand(layer.size[0], layer.size[1]);
      star.style.cssText =
        'width:' + sz + 'px;' +
        'height:' + sz + 'px;' +
        'top:' + rand(0, 75) + '%;' +
        'left:' + rand(0, 100) + '%;' +
        'animation-duration:' + rand(2, 6) + 's;' +
        'animation-delay:-' + rand(0, 6) + 's;';
      starContainer.appendChild(star);
    }
  });
  sky.appendChild(starContainer);

  // ── 5. shooting stars ────────────────────────────────────
  var shootingContainer = document.createElement('div');
  shootingContainer.className = 'sky-shooting';
  function spawnShootingStar() {
    var ss = document.createElement('div');
    ss.className = 'shooting-star';
    var startX = rand(10, 80);
    var startY = rand(0, 30);
    var angle = rand(25, 45);
    var length = rand(80, 200);
    ss.style.cssText =
      'top:' + startY + '%;' +
      'left:' + startX + '%;' +
      'width:' + length + 'px;' +
      'transform:rotate(' + angle + 'deg);';
    shootingContainer.appendChild(ss);
    setTimeout(function() { ss.remove(); }, 1500);
  }
  // spawn every 4–9 seconds
  (function loopShooting() {
    spawnShootingStar();
    setTimeout(loopShooting, rand(2500, 6000));
  })();
  sky.appendChild(shootingContainer);

  // ── 6. floating bubbles ──────────────────────────────────
  var bubbleContainer = document.createElement('div');
  bubbleContainer.className = 'sky-bubbles';
  for (var b = 0; b < 15; b++) {
    var bubble = document.createElement('div');
    bubble.className = 'sky-bubble';
    var bSize = rand(20, 120);
    bubble.style.cssText =
      'width:' + bSize + 'px;' +
      'height:' + bSize + 'px;' +
      'top:' + rand(10, 85) + '%;' +
      'left:' + rand(0, 95) + '%;' +
      'animation-duration:' + rand(10, 25) + 's;' +
      'animation-delay:-' + rand(0, 20) + 's;';
    bubbleContainer.appendChild(bubble);
  }
  sky.appendChild(bubbleContainer);

  // ── 7. sparkle stars (4-point) ───────────────────────────
  var sparkleContainer = document.createElement('div');
  sparkleContainer.className = 'sky-sparkles';
  var sparkleColors = ['#f472b6', '#67e8f9', '#c4b5fd', '#fde68a', '#fff'];
  for (var sp = 0; sp < 12; sp++) {
    var sparkle = document.createElement('div');
    sparkle.className = 'sky-sparkle';
    sparkle.style.cssText =
      'top:' + rand(5, 70) + '%;' +
      'left:' + rand(3, 95) + '%;' +
      'color:' + pick(sparkleColors) + ';' +
      'font-size:' + rand(10, 22) + 'px;' +
      'animation-duration:' + rand(3, 8) + 's;' +
      'animation-delay:-' + rand(0, 8) + 's;';
    sparkle.innerHTML = '✦';
    sparkleContainer.appendChild(sparkle);
  }
  sky.appendChild(sparkleContainer);

  // ── 8. sprinkle pills ────────────────────────────────────
  var sprinkleContainer = document.createElement('div');
  sprinkleContainer.className = 'sky-sprinkles';
  var sprinkleColors = ['#f472b6', '#fde68a', '#67e8f9', '#c4b5fd'];
  for (var sn = 0; sn < 10; sn++) {
    var sprinkle = document.createElement('div');
    sprinkle.className = 'sky-sprinkle';
    sprinkle.style.cssText =
      'top:' + rand(15, 75) + '%;' +
      'left:' + rand(5, 90) + '%;' +
      'background:' + pick(sprinkleColors) + ';' +
      'width:' + rand(4, 8) + 'px;' +
      'height:' + rand(10, 18) + 'px;' +
      'animation-duration:' + rand(5, 12) + 's;' +
      'animation-delay:-' + rand(0, 10) + 's;';
    sprinkleContainer.appendChild(sprinkle);
  }
  sky.appendChild(sprinkleContainer);

  // ── 9. cloud horizon (CSS handles shapes) ────────────────
  var clouds = document.createElement('div');
  clouds.className = 'sky-clouds';
  for (var c = 0; c < 8; c++) {
    var cloud = document.createElement('div');
    cloud.className = 'sky-cloud-h c' + (c + 1);
    clouds.appendChild(cloud);
  }
  sky.appendChild(clouds);

  // ── 9b. comet trails ─────────────────────────────────────
  var comets = document.createElement('div');
  comets.className = 'sky-comets';
  function spawnComet() {
    var c = document.createElement('div');
    c.className = 'comet';
    c.style.cssText =
      'top:' + rand(5, 50) + '%;' +
      'left:' + rand(0, 40) + '%;' +
      'width:' + rand(100, 300) + 'px;' +
      '--angle:' + rand(20, 45) + 'deg;';
    comets.appendChild(c);
    setTimeout(function() { c.remove(); }, 3000);
  }
  (function loopComets() {
    spawnComet();
    setTimeout(loopComets, rand(3000, 8000));
  })();
  sky.appendChild(comets);

  // ── 9c. nebula pulses ────────────────────────────────────
  var nebula = document.createElement('div');
  nebula.className = 'sky-nebula';
  nebula.innerHTML = '<div class="nebula n1"></div><div class="nebula n2"></div><div class="nebula n3"></div>';
  sky.appendChild(nebula);

  // ── 9d. stardust particles ───────────────────────────────
  var dust = document.createElement('div');
  dust.className = 'sky-dust';
  for (var d = 0; d < 30; d++) {
    var particle = document.createElement('div');
    particle.className = 'dust';
    particle.style.cssText =
      'left:' + rand(0, 100) + '%;' +
      'animation-duration:' + rand(15, 30) + 's;' +
      'animation-delay:-' + rand(0, 30) + 's;';
    dust.appendChild(particle);
  }
  sky.appendChild(dust);

  // ── 10. grain overlay ────────────────────────────────────
  var grain = document.createElement('div');
  grain.className = 'sky-grain';
  sky.appendChild(grain);

  // ── 11. vignette ─────────────────────────────────────────
  var vignette = document.createElement('div');
  vignette.className = 'sky-vignette';
  sky.appendChild(vignette);

  // ── 12. parallax mouse tracking ──────────────────────────
  var mouseX = 0, mouseY = 0;
  var currentX = 0, currentY = 0;
  document.addEventListener('mousemove', function(e) {
    mouseX = (e.clientX / window.innerWidth - 0.5) * 2;
    mouseY = (e.clientY / window.innerHeight - 0.5) * 2;
  });
  function updateParallax() {
    currentX += (mouseX - currentX) * 0.03;
    currentY += (mouseY - currentY) * 0.03;
    var stars = sky.querySelector('.sky-stars');
    var bubbles = sky.querySelector('.sky-bubbles');
    var orbs = sky.querySelectorAll('.sky-orb');
    if (stars) {
      stars.style.transform = 'translate(' + (currentX * -15) + 'px,' + (currentY * -10) + 'px)';
    }
    if (bubbles) {
      bubbles.style.transform = 'translate(' + (currentX * -30) + 'px,' + (currentY * -20) + 'px)';
    }
    orbs.forEach(function(orb, i) {
      var depth = (i % 3 + 1) * 8;
      orb.style.transform = 'translate(' + (currentX * -depth) + 'px,' + (currentY * -depth * 0.6) + 'px)';
    });
    requestAnimationFrame(updateParallax);
  }
  requestAnimationFrame(updateParallax);

  // ── inject ───────────────────────────────────────────────
  document.body.insertBefore(sky, document.body.firstChild);
})();
