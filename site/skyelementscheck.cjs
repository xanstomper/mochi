const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
  const p = await b.newPage({ viewport:{width:1920,height:1080} });
  await p.goto('http://127.0.0.1:8937/mochi/index.html', {waitUntil:'networkidle'});
  await p.waitForTimeout(3000);
  const info = await p.evaluate(() => {
    const sky = document.querySelector('.sky-bg');
    if (!sky) return 'no sky-bg';
    const children = [...sky.children].map(c => c.className?.slice(0,30));
    const stars = sky.querySelectorAll('.sky-star').length;
    const bubbles = sky.querySelectorAll('.sky-bubble').length;
    const orbs = sky.querySelectorAll('.sky-orb').length;
    const sparkles = sky.querySelectorAll('.sky-sparkle').length;
    const sprinkles = sky.querySelectorAll('.sky-sprinkle').length;
    const clouds = sky.querySelectorAll('.sky-cloud-h').length;
    const shooting = sky.querySelectorAll('.shooting-star').length;
    return { children, stars, bubbles, orbs, sparkles, sprinkles, clouds, shooting };
  });
  console.log(JSON.stringify(info, null, 1));
  await b.close();
})();
